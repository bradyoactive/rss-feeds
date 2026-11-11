/**
 * Offline tests for the Hex feed. The fixture is a real capture of the one
 * query the val makes. Refresh with:
 *
 *   curl -s --get https://e92memrj.apicdn.sanity.io/v2021-10-21/data/query/production \
 *     --data-urlencode 'query=*[_type=="blogPost"
 *        && references(*[_type=="blogCategory" && slug.current=="engineering"]._id)
 *        && hidePost != true] | order(date desc) [0...100] {
 *          "slug": slug.current, "title": title, "date": date, "synopsis": synopsis,
 *          "author": author, "image": hero.image.asset->url,
 *          "categories": categories[]->name }' \
 *     > test/hex-sanity-engineering.json
 *
 * Run: node --test test/hex-engineering-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  extractPosts,
  type Post,
  renderRss,
} from "../hex-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const payload = JSON.parse(
  await readFile(
    new URL("./hex-sanity-engineering.json", import.meta.url), "utf8",
  ),
);
const posts = extractPosts(payload);
const bySlug = (slug: string) => posts.find((p) => p.slug === slug);

test("reads the whole category from one query", () => {
  assertEquals(posts.length, 14, "post count");
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

test("every post arrives complete", () => {
  for (const field of ["synopsis", "author", "image", "ts"] as const) {
    assertEquals(
      posts.filter((p) => !p[field]).length,
      0,
      `every post has ${field}`,
    );
  }
  assert(
    posts.every((p) => p.categories.includes("Engineering")),
    "every post is in the category asked for",
  );
});

test("reads a known post's fields", () => {
  const p = bySlug("caching-is-all-you-need")!;
  assertEquals(p.title, "Caching is all you need", "title");
  // `date` is date-only, so the post lands on UTC midnight.
  assertEquals(p.ts, Date.parse("2026-07-29T00:00:00Z"), "ts");
  assertEquals(p.author, "Zach Kirby & Olivia Koshy", "multi-author byline");
  assert(
    p.synopsis.startsWith("Our cache hit rate looked great"),
    "synopsis",
  );
  assert(
    p.image.startsWith("https://cdn.sanity.io/images/e92memrj/production/"),
    "Sanity asset URL",
  );
});

test("posts arrive newest first", () => {
  const dates = posts.map((p) => p.ts!);
  assertEquals(dates, [...dates].sort((a, b) => b - a), "descending by date");
});

test("degrades on a row missing its optional fields", () => {
  const [post] = extractPosts({ result: [{ slug: "bare", title: "Bare" }] });
  assertEquals(post, {
    slug: "bare",
    title: "Bare",
    synopsis: "",
    ts: null,
    author: "",
    image: "",
    categories: [],
  }, "bare post");
});

test("survives a payload that is not what we asked for", () => {
  assertEquals(extractPosts({}).length, 0, "no result key");
  assertEquals(extractPosts({ result: null }).length, 0, "null result");
  assertEquals(
    extractPosts({ result: [{ title: "no slug" }, { slug: "no-title" }] })
      .length,
    0,
    "rows without both a slug and a title are dropped",
  );
});

const feed = (query = "") =>
  buildFeed(posts, new URL(`https://feed.val.run/hex${query}`)).text();

test("serves the feed", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 14, "all posts");
  assert(
    body.includes("<title>Hex Blog — Engineering</title>"),
    "channel title uses Hex's own spelling",
  );
  assert(
    body.includes("<link>https://hex.tech/blog/category/engineering/</link>"),
    "channel link",
  );
  assert(
    body.includes(
      '<guid isPermaLink="true">https://hex.tech/blog/caching-is-all-you-need/</guid>',
    ),
    "item guid keeps the trailing slash Hex canonicalises to",
  );
  assert(body.includes("<category>Engineering</category>"), "category");
});

test("self-link is canonical, ignoring junk query params", async () => {
  const body = await feed("?category=product&limit=5&utm_source=x");
  assert(
    body.includes('href="https://feed.val.run/hex" rel="self"'),
    "bare self-link",
  );
  assertEquals((body.match(/<item>/g) ?? []).length, 14, "params ignored");
});

const SITE_LINK = "https://hex.tech/blog/category/engineering/";
const FEED_URL = "https://feed.val.run/hex";
const SAMPLE_ITEM: Post = {
  slug: "s",
  title: "Tom & Jerry <live>",
  synopsis: 'He said "hi"',
  ts: Date.parse("2026-07-29T00:00:00Z"),
  author: "Ada & Grace",
  image: "https://cdn.sanity.io/images/e92memrj/production/x.png",
  categories: ["Engineering"],
};

test("renders XML-safe output", () => {
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
  assert(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(dirty), "control chars stripped");
  assert(dirty.includes("Bellhere"), "and the rest of the title is kept");
});

test("a CDATA breakout in the source cannot escape the section", () => {
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

test("omits optional elements when the record lacks them", () => {
  const bare: Post = {
    slug: "bare",
    title: "Bare",
    synopsis: "",
    ts: null,
    author: "",
    image: "",
    categories: [],
  };
  const xml = renderRss({
    title: "T",
    description: "D",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [bare],
  });

  for (const tag of ["pubDate", "author", "category", "enclosure"]) {
    assert(!xml.includes(`<${tag}`), `omits <${tag}> when empty`);
  }
  assertEquals(
    xml.match(/<description>/g)?.length,
    1,
    "only the channel description",
  );
});
