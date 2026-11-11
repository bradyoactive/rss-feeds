/**
 * RSS feed for the Vegan-tagged products in the Food category at Trader Joe's.
 *
 * Source: https://www.traderjoes.com/home/products/category/food-8
 *           ?filters=%7B%22characteristics%22%3A%5B%22Vegan%22%5D%7D
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves that
 * one filtered listing, newest product first.
 *
 * Trader Joe's publishes no feed. The site is Adobe AEM with a Magento
 * commerce backend, and the React front end drives it entirely through one
 * GraphQL endpoint, /api/graphql. Two calls build the category page: the
 * category tree, and this `products` query. One request with pageSize 500
 * returns the whole filtered listing — 140 products today — with the title,
 * price, size, marketing copy, image, taxonomy and characteristics, so there
 * is no per-product fetch.
 *
 * ## Why the apex host and not www
 *
 * `www.traderjoes.com` is behind Akamai bot management and answers **403
 * Access Denied to every non-browser client** — this laptop, curl, val.town's
 * egress, and a request carrying a full Chrome header set alike. Only a real
 * browser passes. `traderjoes.com` — the bare apex — serves the *same*
 * /api/graphql with no bot rule at all, and answers a bare fetch with no
 * user-agent at 200. That asymmetry is the only reason this val is possible.
 *
 * It is narrow, though: every path on the apex *except* /api/graphql 301s to
 * www, so HTML pages and images are reachable only from a browser. Item links
 * and enclosures therefore point at www — correct, because a reader follows
 * them in a browser and a browser is exactly what Akamai lets through — but
 * they cannot be link-checked from a script. See the linkcheck suite, which
 * says so out loud rather than quietly asserting something weaker.
 *
 * ## Dating
 *
 * `first_published_date` is the item's date: when the product page first went
 * live. Not `last_published_date`, which is equal to it on 198 of 210 rows and
 * moves on any later edit, and not `created_at`, which is when the row entered
 * Magento and runs months earlier (Chewy Thai Coconut Cakes: created 2026-03-02,
 * published 2026-08-24).
 *
 * The API returns "2026-08-24 18:08:06" with no zone. It is **UTC**, which the
 * data itself settles: read as UTC, the 122 dated non-backfill rows land
 * between 08:00 and 19:00 Pacific with nothing at all between 20:00 and 07:00.
 * Read as Pacific they would cluster in the evening and small hours instead.
 * Magento stores UTC in the database and this field is the raw column, even
 * though storeConfig's display timezone is America/Los_Angeles.
 *
 * The 15 oldest rows all carry exactly "2021-02-25 00:00:00", which is a bulk
 * backfill rather than a real publication date; the tail of the feed is
 * therefore an arbitrarily ordered clump, not a chronology.
 */

import { Feed, type Item } from "npm:feed@6.0.0";

/**
 * The apex, deliberately. See the header — www is bot-blocked to everything
 * that is not a browser, and this is the one path on the apex that does not
 * redirect to it.
 */
const API_URL = "https://traderjoes.com/api/graphql";

/** Where a reader is sent. www is what the site itself links, and a reader
 * follows these in a browser, which Akamai admits. */
const SITE = "https://www.traderjoes.com";

/** "food-8" in the page URL: the Food category's Magento id. */
export const CATEGORY_ID = "8";
const CATEGORY_NAME = "Food";
/** Trader Joe's own spelling of the characteristic, which is what it matches. */
export const CHARACTERISTIC = "Vegan";

const CATEGORY_URL = `${SITE}/home/products/category/food-${CATEGORY_ID}` +
  `?filters=${
    encodeURIComponent(JSON.stringify({ characteristics: [CHARACTERISTIC] }))
  }`;

/**
 * One page, sized past the whole listing rather than paginated. 140 products
 * match today and the endpoint honours 500 without a server-side cap; if the
 * listing ever outgrows it the feed says so rather than silently truncating.
 */
const PAGE_SIZE = 500;

