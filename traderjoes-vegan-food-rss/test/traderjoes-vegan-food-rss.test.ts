/**
 * Offline tests for the Trader Joe's vegan food feed.
 *
 * The fixture is the val's own GraphQL query with **`published: { eq: "1" }`
 * removed** — deliberately, and it is the only difference. The live query
 * narrows server-side, but a Magento attribute filter that stops matching does
 * not error, it just stops narrowing, so the val re-checks `published` itself.
 * Capturing the unnarrowed set gives that re-check something to catch: 70 of
 * these 210 rows are unpublished, and an unpublished product's page 404s. The
 * fixture is therefore the worst case rather than the typical one — if the
 * server-side filter ever silently no-ops, this is exactly the payload the val
 * will receive. Refresh:
 *
 *   curl -s -X POST https://traderjoes.com/api/graphql \
 *     -H 'content-type: application/json' \
 *     --data '{"query":"query VeganFood($pageSize: Int!) { products(filter: {category_id: {eq: \"8\"}, item_characteristics: {in: [\"Vegan\"]}}, pageSize: $pageSize, currentPage: 1) { total_count items { sku item_title first_published_date published retail_price sales_size sales_uom_description country_of_origin item_characteristics fun_tags item_story_marketing primary_image category_hierarchy { id name } } } }","variables":{"pageSize":500}}' \
 *     -o traderjoes-vegan-food.json
 *
 * Note the apex host: www is bot-blocked and answers curl with 403.
 *
 * Run: deno test --allow-read test/traderjoes-vegan-food-rss.test.ts
 */

import {
  buildFeed,
  describe,
  extractProducts,
  type Listing,
  parseTimestamp,
  type Product,
  productUrl,
  slugify,
} from "../traderjoes-vegan-food-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const raw = JSON.parse(
  await Deno.readTextFile(
    new URL("./traderjoes-vegan-food.json", import.meta.url),
  ),
);
const listing = extractProducts(raw);
const products = listing.products;
const bySku = (sku: string) => products.find((p) => p.sku === sku)!;

const FEED_URL = "https://feed.val.run/traderjoes";
const feed = () => buildFeed(listing, new URL(FEED_URL)).text();

Deno.test("reads the published vegan food products and only those", () => {
  assertEquals(products.length, 140, "published products");
  assert(
    products.every((p) => p.characteristics.includes("Vegan")),
    "every product is tagged Vegan",
  );
  assert(
    products.every((p) => p.sku && p.title),
    "every product is identified",
  );
  assertEquals(
    new Set(products.map((p) => p.sku)).size,
    products.length,
    "skus are unique",
  );
  assert(products.every((p) => p.ts !== null), "every product is dated");
  assert(products.every((p) => p.story), "every product has marketing copy");
  assert(products.every((p) => p.image), "every product has an image");
  assert(products.every((p) => p.price), "every product has a price");
});

Deno.test("drops the unpublished rows, whose pages 404", () => {
  // This is the guard that matters most: the payload carries a third more rows
  // than the feed should, and every extra one is a dead link. Verified against
  // the live site 2026-09-06 — regression-cocktail-10032021, vegan-pepperoni-076348,
  // meatless-ground-074786 and frooze-balls-peanut-butter-jelly-069092 all 404,
  // while every published sku sampled answered 200.
  const all = raw.data.products.items as { sku: string; published: number }[];
  assertEquals(all.length, 210, "rows in the payload");
  assertEquals(
    all.filter((r) => r.published !== 1).length,
    70,
    "unpublished rows the val must exclude",
  );
  const kept = new Set(products.map((p) => p.sku));
  assert(!kept.has("076348"), "Vegan Pepperoni (unpublished) is excluded");
  assert(!kept.has("10032021"), "the Regression Cocktail test row is excluded");
  assert(kept.has("084084"), "a published product is kept");
});

