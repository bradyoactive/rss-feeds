/**
 * Offline tests for the Uber Backend feed. The two fixtures are verbatim
 * captures of the two RPC calls the val makes, envelope and all. Refresh:
 *
 *   curl -s -X POST https://www.uber.com/api/listCategories \
 *     -H 'content-type: application/json' -H 'x-csrf-token: uber-rss-bridge' \
 *     -d '{"country":"US","locale":"en"}' -o uber-newsroom-categories.json
 *
 *   curl -s -X POST https://www.uber.com/api/getRelatedPages \
 *     -H 'content-type: application/json' -H 'x-csrf-token: uber-rss-bridge' \
 *     -d '{"categoryIDFilters":["b374768e-489f-42d5-913d-269fbb44a44b"],
 *          "country":"US","locale":"en","paging":{"limit":500,"token":"0"},
 *          "sortKey":"PUBLISHED_AT","sortOrder":"DESC"}' \
 *     -o uber-newsroom-backend.json
 *
 * Run: deno test --allow-read test/uber-backend-rss.test.ts
 */

import {
  buildFeed,
  categoryId,
  categoryNames,
  extractCategories,
  extractPosts,
  type Post,
  renderRss,
} from "../uber-backend-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

/** The RPC wraps every reply as { status, data }; `rpc` unwraps it. */
const read = async (name: string) =>
  JSON.parse(await Deno.readTextFile(new URL(`./${name}`, import.meta.url)));

const rawCategories = await read("uber-newsroom-categories.json");
const rawPosts = await read("uber-newsroom-backend.json");

const categories = extractCategories(rawCategories.data);
const names = categoryNames(categories);
const posts = extractPosts(rawPosts.data, names);
const post = (slug: string) => posts.find((p) => p.url.includes(slug))!;

const FEED_URL = "https://feed.val.run/uber";
const feed = (query = "") =>
  buildFeed(posts, new URL(`${FEED_URL}${query}`)).text();

Deno.test("reads every post the category holds", () => {
  assertEquals(rawPosts.data.totalCount, 120, "posts the API reports");
  assertEquals(posts.length, 120, "posts read");
  assert(posts.every((p) => p.url && p.title), "every post has a URL/title");
  assertEquals(
    new Set(posts.map((p) => p.url)).size,
    posts.length,
    "URLs are unique",
  );
  assert(posts.every((p) => p.ts !== null), "every post is dated");
  assert(posts.every((p) => p.image), "every post has an image");
  assert(posts.every((p) => p.categories.includes("Backend")), "in-category");
});

Deno.test("one request covers the category with room to spare", () => {
  // The val asks for 500. If Backend ever outgrows that, the count read here
  // stops matching what the API says it holds — which is the point of checking
  // both rather than trusting the array's length.
  assert(
    rawPosts.data.totalCount <= 500,
    `the category holds ${rawPosts.data.totalCount}, past the page size`,
  );
  assertEquals(
    rawPosts.data.relatedPages.length,
    rawPosts.data.totalCount,
    "the whole category came back in one page",
  );
});

Deno.test("resolves the category by slug, not by a pinned id", () => {
  assertEquals(categories.length, 70, "categories in the tree");
  assertEquals(
    categoryId(categories, "engineering/backend"),
    "b374768e-489f-42d5-913d-269fbb44a44b",
    "the id the site uses today",
  );
  assertEquals(categoryId(categories, "engineering/no-such"), "", "unknown");
});

Deno.test("looks only in the blog namespace", () => {
  // The same call answers for the newsroom and legal trees as well, and slugs
  // are only unique within one namespace.
  const spaces = new Set(categories.map((c) => c.namespace));
  assertEquals([...spaces].sort(), ["blog", "legal", "newsroom"], "namespaces");
  const shadowed = [
    {
      ID: "x",
      name: "Backend",
      slug: "engineering/backend",
      theNamespace: "newsroom",
    },
    {
      ID: "y",
      name: "Backend",
      slug: "engineering/backend",
      theNamespace: "blog",
    },
  ];
  assertEquals(
    categoryId(extractCategories(shadowed), "engineering/backend"),
    "y",
    "the blog one wins",
  );
});

