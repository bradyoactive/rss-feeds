/**
 * Offline tests for the Harvey feed. The fixture is a real capture of the one
 * query the val makes. Refresh with:
 *
 *   curl -s --get https://07s0r5r6.apicdn.sanity.io/v2021-10-21/data/query/production \
 *     --data-urlencode 'query=*[_type=="blogPost"
 *        && references(*[_type=="blogTag" && slug.current=="technical"]._id)
 *        && isHidden != true] | order(body.publishedAt desc) [0...100] {
 *          "slug": body.slug.current, "title": body.title,
 *          "publishedAt": body.publishedAt, "description": body.description,
 *          "image": body.thumbnail.asset->url, "authors": body.postAuthors[]->name }' \
 *     > test/harvey-sanity-technical.json
 *
 * Run: deno test --allow-read test/harvey-technical-rss.test.ts
 */

import {
  buildFeed,
  extractPosts,
  type Post,
  renderRss,
} from "../harvey-technical-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const payload = JSON.parse(
  await Deno.readTextFile(
    new URL("./harvey-sanity-technical.json", import.meta.url),
  ),
);
const posts = extractPosts(payload);
const bySlug = (slug: string) => posts.find((p) => p.slug === slug);

Deno.test("reads the whole tag from one query", () => {
  assertEquals(posts.length, 41, "post count");
  assertEquals(
    posts.length,
    payload.result.length,
    "every returned row became a post",
  );
  assert(posts.every((p) => p.slug && p.title), "every post has a slug/title");
  assertEquals(
    new Set(posts.map((p) => p.slug)).size,
    posts.length,
    "slugs are unique",
  );
});

Deno.test("every post arrives complete — no per-post fetch needed", () => {
  // The point of using the API: the rendered cards carry none of this, which is
  // what used to cost one fetch per post.
  for (const field of ["ts", "description", "image"] as const) {
    assertEquals(
      posts.filter((p) => !p[field]).length,
      0,
      `every post has ${field}`,
    );
  }
  assertEquals(
    posts.filter((p) => p.authors.length === 0).length,
    0,
    "every post has a byline",
  );
});

Deno.test("keeps a byline that is a group rather than a person", () => {
  // These four have no JSON-LD Person node on their pages, so the old scraper
  // dropped their byline entirely. This is the regression the API fixed.
  for (
    const slug of [
      "using-elo-scores-to-build-better-legal-ai",
      "introducing-big-law-bench-global",
      "expanding-big-law-bench",
      "harvey-mcp-overview",
    ]
  ) {
    assertEquals(bySlug(slug)?.authors, ["Harvey Team"], slug);
  }
});

Deno.test("reads a known post's fields", () => {
  const p = bySlug("scaling-document-processing-across-harvey")!;
  assertEquals(
    p.title,
    "Scaling Document Processing Across the Harvey Platform",
    "title",
  );
  // An exact timestamp, where the rendered card gave only "July 27, 2026".
  assertEquals(p.ts, Date.parse("2026-07-27T17:00:00.000Z"), "ts");
  assertEquals(p.authors.length, 8, "all eight authors");
  assertEquals(p.authors[0], "Tom McCormick", "first author");
  assert(
    p.description.startsWith("A look at the infrastructure changes"),
    "description",
  );
  assert(
    p.image.startsWith("https://cdn.sanity.io/images/07s0r5r6/production/"),
    "Sanity asset URL",
  );
});

Deno.test("asks Sanity for a format the reader can use", () => {
  // The raw asset is a PNG; auto=format is what serves WebP to readers that
  // accept it, and is what the site's own pages request.
  assert(
    posts.every((p) => p.image.includes("auto=format")),
    "every image carries auto=format",
  );
  assert(
    !posts.some((p) => p.image.includes("?auto=format?")),
    "never doubled up",
  );
});

Deno.test("posts arrive newest first", () => {
  const dates = posts.map((p) => p.ts!);
  assertEquals(dates, [...dates].sort((a, b) => b - a), "descending by date");
});

Deno.test("degrades on a row missing its optional fields", () => {
  const [post] = extractPosts({ result: [{ slug: "bare", title: "Bare" }] });
  assertEquals(post, {
    slug: "bare",
    title: "Bare",
    ts: null,
    description: "",
    image: "",
    authors: [],
  }, "bare post");
});

