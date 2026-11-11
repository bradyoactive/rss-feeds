/**
 * Offline tests for the Mercury feed. Fixtures are real captures — refresh with:
 *
 *   curl -sL "https://mercury.com/blog/search?topics=Eng+Blog" \
 *     -o mercury-eng-search.html
 *   curl -sL https://mercury.com/blog/announcing-ghciwatch \
 *     -o mercury-post-ghciwatch.html
 *
 * Run: deno test --allow-read test/mercury-eng-rss.test.ts
 */

import {
  buildFeed,
  extractDetail,
  extractIndex,
  type Post,
  renderRss,
} from "../mercury-eng-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const searchHtml = await Deno.readTextFile(
  new URL("./mercury-eng-search.html", import.meta.url),
);
const postHtml = await Deno.readTextFile(
  new URL("./mercury-post-ghciwatch.html", import.meta.url),
);
const stubs = extractIndex(searchHtml, "Eng Blog");

Deno.test("extracts every Eng Blog post from the listing", () => {
  // The listing shows all 8; ?page=2 and /blog/topics/engineering-blog return
  // the same set, so there is no pagination to follow.
  assertEquals(stubs.length, 8, "post count");
  assert(
    stubs.every((s) => s.slug && s.title),
    "every stub has a slug and title",
  );
  assert(stubs.every((s) => s.topic === "Eng Blog"), "every stub is Eng Blog");
  assertEquals(
    new Set(stubs.map((s) => s.slug)).size,
    stubs.length,
    "slugs are unique",
  );
});

Deno.test("takes authors from the listing, which covers every post", () => {
  // Half these posts have no JSON-LD Person node, so the listing is the source.
  assert(stubs.every((s) => s.author), "every stub has an author");
  const ghci = stubs.find((s) => s.slug === "announcing-ghciwatch");
  assertEquals(ghci?.author, "Rebecca Turner", "author");
  assertEquals(ghci?.categories, ["Inside Mercury"], "categories");
});

Deno.test("matches a topic by display name, slug, or plus-form", () => {
  for (const spelling of ["Eng Blog", "eng blog", "eng-blog"]) {
    assertEquals(
      extractIndex(searchHtml, spelling).length,
      8,
      `topic “${spelling}”`,
    );
  }
  // The topic's own slug differs from its name's slug; both must resolve.
  assertEquals(
    extractIndex(searchHtml, "engineering-blog").length,
    8,
    "topic slug",
  );
  assertEquals(
    extractIndex(searchHtml, "Personal Finance").length,
    0,
    "other topic",
  );
});

Deno.test("reads date, description and image from a post page", () => {
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

Deno.test("survives a post page with no usable metadata", () => {
  const detail = extractDetail(
    "<html><head></head><body>nothing here</body></html>",
  );
  assertEquals(
    detail,
    { ts: null, description: "", image: "" },
    "empty detail",
  );
});

Deno.test("survives records split across flight chunk boundaries", () => {
  const marker = '{\\"topic\\":{';
  const first = searchHtml.indexOf(marker);
  assert(first > -1, "fixture still uses escaped flight chunks");
  const cut = first + marker.length + 8;
  const split = searchHtml.slice(0, cut) + '");self.__next_f.push([1,"' +
    searchHtml.slice(cut);
  assertEquals(
    extractIndex(split, "Eng Blog").length,
    stubs.length,
    "same post count",
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

Deno.test("serves the feed", async () => {
  const { status, body } = await feed("");
  assertEquals(status, 200, "status");
  assertEquals(itemCount(body), 8, "all posts");
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
  assert(
    body.includes("<category>Inside Mercury</category>"),
    "Mercury's own category too",
  );
});

Deno.test("orders items newest first", async () => {
  const dates = [...(await feed("")).body.matchAll(/<pubDate>([^<]+)</g)].map((
    m,
  ) => Date.parse(m[1]));
  assertEquals(dates, [...dates].sort((a, b) => b - a), "descending by date");
});

Deno.test("self-link is canonical, ignoring junk query params", async () => {
  // ?topic= and ?limit= are gone; passing them should change nothing.
  const { body } = await feed("?topic=personal-finance&limit=5&utm_source=x");
  assert(
    body.includes('href="https://feed.val.run/mercury" rel="self"'),
    "bare self-link",
  );
  assertEquals(itemCount(body), 8, "params ignored");
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

Deno.test("renders XML-safe output", () => {
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
  assert(
    xml.includes("<pubDate>"),
    "RFC-822 pubDate",
  );
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
Deno.test("omits optional elements when the post lacks them", () => {
  const xml = renderRss({
    title: "T",
    description: "D",
    siteLink: "https://mercury.com/blog/",
    feedUrl: "https://mercury.com/blog/",
    items: [{
      slug: "bare",
      title: "Bare",
      description: "",
      ts: null,
      author: "",
      image: "",
      topic: "",
      categories: [],
    }],
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
