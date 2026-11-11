/**
 * Offline tests for the Rippling feed. The fixture is a real capture of the one
 * call the val makes. Refresh with:
 *
 *   curl -s "https://6fnax3tbef-dsn.algolia.net/1/indexes/blog_en-US_production/query" \
 *     -H "x-algolia-application-id: 6FNAX3TBEF" \
 *     -H "x-algolia-api-key: 416caa4690f002ff6fe4a2097623640b" \
 *     -H "content-type: application/json" \
 *     -d '{"query":"","hitsPerPage":100,"filters":"hubs.name:\"Engineering\""}' \
 *     > test/rippling-algolia-engineering.json
 *
 * Run: deno test --allow-read test/rippling-engineering-rss.test.ts
 */

import {
  buildFeed,
  extractPosts,
  type Post,
  renderRss,
} from "../rippling-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const payload = JSON.parse(
  await Deno.readTextFile(
    new URL("./rippling-algolia-engineering.json", import.meta.url),
  ),
);
const posts = extractPosts(payload);
const bySlug = (slug: string) => posts.find((p) => p.slug === slug);

Deno.test("extracts every Engineering hit from the response", () => {
  assertEquals(posts.length, 43, "post count");
  assertEquals(posts.length, payload.nbHits, "one page covers the hub whole");
  assert(posts.every((p) => p.slug && p.title), "every post has a slug/title");
  assert(
    posts.every((p) => p.hubs.includes("Engineering")),
    "every post is in Engineering",
  );
  assertEquals(
    new Set(posts.map((p) => p.slug)).size,
    posts.length,
    "slugs are unique",
  );
});

Deno.test("keeps out a hit that is not in the hub", () => {
  // The query is server-filtered, so this can only happen if that filter
  // loosens — which is exactly when a silent extra post would appear.
  const stray = { ...payload.hits[0], slug: "stray", hubs: [{ name: "HR" }] };
  const extracted = extractPosts({ hits: [stray] });
  assertEquals(extracted.length, 0, "HR-only post dropped");
});

Deno.test("parses both publishedDate shapes as UTC", () => {
  // The index holds date-only "2026-03-25" and naive "2025-04-30T11:23:33".
  // Date.parse reads the first as UTC and the second as *local* time, which
  // would shift a post by hours depending on where the val runs.
  const dateOnly = payload.hits.find((h: { publishedDate: string }) =>
    !h.publishedDate.includes("T")
  );
  const naive = payload.hits.find((h: { publishedDate: string }) =>
    h.publishedDate.includes("T")
  );
  assert(dateOnly && naive, "both shapes still present in the fixture");

  assertEquals(
    bySlug(dateOnly.slug)?.ts,
    Date.parse(`${dateOnly.publishedDate}T00:00:00Z`),
    "date-only is midnight UTC",
  );
  assertEquals(
    bySlug(naive.slug)?.ts,
    Date.parse(`${naive.publishedDate}Z`),
    "naive datetime is UTC, not local",
  );

  const withTime = posts.filter((p) => p.ts! % 86_400_000 !== 0).length;
  assertEquals(withTime, 37, "datetime-shaped dates");
  assertEquals(posts.length - withTime, 6, "date-only dates");
});

Deno.test("absolutizes the image and takes its type from Contentful", () => {
  assert(
    posts.every((p) => p.image.startsWith("https://images.ctfassets.net/")),
    "protocol-relative URLs made absolute",
  );
  assert(
    posts.every((p) => p.imageType.startsWith("image/")),
    "every type stated rather than guessed from the extension",
  );
});

Deno.test("joins a multi-author byline", () => {
  const many = posts.find((p) => p.author.includes(" & "))!;
  assert(many, "the fixture still has a multi-author post");
  assert(
    !many.author.includes("undefined"),
    "every name resolved, none left blank",
  );
  assert(
    posts.every((p) => p.author),
    "every post has a byline",
  );
});

Deno.test("degrades on a hit missing image, excerpt, authors and date", () => {
  const hit = { ...payload.hits[0] };
  delete hit.featuredImage;
  delete hit.excerpt;
  delete hit.authors;
  delete hit.publishedDate;

  const [post] = extractPosts({ hits: [hit] });
  assertEquals(
    post,
    {
      slug: hit.slug,
      title: hit.title,
      description: "",
      ts: null,
      author: "",
      image: "",
      imageType: "",
      hubs: ["Engineering"],
    },
    "bare post",
  );
});

const feed = (query = "") =>
  buildFeed(posts, new URL(`https://feed.val.run/rippling${query}`)).text();

Deno.test("serves the feed", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 43, "all posts");
  assert(
    body.includes("<title>Rippling Blog — Engineering</title>"),
    "channel title",
  );
  assert(
    body.includes("<link>https://www.rippling.com/blog/hub/engineering</link>"),
    "channel link is the hub page",
  );
  assert(body.includes("<category>Engineering</category>"), "hub as category");
  assert(
    body.includes('type="image/png"'),
    "media type carried through from Contentful",
  );
});

Deno.test("orders items newest first", async () => {
  const dates = [...(await feed()).matchAll(/<pubDate>([^<]+)</g)].map((m) =>
    Date.parse(m[1])
  );
  assertEquals(dates.length, 43, "every item is dated");
  assertEquals(dates, [...dates].sort((a, b) => b - a), "descending by date");
});

Deno.test("self-link is canonical, ignoring junk query params", async () => {
  // ?hub= and ?limit= are gone; passing them should change nothing.
  const body = await feed("?hub=hr&limit=5&utm_source=x");
  assert(
    body.includes('href="https://feed.val.run/rippling" rel="self"'),
    "bare self-link",
  );
  assertEquals((body.match(/<item>/g) ?? []).length, 43, "params ignored");
});

const SITE_LINK = "https://www.rippling.com/blog/hub/engineering";
const FEED_URL = "https://feed.val.run/rippling";
const SAMPLE_ITEM: Post = {
  slug: "s",
  title: "Tom & Jerry <live>",
  description: 'He said "hi"',
  ts: Date.parse("2026-03-25T00:00:00Z"),
  author: "Ada & Grace",
  image: "https://images.ctfassets.net/x/y.png",
  imageType: "image/png",
  hubs: ["Engineering"],
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
  const bare: Post = {
    slug: "bare",
    title: "Bare",
    description: "",
    ts: null,
    author: "",
    image: "",
    imageType: "",
    hubs: [],
  };
  const xml = renderRss({
    title: "T",
    description: "D",
    siteLink: "https://www.rippling.com/blog/hub/engineering",
    feedUrl: "https://feed.val.run/rippling",
    items: [bare],
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