/**
 * How long a reader or CDN may reuse a response. Trader Joe's adds a handful
 * of products a week, so a long window costs nothing in freshness. This is the
 * only caching the val does — module state does not reliably survive val.town
 * recycling an idle isolate.
 */
const CACHE_SECONDS = 12 * 60 * 60;

const QUERY =
  `query VeganFood($categoryId: String!, $characteristic: String!, $pageSize: Int!) {
  products(
    filter: {
      category_id: { eq: $categoryId }
      item_characteristics: { in: [$characteristic] }
      published: { eq: "1" }
    }
    pageSize: $pageSize
    currentPage: 1
  ) {
    total_count
    items {
      sku
      item_title
      first_published_date
      published
      retail_price
      sales_size
      sales_uom_description
      country_of_origin
      item_characteristics
      fun_tags
      item_story_marketing
      primary_image
      category_hierarchy { id name }
    }
  }
}`;

export interface Product {
  sku: string;
  title: string;
  /** Publication time in ms, or null when the record carried no usable date. */
  ts: number | null;
  /** Marketing copy, as the HTML the product page renders. */
  story: string;
  /** Absolute www URL, or "" when the record carried no image. */
  image: string;
  /** Derived from the extension; "" when there is no image to type. */
  imageType: string;
  price: string;
  /** e.g. "4.76 Oz"; "" when the size says nothing ("1 Each"). */
  size: string;
  origin: string;
  /** "Vegan", "Gluten Free", "Kosher", … */
  characteristics: string[];
  /** Trader Joe's whimsical merchandising tags ("Backpack Ready"). */
  funTags: string[];
  /** The taxonomy below the "Products" root: Food → … → leaf. */
  path: string[];
}

export interface Listing {
  products: Product[];
  /** What the API says matches, which is not always what it returned. */
  totalCount: number;
  /**
   * Rows in the page the API actually sent, before the val filtered any out.
   *
   * Completeness has to be measured against this and not against
   * `products.length`, which is smaller for a reason that is not truncation:
   * the val drops every unpublished row. Comparing `totalCount` to the kept
   * count would report a 210-row payload narrowed to 140 as "the listing has
   * outgrown the page size", which is a different and false claim.
   */
  rowCount: number;
}

export default async function (req: Request): Promise<Response> {
  let listing: Listing;
  try {
    listing = extractProducts(await fetchProducts());
  } catch (err) {
    return text(502, `Failed to fetch ${API_URL}: ${err}`);
  }

  return buildFeed(listing, new URL(req.url));
}

/** Pure half of the handler: a listing in, an RSS response out. */
export function buildFeed(listing: Listing, url: URL): Response {
  const items = [...listing.products].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const complete = listing.totalCount <= listing.rowCount;

  const xml = renderRss({
    title: `Trader Joe's — ${CHARACTERISTIC} ${CATEGORY_NAME}`,
    description: describeFeed(listing, complete),
    siteLink: CATEGORY_URL,
    feedUrl: `${url.origin}${url.pathname}`,
    items,
  });

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
      // Same reasoning as the channel note: a cap that silently trims the
      // listing has to be visible somewhere a machine can read it.
      "x-feed-complete": String(complete),
    },
  });
}

function describeFeed(listing: Listing, complete: boolean): string {
  const base = `Products tagged “${CHARACTERISTIC}” in the ${CATEGORY_NAME} ` +
    `category at Trader Joe's, newest first.`;
  if (complete) return base;
  return `${base} Showing ${listing.rowCount} of ` +
    `${listing.totalCount} matches — the listing has outgrown the val's ` +
    `page size of ${PAGE_SIZE}, so the oldest products are missing.`;
}

export async function fetchProducts(): Promise<unknown> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "traderjoes-rss-bridge (+https://val.town)",
      accept: "application/json",
    },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        categoryId: CATEGORY_ID,
        characteristic: CHARACTERISTIC,
        pageSize: PAGE_SIZE,
      },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  // GraphQL answers 200 with an `errors` array, so the status line is not the
  // check. A partial response would otherwise read as a shrunken listing.
  if (body?.errors?.length) {
    throw new Error(`GraphQL: ${body.errors[0]?.message ?? "unknown error"}`);
  }
  return body;
}