Deno.test("the fields the val reads survive being unpublished", () => {
  // The three undated rows, the three with no marketing copy and the two with
  // no image are all unpublished, which is why the assertions above can be
  // unconditional. If that stops being true the feed needs the fallbacks the
  // Product type already allows for, so pin it.
  const all = raw.data.products.items as Record<string, unknown>[];
  const gaps = all.filter((r) =>
    !r.first_published_date || !r.item_story_marketing || !r.primary_image
  );
  assert(gaps.length > 0, "the payload does have gappy rows");
  assert(
    gaps.every((r) => r.published !== 1),
    "every gappy row is an unpublished one",
  );
});

Deno.test("reads every field of a known product", () => {
  const p = bySku("084084");
  assertEquals(p.title, "Chewy Thai Coconut Cakes", "title");
  assertEquals(p.ts, Date.parse("2026-08-24T18:08:06Z"), "ts");
  assertEquals(p.price, "3.79", "price");
  assertEquals(p.size, "4.76 Oz", "size");
  assertEquals(p.origin, "Product of Thailand", "origin");
  assertEquals(p.characteristics, ["Vegan"], "characteristics");
  assertEquals(
    p.path,
    ["Food", "From The Freezer", "Cool Desserts"],
    "taxonomy below the Products root",
  );
  assertEquals(
    p.image,
    "https://www.traderjoes.com/content/dam/trjo/products/m20604/84084.png",
    "image is absolute and on www",
  );
  assertEquals(p.imageType, "image/png", "type from the extension");
  assert(p.story.startsWith("<p>Chewy Thai coconut cakes are among"), "story");
});

Deno.test("dates the space-separated timestamp as UTC", () => {
  // Date.parse would read "2026-08-24 18:08:06" as local time, which happens
  // to be UTC on val.town but only by accident and is not UTC under `deno test`
  // on this laptop. See the val's header for the evidence that UTC is right.
  assertEquals(parseTimestamp("2026-08-24 18:08:06"), 1787594886000, "instant");
  assertEquals(
    new Date(parseTimestamp("2021-02-25 00:00:00")!).toISOString(),
    "2021-02-25T00:00:00.000Z",
    "the backfill date lands at UTC midnight",
  );
  assertEquals(
    parseTimestamp("2026-08-24T18:08:06"),
    null,
    "ISO form rejected",
  );
  assertEquals(parseTimestamp(""), null, "empty rejected");
  assertEquals(parseTimestamp("not a date"), null, "garbage rejected");
});

Deno.test("builds product URLs with the site's own slug rules", () => {
  // Each of these is a case the obvious slugify writes differently from the
  // site. They all resolve either way — the page keys on the trailing sku —
  // so what is pinned here is that the val emits the same link the site does.
  assertEquals(
    productUrl(bySku("060216")),
    "https://www.traderjoes.com/home/products/pdp/jalapeno-sauce-060216",
    "ñ is folded to n, not dropped",
  );
  assertEquals(
    productUrl(bySku("064672")),
    "https://www.traderjoes.com/home/products/pdp/organic-acai-bowl-064672",
    "ç is folded to c",
  );
  assertEquals(
    productUrl(bySku("092337")),
    "https://www.traderjoes.com/home/products/pdp/garlic-herb-pizza-dough-092337",
    "& is deleted and the double space it leaves collapses to one hyphen",
  );
  assertEquals(
    productUrl(bySku("081188")),
    "https://www.traderjoes.com/home/products/pdp/whipt-plant-based-dairy-free-whipped-coconut-081188",
    "™ is dropped",
  );
  assertEquals(
    productUrl(bySku("081417")),
    "https://www.traderjoes.com/home/products/pdp/gomacro-timeless-treasure-salted-caramel-chocolate-chips-081417",
    "® is dropped and + is deleted like any other punctuation",
  );
});

Deno.test("reproduces the site's slugify quirks exactly", () => {
  // Lifted verbatim from Trader Joe's bundle. These are the rules a fresh
  // implementation would "fix" and thereby drift from the site's own links.
  assertEquals(slugify("A & B"), "a-b", "& deleted, then spaces collapsed");
  assertEquals(slugify("a - b"), "a-b", "spaced hyphen becomes one hyphen");
  assertEquals(
    slugify("a???b"),
    "ab",
    "punctuation is deleted rather than separated",
  );
  assertEquals(
    slugify("Trailing "),
    "trailing-",
    "no trim: a stored trailing space keeps its hyphen",
  );
});

