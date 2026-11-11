/**
 * RSS feed for the Engineering category of the Modal blog.
 *
 * Source: https://modal.com/blog?category=Engineering
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves that
 * category, newest first.
 *
 * Modal publishes no feed (/feed, /rss.xml, /blog/feed.xml all 404). The site
 * is SvelteKit, so the page's loader output is served at:
 *
 *   https://modal.com/blog/__data.json
 *
 * One request returns all 130 posts with title, slug, date, description, image
 * and category — the whole listing, not a page of it, because the category
 * filter runs in the browser. There is no per-post fetch.
 *
 * The content behind it is Sanity, but there is nothing to query directly: the
 * project id appears nowhere in the client, images are served through
 * modal-cdn.com, and SvelteKit does the Sanity call server-side.
 */

import { Feed, type Item } from "npm:feed@6.0.0";

const SITE = "https://modal.com";
/** SvelteKit's data route for /blog. */
const DATA_URL = `${SITE}/blog/__data.json`;

/** Modal's own spelling of the category, which is what the filter matches. */
const CATEGORY = "Engineering";
const CATEGORY_URL = `${SITE}/blog?category=${CATEGORY}`;

/**
 * How long a reader or CDN may reuse a response. These blogs publish a handful
 * of times a month and FreshRSS polls at most hourly, so a long window costs
 * nothing in freshness and is the only caching left in these vals — the
 * in-memory kind never survived val.town recycling an idle isolate.
 */
const CACHE_SECONDS = 12 * 60 * 60;

export interface Post {
  slug: string;
  title: string;
  description: string;
  /** Publication time in ms, or null when the record carried no usable date. */
  ts: number | null;
  image: string;
  imageType: string;
  category: string;
  /** Modal's own estimate, in minutes; shown in the item body. */
  minutes: number | null;
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    posts = extractPosts(await fetchData());
  } catch (err) {
    return text(502, `Failed to fetch ${DATA_URL}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: `Modal — ${CATEGORY}`,
    description: `Posts in the “${CATEGORY}” category of the Modal blog.`,
    siteLink: CATEGORY_URL,
    feedUrl: `${url.origin}${url.pathname}`,
    items,
  });

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
}

async function fetchData(): Promise<unknown> {
  const res = await fetch(DATA_URL, {
    headers: {
      "user-agent": "modal-rss-bridge (+https://val.town)",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Reads the posts out of a decoded SvelteKit payload.
 *
 * The array is found by shape rather than by node position: the response is a
 * list of route nodes, only one of which holds the loader data for /blog, and
 * which index that is depends on the layout tree.
 */
export function extractPosts(payload: unknown): Post[] {
  const bySlug = new Map<string, Post>();

  for (const row of findPosts(payload)) {
    const slug = str(row.slug);
    const title = str(row.title);
    if (!slug || !title || bySlug.has(slug)) continue;
    if (str(row.category) !== CATEGORY) continue;
    // `published` is true on every record today, but an unpublished one has no
    // business in a feed.
    if (row.published === false) continue;

    const image = str(row.image);
    // Dates come in two shapes from the same list: date-only "2026-08-04" and
    // a Z-suffixed instant. Date.parse reads both as UTC.
    const ts = Date.parse(str(row.date));
    const minutes = Number(row.length);

    bySlug.set(slug, {
      slug,
      title,
      description: str(row.description),
      ts: Number.isFinite(ts) ? ts : null,
      image,
      imageType: mediaType(image),
      category: str(row.category),
      minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
    });
  }

  return [...bySlug.values()];
}

/** Every object that looks like a blog post anywhere in the decoded payload. */
function findPosts(payload: unknown): Record<string, unknown>[] {
  const nodes = list(obj(payload)?.nodes);

  for (const node of nodes) {
    const decoded = obj(devalue(node.data));
    if (!decoded) continue;
    const posts = list(decoded.posts);
    if (posts.length) return posts;
  }
  return [];
}

/**
 * Rebuilds the object graph from SvelteKit's devalue encoding.
 *
 * A node's `data` is one flat array; index 0 is the root and every integer
 * elsewhere is an index into that array, so a repeated string is stored once.
 * Unlike the turbo-stream the Shopify val decodes, object keys are literal —
 * only the values are indices. Negative numbers are constants rather than
 * indices: -1 is undefined, -2 a hole, -3 NaN, -4 and -5 the infinities.
 *
 * Results are memoised by index. Without it the shared strings are re-walked
 * once per reference, which is what would make this slow on a payload of a few
 * thousand entries — not the size.
 */
export function devalue(data: unknown): unknown {
  const flat = data as unknown[];
  if (!Array.isArray(flat) || flat.length === 0) return null;

  const CONSTANTS: Record<number, unknown> = {
    [-1]: undefined,
    [-2]: undefined,
    [-3]: NaN,
    [-4]: Infinity,
    [-5]: -Infinity,
  };
  const memo = new Map<number, unknown>();

  const at = (index: number): unknown => {
    if (index < 0) return CONSTANTS[index] ?? undefined;
    if (memo.has(index)) return memo.get(index);

    const value = flat[index];

    if (Array.isArray(value)) {
      const out: unknown[] = [];
      memo.set(index, out);
      for (const item of value) out.push(resolve(item));
      return out;
    }

    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      memo.set(index, out);
      for (const [key, item] of Object.entries(value)) out[key] = resolve(item);
      return out;
    }

    memo.set(index, value);
    return value;
  };

  // A container's slots are indices; anything else is already the value.
  const resolve = (item: unknown) => typeof item === "number" ? at(item) : item;

  return at(0);
}

export function renderRss(feed: {
  title: string;
  description: string;
  siteLink: string;
  feedUrl: string;
  items: Post[];
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
      link: postUrl(p.slug),
      // `date` is typed as required but is optional at runtime; an item without
      // one simply gets no <pubDate>, which is right for a post we could not date.
      ...(p.ts !== null ? { date: new Date(p.ts) } : {}),
      description: clean(describe(p)) || undefined,
      // Modal credits no author on the listing, so items carry no <author>.
      category: p.category ? [{ name: clean(p.category) }] : [],
      image: p.image
        ? { url: p.image, type: p.imageType || undefined }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

function describe(p: Post): string {
  const read = p.minutes ? `${p.minutes} min read` : "";
  return [p.description, read].filter(Boolean).join(" · ");
}

function postUrl(slug: string): string {
  return `${SITE}/blog/${slug}`;
}

/** Modal's CDN keeps the extension; most are .webp. */
function mediaType(url: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (!ext) return "";
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : null;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(obj).filter((x) => x !== null) : [];
}

/** Editor-entered text can carry stray whitespace the rendered page trimmed. */
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
