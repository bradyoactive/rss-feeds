/**
 * Offline tests for the Mercury feed. Fixtures are real captures — refresh with:
 *
 *   curl -sL "https://mercury.com/blog/search?topics=Eng+Blog" \
 *     -o mercury-eng-search.html
 *   curl -sL https://mercury.com/blog/announcing-ghciwatch \
 *     -o mercury-post-ghciwatch.html
 *
 * Run: node --test test/mercury-eng-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  extractDetail,
  extractIndex,
  type Post,
  renderRss,
} from "../mercury-eng-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const searchHtml = await readFile(
  new URL("./mercury-eng-search.html", import.meta.url),
  "utf8",
);
const postHtml = await readFile(
  new URL("./mercury-post-ghciwatch.html", import.meta.url),
  "utf8",
);
const stubs = extractIndex(searchHtml, "Eng Blog");

test("extracts every Eng Blog post from the listing", () => {
  // The listing shows all 9; /blog/topics/engineering-blog returns the same
  // set, so there is no pagination to follow.
  assertEquals(stubs.length, 9, "post count");
  assert(
    stubs.every((s) => s.slug && s.title),
    "every stub has a slug and title",
  );
  assert(
    stubs.every((s) => s.topic === "Eng Blog"),
    "every stub is Eng Blog",
  );
  assertEquals(
    new Set(stubs.map((s) => s.slug)).size,
    stubs.length,
    "slugs are unique",
  );
});

test("takes authors from the listing, which covers every post", () => {
  // Half these posts have no JSON-LD Person node, so the listing is the source.
  assert(
    stubs.every((s) => s.author),
    "every stub has an author",
  );
  const ghci = stubs.find((s) => s.slug === "announcing-ghciwatch");
  assertEquals(ghci?.author, "Rebecca Turner", "author");
  assertEquals(ghci?.title, "Announcing ghciwatch 1.0", "title");
  assertEquals(ghci?.categories, [], "cards carry no categories");
});

test("matches a topic by display name, slug, or plus-form", () => {
  for (const spelling of ["Eng Blog", "eng blog", "eng-blog"]) {
    assertEquals(
      extractIndex(searchHtml, spelling).length,
      9,
      `topic “${spelling}”`,
    );
  }
  // The topic's own slug differs from its name's slug; both must resolve.
  assertEquals(
    extractIndex(searchHtml, "engineering-blog").length,
    9,
    "topic slug",
  );
  assertEquals(
    extractIndex(searchHtml, "Personal Finance").length,
    0,
    "other topic",
  );
});

test("reads date, description and image from a post page", () => {
  const detail = extractDetail(postHtml);
  assertEquals(detail.ts, Date.parse("2024-07-15T06:00:00+01:00"), "ts");
  assert(
    detail.description.startsWith("Introducing ghciwatch:"),
    "description",
  );
  assert(
    detail.image.startsWith("https://www.datocms-assets.com/"),
    "image host",
  );
  // og:image is entity-encoded in the HTML attribute and must be decoded.
  assert(!detail.image.includes("&amp;"), "image URL is entity-decoded");
  assert(detail.image.includes("&fit=crop"), "query params survive decoding");
});

test("survives a post page with no usable metadata", () => {
  const detail = extractDetail(
    "<html><head></head><body>nothing here</body></html>",
  );
  assertEquals(
    detail,
    { ts: null, description: "", image: "" },
    "empty detail",
  );
});

test("reads a card's topic, title and authors only from that card", () => {
  const card = (slug: string, topic: string, author: string) =>
    `<a href="/blog/topics/${topic}"><span>${topic}</span></a>` +
    `<a data-analytics-event-name="blog-article" href="/blog/${slug}"><span><h2>${slug} &amp; co</h2></span></a>` +
    `<a data-analytics-event-name="blog-author" href="/blog/authors/x"><span>${author}</span></a>` +
    `<a data-analytics-event-name="blog-article" aria-hidden="true" href="/blog/${slug}"></a>`;
  const html =
    card("a", "engineering-blog", "Ann") +
    card("b", "personal-finance", "Bob") +
    card("c", "engineering-blog", "Cy");
  assertEquals(
    extractIndex(html, "engineering-blog"),
    [
      {
        slug: "a",
        title: "a & co",
        author: "Ann",
        topic: "engineering-blog",
        categories: [],
      },
      {
        slug: "c",
        title: "c & co",
        author: "Cy",
        topic: "engineering-blog",
        categories: [],
      },
    ],
    "stubs",
  );
});

const posts: Post[] = stubs.map((s, i) => ({
  ...s,
  description: `desc ${i}`,
  // Descending dates, deliberately out of order to prove the feed sorts.
  ts: Date.parse("2024-01-01") + (i % 2 === 0 ? i : -i) * 86400000,
  image: "https://www.datocms-assets.com/x/cover.jpg?auto=format&w=1200",
}));

const feed = async (query = "") => {
  const res = buildFeed(posts, new URL(`https://feed.val.run/mercury${query}`));
  return { status: res.status, body: await res.text() };
};

const itemCount = (xml: string) => (xml.match(/<item>/g) ?? []).length;

test("serves the feed", async () => {
  const { status, body } = await feed("");
  assertEquals(status, 200, "status");
  assertEquals(itemCount(body), 9, "all posts");
  assert(
    body.includes("<title>Mercury Blog — Eng Blog</title>"),
    "channel title",
  );
  assert(
    body.includes(
      "<link>https://mercury.com/blog/search?topics=Eng+Blog</link>",
    ),
    "channel link keeps Mercury's plus-form",
  );
  assert(
    body.includes(
      '<guid isPermaLink="true">https://mercury.com/blog/announcing-ghciwatch</guid>',
    ),
    "item guid",
  );
  assert(body.includes("<category>Eng Blog</category>"), "topic as a category");
});

test("orders items newest first", async () => {
  const dates = [...(await feed("")).body.matchAll(/<pubDate>([^<]+)</g)].map(
    (m) => Date.parse(m[1]),
  );
  assertEquals(
    dates,
    [...dates].sort((a, b) => b - a),
    "descending by date",
  );
});

test("self-link is canonical, ignoring junk query params", async () => {
  // ?topic= and ?limit= are gone; passing them should change nothing.
  const { body } = await feed("?topic=personal-finance&limit=5&utm_source=x");
  assert(
    body.includes('href="https://feed.val.run/mercury" rel="self"'),
    "bare self-link",
  );
  assertEquals(itemCount(body), 9, "params ignored");
});

const SITE_LINK = "https://mercury.com/blog/search?topics=Eng+Blog";
const FEED_URL = "https://feed.val.run/mercury";
const SAMPLE_ITEM: Post = {
  slug: "s",
  title: "Tom & Jerry <live>",
  description: 'He said "hi"',
  ts: Date.parse("2026-07-27T00:00:00Z"),
  author: "Ada & Grace",
  image: "https://x.com/y.jpg",
  topic: "Eng Blog",
  categories: ["Inside Mercury"],
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

  // The library wraps text in CDATA rather than escaping entities, so the
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
  // "]]>" inside a title would end the CDATA early and corrupt the document;
  // the library splits it, and this pins that it still does.
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
  const xml = renderRss({
    title: "T",
    description: "D",
    siteLink: "https://mercury.com/blog/",
    feedUrl: "https://mercury.com/blog/",
    items: [
      {
        slug: "bare",
        title: "Bare",
        description: "",
        ts: null,
        author: "",
        image: "",
        topic: "",
        categories: [],
      },
    ],
  });

  for (const tag of ["pubDate", "category", "dc:creator", "media:content"]) {
    assert(!xml.includes(`<${tag}`), `omits <${tag}> when empty`);
  }
  assertEquals(
    xml.match(/<description>/g)?.length,
    1,
    "only the channel description",
  );
});
