/**
 * RSS feed for the Engineering tag on the PostHog blog.
 *
 * Source: https://posthog.com/blog?tag=Engineering
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves that
 * tag, newest first.
 *
 * PostHog does publish https://posthog.com/rss.xml, and it is a good feed —
 * 279 posts with full <content:encoded> bodies — but it carries no <category>
 * on any item, so there is no way to reduce it to the Engineering tag. The
 * site's own listing does not read that feed either.
 *
 * posthog.com is Gatsby, but the tag filter is not in the static build: the
 * page-data for /blog is a stub and the static queries behind it hold docs
 * slugs. The listing is fetched in the browser from **Strapi Cloud**, and this
 * asks it the same question the page does, filter and all. One request returns
 * every field the feed needs, so there is no per-post fetch.
 *
 * The Strapi host below is the one the site ships to every browser. Responses
 * are Strapi v4 shaped — `{ data: [{ id, attributes }] }` with each relation
 * wrapped in its own `{ data: … }` — which is what `unwrap` is for.
 */

import { Feed, type Item } from "feed";

const SITE = "https://posthog.com";
const STRAPI = "https://better-animal-d658c56969.strapiapp.com/api/posts";

/** PostHog's own spelling of the tag, which is what the filter matches. */
const TAG = "Engineering";
const TAG_URL = `${SITE}/blog?tag=${encodeURIComponent(TAG)}`;
/** One request, comfortably clear of the tag's ~58 posts. */
const PAGE_SIZE = 100;

/**
 * How long a reader or CDN may reuse a response. These blogs publish a handful
 * of times a month and FreshRSS polls at most hourly, so a long window costs
 * nothing in freshness and is the only caching left in these vals — the
 * in-memory kind never survived val.town recycling an idle isolate.
 */
const CACHE_SECONDS = 12 * 60 * 60;

export interface Post {
  /** Stored with a leading slash and its section, e.g. "/newsletter/foo". */
  path: string;
  title: string;
  excerpt: string;
  /** Publication time in ms, or null when the record carried no usable date. */
  ts: number | null;
  author: string;
  image: string;
  imageType: string;
  /** PostHog's own labels: the post's category first, then its tags. */
  labels: string[];
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    posts = extractPosts(await query());
  } catch (err) {
    return text(502, `Failed to fetch ${STRAPI}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: `PostHog — ${TAG}`,
    description: `Posts tagged “${TAG}” on the PostHog blog.`,
    siteLink: TAG_URL,
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
 * The tag's posts, newest first.
 *
 * The `$or` on folder is the site's own: PostHog files these under several
 * sections — newsletter, blog, product-engineers, founders — and the listing
 * gathers anything whose category *or* crosspost category sits in the blog
 * folder. Keeping it means the feed holds the same set the page shows.
 */
function queryUrl(): string {
  const params = new URLSearchParams([
    ["populate[0]", "featuredImage"],
    ["populate[1]", "post_category"],
    ["populate[2]", "authors"],
    ["populate[3]", "post_tags"],
    ["sort[0]", "date:desc"],
    ["pagination[start]", "0"],
    ["pagination[limit]", String(PAGE_SIZE)],
    ["filters[$and][0][$or][0][post_category][folder][$eq]", "blog"],
    ["filters[$and][0][$or][1][crosspost_categories][folder][$eq]", "blog"],
    ["filters[$and][1][post_tags][label][$in][0]", TAG],
  ]);
  return `${STRAPI}?${params}`;
}

async function query(): Promise<unknown> {
  const res = await fetch(queryUrl(), {
    headers: {
      "user-agent": "posthog-rss-bridge (+https://val.town)",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Reads the Strapi response.
 *
 * The query is already tag-filtered, but each post is checked again, so a
 * stray one stays out if that filter ever loosens.
 */
export function extractPosts(payload: unknown): Post[] {
  const byPath = new Map<string, Post>();

  for (const entry of list(obj(payload)?.data)) {
    const fields = obj(entry.attributes);
    const path = str(fields?.slug);
    const title = str(fields?.title);
    if (!path || !title || byPath.has(path)) continue;

    const tags = many(fields?.post_tags).map((t) => str(t.label)).filter(
      Boolean,
    );
    if (!tags.includes(TAG)) continue;

    // `date` is the editorial publication date; `publishedAt` is when the
    // record entered Strapi, which for a backfilled post is years later.
    const ts = Date.parse(str(fields?.date));
    const image = obj(one(fields?.featuredImage)) ?? obj(fields?.featuredImage);
    const category = str(obj(one(fields?.post_category))?.label);

    byPath.set(path, {
      path,
      title,
      excerpt: str(fields?.excerpt),
      ts: Number.isFinite(ts) ? ts : null,
      author: many(fields?.authors)
        .map((a) =>
          [str(a.firstName), str(a.lastName)].filter(Boolean).join(" ")
        )
        .filter(Boolean)
        .join(" & "),
      image: str(image?.url),
      imageType: mediaType(str(image?.url)),
      labels: [category, ...tags].filter(Boolean),
    });
  }

  return [...byPath.values()];
}

/**
 * Strapi v4 wraps every relation as `{ data: … }`, where `data` is one object
 * for a single relation and an array for a repeatable one, each carrying its
 * own `attributes`. These two unwrap that so the callers above read fields
 * rather than plumbing.
 */
function one(relation: unknown): Record<string, unknown> | null {
  const inner = obj(obj(relation)?.data);
  return inner ? obj(inner.attributes) ?? inner : null;
}

function many(relation: unknown): Record<string, unknown>[] {
  const wrapped = obj(relation);
  const inner = wrapped && "data" in wrapped ? wrapped.data : relation;
  return list(inner).map((x) => obj(x.attributes) ?? x);
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
      link: postUrl(p.path),
      // `date` is typed as required but is optional at runtime; an item without
      // one simply gets no <pubDate>, which is right for a post we could not date.
      ...(p.ts !== null ? { date: new Date(p.ts) } : {}),
      description: clean(p.excerpt) || undefined,
      author: p.author ? [{ name: clean(p.author) }] : undefined,
      category: p.labels.map((name) => ({ name: clean(name) })),
      image: p.image
        ? { url: p.image, type: p.imageType || undefined }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

/** Paths are stored absolute; PostHog serves each post from the site root. */
function postUrl(path: string): string {
  return `${SITE}${path}`;
}

/**
 * The image's media type, or "" when the URL does not say.
 *
 * Worth stating rather than leaving to the library, which would guess
 * "image/jpg" — not a real type — from a .jpg. Most of these URLs carry an
 * extension; a few are Cloudinary transformations that name the format in the
 * path instead (`/f_webp,w_3627/…`), and a couple are bare public ids that give
 * nothing away. Returning "" for those is deliberate: an enclosure with no type
 * is honest, where a wrong one would be worse. It does cost the thumbnail in
 * FreshRSS, which decides an enclosure is an image by its mime type.
 */
function mediaType(url: string): string {
  const format = /\/f_([a-z0-9]+)[,/]/i.exec(url)?.[1] ??
    /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1];
  if (!format) return "";
  const ext = format.toLowerCase();
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : null;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(obj).filter((x) => x !== null) : [];
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
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
