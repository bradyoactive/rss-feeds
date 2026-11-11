/**
 * Offline tests for the Snowflake feed. The fixture is a real capture of the
 * one request the val makes. Refresh with:
 *
 *   curl -s -H 'Accept: application/json' \
 *     'https://publish-p57963-e462109.adobeaemcloud.com/conf/snowflake-site/settings/wcm/templates/blog-category-page/structure/_jcr_content/root/responsivegrid/container/flexible_column_cont/flexible_column_content_container_1/blog_category_filter.filter.json?pagePath=/content/snowflake-site/global/en/blog/engineering/core-platform&offset=0&pageSize=9&orderBy=customPublicationDate&sortOrder=desc' \
 *     > test/snowflake-aem-core-platform.json
 *
 * Run: node --test test/snowflake-engineering-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  extractPosts,
  parseDate,
  type Post,
  renderRss,
} from "../snowflake-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const payload = JSON.parse(
  await readFile(
    new URL("./snowflake-aem-core-platform.json", import.meta.url),
    "utf8",
  ),
);
const posts = extractPosts(payload);
const byPath = (path: string) => posts.find((p) => p.path === path);

test("reads the whole page from one request", () => {
  assertEquals(posts.length, 9, "post count");
  assertEquals(
    posts.length,
    payload.hits.length,
    "every returned card became a post",
  );
  assert(
    posts.every((p) => p.title && p.path),
    "every post has a title/path",
  );
  assertEquals(
    new Set(posts.map((p) => p.path)).size,
    posts.length,
    "paths are unique",
  );
});

test("asks for one page of a larger category", () => {
  // The endpoint reports the full size behind the filter; the val deliberately
  // takes only the first page. If this ever equals `posts.length` the feed has
  // quietly become the whole archive.
  assert(
    payload.totalMatches > posts.length,
    `totalMatches (${payload.totalMatches}) exceeds one page`,
  );
});

test("every post arrives complete", () => {
  assertEquals(
    posts.filter((p) => p.ts === null).length,
    0,
    "every post dated",
  );
  assertEquals(
    posts.filter((p) => !p.authors.length).length,
    0,
    "every post has at least one byline",
  );
  assert(
    posts.every((p) => p.path.startsWith("/en/blog/")),
    "every path is site-relative under /en/blog/",
  );
});

test("reads a known post's fields", () => {
  const p = byPath(
    "/en/blog/engineering/the-opentelemetry-collector-is-your-open-source-data-pipeline/",
  )!;
  assertEquals(
    p.title,
    "The OpenTelemetry Collector is your open source data pipeline",
    "title",
  );
  assertEquals(p.ts, Date.UTC(2026, 8, 8), "SEP 08, 2026 read as UTC");
  assertEquals(p.authors, ["Sean Kunkler"], "byline");
  assertEquals(p.categories, ["Core Platform"], "tag");
});

test("keeps every name on a multi-author post", () => {
  const p = byPath("/en/blog/engineering/ai-agent-memory-experience-cards/")!;
  assertEquals(p.authors.length, 5, "five authors");
  assertEquals(p.authors[0], "Harshn Pathak", "first author");
  assertEquals(p.authors[4], "Yuxiong He", "last author");
});

test("takes the title from title.lines, not just the button", () => {
  const [post] = extractPosts({
    hits: [
      {
        title: { lines: ["Two", "lines"] },
        button: { text: "Button text", buttonLink: { url: "/en/blog/x/" } },
      },
    ],
  });
  assertEquals(post.title, "Two lines", "lines joined, button ignored");

  const [fallback] = extractPosts({
    hits: [{ button: { text: "Only the button", buttonLink: { url: "/y/" } } }],
  });
  assertEquals(fallback.title, "Only the button", "falls back to button text");
});

test("posts arrive newest first", () => {
  const dates = posts.map((p) => p.ts!);
  assertEquals(
    dates,
    [...dates].sort((a, b) => b - a),
    "descending by date",
  );
});

test("degrades on a card missing its optional fields", () => {
  const [post] = extractPosts({
    hits: [{ button: { text: "Bare", buttonLink: { url: "/en/blog/bare/" } } }],
  });
  assertEquals(
    post,
    {
      title: "Bare",
      path: "/en/blog/bare/",
      ts: null,
      authors: [],
      categories: [],
    },
    "bare post",
  );
});

test("survives a payload that is not what we asked for", () => {
  assertEquals(extractPosts({}).length, 0, "no hits key");
  assertEquals(extractPosts({ hits: null }).length, 0, "null hits");
  assertEquals(extractPosts(null).length, 0, "no payload at all");
  assertEquals(
    extractPosts({
      hits: [
        { button: { buttonLink: { url: "/no-title/" } } },
        { title: { lines: ["no link"] } },
      ],
    }).length,
    0,
    "cards without both a title and a link are dropped",
  );
});

test("drops a duplicate card rather than repeating the post", () => {
  const card = {
    title: { lines: ["Same"] },
    button: { buttonLink: { url: "/en/blog/same/" } },
  };
  assertEquals(extractPosts({ hits: [card, card] }).length, 1, "deduped");
});

test("reads the display date as UTC, not as local midnight", () => {
  // The whole point of parseDate: `new Date("SEP 08, 2026")` is local midnight,
  // so west of Greenwich it lands on the 7th in UTC and the feed dates every
  // post a day early. This must hold whatever TZ the test host is in.
  assertEquals(parseDate("SEP 08, 2026"), Date.UTC(2026, 8, 8), "SEP");
  assertEquals(parseDate("JAN 01, 2026"), Date.UTC(2026, 0, 1), "JAN");
  assertEquals(parseDate("DEC 31, 2026"), Date.UTC(2026, 11, 31), "DEC");
  assertEquals(parseDate("aug 14, 2026"), Date.UTC(2026, 7, 14), "lowercase");
  assertEquals(parseDate("  SEP 8, 2026  "), Date.UTC(2026, 8, 8), "loose");
  assertEquals(
    new Date(parseDate("SEP 08, 2026")!).toISOString(),
    "2026-09-08T00:00:00.000Z",
    "midnight UTC exactly",
  );
});

test("refuses a date it cannot read rather than guessing", () => {
  for (const bad of [
    "",
    "2026-09-08",
    "SEPT 08, 2026",
    "XXX 08, 2026",
    "FEB 31, 2026",
    "SEP 08",
    "not a date",
  ]) {
    assertEquals(parseDate(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
});

const feed = (query = "") =>
  buildFeed(posts, new URL(`https://feed.val.run/snowflake${query}`)).text();

test("serves the feed", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 9, "all posts");
  assert(
    body.includes("<title>Snowflake Engineering Blog — Core Platform</title>"),
    "channel title",
  );
  assert(
    body.includes(
      "<link>https://www.snowflake.com/en/blog/engineering/core-platform/</link>",
    ),
    "channel link",
  );
  assert(
    body.includes(
      '<guid isPermaLink="true">https://www.snowflake.com/en/blog/engineering/the-opentelemetry-collector-is-your-open-source-data-pipeline/</guid>',
    ),
    "item guid is the absolute post URL",
  );
  assert(body.includes("<category>Core Platform</category>"), "category");
});

test("gives every item an absolute link", async () => {
  const body = await feed();
  const links = [...body.matchAll(/<link>([^<]+)<\/link>/g)].map((m) => m[1]);
  assert(links.length > 1, "found item links");
  assert(
    links.every((l) => l.startsWith("https://")),
    "no site-relative link survived into the feed",
  );
});

test("names every byline the API gave", async () => {
  const body = await feed();
  // The five-author post is the one that would expose a byline that only ever
  // renders its first name.
  for (const name of ["Harshn Pathak", "Danmei Xu", "Yuxiong He"]) {
    assert(body.includes(name), `byline ${name}`);
  }
  assert(!body.includes("undefined"), "no undefined leaked into the feed");
});

test("self-link is canonical, ignoring junk query params", async () => {
  const body = await feed("?category=product&limit=5&utm_source=x");
  assert(
    body.includes('href="https://feed.val.run/snowflake" rel="self"'),
    "bare self-link",
  );
  assertEquals((body.match(/<item>/g) ?? []).length, 9, "params ignored");
});

const SITE_LINK =
  "https://www.snowflake.com/en/blog/engineering/core-platform/";
const FEED_URL = "https://feed.val.run/snowflake";
const SAMPLE_ITEM: Post = {
  title: "Tom & Jerry <live>",
  path: "/en/blog/engineering/sample/",
  ts: Date.UTC(2026, 8, 8),
  authors: ["Ada & Grace"],
  categories: ["Core Platform"],
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

test("omits optional elements when the card lacks them", () => {
  const bare: Post = {
    title: "Bare",
    path: "/en/blog/engineering/bare/",
    ts: null,
    authors: [],
    categories: [],
  };
  const xml = renderRss({
    title: "T",
    description: "D",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [bare],
  });

  for (const tag of ["pubDate", "author", "category"]) {
    assert(!xml.includes(`<${tag}`), `omits <${tag}> when empty`);
  }
  assertEquals(
    xml.match(/<description>/g)?.length,
    1,
    "only the channel description",
  );
});
