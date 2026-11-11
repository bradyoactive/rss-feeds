/**
 * Offline tests for the Figma feed.
 *
 * The fixture is a subset of Figma's blog search index, taken verbatim from
 * https://www.figma.com/blogSearch/blog-data.json — the live file holds all 737
 * posts and runs to 4.6 MB, which is more than a fixture needs to pin. It keeps
 * the 20 newest Engineering posts, the three whose lede has an unusual shape
 * (spans split by a link, and one spread over three blocks), and 10 posts
 * tagged something else, so the tag filter has something to exclude. Refresh:
 *
 *   curl -sL https://www.figma.com/blogSearch/blog-data.json | python3 -c '…'
 *
 * Run: node --test test/figma-engineering-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  extractPosts,
  type Post,
  renderRss,
} from "../figma-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const raw = JSON.parse(
  await readFile(
    new URL("./figma-blog-search-index.json", import.meta.url), "utf8",
  ),
);
const posts = extractPosts(raw);

test("reads the tagged posts and only those", () => {
  assertEquals(raw.length, 33, "records in the fixture");
  assertEquals(posts.length, 23, "tagged Engineering");
  assert(posts.every((p) => p.path && p.title), "every post has a path/title");
  assert(
    posts.every((p) => p.labels.includes("Engineering")),
    "nothing from another tag leaks in",
  );
  assertEquals(
    new Set(posts.map((p) => p.path)).size,
    posts.length,
    "paths are unique",
  );
});

test("matches the tag on its slug, not its display name", () => {
  // The whole filter rests on this: Figma can rename the tag in Sanity and the
  // feed keeps working, because the slug is the tag page's own URL.
  const record = (tag: { name: string; slug: string }) => ({
    title: "T",
    slug: { current: "/blog/t/" },
    publicationDate: "2026-01-01",
    labels: { tags: [{ name: tag.name, slug: { current: tag.slug } }] },
  });

  assertEquals(
    extractPosts([record({ name: "Renamed", slug: "/blog/engineering/" })])
      .length,
    1,
    "a renamed tag still matches on its slug",
  );
  assertEquals(
    extractPosts([record({ name: "Engineering", slug: "/blog/eng-blog/" })])
      .length,
    0,
    "the right name at a different slug does not",
  );
});

test("reads every field of a known item", () => {
  const p = posts.find((p) =>
    p.path === "/blog/the-benefits-of-code-connect-in-mcp/"
  )!;
  assertEquals(
    p.title,
    "Better code, fewer tokens: The benefits of Code Connect in MCP",
    "title",
  );
  assertEquals(p.ts, Date.parse("2026-08-05T18:16:00.000Z"), "ts");
  assertEquals(p.author, "Tom Weightman", "author");
  assertEquals(
    p.labels,
    [
      "Inside Figma",
      "Engineering",
      "Figma MCP",
      "Dev Mode",
      "Design systems",
      "AI",
    ],
    "category first, then tags",
  );
  assertEquals(p.imageType, "image/jpeg", "Sanity states the media type");
  assert(p.image.startsWith("https://cdn.sanity.io/images/"), "image");
  assert(p.lede.startsWith("When going from design to code"), "lede");
});

test("joins several authors the way the byline reads", () => {
  const p = posts.find((p) =>
    p.path === "/blog/figma-rendering-powered-by-webgpu/"
  )!;
  assertEquals(p.author, "Alex Ringlein & Luke Anderson");
});

test("flattens the lede's portable text", () => {
  // Spans are the runs of one sentence, split where a link or emphasis starts,
  // so they join with nothing between them — a separator would insert spaces
  // mid-sentence. Blocks are paragraphs and do get one.
  const linked = posts.find((p) =>
    p.path === "/blog/how-magician-uses-figmas-text-review-api/"
  )!;
  assert(
    linked.lede.startsWith(
      "We sat down with Jordan Singer, who built Magician",
    ),
    `spans joined without separators, got: ${linked.lede.slice(0, 60)}`,
  );

  const paragraphs = posts.find((p) =>
    p.path === "/blog/inside-figma-how-figma-engineering-uses-figjam-to-scale/"
  )!;
  assert(paragraphs.lede.length > 0, "a multi-block lede still reads as text");
  assert(!/\s{2,}/.test(paragraphs.lede), "no doubled whitespace at the seams");

  assert(posts.every((p) => p.lede), "every post in the fixture has a lede");
});

test("reads dates in both shapes the index stores", () => {
  // Older posts carry a bare "2025-09-18" and newer ones a Z-suffixed instant.
  // Date.parse reads both as UTC; a naive datetime would have been read as
  // local time and shifted by however many hours the val happened to run at.
  const dateOnly = posts.find((p) =>
    p.path === "/blog/figma-rendering-powered-by-webgpu/"
  )!;
  assertEquals(
    dateOnly.ts,
    Date.UTC(2025, 8, 18),
    "date-only, at UTC midnight",
  );
  assert(posts.every((p) => p.ts !== null), "every post is dated");
});

test("takes the cover image when the card has none", () => {
  // Three posts in the fixture only set coverMedia; ten set neither, because
  // their card is a video or an embed and Figma almost never fills in a poster.
  const withImage = posts.filter((p) => p.image);
  assertEquals(withImage.length, 13, "posts with a usable image");
  assert(
    withImage.every((p) => p.image.startsWith("https://cdn.sanity.io/")),
    "images come from Sanity's CDN",
  );
  assert(
    withImage.every((p) => p.imageType.startsWith("image/")),
    "and every one states an image media type",
  );
});

test("survives input that is not the index we asked for", () => {
  assertEquals(extractPosts([]).length, 0, "empty");
  assertEquals(extractPosts(null).length, 0, "null");
  assertEquals(extractPosts({ hits: [] }).length, 0, "not an array");
  assertEquals(
    extractPosts([{ title: "no slug", labels: { tags: [] } }]).length,
    0,
    "records without a slug are dropped",
  );
  assertEquals(
    extractPosts([{ slug: { current: "/blog/x/" }, title: "untagged" }]).length,
    0,
    "records without labels are dropped",
  );
});

const feed = (query = "") =>
  buildFeed(posts, new URL(`https://feed.val.run/figma${query}`)).text();

test("serves the Engineering tag", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 23, "every tagged post");
  assert(
    body.includes("<title>Figma Blog — Engineering</title>"),
    "channel title uses Figma's own spelling of the tag",
  );
  assert(
    body.includes("<link>https://www.figma.com/blog/engineering/</link>"),
    "channel link is the tag page",
  );
  assert(
    body.includes(
      '<guid isPermaLink="true">https://www.figma.com/blog/the-benefits-of-code-connect-in-mcp/',
    ),
    "item guid is the post URL",
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
  const body = await feed("?tag=design&limit=5&utm_source=x");
  assert(
    body.includes('href="https://feed.val.run/figma" rel="self"'),
    "bare self-link",
  );
  assertEquals((body.match(/<item>/g) ?? []).length, 23, "params ignored");
});

const TAG_LINK = "https://www.figma.com/blog/engineering/";
const FEED_URL = "https://feed.val.run/figma";
const SAMPLE_ITEM: Post = {
  path: "/blog/s/",
  title: "Tom & Jerry <live>",
  lede: 'He said "hi"',
  ts: Date.parse("2026-08-11T19:59:00Z"),
  author: "Ada & Grace",
  image: "https://cdn.sanity.io/images/599r6htc/regionalized/a.jpg",
  imageType: "image/jpeg",
  labels: ["Engineering"],
};

test("renders XML-safe output", () => {
  const bell = String.fromCharCode(7);
  const out = renderRss({
    title: "Feed & <friends>",
    description: 'Quote " and control',
    siteLink: TAG_LINK,
    feedUrl: FEED_URL,
    items: [SAMPLE_ITEM],
  });

  // The library wraps item text in CDATA rather than escaping entities, so the
  // characters that used to need escaping now appear verbatim — what matters is
  // that they cannot terminate the section early.
  assert(
    out.includes("<![CDATA[Tom & Jerry <live>]]>"),
    "item title survives verbatim inside CDATA",
  );
  assert(!out.includes("]]]]"), "no stray CDATA breakout in ordinary text");
  assert(out.includes("<pubDate>"), "RFC-822 pubDate");
  assert(
    out.includes('type="image/jpeg"'),
    "the enclosure carries the stated media type",
  );

  // Control characters are illegal in XML 1.0 and the library does not strip
  // them, so the val must — one anywhere breaks the whole document.
  const dirty = renderRss({
    title: `T${bell}`,
    description: "d",
    siteLink: TAG_LINK,
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE_ITEM, title: `Bell${bell}here` }],
  });
  assert(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(dirty), "control chars stripped");
  assert(dirty.includes("Bellhere"), "and the rest of the title is kept");
});

test("a CDATA breakout in the source cannot escape the section", () => {
  const out = renderRss({
    title: "T",
    description: "d",
    siteLink: TAG_LINK,
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE_ITEM, title: "before ]]> after" }],
  });
  assert(out.includes("]]]]><![CDATA[>"), "breakout split");
  assert(!/\]\]>\s*after/.test(out), "no early termination");
});

test("omits optional elements when the item lacks them", () => {
  const bare: Post = {
    path: "/blog/bare/",
    title: "Bare",
    lede: "",
    ts: null,
    author: "",
    image: "",
    imageType: "",
    labels: [],
  };
  const out = renderRss({
    title: "T",
    description: "D",
    siteLink: TAG_LINK,
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
