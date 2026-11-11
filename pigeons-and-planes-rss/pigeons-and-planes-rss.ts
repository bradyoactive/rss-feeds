/**
 * RSS feed for Pigeons & Planes.
 *
 * Source: https://www.pigeonsandplanes.com
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves the
 * site's latest posts, newest first.
 *
 * The site is a Next.js front end over Sanity, and it proxies its own GROQ
 * queries through `/api/sanity?query=…` rather than exposing the project
 * directly — so the query below is the site's own read path, not a private API.
 * The projection asks for exactly the fields the feed renders, and lets
 * Sanity do the flattening that would otherwise have to happen here:
 * `coalesce(headlineRich[0].children[0].text, headline)` collapses the rich
 * headline to text with the plain headline as a fallback, `authors[]->name`
 * comes back as bare strings, and `thumbnail.asset->url` resolves the image
 * reference in the same round trip. Projecting server-side is also what keeps
 * this cheap: asking for the documents whole pulls `body` and `pageContent`
 * too, which is 452 KB per request against 9.7 KB for this.
 *
 * This val used to answer `?format=rss|atom|json`. It was the only feed in the
 * collection that did, nothing subscribes to the other two, and Atom cost real
 * complexity for it — its spec makes entry <updated> mandatory where RSS's
 * <pubDate> is optional, so the undated post below had to be dropped from Atom
 * alone. RSS only, like every other val here.
 *
 * Two things this feed has to defend against, both present in today's payload:
 *
 *  - **`publishedAt` can be null.** At least one live post carries no date at
 *    all, and `order(publishedAt desc)` sorts those to the *front*. Handing
 *    that to `new Date()` yields the epoch, so the post arrives dated
 *    1 January 1970 and drags the channel's own `updated` back with it. A post
 *    that cannot be dated gets no <pubDate> here and sorts last.
 *  - **Rows are not guaranteed complete.** Every field below is read
 *    defensively; a row missing a title or a slug is dropped rather than
 *    throwing, because an unguarded read takes down the whole feed and not
 *    just its own item.
 */

import { Feed, type Item } from "feed";

const SITE = "https://www.pigeonsandplanes.com";
const TITLE = "Pigeons & Planes";
const DESCRIPTION =
  "The latest music news and album drops from Pigeons & Planes.";

/** Comfortably more than the front page shows, still one small request. */
const PAGE_SIZE = 20;

/**
 * How long a reader or CDN may reuse a response. These blogs publish a handful
 * of times a month and FreshRSS polls at most hourly, so a long window costs
 * nothing in freshness.
 */
const CACHE_SECONDS = 12 * 60 * 60;

export interface Post {
  title: string;
  /** The `alias.current` slug; P&P serves posts at /read/<slug>. */
  slug: string;
  description: string;
  /** Publication time in ms, or null when the record carried no usable date. */
  ts: number | null;
  image: string;
  /** Sanity states the asset's media type, so it is never guessed. */
  imageType: string;
  authors: string[];
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    posts = extractPosts(await query());
  } catch (err) {
    return text(502, `Failed to fetch ${SITE}/api/sanity: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  // Undated posts sort last rather than to the front, which is where the
  // upstream ordering puts them.
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: TITLE,
    description: DESCRIPTION,
    siteLink: SITE,
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
 * The seven fields the feed renders, flattened by Sanity rather than here.
 * `hidePost != true` keeps retired posts out, matching what the site shows.
 */
const GROQ = `*[_type == "post" && hidePost != true]
  | order(publishedAt desc) [0...${PAGE_SIZE}] {
    "title": coalesce(headlineRich[0].children[0].text, headline),
    "slug": alias.current,
    description,
    publishedAt,
    "image": thumbnail.asset->url,
    "imageType": thumbnail.asset->mimeType,
    "authors": authors[]->name
  }`;

async function query(): Promise<unknown> {
  const res = await fetch(
    `${SITE}/api/sanity?query=${encodeURIComponent(GROQ)}`,
    {
      headers: {
        "user-agent": "pigeons-rss-bridge (+https://val.town)",
        accept: "application/json",
      },
    },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

/**
 * Reads the query result. The proxy hands back the bare array; `result` is
 * accepted too so this still reads a raw Sanity response if the route changes.
 */
export function extractPosts(payload: unknown): Post[] {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { result?: unknown })?.result)
    ? (payload as { result: unknown[] }).result
    : [];

  const bySlug = new Map<string, Post>();

  for (const raw of rows) {
    const row = obj(raw);
    const slug = str(row.slug);
    const title = str(row.title);
    if (!slug || !title || bySlug.has(slug)) continue;

    const ts = Date.parse(str(row.publishedAt));

    bySlug.set(slug, {
      title,
      slug,
      description: str(row.description),
      ts: Number.isFinite(ts) ? ts : null,
      image: str(row.image),
      imageType: str(row.imageType),
      // `authors[]->name` projects to strings. The version of this val that
      // read `.name` off each one instead put no byline in the feed at all.
      authors: list(row.authors).map(str).filter(Boolean),
    });
  }

  return [...bySlug.values()];
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
      // This val used to pass the Sanity `_id` here, which is why the
      // projection no longer asks for one.
      link: postUrl(p.slug),
      ...(p.ts !== null ? { date: new Date(p.ts) } : {}),
      description: clean(p.description) || undefined,
      image: p.image
        ? { url: p.image, type: p.imageType || undefined }
        : undefined,
      author: p.authors.length
        ? p.authors.map((name) => ({ name: clean(name) }))
        : undefined,
    } as Item);
  }

  return out.rss2();
}

function postUrl(slug: string): string {
  return `${SITE}/read/${slug}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? v as Record<string, unknown>
    : {};
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
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
