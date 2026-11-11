/**
 * RSS feed for the Snap Engineering Blog.
 *
 * Source: https://eng.snap.com/blog
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves
 * the latest technical articles, AI models, and AR systems from Snap,
 * newest first.
 *
 * Snap publishes no feed of its own (/rss.xml and /feed.xml redirect to /404).
 *
 * The blog is a React client using Apollo Client and Contentful. All blog
 * articles, titles, publication dates, summaries, and Contentful media
 * assets are present in the `window.APOLLO_STATE` payload on the blog page.
 */

import { Feed, type Item } from "feed";

const SITE = "https://eng.snap.com";
const BLOG_URL = `${SITE}/blog`;

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
    return text(502, `Failed to fetch ${BLOG_URL}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: "Snap Engineering Blog",
    description:
      "Technical deep dives, augmented reality, spatial intelligence, and AI agents from Snap.",
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
      "user-agent": "snap-rss-bridge (+https://val.town)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${BLOG_URL}`);
  return res.text();
}

/**
 * Extracts post records from `window.APOLLO_STATE` in the page HTML.
 */
export function extractPosts(html: string): Post[] {
  const match = html.match(/window\.APOLLO_STATE\s*=\s*(\{[\s\S]*?\});/);
  if (!match) {
    throw new Error("Could not find window.APOLLO_STATE in page HTML");
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`Failed to parse APOLLO_STATE JSON: ${err}`);
  }

  const bySlug = new Map<string, Post>();

  for (const [_key, rawVal] of Object.entries(data)) {
    const val = obj(rawVal);
    if (!val || !val.slugReference) continue;

    const slugRef = str(obj(val.slugReference)?.__ref);
    const slugObj = obj(data[slugRef]);
    const slug = str(slugObj?.slug).trim();
    if (!slug || bySlug.has(slug)) continue;

    const typename = str(val.__typename);

    // Title
    let title = "";
    if (typename === "Tile") {
      title = extractRichText(obj(obj(val.title)?.json));
    } else if (typename === "CarouselCard") {
      title = str(val.subtitle);
    }
    if (!title) title = slug;

    // Description
    const description = extractRichText(obj(obj(val.label)?.json));

    // Date
    const rawDate = str(val.date) ||
      str(obj(data[str(obj(val.sys)?.__ref)])?.publishedAt);
    const ts = parseDate(rawDate);

    // Image
    let image = "";
    let imageType = "";
    const mediaRef = str(obj(val.media)?.__ref);
    if (mediaRef && data[mediaRef]) {
      const imgEntity = obj(data[mediaRef]);
      const asset = obj(imgEntity?.media);
      image = str(asset?.url).trim();
      imageType = str(asset?.contentType).trim();
    }
    if (image.startsWith("//")) image = `https:${image}`;
    if (image && !imageType) imageType = mediaType(image);

    // Categories
    const brand = str(val.brand).trim();
    const categories = ["Engineering"];
    if (brand && brand.toLowerCase() !== "engineering") {
      categories.push(brand.charAt(0).toUpperCase() + brand.slice(1));
    }

    bySlug.set(slug, {
      slug,
      title,
      description,
      ts,
      author: "Snap Engineering",
      image,
      imageType,
      categories,
    });
  }

  return [...bySlug.values()];
}

function extractRichText(doc: Record<string, unknown> | null): string {
  if (!doc) return "";
  const parts: string[] = [];
  function recurse(node: Record<string, unknown>) {
    if (node.value && typeof node.value === "string") {
      parts.push(node.value);
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        if (typeof child === "object" && child !== null) {
          recurse(child as Record<string, unknown>);
        }
      }
    }
  }
  recurse(doc);
  return parts.join(" ").trim();
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
  return `${SITE}/${slug.replace(/^\/+/, "")}`;
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

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
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
