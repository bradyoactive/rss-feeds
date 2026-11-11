/**
 * RSS feed for the Engineering Spotlight on the Inside Asana blog.
 *
 * Source: https://asana.com/inside-asana/engineering-spotlight
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves the
 * Engineering Spotlight, newest first.
 *
 * Asana publishes no feed of its own (/inside-asana/feed, /feed, /blog/feed,
 * and /rss.xml all 404 or redirect to /inside-asana).
 *
 * The blog is a Next.js front end. The category page server-renders its entire
 * engineering archive into `<script id="__NEXT_DATA__">`: title, path, ISO
 * publication date, author byline, topic tags, and hero image for all 90+
 * posts are present in that single HTML payload. One request delivers the
 * complete feed without pagination or per-post fetches.
 *
 * Two details about this source:
 *
 *  - Post paths are usually `/inside-asana/<slug>`, but can occasionally point
 *    to other paths such as `/resources/<slug>` (e.g. `/resources/scaling-lunadb`).
 *    `postUrl` resolves both properly against the site root.
 *  - Image URLs come from Asana's transform CDN (`assets.asana.biz/transform/…`)
 *    without file extensions. `Feed` guesses the MIME type by reading after the
 *    last dot if `type` is omitted, which would emit invalid MIME types like
 *    `type="image//slug"`. Setting `imageType: "image/jpeg"` avoids this.
 */

import { Feed, type Item } from "npm:feed@6.0.0";

const SITE = "https://asana.com";
const CATEGORY_URL = `${SITE}/inside-asana/engineering-spotlight`;

/**
 * How long a reader or CDN may reuse a response. Engineering blogs publish
 * periodically and feed aggregators poll at most hourly, so a 12-hour window
 * costs nothing in freshness and is the standard caching window across these vals.
 */
const CACHE_SECONDS = 12 * 60 * 60;

export interface Post {
  /** Relative path as Asana stores it, e.g. "/inside-asana/database-architecture-sharding-scaling". */
  path: string;
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
    title: "Asana Engineering Blog",
    description:
      "Engineering spotlights, architecture, and technical insights from Asana.",
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
      "user-agent": "asana-rss-bridge (+https://val.town)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${CATEGORY_URL}`);
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

  const page = obj(obj(payload.props)?.pageProps)?.page as
    | Record<string, unknown>
    | null;
  const cards = list(obj(page?.pageTemplate)?.cards);

  const byPath = new Map<string, Post>();

  for (const card of cards) {
    const rawPath = str(card.url).trim();
    const title = str(card.title).trim();
    if (!rawPath || !title || byPath.has(rawPath)) continue;

    const ts = parseDate(card.publishDateRaw);

    const contributor = obj(card.contributor);
    const author = str(contributor?.fullName).trim();

    const mainTopic = str(obj(card.mainTopic)?.name);
    const secondary = list(card.secondaryTopics).map((t) => str(t.name));
    const categories = [mainTopic, ...secondary].filter(Boolean);

    const imageObj = obj(card.image);
    const image = str(imageObj?.src);

    byPath.set(rawPath, {
      path: rawPath,
      title,
      description: str(card.summary).trim(),
      ts,
      author,
      image,
      imageType: image ? mediaType(image) : "",
      categories,
    });
  }

  return [...byPath.values()];
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
      link: postUrl(p.path),
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

export function postUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${SITE}${path.startsWith("/") ? path : `/${path}`}`;
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
  // deno-lint-ignore no-control-regex
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
