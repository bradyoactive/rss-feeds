/**
 * RSS feed for the “Technical” tag on the Harvey blog.
 *
 * Source: https://www.harvey.ai/blog/tag/technical
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves every
 * post carrying that tag, newest first.
 *
 * Harvey publishes no feed of its own, and its blog is a Next.js front end over
 * Sanity. The rendered page is a poor source: post records ride in the App
 * Router flight chunks, the cards carry no summary or byline at all, and the
 * tag paginates. Reading it cost one fetch for the listing plus one per post
 * for the summary, and even then covered only the first page.
 *
 * So the posts come from Sanity's public read API instead — the same project
 * and dataset the site's own images are served from, which is where the project
 * id below comes from (`cdn.sanity.io/images/07s0r5r6/production/…`). One GROQ
 * query returns every field the feed needs for the whole tag, so there is no
 * per-post fetch and no pagination to follow.
 *
 * It is also the more complete source: a post bylined to a group rather than a
 * person — "Harvey Team" — has no JSON-LD `Person` node on its page, so the old
 * scraper dropped four bylines that this returns.
 */

import { Feed, type Item } from "feed";

const SITE = "https://www.harvey.ai";
const BLOG = `${SITE}/blog`;
const TAG = "technical";
const TAG_URL = `${BLOG}/tag/${TAG}`;
/** Every post here is in the tag by construction, so the label is a constant. */
const TAG_LABEL = "Technical";

const PROJECT = "07s0r5r6";
const DATASET = "production";
/** Pinned: Sanity dates its API, and an unpinned version is a silent upgrade. */
const API_VERSION = "v2021-10-21";
/** apicdn is the cached host; the plain api. host is rate-limited harder. */
const SANITY_URL = `https://${PROJECT}.apicdn.sanity.io/${API_VERSION}/data/query/${DATASET}`;
/** One request, comfortably clear of the tag's ~41 posts. */
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
  /** Publication time in ms, or null when the record carried no usable date. */
  ts: number | null;
  description: string;
  image: string;
  authors: string[];
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
export function buildFeed(items: Post[], url: URL): Response {
  const xml = renderRss({
    title: `Harvey Blog — ${TAG_LABEL}`,
    description: `Posts tagged “${TAG_LABEL}” on the Harvey blog.`,
    siteLink: TAG_URL,
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
 * Every post in the tag, newest first, with its byline and summary resolved.
 *
 * `references(*[…]._id)` looks the tag up by slug in the same round trip, so
 * nothing here depends on a document id that a rebuild could change, and
 * `isHidden != true` keeps retired posts out — Sanity holds them where the
 * rendered page had already filtered them away.
 */
const GROQ = `*[_type=="blogPost"
    && references(*[_type=="blogTag" && slug.current=="${TAG}"]._id)
    && isHidden != true]
  | order(body.publishedAt desc) [0...${PAGE_SIZE}] {
    "slug": body.slug.current,
    "title": body.title,
    "publishedAt": body.publishedAt,
    "description": body.description,
    "image": body.thumbnail.asset->url,
    "authors": body.postAuthors[]->name
  }`;

async function query(): Promise<unknown> {
  const res = await fetch(`${SANITY_URL}?query=${encodeURIComponent(GROQ)}`, {
    headers: {
      "user-agent": "harvey-rss-bridge (+https://val.town)",
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

    const ts = Date.parse(str(row.publishedAt));

    bySlug.set(slug, {
      slug,
      title,
      ts: Number.isFinite(ts) ? ts : null,
      description: str(row.description),
      image: withAutoFormat(str(row.image)),
      authors: (Array.isArray(row.authors) ? row.authors : [])
        .map(str)
        .filter(Boolean),
    });
  }

  return [...bySlug.values()];
}

/**
 * Sanity serves the original asset. `auto=format` is what gets a reader WebP
 * instead of the source PNG, and is what the site's own pages ask for.
 */
function withAutoFormat(url: string): string {
  if (!url) return "";
  return url.includes("?") ? `${url}&auto=format` : `${url}?auto=format`;
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
      description: clean(p.description) || undefined,
      author: p.authors.length
        ? p.authors.map((name) => ({ name: clean(name) }))
        : undefined,
      category: [{ name: TAG_LABEL }],
      image: p.image || undefined,
    } as Item);
  }

  return out.rss2();
}

/** Locale-free form: /en-US/blog/<slug> redirects here, and og:url uses it. */
function postUrl(slug: string): string {
  return `${BLOG}/${slug}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
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
