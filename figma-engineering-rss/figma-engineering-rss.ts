/**
 * RSS feed for the “Engineering” tag of the Figma blog.
 *
 * Source: https://www.figma.com/blog/engineering/
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves that
 * tag, newest first.
 *
 * Figma does publish an Atom feed (/blog/feed/atom.xml) carrying the whole
 * archive, but it has no <category> on any entry, so filtering it meant
 * fetching each post's HTML and looking for “Engineering” in its tag list. That
 * is what this val used to do, over the five newest posts of the *whole* blog —
 * so in any week Figma published five non-engineering posts, the feed was empty.
 *
 * The posts come from the blog's own search index instead:
 * /blogSearch/blog-data.json, a static file the search page downloads and
 * queries in the browser. It holds every post ever published (737 at the time
 * of writing) with title, lede, publication date, authors, images and the full
 * tag list — so one request replaces the feed fetch plus a fetch per post, and
 * the whole Engineering back catalogue comes with it rather than five posts.
 *
 * It is ~4.6 MB of JSON, which sounds worse than it is: it is served brotli'd at
 * ~0.8 MB and answers in about a third of a second.
 *
 * The blog is a Next.js front end over Sanity (`cdn.sanity.io/images/599r6htc/…`),
 * but unlike Hex's and Harvey's that dataset is *not* world-readable — an
 * unauthenticated GROQ query returns an empty result rather than an error — so
 * the search index is the public door.
 */

import { Feed, type Item } from "feed";

const SITE = "https://www.figma.com";
/** The static index the blog's own search page downloads. */
const INDEX_URL = `${SITE}/blogSearch/blog-data.json`;

/** Tags are identified by their slug, which is the tag page's own path. */
const TAG_SLUG = "/blog/engineering/";
const TAG_URL = `${SITE}${TAG_SLUG}`;

/**
 * How long a reader or CDN may reuse a response. These blogs publish a handful
 * of times a month and FreshRSS polls at most hourly, so a long window costs
 * nothing in freshness and is the only caching left in these vals — the
 * in-memory kind never survived val.town recycling an idle isolate.
 */
const CACHE_SECONDS = 12 * 60 * 60;

export interface Post {
  /** Path as Figma stores it, e.g. "/blog/figma-rendering-powered-by-webgpu/". */
  path: string;
  title: string;
  lede: string;
  /** Publication time in ms, or null when the record carried no usable date. */
  ts: number | null;
  author: string;
  image: string;
  /** Sanity states the image's media type, so it is never guessed from the URL. */
  imageType: string;
  /** Figma's own labels: the post's category first, then its tags. */
  labels: string[];
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    posts = extractPosts(await fetchIndex());
  } catch (err) {
    return text(502, `Failed to fetch ${INDEX_URL}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const label = displayName(items);

  const xml = renderRss({
    title: `Figma Blog — ${label}`,
    description: `Posts tagged “${label}” on the Figma blog.`,
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

async function fetchIndex(): Promise<unknown> {
  const res = await fetch(INDEX_URL, {
    headers: {
      "user-agent": "figma-rss-bridge (+https://val.town)",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * The tagged posts, read out of the search index.
 *
 * Membership is tested on the tag's slug rather than its display name, so a
 * rename in the CMS cannot silently empty the feed — the slug is the tag page's
 * URL, which Figma would have to keep working anyway.
 */
export function extractPosts(payload: unknown): Post[] {
  const byPath = new Map<string, Post>();

  for (const row of list(payload)) {
    const path = str(obj(row.slug)?.current);
    const title = str(row.title);
    if (!path || !title || byPath.has(path)) continue;

    const labels = obj(row.labels);
    const tags = list(labels?.tags);
    if (!tags.some((t) => str(obj(t.slug)?.current) === TAG_SLUG)) continue;

    // Cards mostly carry their own crop; older posts only have the cover.
    const asset = imageAsset(row.cardMedia) ?? imageAsset(row.coverMedia);
    const ts = Date.parse(str(row.publicationDate));
    const category = str(obj(labels?.category)?.name);

    byPath.set(path, {
      path,
      title,
      lede: plainText(row.lede),
      ts: Number.isFinite(ts) ? ts : null,
      author: list(row.authors)
        .map((a) => str(a.name))
        .filter(Boolean)
        .join(" & "),
      image: str(asset?.url),
      imageType: str(asset?.mimeType),
      labels: [category, ...tags.map((t) => str(t.name))].filter(Boolean),
    });
  }

  return [...byPath.values()];
}

/** Figma's own spelling of the tag, taken from the posts rather than the slug. */
function displayName(posts: Post[]): string {
  for (const p of posts) {
    // The category leads `labels`, so the tag has to be matched by name shape
    // rather than by position — anything that slugifies to the tag path.
    const match = p.labels.find((l) => `/blog/${slugify(l)}/` === TAG_SLUG);
    if (match) return match;
  }
  return "Engineering";
}

/** The `sanity.imageAsset` behind a `media` field, when it holds an image. */
function imageAsset(media: unknown): Record<string, unknown> | null {
  return obj(obj(obj(media)?.image)?.asset);
}

/**
 * Ledes are Sanity portable text: an array of blocks, each an array of spans.
 * Spans are joined without a separator — they are the runs of one sentence,
 * split only where formatting changes — and blocks with a space between them.
 */
function plainText(v: unknown): string {
  return list(v)
    .map((block) =>
      list(block.children)
        .map((c) => raw(c.text))
        .join(""),
    )
    .filter(Boolean)
    .join(" ")
    .trim();
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
      description: clean(p.lede) || undefined,
      author: p.author ? [{ name: clean(p.author) }] : undefined,
      category: p.labels.map((name) => ({ name: clean(name) })),
      // Sanity states the media type, so pass it rather than let the library
      // guess from the URL.
      image: p.image
        ? { url: p.image, type: p.imageType || undefined }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

/** Paths are stored absolute and slash-terminated, which is what the site serves. */
function postUrl(path: string): string {
  return `${SITE}${path}`;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(obj).filter((x) => x !== null) : [];
}

function raw(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Editor-entered text can carry stray whitespace the rendered page trimmed. */
function str(v: unknown): string {
  return raw(v).trim();
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
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
