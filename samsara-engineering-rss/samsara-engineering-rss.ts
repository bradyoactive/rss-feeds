/**
 * RSS feed for the “Engineering At Samsara” category of the Samsara blog.
 *
 * Source: https://www.samsara.com/blog/category/engineering-at-samsara
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves that
 * category, newest first.
 *
 * Samsara publishes no feed of its own (/blog/rss.xml 404s) and the blog is a
 * Nuxt front end over Contentful. Its rendered category page is a poor source:
 * the cards carry a title, a link and an image, but no date and no summary.
 *
 * So the posts come from Contentful's public read-only Delivery API instead —
 * the same space and token the site's own browser code queries — which returns
 * every field the feed needs, already ordered by publication date, in a single
 * request. Those credentials are inlined in each page as
 * `window.__NUXT__.config.public.ctfl`; they are baked in below and the blog is
 * touched only if Contentful ever rejects them, which is what keeps a token
 * rotation self-healing without paying for a page fetch on every request.
 *
 * Contentful matches `fields.blogCategory` as an exact string, and the stored
 * spelling is not the one the nav prints — the nav says “Engineering at
 * Samsara”, which matches nothing. The constant below is the stored spelling,
 * capital A and all.
 */

import { Feed, type Item } from "feed";

const SITE = "https://www.samsara.com";
const CDN = "https://cdn.contentful.com";

/** The page carrying the config blob; also where the feed's channel points. */
const CATEGORY_PAGE = `${SITE}/blog/category/engineering-at-samsara`;

/** Contentful's own spelling. "Engineering at Samsara" returns nothing. */
const CATEGORY = "Engineering At Samsara";
/** One request, comfortably clear of the category's ~15 posts. */
const PAGE_SIZE = 100;

/**
 * The credentials the blog ships to every browser. Used first; the page is only
 * re-read if Contentful rejects this token. Read-only Delivery API keys, public
 * by design — this is not a secret being checked in.
 */
const CREDENTIALS: Credentials = {
  spaceId: "bx9krvy0u3sx",
  accessToken:
    "9247925a3764b651e63f560743ccc11a2f3d8d478143e2431409232986436f5f",
  environment: "master",
};

/**
 * How long a reader or CDN may reuse a response. These blogs publish a handful
 * of times a month and FreshRSS polls at most hourly, so a long window costs
 * nothing in freshness and is the only caching left in these vals — the
 * in-memory kind never survived val.town recycling an idle isolate.
 */
const CACHE_SECONDS = 12 * 60 * 60;

export interface Credentials {
  spaceId: string;
  accessToken: string;
  environment: string;
}

export interface Post {
  slug: string;
  title: string;
  description: string;
  /** Publication time in ms, or null when the entry carried no usable date. */
  ts: number | null;
  author: string;
  image: string;
  /** The asset's own MIME type; "" when the image asset is missing. */
  imageType: string;
  /** Samsara's taxonomy — a post is often in two: "Life At Samsara", … */
  categories: string[];
}

