/**
 * Offline tests for the Mistral feed.
 *
 * Two fixtures, both real captures of the two requests the val makes:
 *
 *   mistral-news-rss.xml   the firehose, whole and verbatim:
 *     curl -s https://mistral.ai/news/rss > test/mistral-news-rss.xml
 *
 *   mistral-news-page.html the listing page, cut down. The live page is 1.2 MB
 *     — 84 <article> cards, most of that the base64 blur placeholder each one
 *     carries — so the fixture keeps 13 of them **byte-for-byte**, spliced back
 *     into the real page around them. The 13 are chosen for shape, not
 *     convenience: both Engineering posts, the featured card (whose markup is
 *     laid out differently), Research posts with and without a summary, and
 *     five posts in other categories so the filter has something to exclude.
 *     Recapture with:
 *       curl -s https://mistral.ai/news/ > test/full.html
 *     then re-splice, or just commit the whole thing and accept the megabyte.
 *
 * The counts below are the fixture's. The parity worth knowing is against the
 * *live* pair, which yields the same 41 posts, the same Research 39 /
 * Engineering 2 split and the same 7 descriptions the retired Payload API did.
 *
 * Run: node --test test/mistral-news-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  displayNames,
  extractPosts,
  type Post,
  renderRss,
} from "../mistral-news-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const pageHtml = await readFile(
  new URL("./mistral-news-page.html", import.meta.url),
  "utf8",
);
const feedXml = await readFile(
  new URL("./mistral-news-rss.xml", import.meta.url),
  "utf8",
);

const posts = extractPosts(pageHtml, feedXml);
const bySlug = (slug: string) => posts.find((p) => p.slug === slug);

const countByCategory = () => {
  const counts: Record<string, number> = {};
  for (const p of posts) {
    for (const c of p.categories) counts[c] = (counts[c] ?? 0) + 1;
  }
  return counts;
};

test("keeps only the two categories it exists for", () => {
  assertEquals(posts.length, 8, "post count");
  assertEquals(
    countByCategory(),
    {
      Research: 6,
      Engineering: 2,
    },
    "posts per category",
  );
  // The fixture holds five posts in company/product/solutions. If the filter
  // ever stopped applying, this is the number that would move first.
  assertEquals(
    (pageHtml.match(/<article\b[^>]*\bjs-post\b/g) ?? []).length,
    13,
    "cards in the fixture",
  );
  assertEquals(
    new Set(posts.map((p) => p.slug)).size,
    posts.length,
    "slugs are unique",
  );
});

test("joins the firehose onto the listing by slug", () => {
  const p = bySlug("robostral-navigate")!;
  // From the page: title, byline, thumbnail, category.
  assertEquals(p.title, "Introducing Robostral Navigate", "title");
  assertEquals(p.author, "Mistral AI", "byline, with the card's 'By ' dropped");
  assertEquals(p.categories, ["Research"], "category");
  assertEquals(
    p.image,
    "https://mistral.ai/_astro/Robostral-navigate_2lHiJb.webp",
    "thumbnail, absolute and stripped of ?dpl=",
  );
  // From the feed: the exact instant, where the card prints only "July 8, 2026".
  assertEquals(p.ts, Date.parse("2026-07-08T12:00:59.000Z"), "ts");
  assert(
    p.description.startsWith("Introducing Robostral Navigate:"),
    "description comes from the feed",
  );
});

test("drops the ?dpl= cache buster from every thumbnail", () => {
  // It changes on every mistral.ai deploy, and FreshRSS hashes the enclosure
  // URL — leaving it on re-unreads the whole feed when Mistral ships anything.
  assert(
    posts.every((p) => p.image),
    "every post has a thumbnail",
  );
  assert(!posts.some((p) => p.image.includes("dpl=")), "no deploy id survives");
  assert(
    posts.every((p) => p.image.startsWith("https://mistral.ai/_astro/")),
    "rooted at the site, not left relative",
  );
  // The card's src is relative, so the prefix is the thing under test.
  assert(pageHtml.includes('src="/_astro/'), "the source really is relative");
  assert(pageHtml.includes("?dpl="), "and really does carry the buster");
});

test("descriptions are as sparse as the source, and that is the finding", () => {
  // Mistral sets a summary on a minority of posts. Fetching each post page to
  // fill the rest was measured and recovers nothing — see the val's header.
  assertEquals(posts.filter((p) => p.description).length, 3, "descriptions");
  assert(
    posts.every((p) => p.title && p.author),
    "titles and bylines are total",
  );
  assert(
    posts.every((p) => p.ts !== null),
    "every post is dated",
  );
});

test("names the categories the site actually used, in order", () => {
  assertEquals(displayNames(posts), ["Engineering", "Research"], "both");
  // A category no post currently uses drops out rather than leaving a gap.
  const researchOnly = posts.filter((p) => p.categories.includes("Research"));
  assertEquals(displayNames(researchOnly), ["Research"], "only the one in use");
  assertEquals(displayNames([]), [], "none at all");
});

test("decodes the entities both sources escape", () => {
  // The page escapes &amp; and &#39;; the feed escapes &apos;. Either would
  // ship double-encoded if it reached the feed library as written.
  const card = `<article class="js-post" data-categories="engineering">
    <a href="/news/entities/"></a>
    <span data-category-slug="engineering"><p>Engineering</p></span>
    <h2 class="js-post-title">Tom &amp; Jerry&#39;s &lt;tag&gt;</h2>
    <p class="text-body-small text-text-tertiary">March 8, 2026</p>
    <p class="text-body-small text-text-tertiary line-clamp-1">By R&amp;D </p>
  </article>`;
  const [p] = extractPosts(
    card,
    `<item><link>https://mistral.ai/news/entities/</link>
     <description>it&apos;s fine</description></item>`,
  );
  assertEquals(p.title, "Tom & Jerry's <tag>", "title");
  assertEquals(p.author, "R&D", "byline, entity-decoded and trimmed");
  assertEquals(p.description, "it's fine", "description");
});

test("falls back to the card's date for a post the firehose dropped", () => {
  const card = `<article class="js-post" data-categories="engineering">
    <a href="/news/orphan/"></a>
    <span data-category-slug="engineering"><p>Engineering</p></span>
    <h2 class="js-post-title">Orphan</h2>
    <p class="text-body-small text-text-tertiary">March 8, 2026</p>
  </article>`;
  const [dated] = extractPosts(card, "<rss></rss>");
  assertEquals(dated.ts, Date.UTC(2026, 2, 8), "UTC day precision, not null");
  assertEquals(dated.description, "", "and no description to borrow");

  // Anything that is not a date the card prints stays null: no <pubDate> at all
  // beats a wrong one.
  const [undated] = extractPosts(
    card.replace("March 8, 2026", "Coming soon"),
    "<rss></rss>",
  );
  assertEquals(undated.ts, null, "unparseable date");
});

test("posts arrive newest first", () => {
  const dates = posts.map((p) => p.ts!);
  assertEquals(
    dates,
    [...dates].sort((a, b) => b - a),
    "descending by date",
  );
});

test("survives markup that is not what we asked for", () => {
  assertEquals(extractPosts("", "").length, 0, "nothing at all");
  assertEquals(
    extractPosts("<article class='js-post'>no anchor</article>", "").length,
    0,
    "a card with no post link",
  );
  assertEquals(
    extractPosts(
      `<article class="js-post"><a href="/news/x/"></a>
       <span data-category-slug="engineering"><p>Engineering</p></span></article>`,
      "",
    ).length,
    0,
    "a card with no title",
  );
  assertEquals(
    extractPosts(
      `<article class="js-post"><a href="/news/x/"></a>
       <h2 class="js-post-title">Untagged</h2></article>`,
      "",
    ).length,
    0,
    "a card carrying no category chip",
  );
});

const feed = (query = "") =>
  buildFeed(posts, new URL(`https://feed.val.run/mistral${query}`)).text();

test("serves the feed", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 8, "all posts");
  assert(
    // Channel-level text is entity-escaped; only item text goes in CDATA.
    body.includes("<title>Mistral News — Engineering &amp; Research</title>"),
    "channel title names both categories",
  );
  assert(
    body.includes("“Engineering” or “Research”"),
    "channel description names both",
  );
  assert(
    body.includes(
      "<link>https://mistral.ai/news/?categories=engineering,research</link>",
    ),
    "channel link keeps Mistral's own param",
  );
  assert(
    body.includes(
      '<guid isPermaLink="true">https://mistral.ai/news/debugging-memory-leak-in-vllm/</guid>',
    ),
    "item guid is the slash-terminated post URL",
  );
  assert(body.includes("<category>Engineering</category>"), "category");
  assert(body.includes("<author>Mistral AI</author>"), "byline");
});

test("sends a cache-control window rather than leaning on the isolate", async () => {
  const res = buildFeed(posts, new URL("https://feed.val.run/mistral"));
  assertEquals(
    res.headers.get("cache-control"),
    "public, max-age=43200",
    "12 hours",
  );
  assertEquals(
    res.headers.get("content-type"),
    "application/rss+xml; charset=utf-8",
    "content type",
  );
  await res.text();
});

test("orders items newest first in the feed too", async () => {
  const dates = [...(await feed()).matchAll(/<pubDate>([^<]+)</g)].map((m) =>
    Date.parse(m[1]),
  );
  assertEquals(dates.length, 8, "every item is dated");
  assertEquals(
    dates,
    [...dates].sort((a, b) => b - a),
    "descending by date",
  );
});

test("self-link is canonical, ignoring junk query params", async () => {
  const body = await feed("?categories=product&limit=5&utm_source=x");
  assert(
    body.includes('href="https://feed.val.run/mistral" rel="self"'),
    "bare self-link",
  );
  assertEquals((body.match(/<item>/g) ?? []).length, 8, "params ignored");
});

const SITE_LINK = "https://mistral.ai/news/?categories=engineering,research";
const FEED_URL = "https://feed.val.run/mistral";
const SAMPLE_ITEM: Post = {
  slug: "s",
  title: "Tom & Jerry <live>",
  description: 'He said "hi"',
  ts: Date.parse("2026-07-27T00:00:00Z"),
  author: "Mistral AI",
  image: "https://mistral.ai/_astro/x.webp",
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

test("omits optional elements when the post lacks them", () => {
  const bare: Post = {
    slug: "bare",
    title: "Bare",
    description: "",
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
});
