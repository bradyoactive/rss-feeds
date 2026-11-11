/**
 * RSS feed for the Anthropic Engineering Blog.
 *
 * Source: https://www.anthropic.com/engineering
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves
 * the latest technical deep dives and engineering architecture posts from
 * Anthropic, newest first.
 *
 * Anthropic publishes no feed of its own for engineering (/engineering/feed,
 * /rss.xml, and /feed.xml return 404).
 *
 * The site is a Next.js App Router front end backed by Sanity CMS. The
 * engineering portal renders all posts into clean HTML article cards and
 * carries the exact publication dates in the RSC payload and `<time>` tags.
 */

import { Feed, type Item } from "npm:feed@6.0.0";

const SITE = "https://www.anthropic.com";
const ENGINEERING_URL = `${SITE}/engineering`;

/**
 * How long a reader or CDN may reuse a response. Engineering blogs publish
 * periodically and feed aggregators poll at most hourly, so a 12-hour window
 * costs nothing in freshness and is the standard caching window across these vals.
 */
const CACHE_SECONDS = 12 * 60 * 60;

export interface Post {
  slug: string;
  title: string;
  description: string;
  /** Publication timestamp in ms, or null if missing/unparseable. */
  ts: number | null;
  author: string;
  image: string;
  imageType: string;
  categories: string[];
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    posts = extractPosts(await fetchPage());
  } catch (err) {
    return text(502, `Failed to fetch ${ENGINEERING_URL}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: "Anthropic Engineering Blog",
    description:
      "Technical deep dives, systems architecture, and engineering methodologies from Anthropic.",
    siteLink: ENGINEERING_URL,
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

async function fetchPage(): Promise<string> {
  const res = await fetch(ENGINEERING_URL, {
    headers: {
      "user-agent": "anthropic-rss-bridge (+https://val.town)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${ENGINEERING_URL}`);
  return res.text();
}

/**
 * Extracts post records from the engineering portal HTML.
 */
export function extractPosts(html: string): Post[] {
  // Map slugs to publication dates from embedded Sanity/RSC payload
  const datesBySlug = extractDates(html);

  // Extract article elements
  const articleMatches = html.match(
    /<article\s+class="[^"]*ArticleList[^"]*"[\s\S]*?<\/article>/g,
  );
  if (!articleMatches || articleMatches.length === 0) {
    throw new Error(
      "Could not find article cards in Anthropic engineering page",
    );
  }

  const bySlug = new Map<string, Post>();

  for (const articleHtml of articleMatches) {
    const linkMatch = articleHtml.match(/href="\/engineering\/([^"?#]+)"/);
    if (!linkMatch) continue;
    const slug = linkMatch[1].trim();
    if (!slug || bySlug.has(slug)) continue;

    // Title
    const titleMatch = articleHtml.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/);
    const rawTitle = titleMatch ? titleMatch[1] : slug;
    const title = decodeHtmlEntities(stripHtml(rawTitle)).trim();

    // Summary
    const summaryMatch = articleHtml.match(
      /<p\s+class="[^"]*summary[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    );
    const description = summaryMatch
      ? decodeHtmlEntities(stripHtml(summaryMatch[1])).trim()
      : "";

    // Image
    const imgMatch = articleHtml.match(/<img[^>]*src="([^"]+)"/);
    const image = imgMatch ? imgMatch[1].trim() : "";
    const imageType = image ? mediaType(image) : "";

    // Date: check <time dateTime="..."> first, then fallback to datesBySlug
    const timeMatch = articleHtml.match(/<time\s+dateTime="([^"]+)"/);
    const rawDate = timeMatch ? timeMatch[1] : datesBySlug.get(slug);
    const ts = parseDate(rawDate);

    bySlug.set(slug, {
      slug,
      title,
      description,
      ts,
      author: "Anthropic Engineering",
      image,
      imageType,
      categories: ["Engineering", "AI"],
    });
  }

  return [...bySlug.values()];
}

/**
 * Extracts published dates from Sanity JSON pairs in the RSC payload.
 */
export function extractDates(html: string): Map<string, string> {
  const datesBySlug = new Map<string, string>();
  // Match \"publishedOn\":\"YYYY-MM-DD\" followed by slug
  const regex =
    /\\\"publishedOn\\\":\\\"([0-9-]+)\\\"[^}]*?\\\"slug\\\":\{\\\"_type\\\":\\\"slug\\\",\\\"current\\\":\\\"([^"\\]+)\\\"/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const [, date, slug] = match;
    datesBySlug.set(slug, date);
  }
  return datesBySlug;
}

export function renderRss(feed: {
  title: string;
  description: string;
  siteLink: string;
  feedUrl: string;
  items: Post[];
}): string {
  const dates = feed.items.map((p) => p.ts).filter((ts): ts is number =>
    ts !== null
  );

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
      link: postUrl(p.slug),
      ...(p.ts !== null ? { date: new Date(p.ts) } : {}),
      description: clean(p.description) || undefined,
      author: p.author ? [{ name: clean(p.author) }] : undefined,
      category: p.categories.map((name) => ({ name: clean(name) })),
      image: p.image
        ? { url: p.image, type: p.imageType || undefined }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

export function parseDate(v: unknown): number | null {
  const s = str(v).trim();
  if (!s) return null;
  const naive = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?$/
    .exec(s);
  if (naive) {
    const [y, mo, d, h, mi, sec] = naive.slice(1).map(Number);
    return Date.UTC(y, mo - 1, d, h || 0, mi || 0, sec || 0);
  }
  const ts = Date.parse(s);
  return Number.isFinite(ts) ? ts : null;
}

export function postUrl(slug: string): string {
  if (slug.startsWith("http://") || slug.startsWith("https://")) return slug;
  return `${SITE}/engineering/${slug.replace(/^\/+/, "")}`;
}

export function mediaType(url: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (ext) {
    if (ext === "svg") return "image/svg+xml";
    if (ext === "jpg") return "image/jpeg";
    return `image/${ext}`;
  }
  return "image/jpeg";
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Strips characters illegal in XML 1.0 (control characters).
 */
export function clean(s: string): string {
  // deno-lint-ignore no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