/**
 * Reads the products out of the GraphQL response.
 *
 * Both filters the query sends are re-checked here rather than trusted. A
 * Magento attribute filter that stops matching does not error — it returns the
 * unfiltered set or an empty one — and getting `published` wrong is the
 * expensive case: an unpublished product's page **404s**, so every one of the
 * 70 unpublished rows in this listing would be a dead link in the feed.
 */
export function extractProducts(payload: unknown): Listing {
  const products = obj(obj(obj(payload)?.data)?.products);
  const rows = list(products?.items);
  const bySku = new Map<string, Product>();

  for (const row of rows) {
    const sku = str(row.sku);
    const title = str(row.item_title);
    if (!sku || !title || bySku.has(sku)) continue;
    // An unpublished product has no page to link to.
    if (Number(row.published) !== 1) continue;

    const characteristics = strings(row.item_characteristics);
    if (!characteristics.includes(CHARACTERISTIC)) continue;

    const path = list(row.category_hierarchy)
      .map((c) => str(c.name))
      // The root is the same "Products" on every row and says nothing.
      .filter((name) => name && name !== "Products");

    const image = str(row.primary_image);

    bySku.set(sku, {
      sku,
      title,
      ts: parseTimestamp(str(row.first_published_date)),
      story: str(row.item_story_marketing),
      image: image ? `${SITE}${image}` : "",
      imageType: mediaType(image),
      price: str(row.retail_price),
      size: formatSize(row.sales_size, str(row.sales_uom_description)),
      origin: str(row.country_of_origin),
      characteristics,
      funTags: strings(row.fun_tags),
      path,
    });
  }

  const totalCount = Number(products?.total_count);

  return {
    products: [...bySku.values()],
    totalCount: Number.isFinite(totalCount) ? totalCount : rows.length,
    rowCount: rows.length,
  };
}

/**
 * "2026-08-24 18:08:06" → ms.
 *
 * The space-separated form is not ISO 8601, and `Date.parse` reads it as
 * **local time** — which on val.town would be UTC anyway, but only by
 * accident. Stating the zone makes the value mean the same thing wherever the
 * tests run. See the header for why UTC is the right zone.
 */
export function parseTimestamp(raw: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(raw);
  if (!m) return null;
  const ts = Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * The enclosure's mime type, from the image's extension.
 *
 * FreshRSS decides whether to rewrite an <enclosure> into an <img> from this
 * type and not from the URL, so an untyped enclosure is a product photo that
 * silently never renders. Every published product's image is a .png today, but
 * the DAM stores .jpg too — one unpublished row has one — and an extension
 * that is right there to read is not worth hardcoding past.
 */
function mediaType(path: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(path)?.[1]?.toLowerCase();
  if (!ext) return "";
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

/** "1 Each" is noise; every other size is worth printing. */
function formatSize(size: unknown, uom: string): string {
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0 || !uom) return "";
  if (uom === "Each" && n === 1) return "";
  return `${n} ${uom}`;
}

/**
 * The product page's URL: the slugified title, then the sku.
 *
 * **The page resolves on the trailing sku alone** — /pdp/zzzz-060216 and
 * /pdp/060216 both serve Jalapeño Sauce, and what makes a URL 404 is the sku
 * being absent or unpublished, never the slug being wrong. Verified in a
 * browser 2026-09-06.
 *
 * Two things follow. The slug is written the site's way because these links
 * should be the ones the site itself renders, not because they would otherwise
 * break — a drift in `slugify` is a cosmetic bug here, not a dead link. And
 * `url_key`, which the API also returns and which looks like exactly this slug
 * ("084084-kanom-dok-mai-chewy-coconut-cakes"), 404s: it puts the sku at the
 * *front*, where the resolver does not look.
 *
 * The slug does cost a little stability — an edited title changes the link, and
 * a reader that dedupes on it would show the product twice. /pdp/<sku> alone
 * would be immune, and is the fallback if that ever actually happens; it is not
 * the default because it is unreadable in a reader and is not what the site links.
 */
export function productUrl(p: Product): string {
  return `${SITE}/home/products/pdp/${slugify(p.title)}-${p.sku}`;
}

/**
 * Lifted verbatim from Trader Joe's own bundle (clientlib-react.min.js) rather
 * than reinvented, because the obvious implementation disagrees with the site
 * on real products: it renders "Jalapeño Sauce" as `jalape-o-sauce` where the
 * site writes `jalapeno-sauce`, and "Organic Açai Bowl" as `organic-a-ai-bowl`
 * against `organic-acai-bowl`. Both of those URLs do in fact load — see
 * productUrl, the sku is what resolves — so this is about emitting the same
 * link the site does, not about avoiding a 404.
 *
 * The quirks are all load-bearing and none of them are what a fresh
 * implementation would choose:
 *   - `&` is *deleted*, not replaced by a separator, so the double space it
 *     leaves is what the collapse below turns into one hyphen.
 *   - the final `--` → `-` is one pass, so three hyphens collapse to two.
 *   - there is no leading/trailing trim, so a title stored with a trailing
 *     space keeps a trailing hyphen. That is genuinely how the site links it.
 */
export function slugify(title: string): string {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/ - /g, "-")
    .replace(/ {2,}/g, " ")
    .replace(/[\r\n]/gm, " ")
    .replace(/[^0-9a-zA-Z- ]/g, "")
    .replace(/ /g, "-")
    .replace(/--/g, "-");
}