Deno.test("reads every field of a known post", () => {
  const p = post("query-gpt");
  assertEquals(
    p.title,
    "QueryGPT – Natural Language to SQL Using Generative AI",
    "title",
  );
  assertEquals(p.ts, Date.parse("2024-09-19T06:00:00.000Z"), "ts");
  assertEquals(p.imageType, "image/jpeg", "media type from the extension");
  assertEquals(
    p.categories,
    ["AI / ML", "Backend", "Data", "Engineering"],
    "categories, resolved from ids and sorted the way the cards print them",
  );
  assert(p.image.startsWith("https://tb-static.uber.com/"), "image");
});

Deno.test("prefers `title` over `ogTitle`", () => {
  // The two differ on a dozen posts. The cards render `title`, and it is the
  // better-kept of the pair — ogTitle still says "QueryGPT - … using Generative
  // AI" with a hyphen and lower-case "using".
  const entry = {
    fullURL: "www.uber.com/us/en/blog/x/",
    title: "Kept",
    ogTitle: "Stale",
  };
  assertEquals(
    extractPosts({ relatedPages: [entry] })[0].title,
    "Kept",
  );
});

Deno.test("collapses a double space the rendered page would have folded", () => {
  // Stored as "Upgrading Uber’s MySQL Fleet  to version 8.0".
  assertEquals(
    post("upgrading-ubers-mysql-fleet").title,
    "Upgrading Uber’s MySQL Fleet to version 8.0",
  );
});

Deno.test("turns category ids into names, and drops ones it cannot", () => {
  // A bare UUID in <category> would be worse than no category at all.
  const entry = {
    fullURL: "www.uber.com/us/en/blog/x/",
    title: "T",
    categoryIDs: ["b374768e-489f-42d5-913d-269fbb44a44b", "not-a-real-id"],
  };
  assertEquals(
    extractPosts({ relatedPages: [entry] }, names)[0].categories,
    ["Backend"],
  );
  assertEquals(
    extractPosts({ relatedPages: [entry] })[0].categories,
    [],
    "with no name map at all, nothing is printed",
  );
});

Deno.test("gives every post an absolute link", () => {
  // `fullURL` comes back scheme-less.
  assert(
    rawPosts.data.relatedPages.every((r: { fullURL: string }) =>
      r.fullURL.startsWith("www.uber.com/")
    ),
    "the API stores them without a scheme",
  );
  assert(
    posts.every((p) => p.url.startsWith("https://www.uber.com/us/en/blog/")),
    "and the feed emits them with one",
  );
  assertEquals(
    extractPosts({
      relatedPages: [{ fullURL: "https://www.uber.com/x/", title: "T" }],
    })[0].url,
    "https://www.uber.com/x/",
    "a record that already carries a scheme is left alone",
  );
});

Deno.test("survives input that is not the response we asked for", () => {
  assertEquals(extractPosts(null).length, 0, "null");
  assertEquals(extractPosts({ relatedPages: [] }).length, 0, "empty");
  assertEquals(extractPosts([]).length, 0, "not a response body");
  assertEquals(
    extractPosts({ relatedPages: [{ title: "no url" }] }).length,
    0,
    "records without a URL are dropped",
  );
  assertEquals(extractCategories(null).length, 0, "null categories");
  assertEquals(extractCategories({}).length, 0, "not a list");
  assertEquals(
    extractCategories([{ name: "no id" }, { ID: "x" }]).length,
    0,
    "categories missing an id or a name are dropped",
  );
});

Deno.test("serves the category", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 120, "every post");
  assert(
    body.includes("<title>Uber Engineering — Backend</title>"),
    "channel title",
  );
  assert(
    body.includes(
      "<link>https://www.uber.com/us/en/blog/engineering/backend/</link>",
    ),
    "channel link is the page this mirrors",
  );
  assert(
    body.includes(
      '<guid isPermaLink="true">https://www.uber.com/us/en/blog/query-gpt/</guid>',
    ),
    "item guid is the post URL",
  );
  assert(body.includes("<category>Backend</category>"), "category");
  assertEquals(
    (body.match(/<enclosure/g) ?? []).length,
    120,
    "every item carries its image",
  );
});