Deno.test("survives a payload that is not what we asked for", () => {
  assertEquals(extractPosts({}).length, 0, "no result key");
  assertEquals(extractPosts({ result: null }).length, 0, "null result");
  assertEquals(
    extractPosts({ result: [{ title: "no slug" }, { slug: "no-title" }] })
      .length,
    0,
    "rows without both a slug and a title are dropped",
  );
});

const feed = () =>
  buildFeed(posts, new URL("https://feed.val.run/harvey")).text();

Deno.test("serves the feed", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 41, "all posts");
  assert(
    body.includes("<title>Harvey Blog — Technical</title>"),
    "channel title",
  );
  assert(
    body.includes("<link>https://www.harvey.ai/blog/tag/technical</link>"),
    "channel link is the tag page a reader would visit",
  );
  assert(
    body.includes(
      '<guid isPermaLink="true">https://www.harvey.ai/blog/scaling-document-processing-across-harvey</guid>',
    ),
    "item guid drops the /en-US prefix the site links with",
  );
  assert(body.includes("<category>Technical</category>"), "tag as a category");
  assertEquals(
    (body.match(/<author>/g) ?? []).length,
    posts.reduce((n, p) => n + p.authors.length, 0),
    "every byline emitted",
  );
});

Deno.test("self-link is canonical, ignoring junk query params", async () => {
  const body = await buildFeed(
    posts,
    new URL("https://feed.val.run/harvey?limit=5&tag=product&utm_source=x"),
  ).text();
  assert(
    body.includes('href="https://feed.val.run/harvey" rel="self"'),
    "bare self-link",
  );
  assertEquals((body.match(/<item>/g) ?? []).length, 41, "params ignored");
});

const SITE_LINK = "https://www.harvey.ai/blog/tag/technical";
const FEED_URL = "https://feed.val.run/harvey";
const SAMPLE_ITEM: Post = {
  slug: "s",
  title: "Tom & Jerry <live>",
  description: 'He said "hi"',
  ts: Date.parse("2026-07-27T00:00:00Z"),
  image: "https://cdn.sanity.io/images/x/y.png?auto=format",
  authors: ["Ada & Grace"],
};

Deno.test("renders XML-safe output", () => {
  const bell = String.fromCharCode(7);
  const xml = renderRss({
    title: "Feed & <friends>",
    description: 'Quote " and control',
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [SAMPLE_ITEM],
  });

  // The library wraps item text in CDATA rather than escaping entities, so the
  // characters that used to need escaping now appear verbatim — what matters is
  // that they cannot terminate the section early.
  assert(
    xml.includes("<![CDATA[Tom & Jerry <live>]]>"),
    "item title survives verbatim inside CDATA",
  );
  assert(!xml.includes("]]]]"), "no stray CDATA breakout in ordinary text");
  assert(xml.includes("<pubDate>"), "RFC-822 pubDate");

  // Control characters are illegal in XML 1.0 and the library does not strip
  // them, so the val must — one anywhere breaks the whole document.
  const dirty = renderRss({
    title: `T${bell}`,
    description: "d",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE_ITEM, title: `Bell${bell}here` }],
  });
  // deno-lint-ignore no-control-regex
  assert(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(dirty), "control chars stripped");
  assert(dirty.includes("Bellhere"), "and the rest of the title is kept");
});

Deno.test("a CDATA breakout in the source cannot escape the section", () => {
  const xml = renderRss({
    title: "T",
    description: "d",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE_ITEM, title: "before ]]> after" }],
  });
  assert(xml.includes("]]]]><![CDATA[>"), "breakout split");
  assert(!/\]\]>\s*after/.test(xml), "no early termination");
});

Deno.test("omits optional elements when the post lacks them", () => {
  const bare: Post = {
    slug: "bare",
    title: "Bare",
    description: "",
    ts: null,
    image: "",
    authors: [],
  };
  const xml = renderRss({
    title: "T",
    description: "D",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [bare],
  });

  for (const tag of ["pubDate", "author", "enclosure"]) {
    assert(!xml.includes(`<${tag}`), `omits <${tag}> when empty`);
  }
  assertEquals(
    xml.match(/<description>/g)?.length,
    1,
    "only the channel description",
  );
});
