/**
 * RSS feed for the “Engineering” category of the Hex blog.
 *
 * Source: https://hex.tech/blog/category/engineering/
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves that
 * category, newest first.
 *
 * Hex publishes no feed of its own (/feed, /blog/rss and friends all 404), and
 * its blog is a Next.js front end over Sanity. The rendered category page put
 * the post records in App Router flight chunks, which meant reassembling the
 * streamed payload and scanning it for records that could straddle a chunk
 * boundary.
 *
 * So the posts come from Sanity's public read API instead — the same project
 * and dataset the site's own images are served from, which is where the project
 * id below comes from (`cdn.sanity.io/images/e92memrj/production/…`). One GROQ
 * query returns every field the feed needs.
 *
 * The category is resolved by slug inside the query rather than by its document
 * id, so the feed keeps working if Hex ever rebuilds the category.
 */

import { Feed, type Item } from "feed";

const SITE = "https://hex.tech";
const CATEGORY = "engineering";
const CATEGORY_URL = `${SITE}/blog/category/${CATEGORY}/`;

const PROJECT = "e92memrj";
const DATASET = "production";
/** Pinned: Sanity dates its API, and an unpinned version is a silent upgrade. */
const API_VERSION = "v2021-10-21";
/** apicdn is the cached host; the plain api. host is rate-limited harder. */
const SANITY_URL =
  `https://${PROJECT}.apicdn.sanity.io/${API_VERSION}/data/query/${DATASET}`;
/** One request, comfortably clear of the category's ~14 posts. */
const PAGE_SIZE = 100;

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
  synopsis: string;
  /** Publication time in ms, or null when the record carried no usable date. */
  ts: number | null;
  author: string;
  image: string;
  /** Display names as Hex spells them, e.g. ["Engineering", "Research"]. */
  categories: string[];
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    posts = extractPosts(await query());
  } catch (err) {
    return text(502, `Failed to fetch ${SANITY_URL}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const label = displayName(items);

  const xml = renderRss({
    title: `Hex Blog — ${label}`,
    description: `Posts in the “${label}” category of the Hex blog.`,
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

/**
 * Every post in the category, newest first.
 *
 * `references(*[…]._id)` looks the category up by slug in the same round trip,
 * so nothing here depends on a document id a rebuild could change, and
 * `hidePost != true` keeps retired posts out — Sanity holds them where the
 * rendered page had already filtered them away.
 */
const GROQ = `*[_type=="blogPost"
    && references(*[_type=="blogCategory" && slug.current=="${CATEGORY}"]._id)
    && hidePost != true]
  | order(date desc) [0...${PAGE_SIZE}] {
    "slug": slug.current,
    "title": title,
    "date": date,
    "synopsis": synopsis,
    "author": author,
    "image": hero.image.asset->url,
    "categories": categories[]->name
  }`;

async function query(): Promise<unknown> {
  const res = await fetch(`${SANITY_URL}?query=${encodeURIComponent(GROQ)}`, {
    headers: {
      "user-agent": "hex-rss-bridge (+https://val.town)",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Reads the query result. Sanity returns plain text, so nothing needs decoding. */
export function extractPosts(payload: unknown): Post[] {
  const result = (payload as { result?: unknown })?.result;
  const bySlug = new Map<string, Post>();

  for (const raw of Array.isArray(result) ? result : []) {
    const row = raw as Record<string, unknown>;
    const slug = str(row.slug);
    const title = str(row.title);
    if (!slug || !title || bySlug.has(slug)) continue;

    // `date` is date-only ("2026-06-19"), which Date.parse reads as UTC.
    const ts = Date.parse(str(row.date));

    bySlug.set(slug, {
      slug,
      title,
      synopsis: str(row.synopsis),
      ts: Number.isFinite(ts) ? ts : null,
      author: str(row.author),
      image: str(row.image),
      categories: (Array.isArray(row.categories) ? row.categories : [])
        .map(str)
        .filter(Boolean),
    });
  }

  return [...bySlug.values()];
}

/** Hex's own spelling of the category, taken from the posts rather than the slug. */
function displayName(posts: Post[]): string {
  for (const p of posts) {
    const match = p.categories.find((c) => slugify(c) === CATEGORY);
    if (match) return match;
  }
  return "Engineering";
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
      description: clean(p.synopsis) || undefined,
      author: p.author ? [{ name: clean(p.author) }] : undefined,
      category: p.categories.filter(Boolean).map((name) => ({
        name: clean(name),
      })),
      image: p.image || undefined,
    } as Item);
  }

  return out.rss2();
}

/** Hex canonicalises to a trailing slash; the bare form redirects here. */
function postUrl(slug: string): string {
  return `${SITE}/blog/${slug}/`;
}

/** Editor-entered text can carry stray whitespace the rendered page trimmed. */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-|-$/g,
    "",
  );
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
