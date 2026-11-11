/**
 * RSS feed for the Shopify Engineering blog.
 *
 * Source: https://shopify.engineering/latest
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves the
 * latest articles, newest first.
 *
 * Shopify publishes no feed of its own: /feed, /rss.xml and /atom.xml all 404,
 * and /blog.atom soft-200s onto a "Work with us" page.
 *
 * The blog is a Shopify store's blog (`gid://shopify/Article/…`, assets under
 * `cdn.shopify.com/s/files/1/0779/4361/articles/…`) behind a headless React
 * Router front end. The Storefront API is not reachable — the GraphQL runs
 * server-side and no client script carries a storefront token — but React
 * Router's single-fetch data route is public:
 *
 *   https://shopify.engineering/latest.data
 *
 * That hands back the Storefront GraphQL result verbatim: title, handle,
 * publishedAt, image, tags, excerpt, author and resolved metaobject references,
 * for every article on the page. One request, no per-post fetch, and 74 KB
 * against the 211 KB of HTML that embeds the same payload.
 *
 * Scraping the rendered markup instead was considered and rejected: it carries
 * neither the excerpt nor the byline — both live only in the embedded payload —
 * and it renders 19 of the 20 articles the route returns.
 *
 * Page size is fixed at 20 server-side (limit, per_page, pageSize, first, count
 * and friends are all ignored), and this serves that first page only.
 */

import { Feed, type Item } from "feed";

const SITE = "https://shopify.engineering";
const LATEST_URL = `${SITE}/latest`;
/** React Router's single-fetch route for the page above. */
const DATA_URL = `${LATEST_URL}.data`;

/**
 * How long a reader or CDN may reuse a response. These blogs publish a handful
 * of times a month and FreshRSS polls at most hourly, so a long window costs
 * nothing in freshness and is the only caching left in these vals — the
 * in-memory kind never survived val.town recycling an idle isolate.
 */
const CACHE_SECONDS = 12 * 60 * 60;

/** What `authorV2` says when nobody is credited; not a person. */
const HOUSE_BYLINE = "Shopify Engineering";

