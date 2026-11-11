/**
 * Offline tests for the Lovable feed. The fixture is a real capture of
 * Lovable's own feed, which this val filters. Refresh with:
 *
 *   curl -sL https://lovable.dev/blog/rss.xml -o lovable-blog-rss.xml
 *
 * Run: deno test --allow-read test/lovable-rss.test.ts
 */

import {
  buildFeed,
  extractPosts,
  type Post,
  renderRss,
  selectPosts,
} from "../lovable-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const xml = await Deno.readTextFile(
  new URL("./lovable-blog-rss.xml", import.meta.url),
);
const posts = extractPosts(xml);
const inside = selectPosts(posts);

Deno.test("reads every item in Lovable's feed", () => {
  assertEquals(posts.length, 147, "item count");
  assertEquals(
    posts.length,
    (xml.match(/<item>/g) ?? []).length,
    "every item became a post",
  );
  assert(posts.every((p) => p.link && p.title), "every post has a link/title");
  assertEquals(
    new Set(posts.map((p) => p.link)).size,
    posts.length,
    "links are unique",
  );
});

Deno.test("filters to the Inside Lovable category", () => {
  assertEquals(inside.length, 28, "Inside Lovable count");
  assert(
    inside.every((p) => p.category.toLowerCase() === "inside lovable"),
    "nothing from another category leaks in",
  );
});

Deno.test("categories are spelled inconsistently at the source", () => {
  // Why matching normalises rather than comparing literally: the same category
  // is written two ways, and an exact match would silently drop one spelling.
  const byNormalised = new Map<string, Set<string>>();
  for (const p of posts) {
    if (!p.category) continue;
    const key = p.category.toLowerCase();
    byNormalised.set(key, (byNormalised.get(key) ?? new Set()).add(p.category));
  }
  const inconsistent = [...byNormalised.values()].filter((s) => s.size > 1);
  assert(
    inconsistent.length > 0,
    "at least one category is written more than one way",
  );
});

Deno.test("reads every field of a known item", () => {
  const p = posts.find((p) => p.link.endsWith("/blog/series-c"))!;
  assertEquals(
    p.title,
    "We just raised $400M in Series C funding to help people run their businesses",
    "title",
  );
  assertEquals(p.ts, Date.parse("Wed, 12 Aug 2026 09:59:00 GMT"), "ts");
  assertEquals(p.author, "Lovable", "dc:creator");
  assertEquals(p.category, "Announcements", "category");
  assert(p.description.startsWith("Lovable has raised $400 million"), "desc");
});

Deno.test("decodes entities the source escapes", () => {
  // Titles arrive with &amp; and &#39; in them; nothing should reach the feed
  // still encoded.
  assert(
    !posts.some((p) => /&(amp|lt|gt|quot|apos|#\d+);/.test(p.title)),
    "no entity survives extraction",
  );
});

Deno.test("keeps every field inside its own item", () => {
  const synthetic = `<rss><channel>
    <item><title>First</title><link>https://lovable.dev/blog/a</link>
      <category>Inside Lovable</category><dc:creator>Ada</dc:creator>
      <description>First desc</description>
      <pubDate>Wed, 12 Aug 2026 09:59:00 GMT</pubDate></item>
    <item><title>Bare</title><link>https://lovable.dev/blog/b</link></item>
    <item><title>Third</title><link>https://lovable.dev/blog/c</link>
      <category>Stories</category><dc:creator>Grace</dc:creator>
      <description>Third desc</description></item>
  </channel></rss>`;

  const [first, bare, third] = extractPosts(synthetic);
  assertEquals(first.description, "First desc", "first description");
  assertEquals(third.author, "Grace", "third byline");
  assertEquals(
    [bare.description, bare.author, bare.category],
    ["", "", ""],
    "the bare item stays bare rather than borrowing a neighbour",
  );
  assertEquals(bare.ts, null, "and undated");
});

Deno.test("survives input that is not the feed we asked for", () => {
  assertEquals(extractPosts("").length, 0, "empty");
  assertEquals(extractPosts("<html>nope</html>").length, 0, "not a feed");
  assertEquals(
    extractPosts("<item><title>no link</title></item>").length,
    0,
    "items without a link are dropped",
  );
});

const feed = (query = "") =>
  buildFeed(posts, new URL(`https://feed.val.run/lovable${query}`)).text();

Deno.test("serves the Inside Lovable category", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 28, "every matching post");
  assert(
    body.includes("<title>Lovable Blog — Inside Lovable</title>"),
    "channel title uses the dominant spelling",
  );
  assert(
    body.includes(
      "<link>https://lovable.dev/blog?category=inside+lovable</link>",
    ),
    "channel link",
  );
  assert(
    body.includes('<guid isPermaLink="true">https://lovable.dev/blog/'),
    "item guid is the post URL Lovable published",
  );
  assert(body.includes("<category>Inside Lovable</category>"), "category");
});

Deno.test("carries no images, because the source feed has none", () => {
  // A deliberate trade: reading Lovable's own feed means no thumbnails at all.
  assert(!xml.includes("<enclosure"), "source has no enclosure");
  assert(!xml.includes("<media:"), "source has no media:content");
});

Deno.test("orders items newest first", async () => {
  const dates = [...(await feed()).matchAll(/<pubDate>([^<]+)</g)].map((m) =>
    Date.parse(m[1])
  );
  assertEquals(dates, [...dates].sort((a, b) => b - a), "descending by date");
});

Deno.test("self-link is canonical, ignoring junk query params", async () => {
  const body = await feed("?category=announcements&limit=5&utm_source=x");
  assert(
    body.includes('href="https://feed.val.run/lovable" rel="self"'),
    "bare self-link",
  );
  assertEquals((body.match(/<item>/g) ?? []).length, 28, "params ignored");
});

const SITE_LINK = "https://lovable.dev/blog?category=inside+lovable";
const FEED_URL = "https://feed.val.run/lovable";
const SAMPLE_ITEM: Post = {
  link: "https://lovable.dev/blog/s",
  title: "Tom & Jerry <live>",
  description: 'He said "hi"',
  ts: Date.parse("2026-08-12T09:59:00Z"),
  author: "Ada & Grace",
  category: "Inside Lovable",
};

Deno.test("renders XML-safe output", () => {
  const bell = String.fromCharCode(7);
  const out = renderRss({
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
    out.includes("<![CDATA[Tom & Jerry <live>]]>"),
    "item title survives verbatim inside CDATA",
  );
  assert(!out.includes("]]]]"), "no stray CDATA breakout in ordinary text");
  assert(out.includes("<pubDate>"), "RFC-822 pubDate");

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
  const out = renderRss({
    title: "T",
    description: "d",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE_ITEM, title: "before ]]> after" }],
  });
  assert(out.includes("]]]]><![CDATA[>"), "breakout split");
  assert(!/\]\]>\s*after/.test(out), "no early termination");
});

Deno.test("omits optional elements when the item lacks them", () => {
  const bare: Post = {
    link: "https://lovable.dev/blog/bare",
    title: "Bare",
    description: "",
    ts: null,
    author: "",
    category: "",
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
