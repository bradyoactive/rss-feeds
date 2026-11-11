/**
 * RSS feed for the Retool Engineering Blog.
 *
 * Source: https://retool.com/blog/category/engineering
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves
 * the latest technical articles, infrastructure deep dives, and architectural
 * case studies from Retool, newest first.
 *
 * Retool publishes no feed of its own (/blog/feed.xml and /rss.xml return 404).
 *
 * The blog is a Next.js App Router front end backed by Sanity CMS. The
 * engineering category page server-renders all engineering articles with
 * title, summary, author byline, publication date, and 16:9 hero image.
 */

import { Feed, type Item } from "feed";

const SITE = "https://retool.com";
const CATEGORY_URL = `${SITE}/blog/category/engineering`;

/**
 * How long a reader or CDN may reuse a response. Engineering blogs publish
 * periodically and feed aggregators poll at most hourly, so a 12-hour window
 * costs nothing in freshness and is the standard caching window across these vals.
 */
const CACHE_SECONDS = 12 * 60 * 60;

export interface Post {
  url: string;
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
    return text(502, `Failed to fetch ${CATEGORY_URL}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: "Retool Engineering Blog",
    description:
      "Engineering architecture, internal tooling systems, and developer platforms from Retool.",
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

async function fetchPage(): Promise<string> {
  const res = await fetch(CATEGORY_URL, {
    headers: {
      "user-agent": "retool-rss-bridge (+https://val.town)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${CATEGORY_URL}`);
  return res.text();
}

/**
 * Extracts post records from `blog-article-item` elements in the HTML.
 */
export function extractPosts(html: string): Post[] {
  const items = html.match(
    /<li[^>]*class="[^"]*blog-article-item[^"]*"[\s\S]*?<\/li>/g,
  );
  if (!items || items.length === 0) {
    throw new Error("Could not find blog-article-item elements in Retool HTML");
  }

  const byUrl = new Map<string, Post>();

  for (const itemHtml of items) {
    const linkMatch = itemHtml.match(
      /<a[^>]*class="[^"]*article-item-link[^"]*"[^>]*href="([^"]+)"[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/,
    );
    if (!linkMatch) continue;

    const rawUrl = linkMatch[1].trim();
    const url = normalizeUrl(rawUrl);
    if (!url || byUrl.has(url)) continue;

    const rawTitle = linkMatch[2];
    const title = decodeHtmlEntities(stripHtml(rawTitle)).trim();
    if (!title) continue;

    // Summary
    const summaryMatch = itemHtml.match(
      /<p\s+class="[^"]*text-body-sm[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    );
    const description = summaryMatch
      ? decodeHtmlEntities(stripHtml(summaryMatch[1])).trim()
      : "";

    // Authors
    const authorMatches = itemHtml.matchAll(
      /<a[^>]*href="[^"]*\/blog\/author\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g,
    );
    const authorNames: string[] = [];
    for (const m of authorMatches) {
      const name = decodeHtmlEntities(stripHtml(m[1])).trim();
      if (name && !authorNames.includes(name)) authorNames.push(name);
    }
    const author = authorNames.join(", ") || "Retool Engineering";

    // Date
    const timeMatch = itemHtml.match(/<time\s+dateTime="([^"]+)"/);
    const dateStr = timeMatch ? timeMatch[1].trim() : "";
    const ts = parseDate(dateStr);

    // Hero image (16:9 banner)
    let image = "";
    const heroMatch = itemHtml.match(
      /aspect-16\/9[\s\S]*?url=(https%3A%2F%2Fcdn\.sanity\.io[^\s&"'\\<]+)/,
    );
    if (heroMatch) {
      image = decodeURIComponent(heroMatch[1]);
    }
    const imageType = image ? mediaType(image) : "";

    byUrl.set(url, {
      url,
      title,
      description,
      ts,
      author,
      image,
      imageType,
      categories: ["Engineering"],
    });
  }

  return [...byUrl.values()];
}

export function renderRss(feed: {
  title: string;
  description: string;
  siteLink: string;
  feedUrl: string;
  items: Post[];
}): string {
  const dates = feed.items
    .map((p) => p.ts)
    .filter((ts): ts is number => ts !== null);

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
      link: p.url,
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
  const naive =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?$/.exec(s);
  if (naive) {
    const [y, mo, d, h, mi, sec] = naive.slice(1).map(Number);
    return Date.UTC(y, mo - 1, d, h || 0, mi || 0, sec || 0);
  }
  const ts = Date.parse(s);
  return Number.isFinite(ts) ? ts : null;
}

export function normalizeUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${SITE}${url.startsWith("/") ? url : `/${url}`}`;
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
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