export interface Post {
  /** Shopify's article handle, which is also its path: /<handle>. */
  handle: string;
  title: string;
  excerpt: string;
  /** Publication time in ms, or null when the record carried no usable date. */
  ts: number | null;
  author: string;
  image: string;
  /** Derived from the URL: Shopify states no media type for article images. */
  imageType: string;
  /** Shopify's own topics, with their internal workflow tags filtered out. */
  topics: string[];
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
    title: "Shopify Engineering",
    description:
      "Latest stories from the teams who build and scale Shopify, from the Shopify Engineering blog.",
    siteLink: LATEST_URL,
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
      "user-agent": "shopify-rss-bridge (+https://val.town)",
      accept: "text/x-script, application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Reads the articles out of a decoded single-fetch payload.
 *
 * The array is found by looking for records that say `__typename: "Article"`
 * rather than by reaching through the route id — the id is currently `latest`
 * but it is derived from a file path, which is the most likely thing to drift.
 */
export function extractPosts(payload: unknown): Post[] {
  const byHandle = new Map<string, Post>();

  for (const row of findArticles(decode(payload))) {
    const handle = str(row.handle);
    const title = str(row.title);
    if (!handle || !title || byHandle.has(handle)) continue;

    const image = str(obj(row.image)?.url);
    // `publishedAt` is always Z-suffixed here, so nothing has to pin the zone.
    const ts = Date.parse(str(row.publishedAt));

    byHandle.set(handle, {
      handle,
      title,
      excerpt: str(row.excerpt),
      ts: Number.isFinite(ts) ? ts : null,
      author: byline(row),
      image,
      imageType: mediaType(image),
      topics: (Array.isArray(row.tags) ? row.tags : [])
        .map(str)
        .filter(isTopic),
    });
  }

  return [...byHandle.values()];
}

/**
 * Who to credit.
 *
 * Two sources, each covering what the other misses: the `authors` metafield is
 * the only one that holds more than one name, and `authorV2` is the only one
 * filled in for the posts that have no metafield. `authorV2` also carries the
 * house name as a placeholder, which is not a byline — but it is the right
 * thing to fall back to when nothing else names anyone.
 */
function byline(row: Record<string, unknown>): string {
  for (const field of list(row.metafields)) {
    if (str(field.key) !== "authors") continue;
    const names = list(obj(field.references)?.edges)
      .map((edge) => str(obj(obj(edge.node)?.field)?.value))
      .filter(Boolean);
    if (names.length) return names.join(" & ");
  }

  return str(obj(row.authorV2)?.name) || HOUSE_BYLINE;
}

/**
 * Whether a tag is a topic readers would recognise.
 *
 * `tags` mixes Shopify's displayed topics — the ones with a /topics/<slug> page
 * behind them, always Title Case — with internal markers that are lowercase
 * slugs: `validated`, `short-cache`, and `author:daniel-beauchamp` duplicates of
 * the byline. Casing is what separates them, and the live check settles it
 * against the real authority — whether /topics/<slug> serves a page.
 */
function isTopic(tag: string): boolean {
  return /[A-Z]/.test(tag);
}

/** The page Shopify publishes for a topic; also what proves it is one. */
export function topicUrl(topic: string): string {
  const slug = topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${SITE}/topics/${slug}`;
}

/** Shopify serves article images from its CDN with the extension intact. */
function mediaType(url: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (!ext) return "";
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

/**
 * Every `Article` record anywhere in the decoded payload. Exported so the live
 * check can reach the raw `tags` the topic filter threw away.
 */
export function findArticles(root: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown) => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const record = node as Record<string, unknown>;
    if (record.__typename === "Article") found.push(record);
    for (const value of Object.values(record)) walk(value);
  };

  walk(root);
  return found;
}

/**
 * Rebuilds the object graph from React Router's turbo-stream encoding.
 *
 * The body is one flat array; index 0 is the root and every integer elsewhere
 * is an index into that array, so the same subtree can be referenced from many
 * places. Three things are not indices:
 *
 *   - negative numbers are sentinels — -5 is null, -7 is undefined
 *   - an object is `{"_<i>": <j>}`, where the *key* is the string at `i`, so
 *     repeated keys are stored once
 *   - a two-element array starting with a string is a tagged scalar, e.g.
 *     `["U", "https://…"]` for a URL, not a pair of indices
 *
 * Results are memoised by index: without it the shared subtrees are re-walked
 * once per reference, which is what would make this slow — not the payload size.
 */
export function decode(payload: unknown): unknown {
  const flat = payload as unknown[];
  if (!Array.isArray(flat) || flat.length === 0) return null;

  const NULL = -5;
  const memo = new Map<number, unknown>();

  const at = (index: number): unknown => {
    if (index < 0) return index === NULL ? null : undefined;
    if (memo.has(index)) return memo.get(index);

    const value = flat[index];

    if (Array.isArray(value)) {
      // Tagged scalar: the tag occupies the slot an index would.
      if (value.length === 2 && typeof value[0] === "string") {
        const inner = value[1];
        return remember(index, typeof inner === "number" ? at(inner) : inner);
      }
      const out: unknown[] = [];
      remember(index, out);
      for (const item of value) out.push(resolve(item));
      return out;
    }

    if (typeof value === "object" && value !== null) {
      const out: Record<string, unknown> = {};
      remember(index, out);
      for (const [key, item] of Object.entries(value)) {
        // Keys are themselves interned: "_12" means "the string at index 12".
        // The digits matter — a literal key can start with an underscore too,
        // and `__typename` is exactly the one this payload is searched for.
        const interned = /^_\d+$/.test(key) ? at(Number(key.slice(1))) : key;
        if (typeof interned === "string") out[interned] = resolve(item);
      }
      return out;
    }

    return remember(index, value);
  };

  // A container's slots are indices; anything else is already the value.
  const resolve = (item: unknown) =>
    typeof item === "number" ? at(item) : item;

  const remember = <T>(index: number, value: T): T => {
    memo.set(index, value);
    return value;
  };

  return at(0);
}

/** Handles are paths: Shopify serves each article from the site root. */
function postUrl(handle: string): string {
  return `${SITE}/${handle}`;
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
      link: postUrl(p.handle),
      // `date` is typed as required but is optional at runtime; an item without
      // one simply gets no <pubDate>, which is right for a post we could not date.
      ...(p.ts !== null ? { date: new Date(p.ts) } : {}),
      description: clean(p.excerpt) || undefined,
      author: p.author ? [{ name: clean(p.author) }] : undefined,
      category: p.topics.map((name) => ({ name: clean(name) })),
      image: p.image
        ? { url: p.image, type: p.imageType || undefined }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
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
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
