/**
 * RSS feed for the Software Engineering topic on the Honeycomb blog.
 *
 * Source: https://www.honeycomb.io/blog?topic=Software+Engineering
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves that
 * topic, newest first.
 *
 * Honeycomb does publish https://www.honeycomb.io/feed, but it is the whole
 * blog — 50 items, no <category> on any of them — so it cannot be narrowed to
 * a topic. The site is a Next.js front end over Sanity, and that dataset is
 * world-readable, so the posts come from one GROQ query instead.
 *
 * The topic is resolved by slug inside the query rather than by its document
 * id, so the feed keeps working if Honeycomb rebuilds it. Matching on the
 * *title* would be worse than it looks: two different topic documents are both
 * titled "AI & LLMs", so titles are not unique in this dataset.
 *
 * One wrinkle worth naming: the image is nested a level deeper than the usual
 * Sanity shape. `mainImage` is an `assetImage` wrapper, so the asset is at
 * `mainImage.image.asset`, and reading `mainImage.asset` returns null for
 * every article rather than failing.
 */

import { Feed, type Item } from "npm:feed@6.0.0";

const SITE = "https://www.honeycomb.io";
const TOPIC = "Software Engineering";
const TOPIC_SLUG = "software-engineering";
const TOPIC_URL = `${SITE}/blog?topic=${encodeURIComponent(TOPIC)}`;

const PROJECT = "927dxq0h";
const DATASET = "production";
/** Pinned: Sanity dates its API, and an unpinned version is a silent upgrade. */
const API_VERSION = "v2021-10-21";
/** apicdn is the cached host; the plain api. host is rate-limited harder. */
const SANITY_URL =
  `https://${PROJECT}.apicdn.sanity.io/${API_VERSION}/data/query/${DATASET}`;
/** One request. The topic has ~100 articles of the dataset's 656. */
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
  summary: string;
  /** Publication time in ms, or null when the record carried no usable date. */
  ts: number | null;
  author: string;
  image: string;
  /** Sanity states the asset's media type, so it is never guessed. */
  imageType: string;
  /** Honeycomb's own topic names, e.g. ["Software Engineering", "AI & LLMs"]. */
  topics: string[];
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
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: `Honeycomb — ${TOPIC}`,
    description: `Posts in the “${TOPIC}” topic of the Honeycomb blog.`,
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

/**
 * Every article carrying the topic, newest first.
 *
 * `references(*[…]._id)` looks the topic up by slug in the same round trip, so
 * nothing here depends on a document id a rebuild could change. `coalesce`
 * walks the three places an image can live, in the order the site prefers.
 */
export const GROQ = `*[_type=="blogArticle"
    && references(*[_type=="topic" && slug.current=="${TOPIC_SLUG}"]._id)]
  | order(publishedAt desc) [0...${PAGE_SIZE}] {
    "slug": slug.current,
    title,
    publishedAt,
    summary,
    "author": author->fullName,
    "topics": topics[]->title,
    "image": coalesce(mainImage.image.asset->url, featuredImage.image.asset->url, seo.metaImage.asset->url),
    "imageType": coalesce(mainImage.image.asset->mimeType, featuredImage.image.asset->mimeType, seo.metaImage.asset->mimeType)
  }`;

async function query(): Promise<unknown> {
  const res = await fetch(`${SANITY_URL}?query=${encodeURIComponent(GROQ)}`, {
    headers: {
      "user-agent": "honeycomb-rss-bridge (+https://val.town)",
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

    // publishedAt is a Z-suffixed instant, so Date.parse reads it as UTC.
    const ts = Date.parse(str(row.publishedAt));

    bySlug.set(slug, {
      slug,
      title,
      summary: str(row.summary),
      ts: Number.isFinite(ts) ? ts : null,
      author: str(row.author),
      image: str(row.image),
      imageType: str(row.imageType),
      topics: (Array.isArray(row.topics) ? row.topics : []).map(str).filter(
        Boolean,
      ),
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
      link: postUrl(p.slug),
      // `date` is typed as required but is optional at runtime; an item without
      // one simply gets no <pubDate>, which is right for a post we could not date.
      ...(p.ts !== null ? { date: new Date(p.ts) } : {}),
      description: clean(p.summary) || undefined,
      author: p.author ? [{ name: clean(p.author) }] : undefined,
      category: p.topics.map((name) => ({ name: clean(name) })),
      image: p.image
        ? { url: p.image, type: p.imageType || undefined }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

function postUrl(slug: string): string {
  return `${SITE}/blog/${slug}`;
}

/** Editor-entered text can carry stray whitespace the rendered page trimmed. */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Strips the characters that are illegal in XML 1.0. The feed library escapes
 * CDATA breakouts correctly but passes control characters through untouched,
 * and a single one anywhere would make the whole document unparseable — not
 * just its own item.
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
