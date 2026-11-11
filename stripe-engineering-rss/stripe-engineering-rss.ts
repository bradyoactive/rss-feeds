/**
 * RSS feed for the Stripe Engineering & Developer Blog.
 *
 * Source: https://stripe.dev/blog/topic/engineering
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves
 * the latest technical articles, infrastructure deep dives, and engineering
 * insights from Stripe, newest first.
 *
 * Stripe publishes no feed of its own for engineering (/blog/feed.xml and
 * /feed.xml return 404).
 *
 * The blog is a Next.js front end on stripe.dev. The engineering topic page
 * server-renders the complete blog archive (every topic, 120+ posts) into
 * `<script id="__NEXT_DATA__">` and filters client-side: title, summary, slug,
 * publication date, authors list, and topic tags are present in that single
 * HTML payload. Only posts tagged "Engineering" make it into the feed.
 */

import { Feed, type Item } from "feed";

const SITE = "https://stripe.dev";
const TOPIC_URL = `${SITE}/blog/topic/engineering`;

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
  categories: string[];
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    posts = extractPosts(await fetchPage());
  } catch (err) {
    return text(502, `Failed to fetch ${TOPIC_URL}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: "Stripe Engineering Blog",
    description:
      "Engineering insights, infrastructure scaling, and technical architecture from Stripe.",
    siteLink: TOPIC_URL,
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
  const res = await fetch(TOPIC_URL, {
    headers: {
      "user-agent": "stripe-rss-bridge (+https://val.town)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${TOPIC_URL}`);
  return res.text();
}

/**
 * Extracts post records from the Next.js `__NEXT_DATA__` script tag.
 */
export function extractPosts(html: string): Post[] {
  const match = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/,
  );
  if (!match) throw new Error("Could not find __NEXT_DATA__ in page HTML");

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`Failed to parse __NEXT_DATA__ JSON: ${err}`);
  }

  const pageProps = obj(obj(payload.props)?.pageProps);
  const postsRaw = list(pageProps?.posts);

  const bySlug = new Map<string, Post>();

  for (const entry of postsRaw) {
    const slug = str(entry.slug).trim();
    const title = str(entry.title).trim();
    if (!slug || !title || bySlug.has(slug)) continue;

    const summary = str(entry.summary).trim();

    // Authors
    const authorsList = Array.isArray(entry.authors)
      ? entry.authors
          .map(str)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    const author = authorsList.join(", ") || "Stripe Engineering";

    // Categories / Topics. The payload holds every blog post, so keep only
    // the ones the topic page itself would show.
    const topics = Array.isArray(entry.topics)
      ? entry.topics
          .map(str)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (!topics.some((t) => t.toLowerCase() === "engineering")) continue;

    // Publication date
    const ts = parseDate(entry.date);

    bySlug.set(slug, {
      slug,
      title,
      description: summary,
      ts,
      author,
      categories: topics,
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
      link: postUrl(p.slug),
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
  const naive =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2}))?$/.exec(s);
  if (naive) {
    const [y, mo, d, h, mi, sec] = naive.slice(1).map(Number);
    return Date.UTC(y, mo - 1, d, h || 0, mi || 0, sec || 0);
  }
  const ts = Date.parse(s);
  return Number.isFinite(ts) ? ts : null;
}

export function postUrl(slug: string): string {
  if (slug.startsWith("http://") || slug.startsWith("https://")) return slug;
  return `${SITE}/blog/${slug.replace(/^\/+/, "")}`;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v)
    ? v.map(obj).filter((x): x is Record<string, unknown> => x !== null)
    : [];
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
