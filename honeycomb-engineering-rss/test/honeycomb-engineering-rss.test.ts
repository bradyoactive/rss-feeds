/**
 * Offline tests for the Honeycomb Software Engineering feed. The fixture is a
 * verbatim capture of the GROQ query the val makes — `GROQ` is exported, so
 * refresh with:
 *
 *   curl -sG "https://927dxq0h.apicdn.sanity.io/v2021-10-21/data/query/production" \
 *     --data-urlencode "query=<the GROQ export>" \
 *     -o honeycomb-sanity-software-engineering.json
 *
 * Run: node --test test/honeycomb-engineering-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  extractPosts,
  GROQ,
  type Post,
  renderRss,
} from "../honeycomb-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const raw = JSON.parse(
  await readFile(
    new URL("./honeycomb-sanity-software-engineering.json", import.meta.url), "utf8",
  ),
);
const posts = extractPosts(raw);
const post = (slug: string) => posts.find((p) => p.slug === slug)!;

const FEED_URL = "https://feed.val.run/honeycomb";
const feed = (query = "") =>
  buildFeed(posts, new URL(`${FEED_URL}${query}`)).text();

test("reads every article in the topic", () => {
  assertEquals(posts.length, 100, "articles");
  assert(posts.every((p) => p.slug && p.title), "every post has a slug/title");
  assertEquals(
    new Set(posts.map((p) => p.slug)).size,
    posts.length,
    "slugs are unique",
  );
  assert(posts.every((p) => p.ts !== null), "every post is dated");
  assert(posts.every((p) => p.author), "every post has an author");
  assert(posts.every((p) => p.image), "every post has an image");
  assert(
    posts.every((p) => p.topics.includes("Software Engineering")),
    "every post carries the topic",
  );
});

test("reads every field of a known article", () => {
  const p = post("embracing-code-review-bottleneck");
  assertEquals(p.title, "Embracing the Code Review Bottleneck", "title");
  assertEquals(p.author, "Fred Hebert", "author, resolved through a reference");
  assertEquals(p.ts, Date.parse("2026-07-22T15:00:00.000Z"), "ts");
  assertEquals(p.topics, ["Software Engineering", "AI & LLMs"], "topics");
  assertEquals(p.imageType, "image/png", "Sanity states the media type");
  assert(
    p.image.startsWith("https://cdn.sanity.io/images/927dxq0h/production/"),
    "image",
  );
  assert(p.summary.startsWith("Faced with an endless stream"), "summary");
});

test("resolves the topic by slug, not by title", () => {
  // Titles are not unique in this dataset — two different topic documents are
  // both called "AI & LLMs" — so matching on one would be a coin flip.
  assert(
    GROQ.includes('_type=="topic" && slug.current=="software-engineering"'),
    "the query joins on the slug",
  );
  assert(
    !GROQ.includes('title=="Software Engineering"'),
    "and never on the title",
  );
});

test("reaches the image through the assetImage wrapper", () => {
  // mainImage is an `assetImage`, so the asset sits at mainImage.image.asset.
  // Reading mainImage.asset returns null for every article rather than
  // failing, which is how this was wrong and silent the first time.
  assert(
    GROQ.includes("mainImage.image.asset->url"),
    "the query goes through .image",
  );
  assert(
    !/mainImage\.asset->/.test(GROQ),
    "and not straight at mainImage.asset",
  );
  const mimes = new Set(posts.map((p) => p.imageType));
  assert(
    [...mimes].every((m) => m.startsWith("image/")),
    `every image resolved to a real type: ${[...mimes].join(", ")}`,
  );
});

test("keeps an article whose summary is missing", () => {
  // Three of the hundred have none; they should still appear, just without a
  // <description>.
  const withoutSummary = posts.filter((p) => !p.summary);
  assertEquals(withoutSummary.length, 3, "articles with no summary");
  assert(
    withoutSummary.every((p) => p.title && p.ts !== null),
    "and they are otherwise complete",
  );
});

test("survives input that is not the response we asked for", () => {
  assertEquals(extractPosts(null).length, 0, "null");
  assertEquals(extractPosts({ result: [] }).length, 0, "empty");
  assertEquals(extractPosts({ result: "nope" }).length, 0, "not an array");
  assertEquals(
    extractPosts({ result: [{ title: "no slug" }] }).length,
    0,
    "records without a slug are dropped",
  );
});

test("serves the topic", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 100, "every article");
  assert(
    body.includes("<title>Honeycomb — Software Engineering</title>"),
    "channel title",
  );
  assert(
    body.includes(
      "<link>https://www.honeycomb.io/blog?topic=Software%20Engineering</link>",
    ),
    "channel link is the page this mirrors",
  );
  assert(
    body.includes(
      '<guid isPermaLink="true">https://www.honeycomb.io/blog/embracing-code-review-bottleneck</guid>',
    ),
    "item guid is the post URL",
  );
  assert(
    body.includes("<category>Software Engineering</category>"),
    "category",
  );
  assertEquals(
    (body.match(/<enclosure/g) ?? []).length,
    100,
    "every item carries its image",
  );
});

test("orders items newest first", async () => {
  const dates = [...(await feed()).matchAll(/<pubDate>([^<]+)</g)].map((m) =>
    Date.parse(m[1])
  );
  assertEquals(dates, [...dates].sort((a, b) => b - a), "descending by date");
});

test("self-link is canonical, ignoring junk query params", async () => {
  const body = await feed("?topic=Culture&limit=5");
  assert(body.includes(`href="${FEED_URL}" rel="self"`), "bare self-link");
  assertEquals((body.match(/<item>/g) ?? []).length, 100, "params ignored");
});

const SITE_LINK = "https://www.honeycomb.io/blog?topic=Software+Engineering";
const SAMPLE: Post = {
  slug: "s",
  title: "Tom & Jerry <live>",
  summary: 'He said "hi"',
  ts: Date.parse("2026-07-22T15:00:00Z"),
  author: "Ada & Grace",
  image: "https://cdn.sanity.io/images/927dxq0h/production/a-1920x1080.png",
  imageType: "image/png",
  topics: ["Software Engineering"],
};

test("renders XML-safe output", () => {
  const bell = String.fromCharCode(7);
  const out = renderRss({
    title: "Feed & <friends>",
    description: 'Quote " and control',
    siteLink: SITE_LINK,
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
    siteLink: SITE_LINK,
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
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE, title: "before ]]> after" }],
  });
  assert(out.includes("]]]]><![CDATA[>"), "breakout split");
  assert(!/\]\]>\s*after/.test(out), "no early termination");
});

test("omits optional elements when the article lacks them", () => {
  const bare: Post = {
    slug: "bare",
    title: "Bare",
    summary: "",
    ts: null,
    author: "",
    image: "",
    imageType: "",
    topics: [],
  };
  const out = renderRss({
    title: "T",
    description: "D",
    siteLink: SITE_LINK,
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