export function renderRss(feed: {
  title: string;
  description: string;
  siteLink: string;
  feedUrl: string;
  items: Product[];
}): string {
  const dates = feed.items.map((p) => p.ts).filter((ts) => ts !== null);

  const out = new Feed({
    title: clean(feed.title),
    description: clean(feed.description),
    link: feed.siteLink,
    language: "en",
    updated: new Date(dates.length ? Math.max(...dates) : Date.now()),
    feedLinks: { rss: feed.feedUrl },
    generator: false,
  });

  for (const p of feed.items) {
    out.addItem({
      title: clean(p.title),
      // Neither `id` nor `guid`: with only a link, the library emits
      // <guid isPermaLink="true"> holding that link — the same identity readers
      // already dedupe these items on. Setting either would flip it to "false".
      link: productUrl(p),
      ...(p.ts !== null ? { date: new Date(p.ts) } : {}),
      description: clean(describe(p)) || undefined,
      // Trader Joe's credits no author, so items carry no <author>.
      category: [...p.path, ...p.characteristics].map((name) => ({
        name: clean(name),
      })),
      image: p.image
        ? { url: p.image, type: p.imageType || undefined }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

/**
 * The item body: the product's own marketing copy, then a line of facts.
 *
 * Deliberately absent are `product_label` ("GOING FAST", "LIMITED TIME") and
 * `availability`, the two fields that move without the product changing.
 * FreshRSS hashes link + title + content + tags to decide an entry was edited
 * and re-dates it when it was, so a transient inventory state in here would
 * churn items that are years old. Price and size can change too, but they are
 * facts about the product rather than a stock reading, and they are most of
 * what makes a product feed worth reading.
 */
export function describe(p: Product): string {
  const facts = [
    p.price ? `$${p.price}` : "",
    p.size,
    p.origin,
    p.characteristics.join(", "),
  ].filter(Boolean).join(" · ");

  const tags = p.funTags.length
    ? `<p><em>${esc(p.funTags.join(" · "))}</em></p>`
    : "";

  return [p.story, facts ? `<p>${esc(facts)}</p>` : "", tags]
    .filter(Boolean)
    .join("\n");
}

/** For the text this val composes itself; the story is already HTML. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : null;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(obj).filter((x) => x !== null) : [];
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : [];
}

/** CMS text is editor-entered and carries whitespace the page trims for us. */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Strips the characters that are illegal in XML 1.0. The feed library escapes
 * CDATA breakouts correctly but passes control characters through untouched,
 * and a single one anywhere would make the whole document unparseable — not
 * just its own item.
 */
function clean(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
