/**
 * RSS feed for the Notion Tech & Engineering Blog.
 *
 * Source: https://www.notion.com/blog/topic/tech
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves
 * the latest technical deep dives from Notion, newest first.
 *
 * Notion publishes no feed of its own (/blog/feed, /feed, and /rss.xml all 404).
 *
 * The blog is a Next.js front end powered by Contentful. The topic page
 * server-renders its engineering/tech articles into `<script id="__NEXT_DATA__">`:
 * title, subtitle, slug, publication date, author bylines, topic tags, and
 * hero thumbnail are all present in that single HTML payload.
 */

import { Feed, type Item } from "feed";

const SITE = "https://www.notion.com";
const TOPIC_URL = `${SITE}/blog/topic/tech`;

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
    return text(502, `Failed to fetch ${TOPIC_URL}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: "Notion Engineering Blog",
    description:
      "How we're building Notion, block by block: architecture, systems, and engineering craft.",
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
      "user-agent": "notion-rss-bridge (+https://val.town)",
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
    const fields = obj(entry.fields);
    if (!fields) continue;

    const slug = str(fields.slug).trim();
    const title = str(fields.title).trim();
    if (!slug || !title || bySlug.has(slug)) continue;

    const subtitle = str(fields.subtitle).trim();

    // Authors
    const people = list(fields.people);
    const authorNames = people
      .map((p) => str(obj(p.fields)?.name).trim())
      .filter(Boolean);
    const author = authorNames.join(", ");

    // Topics / Categories
    const topicList = list(fields.topic);
    const categories = topicList
      .map((t) => str(obj(t.fields)?.title).trim())
      .filter(Boolean);
    if (!categories.includes("Engineering") && !categories.includes("Tech")) {
      categories.unshift("Tech");
    }

    // Thumbnail & date
    const thumbnail = obj(fields.thumbnail);
    const thumbFile = obj(obj(thumbnail?.fields)?.file);
    let image = str(thumbFile?.url).trim();
    if (image.startsWith("//")) image = `https:${image}`;
    const imageType =
      str(thumbFile?.contentType).trim() || (image ? mediaType(image) : "");

    // Creation date from thumbnail or sys
    const thumbSys = obj(thumbnail?.sys);
    const rawDate = str(thumbSys?.createdAt) || str(obj(entry.sys)?.createdAt);
    const ts = parseDate(rawDate);

    bySlug.set(slug, {
      slug,
      title,
      description: subtitle,
      ts,
      author,
      image,
      imageType,
      categories,
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

export function postUrl(slug: string): string {
  if (slug.startsWith("http://") || slug.startsWith("https://")) return slug;
  return `${SITE}/blog/${slug.replace(/^\/+/, "")}`;
}

export function mediaType(url: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (ext) return `image/${ext === "jpg" ? "jpeg" : ext}`;
  return "image/jpeg";
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
