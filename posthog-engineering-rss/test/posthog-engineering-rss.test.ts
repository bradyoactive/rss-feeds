/**
 * Offline tests for the PostHog Engineering feed. The fixture is a verbatim
 * capture of the Strapi query the val makes — see `queryUrl` in the val for
 * the parameters; the browser sends the same ones.
 *
 * Run: node --test test/posthog-engineering-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  extractPosts,
  type Post,
  renderRss,
} from "../posthog-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const raw = JSON.parse(
  await readFile(
    new URL("./posthog-strapi-engineering.json", import.meta.url), "utf8",
  ),
);
const posts = extractPosts(raw);
const post = (path: string) => posts.find((p) => p.path === path)!;

const FEED_URL = "https://feed.val.run/posthog";
const feed = (query = "") =>
  buildFeed(posts, new URL(`${FEED_URL}${query}`)).text();

test("reads every post in the tag", () => {
  assertEquals(raw.meta.pagination.total, 58, "posts Strapi reports");
  assertEquals(posts.length, 58, "posts read");
  assert(posts.every((p) => p.path && p.title), "every post has a path/title");
  assertEquals(
    new Set(posts.map((p) => p.path)).size,
    posts.length,
    "paths are unique",
  );
  assert(posts.every((p) => p.ts !== null), "every post is dated");
  assert(posts.every((p) => p.excerpt), "every post has an excerpt");
  assert(posts.every((p) => p.image), "every post has a featured image");
  assert(
    posts.every((p) => p.labels.includes("Engineering")),
    "nothing untagged leaks in",
  );
});

test("unwraps Strapi's relation envelopes", () => {
  // Strapi v4 wraps every relation as { data: … } and every record's fields
  // under `attributes`, so nothing here is read straight off the entry.
  const p = post("/newsletter/software-factories");
  assertEquals(p.title, "Can software factories actually work?", "title");
  assertEquals(p.author, "Jina Yoon", "author, from a repeatable relation");
  assertEquals(
    p.labels,
    ["Newsletter", "Product engineers", "Engineering"],
    "category from a single relation, tags from a repeatable one",
  );
  assert(
    p.image.startsWith("https://res.cloudinary.com/"),
    "featured image, from a nested media relation",
  );
});

test("dates posts by `date`, not by when Strapi got them", () => {
  // `publishedAt` is when the record entered Strapi — for this post two days
  // after it went out, and for a backfilled one it can be years later.
  const p = post("/newsletter/software-factories");
  assertEquals(p.ts, Date.parse("2026-08-11T00:00:00.000Z"), "editorial date");
  const attributes =
    raw.data.find((e: { attributes: { slug: string } }) =>
      e.attributes.slug === "/newsletter/software-factories"
    ).attributes;
  assert(
    Date.parse(attributes.publishedAt) !== p.ts,
    "and the two genuinely differ in this capture",
  );
});

test("joins several authors the way a byline reads", () => {
  const multi = posts.find((p) => p.author.includes(" & "));
  assert(multi, "the tag has at least one co-written post");
  assert(
    !multi!.author.includes("undefined"),
    `a missing surname must not leak: ${multi!.author}`,
  );
});

test("keeps posts from every section the tag spans", () => {
  // PostHog files these under several folders and the listing gathers them
  // all, so the feed should not be a /blog-only subset.
  const sections = new Set(posts.map((p) => p.path.split("/")[1]));
  assertEquals(
    [...sections].sort(),
    ["blog", "founders", "newsletter", "product-engineers"],
    "four sections, as the site's own filter yields",
  );
});

test("drops a post that does not carry the tag", () => {
  // The query is already tag-filtered; this guards the filter loosening.
  const entry = (label: string) => ({
    attributes: {
      slug: `/blog/${label}`,
      title: label,
      date: "2026-01-01T00:00:00.000Z",
      post_tags: { data: [{ attributes: { label } }] },
    },
  });
  assertEquals(
    extractPosts({ data: [entry("Engineering"), entry("Product")] })
      .map((p) => p.path),
    ["/blog/Engineering"],
  );
});

test("survives input that is not the response we asked for", () => {
  assertEquals(extractPosts(null).length, 0, "null");
  assertEquals(extractPosts({ data: [] }).length, 0, "empty");
  assertEquals(extractPosts([]).length, 0, "not a response body");
  assertEquals(
    extractPosts({ data: [{ attributes: { title: "no slug" } }] }).length,
    0,
    "entries without a slug are dropped",
  );
});

test("serves the tag", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 58, "every post");
  assert(
    body.includes("<title>PostHog — Engineering</title>"),
    "channel title",
  );
  assert(
    body.includes("<link>https://posthog.com/blog?tag=Engineering</link>"),
    "channel link is the page this mirrors",
  );
  assert(
    body.includes(
      '<guid isPermaLink="true">https://posthog.com/newsletter/software-factories</guid>',
    ),
    "posts live at the site root under their own section",
  );
  assert(body.includes("<category>Engineering</category>"), "category");
});

test("orders items newest first", async () => {
  const dates = [...(await feed()).matchAll(/<pubDate>([^<]+)</g)].map((m) =>
    Date.parse(m[1])
  );
  assertEquals(dates, [...dates].sort((a, b) => b - a), "descending by date");
});

test("self-link is canonical, ignoring junk query params", async () => {
  const body = await feed("?tag=Product&limit=5");
  assert(body.includes(`href="${FEED_URL}" rel="self"`), "bare self-link");
  assertEquals((body.match(/<item>/g) ?? []).length, 58, "params ignored");
});

test("names the image media type rather than letting it be guessed", async () => {
  const body = await feed();
  assert(!body.includes('type="image/jpg"'), "no invalid image/jpg");

  // Most images carry an extension; Cloudinary transformations name the format
  // in the path instead, which is just as good.
  assertEquals(
    post("/blog/devtools-advice-agent-llm").imageType,
    "image/webp",
    "read out of the /f_webp,…/ transformation",
  );

  // And one is a bare public id that says nothing. No type is the right answer
  // there — better than a guessed one — even though FreshRSS then will not
  // treat it as a thumbnail.
  const unknown = posts.filter((p) => !p.imageType);
  assertEquals(unknown.map((p) => p.path), ["/blog/testing-ai-agents"]);
  assert(
    body.includes(
      '<enclosure length="0" url="https://res.cloudinary.com/dmukukwp6/image/upload/hero_9791aaf820"/>',
    ),
    "which emits an enclosure with no type attribute at all",
  );
});

const SAMPLE: Post = {
  path: "/blog/s",
  title: "Tom & Jerry <live>",
  excerpt: 'He said "hi"',
  ts: Date.parse("2026-08-11T00:00:00Z"),
  author: "Ada & Grace",
  image: "https://res.cloudinary.com/dmukukwp6/image/upload/a.png",
  imageType: "image/png",
  labels: ["Blog", "Engineering"],
};

test("renders XML-safe output", () => {
  const bell = String.fromCharCode(7);
  const out = renderRss({
    title: "Feed & <friends>",
    description: 'Quote " and control',
    siteLink: "https://posthog.com/blog?tag=Engineering",
    feedUrl: FEED_URL,
    items: [SAMPLE],
  });

  // The library wraps item text in CDATA rather than escaping entities, so the
  // characters that used to need escaping now appear verbatim — what matters is
  // that they cannot terminate the section early.
  assert(
    out.includes("<![CDATA[Tom & Jerry <live>]]>"),
    "item title survives verbatim inside CDATA",
  );
  assert(!out.includes("]]]]"), "no stray CDATA breakout in ordinary text");
  assert(out.includes('type="image/png"'), "enclosure states the media type");

  // Control characters are illegal in XML 1.0 and the library does not strip
  // them, so the val must — one anywhere breaks the whole document.
  const dirty = renderRss({
    title: "T",
    description: "d",
    siteLink: "https://posthog.com/blog",
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE, title: `Bell${bell}here` }],
  });
  assert(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(dirty), "control chars stripped");
  assert(dirty.includes("Bellhere"), "and the rest of the title is kept");
});

test("a CDATA breakout in the source cannot escape the section", () => {
  const out = renderRss({
    title: "T",
    description: "d",
    siteLink: "https://posthog.com/blog",
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE, title: "before ]]> after" }],
  });
  assert(out.includes("]]]]><![CDATA[>"), "breakout split");
  assert(!/\]\]>\s*after/.test(out), "no early termination");
});

test("omits optional elements when the post lacks them", () => {
  const bare: Post = {
    path: "/blog/bare",
    title: "Bare",
    excerpt: "",
    ts: null,
    author: "",
    image: "",
    imageType: "",
    labels: [],
  };
  const out = renderRss({
    title: "T",
    description: "D",
    siteLink: "https://posthog.com/blog",
    feedUrl: FEED_URL,
    items: [bare],
  });

  for (const tag of ["pubDate", "author", "category", "enclosure"]) {
    assert(!out.includes(`<${tag}`), `omits <${tag}> when empty`);
  }
  assertEquals(
    out.match(/<description>/g)?.length,
    1,
    "only the channel description",
  );
});