/** A failed fetch, remembering the URL so the 502 can name it. */
class UpstreamError extends Error {
  constructor(readonly url: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    posts = await fetchPosts();
  } catch (err) {
    const source = err instanceof UpstreamError ? err.url : CDN;
    return text(502, `Failed to fetch ${source}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: `Samsara Blog — ${CATEGORY}`,
    description: `Posts in the “${CATEGORY}” category of the Samsara blog.`,
    siteLink: CATEGORY_PAGE,
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
 * The baked-in token first, and the blog page only if that token has stopped
 * working.
 *
 * Contentful answers a retired token with a clean 401 (`AccessTokenInvalid`),
 * which makes rotation something to *react* to rather than something to check
 * for on every request. Discovering the token up front cost a 215KB page fetch
 * every time to guard against an event that may never happen; this way the
 * happy path is one request, and a rotation still heals itself on the next one.
 */
async function fetchPosts(): Promise<Post[]> {
  let res = await get(entriesUrl(CREDENTIALS), CREDENTIALS.accessToken, true);

  if (res.status === 401) {
    await res.body?.cancel();
    const rotated = await discoverCredentials();
    if (!rotated) {
      throw new UpstreamError(CDN, "HTTP 401 and the page held no new token");
    }
    res = await get(entriesUrl(rotated), rotated.accessToken);
  }

  return extractPosts(await res.json());
}

function entriesUrl(credentials: Credentials): string {
  const params = new URLSearchParams({
    content_type: "blogPost",
    order: "-fields.publishDate",
    // Depth 2 pulls the author profile and the image assets into `includes`.
    include: "2",
    limit: String(PAGE_SIZE),
    "fields.blogCategory[in]": CATEGORY,
  });
  const { spaceId, environment } = credentials;
  return `${CDN}/spaces/${spaceId}/environments/${environment}/entries?${params}`;
}

/**
 * Turns one Delivery API page into posts, resolving the `{sys:{id}}` links
 * every entry uses for its author and images against the sidecar `includes`.
 */
export function extractPosts(payload: unknown): Post[] {
  const body = payload as {
    items?: unknown[];
    includes?: { Entry?: unknown[]; Asset?: unknown[] };
  };
  const entries = byId(body?.includes?.Entry);
  const assets = byId(body?.includes?.Asset);
  const posts: Post[] = [];

  for (const item of arr(body?.items)) {
    const f = fields(item);
    const slug = str(f.blogPageSlug);
    const title = str(f.title);
    if (!slug || !title) continue;

    // The header image is the fallback: metaImage is the 1200×630 crop the
    // site hands to social cards, which is what a reader wants in a feed.
    const file = obj(
      linked(f.metaImage, assets)?.file ??
        linked(f.backgroundImage, assets)?.file,
    );
    const image = str(file.url);

    // publishDate is date-only ("2026-08-12"), so it parses as UTC midnight.
    // An entry left without one still sorts by when Contentful first saw it.
    const ts = Date.parse(
      str(f.publishDate) || str(obj(obj(item).sys).createdAt),
    );

    posts.push({
      slug,
      title,
      // metaDescription is the editor's one-liner; summary is the post's
      // opening paragraphs, and only two entries lack the former.
      description: str(f.metaDescription) || str(f.summary),
      ts: Number.isFinite(ts) ? ts : null,
      author: str(linked(f.author, entries)?.name),
      image: image.startsWith("//") ? `https:${image}` : image,
      imageType: str(file.contentType),
      categories: arr(f.blogCategory).map(str).filter(Boolean),
    });
  }

  return posts;
}

/**
 * Re-reads the credentials from the blog, for the day the baked-in token is
 * retired. Returns null when the page is unreachable or no longer carries a
 * usable pair — either way there is nothing better than what already failed.
 */
async function discoverCredentials(): Promise<Credentials | null> {
  try {
    return extractCredentials(await (await get(CATEGORY_PAGE)).text());
  } catch {
    return null;
  }
}

/**
 * Nuxt inlines its runtime config as a JS object literal (unquoted keys), so
 * the three fields are matched rather than parsed. `ctflProdSpaceId` and
 * `ctflAccessToken` are the same pair, flattened, and outlive a nesting change.
 */
export function extractCredentials(html: string): Credentials | null {
  const ctfl = /ctfl:\{([^}]*)\}/.exec(html)?.[1] ?? "";
  const field = (src: string, name: string) =>
    new RegExp(`\\b${name}:"([^"]+)"`).exec(src)?.[1] ?? "";

  const spaceId = field(ctfl, "spaceId") || field(html, "ctflProdSpaceId");
  const accessToken = field(ctfl, "accessToken") ||
    field(html, "ctflAccessToken");
  if (!spaceId || !accessToken) return null;

  return {
    spaceId,
    accessToken,
    environment: field(ctfl, "environment") || "master",
  };
}

/**
 * The token also decides which of the two sources is being read. `allow401`
 * hands a rejected token back to the caller instead of throwing, so it can go
 * looking for a fresh one.
 */
async function get(
  url: string,
  token?: string,
  allow401 = false,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        "user-agent": "samsara-rss-bridge (+https://val.town)",
        accept: token ? "application/json" : "text/html",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  } catch (err) {
    throw new UpstreamError(url, err);
  }
  if (res.status === 401 && allow401) return res;
  if (!res.ok) throw new UpstreamError(url, `HTTP ${res.status}`);
  return res;
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
      link: `${SITE}/blog/${p.slug}`,
      // `date` is typed as required but is optional at runtime; an item without
      // one simply gets no <pubDate>, which is right for a post we could not date.
      ...(p.ts !== null ? { date: new Date(p.ts) } : {}),
      description: clean(p.description) || undefined,
      author: p.author ? [{ name: clean(p.author) }] : undefined,
      category: p.categories.filter(Boolean).map((name) => ({
        name: clean(name),
      })),
      // Contentful states the asset's media type, so pass it rather than let
      // the library guess from the URL.
      image: p.image
        ? { url: p.image, type: p.imageType || undefined }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

/** Contentful links are `{sys:{id,linkType}}`; the target rides in `includes`. */
function linked(
  ref: unknown,
  pool: Map<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  return pool.get(str(obj(obj(ref).sys).id));
}

function byId(items: unknown): Map<string, Record<string, unknown>> {
  const pool = new Map<string, Record<string, unknown>>();
  for (const item of arr(items)) {
    const id = str(obj(obj(item).sys).id);
    if (id) pool.set(id, fields(item));
  }
  return pool;
}

function fields(item: unknown): Record<string, unknown> {
  return obj(obj(item).fields);
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? v as Record<string, unknown>
    : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Strips the characters that are illegal in XML 1.0. The feed library escapes
 * CDATA breakouts correctly but passes control characters through untouched,
 * and a single one anywhere would make the whole document unparseable — not
 * just its own item. Scraped titles are exactly where one would come from.
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
