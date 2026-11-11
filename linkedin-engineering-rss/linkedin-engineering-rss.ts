/**
 * RSS feed for the LinkedIn Engineering Blog.
 *
 * Source: https://www.linkedin.com/blog/engineering
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves
 * the latest technical articles, distributed systems architectures, and AI
 * innovations from LinkedIn, newest first.
 *
 * LinkedIn deprecated its legacy native RSS endpoints (/blog.rss and
 * /blog.rss.html both 404).
 *
 * The official blog portal publishes grid cards with post links, titles,
 * author bylines, publication dates, and topic categories.
 */

import { Feed, type Item } from "feed";

const SITE = "https://www.linkedin.com";
const BLOG_URL = `${SITE}/blog/engineering`;

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
  categories: string[];
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    posts = extractPosts(await fetchPage());
  } catch (err) {
    return text(502, `Failed to fetch ${BLOG_URL}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: "LinkedIn Engineering Blog",
    description:
      "Engineering insights, scalable infrastructure, distributed systems, and AI from LinkedIn.",
    siteLink: BLOG_URL,
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
  const res = await fetch(BLOG_URL, {
    headers: {
      "user-agent": "linkedin-rss-bridge (+https://val.town)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${BLOG_URL}`);
  return res.text();
}

/**
 * Extracts post records from grid items in the blog HTML.
 */
export function extractPosts(html: string): Post[] {
  const postItems = html.match(
    /<li[^>]*class="[^"]*grid-post[^"]*"[\s\S]*?<\/li>/g,
  );
  if (!postItems || postItems.length === 0) {
    throw new Error("Could not find grid-post elements in LinkedIn blog HTML");
  }

  const byUrl = new Map<string, Post>();

  for (const itemHtml of postItems) {
    const linkMatch = itemHtml.match(
      /class="[^"]*grid-post__link[^"]*"[^>]*href="([^"]+)"[\s\S]*?>([\s\S]*?)<\/a>/,
    );
    if (!linkMatch) continue;

    const rawUrl = linkMatch[1].trim();
    const url = normalizeUrl(rawUrl);
    if (!url || byUrl.has(url)) continue;

    const rawTitle = linkMatch[2];
    const title = decodeHtmlEntities(stripHtml(rawTitle)).trim();
    if (!title) continue;

    // Author
    const authorMatch = itemHtml.match(
      /class="[^"]*grid-post__author[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    );
    const author = authorMatch
      ? decodeHtmlEntities(stripHtml(authorMatch[1])).trim()
      : "LinkedIn Engineering";

    // Date
    const dateMatch = itemHtml.match(
      /class="[^"]*grid-post__date[^"]*"[^>]*>([\s\S]*?)<\/p>/,
    );
    const dateStr = dateMatch
      ? decodeHtmlEntities(stripHtml(dateMatch[1])).trim()
      : "";
    const ts = parseDate(dateStr);

    // Category extracted from URL path segment (e.g. /blog/engineering/infrastructure/...)
    const cat = extractCategory(url);
    const categories = cat ? ["Engineering", cat] : ["Engineering"];

    byUrl.set(url, {
      url,
      title,
      description: title,
      ts,
      author,
      categories,
    });
  }

  return [...byUrl.values()];
}

export function extractCategory(postUrl: string): string {
  const m = postUrl.match(/\/blog\/engineering\/([^\/]+)\//);
  if (!m) return "";
  const slug = m[1].toLowerCase();
  if (slug === "ai") return "AI";
  // Capitalize words separated by hyphens
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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
      link: p.url,
      ...(p.ts !== null ? { date: new Date(p.ts) } : {}),
      description: clean(p.description) || undefined,
      author: p.author ? [{ name: clean(p.author) }] : undefined,
      category: p.categories.map((name) => ({ name: clean(name) })),
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

export function normalizeUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return `${SITE}${url.startsWith("/") ? url : `/${url}`}`;
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
