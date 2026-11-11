/**
 * RSS feed for the Engineering hub of the Rippling blog.
 *
 * Source: https://www.rippling.com/blog/hub/engineering
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves that
 * hub, newest first.
 *
 * Rippling publishes no feed of its own (/blog/rss.xml, /blog/feed and friends
 * all 404). The hub page is Next.js, but the post list is not in the
 * server-rendered HTML: `__NEXT_DATA__` carries only six `recentHubBlogPosts`
 * and the real listing is fetched in the browser from Algolia InstantSearch. So
 * this asks Algolia the same question the page does — it is the site's own data
 * source, and one request returns every field the feed needs (title, excerpt,
 * date, authors, and a Contentful image complete with its media type), so
 * unlike the other bridges here there is no per-post fetch at all.
 *
 * The application id and API key below are the search-only, read-only
 * credentials Rippling hands to every browser that loads the blog. They ship in
 * a client JS chunk rather than in the SSR HTML, so there is nothing to lift
 * them out of at request time and they are baked in as constants.
 */

import { Feed, type Item } from "npm:feed@6.0.0";

const SITE = "https://www.rippling.com";
const ALGOLIA_APP_ID = "6FNAX3TBEF";
const ALGOLIA_API_KEY = "416caa4690f002ff6fe4a2097623640b";
const ALGOLIA_INDEX = "blog_en-US_production";
const ALGOLIA_URL =
  `https://${ALGOLIA_APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/${ALGOLIA_INDEX}/query`;

/** Rippling's own spelling of the hub, which is what the filter matches. */
const HUB = "Engineering";
const HUB_URL = `${SITE}/blog/hub/engineering`;
const FACET = "hubs.name";
/** One request, comfortably clear of the hub's ~43 posts. */
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
  description: string;
  /** Publication time in ms, or null when `publishedDate` was absent or unreadable. */
  ts: number | null;
  author: string;
  image: string;
  /** Contentful states the image's media type, so it is never guessed from the URL. */
  imageType: string;
  /** Rippling's own taxonomy. A post can sit in several hubs at once. */
  hubs: string[];
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    posts = extractPosts(await query());
  } catch (err) {
    return text(502, `Failed to fetch ${ALGOLIA_URL}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: `Rippling Blog — ${HUB}`,
    description: `Posts in the “${HUB}” hub of the Rippling blog.`,
    siteLink: HUB_URL,
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
 * Reads the hub-filtered Algolia response.
 *
 * The query is already server-filtered, but each hit is checked against the hub
 * again, so a stray post stays out if that filter ever loosens.
 */
export function extractPosts(payload: unknown): Post[] {
  const bySlug = new Map<string, Post>();

  for (const hit of list((payload as Record<string, unknown>)?.hits)) {
    const slug = str(hit.slug);
    const title = str(hit.title);
    if (!slug || !title || bySlug.has(slug)) continue;

    // A post can sit in several hubs at once, so this is a membership test.
    const hubs = list(hit.hubs).map((h) => str(h.name)).filter(Boolean);
    if (!hubs.includes(HUB)) continue;

    const file = obj(obj(obj(hit.featuredImage)?.fields)?.file);

    bySlug.set(slug, {
      slug,
      title,
      description: str(hit.excerpt),
      ts: parseDate(hit.publishedDate),
      author: list(hit.authors).map((a) => str(a.fullName) || str(a.name))
        .filter(Boolean).join(" & "),
      image: absolute(str(file?.url)),
      imageType: str(file?.contentType),
      hubs,
    });
  }

  return [...bySlug.values()];
}

/**
 * The hub's posts. JSON.stringify quotes and escapes the name, so a hub
 * containing a quote could not break out of the filter expression.
 */
async function query(): Promise<unknown> {
  const res = await fetch(ALGOLIA_URL, {
    method: "POST",
    headers: {
      "x-algolia-application-id": ALGOLIA_APP_ID,
      "x-algolia-api-key": ALGOLIA_API_KEY,
      "content-type": "application/json",
      "user-agent": "rippling-rss-bridge (+https://val.town)",
    },
    body: JSON.stringify({
      query: "",
      hitsPerPage: PAGE_SIZE,
      filters: `${FACET}:${JSON.stringify(HUB)}`,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${ALGOLIA_URL}`);
  return res.json();
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
      author: p.author ? [{ name: clean(p.author) }] : undefined,
      category: p.hubs.filter(Boolean).map((name) => ({ name: clean(name) })),
      // Contentful states the media type, so pass it rather than let the
      // library guess from the URL.
      image: p.image
        ? { url: p.image, type: p.imageType || undefined }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

/** Contentful asset URLs are protocol-relative: `//images.ctfassets.net/…`. */
function absolute(url: string): string {
  return url.startsWith("//") ? `https:${url}` : url;
}

/**
 * `publishedDate` comes in two shapes from the same index: date-only
 * "2026-08-13" and a naive datetime "2025-04-30T11:23:33" carrying no zone.
 * Date.parse reads the first as UTC and the second as *local* time, which would
 * shift a post by hours depending on where the val happens to run, so both are
 * pinned to UTC here. Anything that does state a zone falls through to
 * Date.parse, which already handles it correctly.
 */
function parseDate(v: unknown): number | null {
  const s = str(v).trim();
  const naive = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?$/
    .exec(s);
  if (naive) {
    // The time groups are absent on the date-only shape, hence the `|| 0`.
    const [y, mo, d, h, mi, sec] = naive.slice(1).map(Number);
    return Date.UTC(y, mo - 1, d, h || 0, mi || 0, sec || 0);
  }
  const ts = Date.parse(s);
  return Number.isFinite(ts) ? ts : null;
}

function postUrl(slug: string): string {
  return `${SITE}/blog/${slug}`;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : null;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(obj).filter((x) => x !== null) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Strips the characters that are illegal in XML 1.0. The feed library escapes
 * CDATA breakouts correctly but passes control characters through untouched,
 * and a single one anywhere would make the whole document unparseable — not
 * just its own item. Scraped titles are exactly where one would come from.
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
