/**
 * RSS feed for the Tech Blog category of the Robinhood careers blog.
 *
 * Source: https://robinhood.com/us/en/careers/blog/category/tech-blog/
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves that
 * category, newest first.
 *
 * Robinhood publishes no feed of its own, and scraping the category page would
 * get nothing: it is a Next.js page whose `__NEXT_DATA__` ships
 * `articlesCollection: { items: [], total: 0 }`. The list is fetched in the
 * browser, and it is fetched straight from **Contentful's delivery API** — the
 * page hands every visitor the space id and a read-only CDA token, so this asks
 * Contentful the same question the page does.
 *
 * One request returns everything the feed needs. `include=2` resolves the links
 * in the same response, which is what turns author and category references into
 * names and the featured image into a URL with its media type.
 *
 * The credentials below are the ones the site ships to every browser. They live
 * in a content-hashed JS chunk rather than in the HTML, so there is nothing to
 * lift them out of at request time and they are baked in as constants — unlike
 * the Samsara bridge, which finds its token on the page itself and can recover
 * from a rotation. If Robinhood rotates this one the feed 502s and says so.
 */

import { Feed, type Item } from "npm:feed@6.0.0";

const SITE = "https://robinhood.com";
const BLOG_PATH = "/us/en/careers/blog";

const SPACE = "1hpl803w8xsv";
const ENVIRONMENT = "master";
/** Read-only Content Delivery API token, as shipped to the browser. */
const CDA_TOKEN = "c-uWotLcY4Kh6NTH4w15c0aH2n8cwxGTOvo98Nk8STE";
const CDA_URL =
  `https://cdn.contentful.com/spaces/${SPACE}/environments/${ENVIRONMENT}/entries`;

const CONTENT_TYPE = "careersBlogArticle";
/** The category entry id behind /category/tech-blog/, as the page queries it. */
const CATEGORY_ID = "3Yoj9Flwon0pteDV435r7U";
const CATEGORY_NAME = "Tech Blog";
const CATEGORY_URL = `${SITE}${BLOG_PATH}/category/tech-blog/`;
/** One request, comfortably clear of the category's handful of posts. */
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
  description: string;
  /** Publication time in ms, or null when the entry carried no usable date. */
  ts: number | null;
  author: string;
  image: string;
  /** Contentful states the asset's media type, so it is never guessed. */
  imageType: string;
  /** Robinhood's own category names, e.g. ["Tech Blog"]. */
  categories: string[];
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    posts = extractPosts(await query());
  } catch (err) {
    return text(502, `Failed to fetch ${CDA_URL}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: `Robinhood — ${CATEGORY_NAME}`,
    description:
      `Posts in the “${CATEGORY_NAME}” category of the Robinhood careers blog.`,
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

/**
 * The category's entries, newest first.
 *
 * The filter is the same one the page sends. `include=2` is what makes this a
 * single request: depth 1 would return the author and category entries but not
 * the asset behind the featured image.
 */
async function query(): Promise<unknown> {
  const params = new URLSearchParams({
    content_type: CONTENT_TYPE,
    locale: "en-US",
    order: "-fields.publishDate",
    limit: String(PAGE_SIZE),
    include: "2",
    "fields.categories.sys.id[in]": CATEGORY_ID,
  });

  const res = await fetch(`${CDA_URL}?${params}`, {
    headers: {
      authorization: `Bearer ${CDA_TOKEN}`,
      "user-agent": "robinhood-rss-bridge (+https://val.town)",
      accept: "application/json",
    },
  });
  if (res.status === 401) {
    await res.body?.cancel();
    throw new Error(
      "HTTP 401 — the delivery token baked into this val has been rotated",
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Reads the Contentful response.
 *
 * Links are returned beside the entries rather than inside them, so the
 * includes are indexed by id first and every reference resolved through that.
 * The query is already category-filtered, but each entry is checked again so a
 * stray post stays out if that filter ever loosens.
 */
export function extractPosts(payload: unknown): Post[] {
  const body = obj(payload);
  const includes = obj(body?.includes);
  const linked = new Map<string, Record<string, unknown>>();
  for (const kind of ["Entry", "Asset"]) {
    for (const item of list(includes?.[kind])) {
      const id = str(obj(item.sys)?.id);
      if (id) linked.set(id, item);
    }
  }

  /** The entry or asset a `{ sys: { id } }` link points at. */
  const target = (link: unknown) =>
    linked.get(str(obj(obj(link)?.sys)?.id)) ?? null;

  const bySlug = new Map<string, Post>();

  for (const entry of list(body?.items)) {
    const fields = obj(entry.fields);
    const slug = str(fields?.slug);
    const title = str(fields?.title);
    if (!slug || !title || bySlug.has(slug)) continue;

    const categories = list(fields?.categories)
      .map((link) => str(obj(target(link)?.fields)?.name))
      .filter(Boolean);
    if (!categories.includes(CATEGORY_NAME)) continue;

    const file = obj(obj(target(fields?.featuredImage)?.fields)?.file);
    // publishDate carries its own UTC offset ("2026-07-28T00:00+08:00"), so
    // Date.parse reads it correctly wherever the val happens to run.
    const ts = Date.parse(str(fields?.publishDate));

    bySlug.set(slug, {
      slug,
      title,
      description: description(fields, target),
      ts: Number.isFinite(ts) ? ts : null,
      author: list(fields?.authors)
        .map((link) => str(obj(target(link)?.fields)?.name))
        .filter(Boolean)
        .join(" & "),
      image: absolute(str(file?.url)),
      imageType: str(file?.contentType),
      categories,
    });
  }

  return [...bySlug.values()];
}

/**
 * The summary to carry.
 *
 * The first paragraph of the body is what the category page itself prints under
 * each title, so it is what a reader recognises. `seoDescription` is the
 * fallback rather than the first choice: it is written for search engines, and
 * on at least one entry it is a heading and a body sentence run together.
 */
function description(
  fields: Record<string, unknown> | null,
  target: (link: unknown) => Record<string, unknown> | null,
): string {
  const paragraph = firstParagraph(fields?.content);
  if (paragraph) return paragraph;
  return str(obj(target(fields?.seo)?.fields)?.seoDescription);
}

/**
 * The text of the first non-empty paragraph of a Contentful rich-text document.
 * Marks split a sentence into several text nodes — a linked phrase is its own
 * node — so the nodes of one paragraph join with nothing between them.
 */
function firstParagraph(document: unknown): string {
  for (const node of list(obj(document)?.content)) {
    if (str(node.nodeType) !== "paragraph") continue;
    const paragraph = plainText(node).trim();
    if (paragraph) return paragraph;
  }
  return "";
}

function plainText(node: Record<string, unknown>): string {
  if (str(node.nodeType) === "text") return raw(node.value);
  return list(node.content).map(plainText).join("");
}

/** Contentful asset URLs are protocol-relative: `//images.ctfassets.net/…`. */
function absolute(url: string): string {
  return url.startsWith("//") ? `https:${url}` : url;
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
      description: clean(p.description) || undefined,
      author: p.author ? [{ name: clean(p.author) }] : undefined,
      category: p.categories.map((name) => ({ name: clean(name) })),
      // Contentful states the media type, so pass it rather than let the
      // library guess from the URL.
      image: p.image
        ? { url: p.image, type: p.imageType || undefined }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

/** Robinhood canonicalises to a trailing slash; the bare form redirects here. */
function postUrl(slug: string): string {
  return `${SITE}${BLOG_PATH}/${slug}/`;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
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