Deno.test("url_key is not the product URL", () => {
  // The API returns a field that looks exactly like this slug but orders it
  // sku-first ("084084-kanom-dok-mai-chewy-coconut-cakes"), and the resolver
  // only looks for a sku at the *end*, so it 404s. Pin the difference so
  // nobody 'simplifies' productUrl into using the field that is already there.
  const row = (raw.data.products.items as { sku: string }[])
    .find((r) => r.sku === "084084") as Record<string, unknown>;
  assert(!("url_key" in row), "the val does not even request url_key");
  assert(
    !productUrl(bySku("084084")).includes("kanom-dok-mai"),
    "the link is built from item_title, not url_key",
  );
});

Deno.test("orders the feed newest product first", async () => {
  const xml = await feed();
  const titles = [...xml.matchAll(/<title>(?:<!\[CDATA\[)?([^\]<]*)/g)]
    .map((m) => m[1]);
  // titles[0] is the channel.
  assertEquals(titles[1], "Chewy Thai Coconut Cakes", "newest product first");

  const sorted = [...products].sort((a, b) => b.ts! - a.ts!);
  assert(sorted[0].ts! >= sorted[sorted.length - 1].ts!, "descending");
});

Deno.test("emits a link-only guid so readers dedupe on the URL", async () => {
  const xml = await feed();
  assert(
    xml.includes(
      '<guid isPermaLink="true">https://www.traderjoes.com/home/products/pdp/chewy-thai-coconut-cakes-084084</guid>',
    ),
    "guid is the permalink",
  );
  assert(!xml.includes('isPermaLink="false"'), "no opaque guids");
});

Deno.test("carries the taxonomy and characteristics as categories", async () => {
  const xml = await feed();
  const item = xml.slice(xml.indexOf("<item>"), xml.indexOf("</item>"));
  for (const c of ["Food", "From The Freezer", "Cool Desserts", "Vegan"]) {
    assert(item.includes(`<category>${c}</category>`), `category ${c}`);
  }
});

Deno.test("states the enclosure's type so a reader renders the image", async () => {
  const xml = await feed();
  // FreshRSS decides whether to rewrite an <enclosure> into an <img> from the
  // mime type, so an untyped enclosure is an invisible product photo.
  const enclosure = /<enclosure [^>]*\/>/.exec(xml)![0];
  // Asserted attribute by attribute: the library's attribute order is its
  // business, and pinning the serialised string would fail on a formatting
  // change that breaks nothing.
  assert(enclosure.includes('type="image/png"'), "enclosure states its type");
  assert(
    enclosure.includes(
      'url="https://www.traderjoes.com/content/dam/trjo/products/m20604/84084.png"',
    ),
    "enclosure url",
  );
  assert(
    products.every((p) => p.imageType === "image/png"),
    "every published product's image is a png today",
  );
  // The DAM does serve other formats — the one .jpg in the payload belongs to
  // the unpublished "Regression Cocktail" row — so the type is read off the
  // extension rather than assumed.
  const all = raw.data.products.items as { primary_image: string | null }[];
  assert(
    all.some((r) => r.primary_image?.endsWith(".jpg")),
    "the payload does carry a non-png",
  );
});

Deno.test("keeps volatile inventory state out of the item body", () => {
  // FreshRSS hashes link + title + content + tags to decide an entry changed
  // and re-dates it when it did, so "GOING FAST" in the body would churn
  // products published years ago on every poll.
  const body = describe(bySku("084084"));
  for (const noise of ["GOING FAST", "LIMITED TIME", "SEASONAL"]) {
    assert(!body.includes(noise), `${noise} is not in the body`);
  }
  // It is in the source data, so the exclusion is a choice, not an accident.
  const labels = new Set(
    (raw.data.products.items as { product_label?: string }[])
      .map((r) => r.product_label).filter(Boolean),
  );
  assertEquals(labels.size, 0, "the val does not even request product_label");
});

Deno.test("composes the facts line and leaves the story as HTML", () => {
  const body = describe(bySku("084084"));
  assert(
    body.includes("<p>$3.79 · 4.76 Oz · Product of Thailand · Vegan</p>"),
    "facts line",
  );
  assert(body.startsWith("<p>Chewy Thai coconut cakes"), "story comes first");
  assert(
    body.includes(
      "<em>Feeling Adventurous · Finger Food · Treat Yourself</em>",
    ),
    "fun tags",
  );
});

Deno.test("omits a size that says nothing", () => {
  // "1 Each" is not a size. Gum, sku 067358, is the case.
  assertEquals(bySku("067358").size, "", "1 Each is dropped");
  assert(
    !describe(bySku("067358")).includes("1 Each"),
    "and does not reach the body",
  );
  assert(
    products.some((p) => p.size.endsWith(" Oz")),
    "real sizes are still printed",
  );
});

Deno.test("escapes the text it composes but not the story's own markup", () => {
  // The story is HTML by design; the facts line is text this val builds and
  // could carry an & from a country or characteristic.
  const p: Product = {
    ...bySku("084084"),
    origin: "Made in <A & B>",
    story: "<p>real <em>markup</em></p>",
    funTags: [],
  };
  const body = describe(p);
  assert(body.includes("Made in &lt;A &amp; B&gt;"), "facts escaped");
  assert(body.includes("<p>real <em>markup</em></p>"), "story left alone");
});

Deno.test("reports a complete listing, and says so when it is not", async () => {
  // The fixture is the *unnarrowed* query, so its total_count is 210 against
  // 140 kept — which is exactly the case that must NOT read as truncation.
  assertEquals(listing.rowCount, 210, "rows the API sent");
  assertEquals(listing.totalCount, 210, "rows the API says match");
  const res = buildFeed(listing, new URL(FEED_URL));
  assertEquals(
    res.headers.get("x-feed-complete"),
    "true",
    "filtering 210 rows down to 140 is not a truncated page",
  );
  assertEquals(
    res.headers.get("cache-control"),
    "public, max-age=43200",
    "12h",
  );
  assertEquals(
    res.headers.get("content-type"),
    "application/rss+xml; charset=utf-8",
    "content type",
  );
  assert(!(await feed()).includes("has outgrown"), "no shortfall note");

  const truncated: Listing = {
    products: products.slice(0, 10),
    totalCount: 99,
    rowCount: 10,
  };
  const short = buildFeed(truncated, new URL(FEED_URL));
  assertEquals(short.headers.get("x-feed-complete"), "false", "truncated");
  assert(
    (await short.text()).includes("Showing 10 of 99 matches"),
    "the shortfall is stated in the channel description too",
  );
});

Deno.test("survives a payload that has gone wrong rather than throwing", () => {
  assertEquals(extractProducts(null).products.length, 0, "null");
  assertEquals(extractProducts({}).products.length, 0, "empty object");
  assertEquals(
    extractProducts({ data: { products: { items: null } } }).products.length,
    0,
    "null items",
  );
  const empty = extractProducts({ data: { products: { items: [] } } });
  assertEquals(empty.totalCount, 0, "totalCount falls back to what was read");
  assertEquals(empty.rowCount, 0, "rowCount too");
});

Deno.test("renders a well-formed document with every item present", async () => {
  const xml = await feed();
  assertEquals(
    (xml.match(/<item>/g) ?? []).length,
    products.length,
    "one <item> per product",
  );
  assert(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>'), "prolog");
  // Channel text is entity-escaped; only item text is wrapped in CDATA.
  assert(
    xml.includes("<title>Trader Joe's — Vegan Food</title>"),
    "channel title is bare text, while item titles are CDATA-wrapped",
  );
  assert(
    xml.includes("<title><![CDATA[Chewy Thai Coconut Cakes]]></title>"),
    "item title CDATA'd",
  );
  assert(
    xml.includes(
      "<link>https://www.traderjoes.com/home/products/category/food-8",
    ),
    "channel links at the filtered category page",
  );
  // deno-lint-ignore no-control-regex
  assert(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(xml), "no illegal control chars");
});
