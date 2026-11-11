/**
 * Offline tests for the Pigeons & Planes feed. The fixture is a real capture of
 * the one query the val makes. Refresh with:
 *
 *   curl -s -H 'accept: application/json' --get \
 *     https://www.pigeonsandplanes.com/api/sanity \
 *     --data-urlencode 'query=*[_type == "post" && hidePost != true]
 *       | order(publishedAt desc) [0...20] {
 *         "title": coalesce(headlineRich[0].children[0].text, headline),
 *         "slug": alias.current,
 *         description,
 *         publishedAt,
 *         "image": thumbnail.asset->url,
 *         "imageType": thumbnail.asset->mimeType,
 *         "authors": authors[]->name
 *       }' \
 *     > test/pigeons-sanity-posts.json
 *
 * Run: node --test test/pigeons-and-planes-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  extractPosts,
  type Post,
  renderRss,
} from "../pigeons-and-planes-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";
import { channelLink } from "../../common/linkcheck.ts";

const payload = JSON.parse(
  await readFile(
    new URL("./pigeons-sanity-posts.json", import.meta.url), "utf8",
  ),
);
const posts = extractPosts(payload);
const bySlug = (slug: string) => posts.find((p) => p.slug === slug);

test("reads the whole page from one query", () => {
  assertEquals(posts.length, 20, "post count");
  assertEquals(
    posts.length,
    payload.length,
    "every returned row became a post",
  );
  assert(posts.every((p) => p.slug && p.title), "every post has a slug/title");
  assertEquals(
    new Set(posts.map((p) => p.slug)).size,
    posts.length,
    "slugs are unique",
  );
});

test("every post arrives with the fields the feed renders", () => {
  for (const field of ["description", "image", "imageType"] as const) {
    assertEquals(
      posts.filter((p) => !p[field]).length,
      0,
      `every post has ${field}`,
    );
  }
  assertEquals(
    posts.filter((p) => !p.authors.length).length,
    0,
    "every post has at least one byline",
  );
  assert(
    posts.every((p) =>
      p.image.startsWith("https://cdn.sanity.io/images/pu3h3rl5/production/")
    ),
    "images resolve to the site's own Sanity asset host",
  );
});

test("reads a known post's fields", () => {
  const p = bySlug("rostam-taste-in-music")!;
  assertEquals(
    p.title,
    "Rostam’s Taste in Music",
    "title keeps its typography",
  );
  assertEquals(p.ts, Date.parse("2026-09-08T17:03:25.202Z"), "ts");
  assertEquals(p.authors, ["Will Schube"], "byline");
  assert(p.description.startsWith("This spring"), "description");
});

test("authors are names, not undefined", () => {
  // `authors[]->name` projects to bare strings. The version of this val that
  // read `.name` off each string put no <author> in the feed at all, for every
  // item — this is the regression that test exists for.
  assert(
    posts.every((p) => p.authors.every((a) => typeof a === "string" && a)),
    "every byline is a non-empty string",
  );
  const many = posts.find((p) => p.authors.length > 1)!;
  assert(many.authors.length >= 2, "found a multi-author post to check");
  assert(
    !many.authors.includes("undefined" as unknown as string),
    "no stringified undefined",
  );
});

test("a post with no publishedAt is kept but left undated", () => {
  // At least one live post carries publishedAt: null, and Sanity's
  // `order(publishedAt desc)` sorts it to the *front*. `new Date(null)` is the
  // epoch, so the old val dated it 1 Jan 1970 and pulled the channel's own
  // `updated` back to 1970 with it.
  const undated = posts.filter((p) => p.ts === null);
  assertEquals(undated.length, 1, "the fixture has exactly one undated post");
  assertEquals(
    undated[0].slug,
    "best-underground-rap-hip-hop-2000s",
    "and it is the one upstream sorts first",
  );

  const [post] = extractPosts([{ slug: "s", title: "T", publishedAt: null }]);
  assertEquals(post.ts, null, "null publishedAt is not the epoch");
});

test("degrades on a row missing its optional fields", () => {
  const [post] = extractPosts([{ slug: "bare", title: "Bare" }]);
  assertEquals(post, {
    title: "Bare",
    slug: "bare",
    description: "",
    ts: null,
    image: "",
    imageType: "",
    authors: [],
  }, "bare post");
});

test("survives a payload that is not what we asked for", () => {
  assertEquals(extractPosts(null).length, 0, "no payload");
  assertEquals(extractPosts({}).length, 0, "not an array");
  assertEquals(extractPosts({ result: null }).length, 0, "null result");
  assertEquals(
    extractPosts([{ title: "no slug" }, { slug: "no-title" }]).length,
    0,
    "rows without both a slug and a title are dropped",
  );
  // An unguarded read of a rich headline or a thumbnail used to throw here and
  // take the whole feed down rather than the one row.
  assertEquals(
    extractPosts([{ slug: "s", title: "T", authors: null, image: null }])
      .length,
    1,
    "null sub-objects do not throw",
  );
});

test("accepts a raw Sanity response as well as the proxy's array", () => {
  const rows = [{ slug: "s", title: "T" }];
  assertEquals(
    extractPosts(rows).length,
    1,
    "bare array (what the proxy gives)",
  );
  assertEquals(extractPosts({ result: rows }).length, 1, "wrapped in result");
});

const feed = (query = "") =>
  buildFeed(posts, new URL(`https://feed.val.run/pnp${query}`)).text();

test("serves the feed", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 20, "all posts");
  assert(body.includes("<title>Pigeons &amp; Planes</title>"), "channel title");
  // The library normalises the channel link through `new URL()`, which adds
  // the trailing slash the bare origin does not carry.
  assertEquals(
    channelLink(body),
    "https://www.pigeonsandplanes.com/",
    "channel link",
  );
  assert(
    body.includes(
      "<link>https://www.pigeonsandplanes.com/read/rostam-taste-in-music</link>",
    ),
    "item link is /read/<slug>",
  );
  assert(
    body.includes(
      '<guid isPermaLink="true">https://www.pigeonsandplanes.com/read/rostam-taste-in-music</guid>',
    ),
    "guid is the post URL, not the Sanity UUID that atom1() rejects",
  );
});

test("names every image's media type", async () => {
  const body = await feed();
  assertEquals(
    (body.match(/<enclosure/g) ?? []).length,
    20,
    "every item carries its image",
  );
  // Sanity states the mime type, so the feed never has to guess from the
  // extension — and these four all appear in the live payload.
  for (const type of ["image/webp", "image/jpeg", "image/png", "image/gif"]) {
    assert(body.includes(`type="${type}"`), `enclosure states ${type}`);
  }
  assert(!body.includes('type="image/jpg"'), "no bogus media type");
});

test("serves one content type, with the collection's cache window", () => {
  const res = buildFeed(posts, new URL("https://feed.val.run/pnp"));
  assertEquals(
    res.headers.get("content-type"),
    "application/rss+xml; charset=utf-8",
    "content type",
  );
  assertEquals(
    res.headers.get("cache-control"),
    `public, max-age=${12 * 60 * 60}`,
    "12h, as every other bridge in the collection",
  );
});

test("names every byline in the feed", async () => {
  const body = await feed();
  assert(body.includes("<author>"), "the feed has bylines at all");
  assert(body.includes("Will Schube"), "a known byline");
  assert(!body.includes("undefined"), "no undefined leaked into the feed");
});

test("the undated post carries no 1970", async () => {
  const body = await feed();
  assert(!body.includes("1970"), "no epoch dates anywhere in the feed");
  assertEquals(
    (body.match(/<pubDate>/g) ?? []).length,
    19,
    "19 of 20 items dated; the undated one simply has no pubDate",
  );
});

test("undated posts sort last, not first", async () => {
  const body = await feed();
  const firstItem = body.slice(body.indexOf("<item>"));
  assert(
    !firstItem.slice(0, firstItem.indexOf("</item>")).includes(
      "best-underground-rap-hip-hop-2000s",
    ),
    "the undated post is no longer the lead item",
  );
});

test("channel updated is the newest real post, not the epoch", async () => {
  const body = await feed();
  const updated = /<lastBuildDate>([^<]+)<\/lastBuildDate>/.exec(body)?.[1] ??
    "";
  // RFC-822 carries no sub-second precision, so compare at the second.
  assertEquals(
    Math.floor(new Date(updated).getTime() / 1000),
    Math.floor(Date.parse("2026-09-08T17:03:25.202Z") / 1000),
    "lastBuildDate is the newest dated post",
  );
  assert(new Date(updated).getUTCFullYear() === 2026, "not 1970");
});

test("self-link is canonical, ignoring junk query params", async () => {
  const body = await feed("?format=atom&utm_source=x&limit=5");
  assert(
    body.includes('href="https://feed.val.run/pnp" rel="self"'),
    "bare self-link",
  );
  // `?format=` used to switch the serialization. It is an ordinary junk param
  // now, and must not resurrect a second output shape by accident.
  assert(!body.includes("utm_source"), "junk params are not echoed back");
  assert(body.startsWith("<?xml"), "still RSS whatever the params say");
  assertEquals((body.match(/<item>/g) ?? []).length, 20, "params ignored");
});

const SITE_LINK = "https://www.pigeonsandplanes.com";
const FEED_URL = "https://feed.val.run/pnp";
const SAMPLE_ITEM: Post = {
  title: "Tom & Jerry <live>",
  slug: "s",
  description: 'He said "hi"',
  ts: Date.parse("2026-09-08T17:03:25.202Z"),
  image: "https://cdn.sanity.io/images/pu3h3rl5/production/x.webp",
  imageType: "image/webp",
  authors: ["Ada & Grace"],
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
    title: "Bare",
    slug: "bare",
    description: "",
    ts: null,
    image: "",
    imageType: "",
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