Deno.test("names every image's media type", async () => {
  const body = await feed();
  assert(!body.includes('type="image/jpg"'), "no invalid image/jpg");
  assert(posts.every((p) => p.imageType), "the API's URLs all carry one");
  assertEquals(
    [...new Set(posts.map((p) => p.imageType))].sort(),
    ["image/gif", "image/jpeg", "image/png", "image/webp"],
    "the four types in use",
  );
});

Deno.test("carries no description and no byline", async () => {
  // Neither exists anywhere in the newsroom API, and the site's own cards print
  // neither. Inventing one would be worse than leaving it out.
  const body = await feed();
  assert(!body.includes("<author>"), "no invented byline");
  assertEquals(
    body.match(/<description>/g)?.length,
    1,
    "only the channel description",
  );
});

Deno.test("orders items newest first", async () => {
  const dates = [...(await feed()).matchAll(/<pubDate>([^<]+)</g)].map((m) =>
    Date.parse(m[1])
  );
  assertEquals(dates.length, 120, "every item is dated");
  assertEquals(dates, [...dates].sort((a, b) => b - a), "descending by date");
});

Deno.test("dates by publication, not by last edit", async () => {
  // Sorting on UPDATED_AT — which the site's *featured* rail does — puts a 2021
  // Kafka post at the top, because a bulk re-save touched it this month.
  const kafka = post("kafka-async-queuing-with-consumer-proxy");
  assertEquals(kafka.ts, Date.parse("2021-08-31T02:00:32Z"), "published 2021");
  const raw = rawPosts.data.relatedPages.find((r: { fullURL: string }) =>
    r.fullURL.includes("kafka-async-queuing")
  );
  assert(
    Date.parse(raw.updatedAt) > Date.parse(raw.publishedAt),
    "and the record's updatedAt is genuinely much later",
  );
  const body = await feed();
  assert(
    body.indexOf("ubers-payments-platform") < body.indexOf("kafka-async"),
    "so the 2026 post comes first",
  );
});

Deno.test("self-link is canonical, ignoring junk query params", async () => {
  const body = await feed("?category=Mobile&limit=5");
  assert(body.includes(`href="${FEED_URL}" rel="self"`), "bare self-link");
  assertEquals((body.match(/<item>/g) ?? []).length, 120, "params ignored");
});

const SITE_LINK = "https://www.uber.com/us/en/blog/engineering/backend/";
const SAMPLE: Post = {
  url: "https://www.uber.com/us/en/blog/s/",
  title: "Tom & Jerry <live>",
  ts: Date.parse("2026-08-06T15:57:51.347Z"),
  image: "https://tb-static.uber.com/prod/udam-assets/a.png",
  imageType: "image/png",
  categories: ["Backend", "Engineering"],
};

Deno.test("renders XML-safe output", () => {
  const bell = String.fromCharCode(7);
  const out = renderRss({
    title: "Feed & <friends>",
    description: 'Quote " and control',
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [SAMPLE],
  });

  // The library wraps item text in CDATA rather than escaping entities, so the
  // characters that used to need escaping now appear verbatim — what matters is
  // that they cannot terminate the section early.
  assert(
    out.includes("<![CDATA[Tom & Jerry <live>]]>"),
    "item title survives verbatim inside CDATA",
  );
  assert(!out.includes("]]]]"), "no stray CDATA breakout in ordinary text");
  assert(out.includes('type="image/png"'), "enclosure states the media type");

  // Control characters are illegal in XML 1.0 and the library does not strip
  // them, so the val must — one anywhere breaks the whole document.
  const dirty = renderRss({
    title: "T",
    description: "d",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE, title: `Bell${bell}here` }],
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
    items: [{ ...SAMPLE, title: "before ]]> after" }],
  });
  assert(out.includes("]]]]><![CDATA[>"), "breakout split");
  assert(!/\]\]>\s*after/.test(out), "no early termination");
});

Deno.test("omits optional elements when the post lacks them", () => {
  const bare: Post = {
    url: "https://www.uber.com/us/en/blog/bare/",
    title: "Bare",
    ts: null,
    image: "",
    imageType: "",
    categories: [],
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
});
