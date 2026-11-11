/**
 * RSS feed for the “Eng Blog” topic of the Mercury blog.
 *
 * Source: https://mercury.com/blog/search?topics=Eng+Blog
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves that
 * topic, newest first.
 *
 * Mercury publishes no feed of its own (/blog/rss.xml, /blog/feed and friends
 * all 404). The search page is Next.js App Router: post records ride in the
 * flight chunks as real JSON, so fields are JSON.parsed rather than matched.
 *
 * The catch is that the search listing carries no publication date — its
 * `image` and `subheading` are unresolved flight refs (`$L41`) too. Dates,
 * descriptions and cover images come from each post page's JSON-LD BlogPosting,
 * so a cold request costs one listing fetch plus one fetch per post, six at a
 * time. Authors come from the listing, which covers every post; the JSON-LD
 * Person node is missing on half.
 */

import { Feed, type Item } from "feed";

const SITE = "https://mercury.com";
/** Mercury keys the search off the display name, so this is its exact spelling. */
const TOPIC = "Eng Blog";

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
  /** Publication time in ms, or null when the post page had no parseable date. */
  ts: number | null;
  author: string;
  image: string;
  topic: string;
  /** Mercury's own taxonomy: "Inside Mercury", "Library", … */
  categories: string[];
}

/** A listing record, before its post page fills in date/description/image. */
interface Stub {
  slug: string;
  title: string;
  author: string;
  topic: string;
  categories: string[];
}

/** Post pages are fetched this many at a time — it is someone else's site. */
const DETAIL_CONCURRENCY = 6;

type Detail = Pick<Post, "ts" | "description" | "image">;

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    posts = await getPosts();
  } catch (err) {
    return text(502, `Failed to fetch ${searchUrl(TOPIC)}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: `Mercury Blog — ${TOPIC}`,
    description: `Posts in the “${TOPIC}” topic of the Mercury blog.`,
    siteLink: searchUrl(TOPIC),
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

async function getPosts(): Promise<Post[]> {
  const stubs = await fetchIndex();

  // A post whose page fails keeps its listing data and simply carries no date,
  // rather than sinking the whole feed.
  const details = await mapLimit(
    stubs,
    DETAIL_CONCURRENCY,
    (s) => fetchDetail(s.slug),
  );
  return stubs.map((stub, i) => ({ ...stub, ...details[i] }));
}

async function fetchIndex(): Promise<Stub[]> {
  const stubs = extractIndex(await get(searchUrl(TOPIC)), TOPIC);
  if (!stubs.length) throw new Error("no posts found — page structure changed");
  return stubs;
}

/** Promise.all with a ceiling on how many run at once, preserving input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    },
  );

  await Promise.all(workers);
  return results;
}

/** Listing records look like `{"topic":{"slug":…,"name":…},"slug":…,"title":…}`. */
export function extractIndex(html: string, topic: string): Stub[] {
  const payload = flightPayload(html);
  const wanted = slugify(topic);
  const bySlug = new Map<string, Stub>();

  for (const match of payload.matchAll(/\{"topic":\{/g)) {
    const body = sliceJson(payload, match.index!);
    if (!body) continue;

    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(body);
    } catch {
      continue; // a record split across a chunk boundary we failed to rejoin
    }

    const slug = str(raw.slug);
    const title = str(raw.title);
    if (!slug || !title || bySlug.has(slug)) continue;

    const topicObj = raw.topic as Record<string, unknown> | undefined;
    const name = str(topicObj?.name);
    // The listing is server-filtered, but match anyway: by display name or slug,
    // so "Eng Blog", "eng+blog" and "engineering-blog" all address the same feed.
    if (slugify(name) !== wanted && str(topicObj?.slug) !== wanted) continue;

    bySlug.set(slug, {
      slug,
      title,
      author: names(raw.authors),
      topic: name,
      categories: list(raw.categories),
    });
  }

  return [...bySlug.values()];
}

async function fetchDetail(slug: string) {
  try {
    return extractDetail(await get(`${SITE}/blog/${slug}`));
  } catch {
    return { ts: null, description: "", image: "" };
  }
}

/** Date, description and cover image live in the post page's JSON-LD + og:image. */
export function extractDetail(
  html: string,
): Pick<Post, "ts" | "description" | "image"> {
  let posting: Record<string, unknown> | undefined;

  for (
    const block of html.matchAll(
      /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
    )
  ) {
    // The block is raw JSON today. Only fall back to entity-decoding if that
    // fails, so a legitimate "&amp;" inside a description survives intact.
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1]);
    } catch {
      try {
        parsed = JSON.parse(decodeEntities(block[1]));
      } catch {
        continue;
      }
    }
    const graph = (parsed as Record<string, unknown>)?.["@graph"];
    const nodes = Array.isArray(graph) ? graph : [parsed];
    for (const node of nodes as Record<string, unknown>[]) {
      if (node?.["@type"] === "BlogPosting") posting ??= node;
    }
  }

  const ts = Date.parse(str(posting?.datePublished));
  const image =
    /<meta[^>]*property="og:image"[^>]*content="([^"]*)"/.exec(html)?.[1] ?? "";

  return {
    ts: Number.isFinite(ts) ? ts : null,
    description: str(posting?.description),
    image: decodeEntities(image),
  };
}

async function get(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "user-agent": "mercury-rss-bridge (+https://val.town)",
      accept: "text/html",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Concatenates the streamed flight chunks back into one payload string. */
function flightPayload(html: string): string {
  let payload = "";
  for (
    const chunk of html.matchAll(
      /self\.__next_f\.push\(\[\d+,\s*("(?:[^"\\]|\\.)*")/g,
    )
  ) {
    try {
      payload += JSON.parse(chunk[1]);
    } catch {
      // a chunk that isn't a plain string literal contributes nothing
    }
  }
  return payload;
}

/** Returns the JSON object literal starting at `open` ("{"), string-aware. */
function sliceJson(src: string, open: number): string | null {
  let depth = 0;
  let inString = false;

  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      if (--depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
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
      category: [p.topic, ...p.categories].filter(Boolean).map((name) => ({
        name,
      })),
      image: p.image || undefined,
    } as Item);
  }

  return out.rss2();
}

function searchUrl(topic: string): string {
  return `${SITE}/blog/search?topics=${plusEncode(topic)}`;
}

/** Matches Mercury's own `?topics=Eng+Blog` spelling. */
function plusEncode(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, "+");
}

function names(v: unknown): string {
  return list(v).join(" & ");
}

function list(v: unknown): string[] {
  return Array.isArray(v)
    ? v.map((x) => str((x as Record<string, unknown>)?.name)).filter(Boolean)
    : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-|-$/g,
    "",
  );
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
