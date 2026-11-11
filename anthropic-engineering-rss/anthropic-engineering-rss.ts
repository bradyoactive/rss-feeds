/**
 * RSS feed for the Anthropic Engineering Blog.
 *
 * Source: https://www.anthropic.com/engineering
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves
 * the latest technical deep dives and engineering architecture posts from
 * Anthropic, newest first.
 *
 * Anthropic publishes no feed of its own for engineering (/engineering/feed,
 * /rss.xml, and /feed.xml return 404).
 *
 * The site is a Next.js App Router front end backed by Sanity CMS. The
 * engineering portal renders each post as an HTML article card with its title,
 * image and printed date; summaries and ISO dates sit in the RSC payload.
 * Posts themselves live under /research/<slug>.
 */

import { Feed, type Item } from "feed";

const SITE = "https://www.anthropic.com";
const ENGINEERING_URL = `${SITE}/engineering`;

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
    return text(502, `Failed to fetch ${ENGINEERING_URL}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: "Anthropic Engineering Blog",
    description:
      "Technical deep dives, systems architecture, and engineering methodologies from Anthropic.",
    siteLink: ENGINEERING_URL,
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
  const res = await fetch(ENGINEERING_URL, {
    headers: {
      "user-agent": "anthropic-rss-bridge (+https://val.town)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${ENGINEERING_URL}`);
  return res.text();
}

/**
 * Extracts post records from the engineering portal HTML.
 *
 * Each post is an `<article>` card linking to `/research/<slug>` (posts moved
 * there from `/engineering/<slug>`, which now 308-redirects) with its title in
 * a heading and its date printed in a `<time>`, e.g. "Oct 13, 2026". Cards no
 * longer carry a summary, so that comes from the RSC payload instead.
 */
export function extractPosts(html: string): Post[] {
  const payload = extractPayload(html);

  const articleMatches = html.match(/<article\b[^>]*>[\s\S]*?<\/article>/g);
  if (!articleMatches || articleMatches.length === 0) {
    throw new Error(
      "Could not find article cards in Anthropic engineering page",
    );
  }

  const bySlug = new Map<string, Post>();

  for (const articleHtml of articleMatches) {
    const linkMatch = articleHtml.match(
      /href="\/(?:engineering|research)\/([^"?#\/]+)"/,
    );
    if (!linkMatch) continue;
    const slug = linkMatch[1].trim();
    if (!slug || bySlug.has(slug)) continue;

    const titleMatch = articleHtml.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/);
    const rawTitle = titleMatch ? titleMatch[1] : slug;
    const title = decodeHtmlEntities(stripHtml(rawTitle)).trim();

    const meta = payload.get(slug);
    const description = meta?.summary ?? "";

    const imgMatch = articleHtml.match(/<img[^>]*\ssrc="([^"]+)"/);
    const image = imgMatch ? decodeHtmlEntities(imgMatch[1].trim()) : "";
    const imageType = image ? mediaType(image) : "";

    // The card's printed date first, then the payload's publishedOn.
    const timeMatch = articleHtml.match(
      /<time\b(?:[^>]*\sdateTime="([^"]+)")?[^>]*>([^<]*)<\/time>/i,
    );
    const ts = parseDate(timeMatch?.[1] || timeMatch?.[2]) ??
      parseDate(meta?.date);

    bySlug.set(slug, {
      slug,
      title,
      description,
      ts,
      author: "Anthropic Engineering",
      image,
      imageType,
      categories: ["Engineering", "AI"],
    });
  }

  if (bySlug.size === 0) {
    throw new Error("No post links found in Anthropic engineering page cards");
  }
  return [...bySlug.values()];
}

/**
 * Per-slug publication date and summary from the Sanity post records embedded
 * in the RSC stream. These sit inside a JS string literal, so every quote is
 * backslash-escaped (`\"summary\":\"…\"`) and the text is JSON-escaped twice.
 */
export function extractPayload(
  html: string,
): Map<string, { date?: string; summary?: string }> {
  const out = new Map<string, { date?: string; summary?: string }>();
  const records = html.split(/\\"_id\\":/).slice(1);
  for (const record of records) {
    const slug =
      /\\"slug\\":\{\\"_type\\":\\"slug\\",\\"current\\":\\"([^"\\]+)\\"/
        .exec(record)?.[1];
    if (!slug || out.has(slug)) continue;
    const date = /\\"publishedOn\\":\\"([0-9-]+)\\"/.exec(record)?.[1];
    const rawSummary = /\\"summary\\":\\"(.*?)\\",\\"/.exec(record)?.[1];
    out.set(slug, {
      date,
      summary: rawSummary === undefined ? undefined : unescapeTwice(rawSummary),
    });
  }
  return out;
}

function unescapeTwice(s: string): string {
  try {
    return JSON.parse(`"${JSON.parse(`"${s}"`)}"`);
  } catch {
    return s;
  }
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
  // Cards print "Oct 13, 2026", which Date.parse would read in local time.
  if (/^[A-Za-z]{3,9}\.? \d{1,2}, \d{4}$/.test(s)) {
    const ts = Date.parse(`${s.replace(".", "")} 00:00:00 UTC`);
    return Number.isFinite(ts) ? ts : null;
  }
  const ts = Date.parse(s);
  return Number.isFinite(ts) ? ts : null;
}

export function postUrl(slug: string): string {
  if (slug.startsWith("http://") || slug.startsWith("https://")) return slug;
  return `${SITE}/research/${slug.replace(/^\/+/, "")}`;
}

export function mediaType(url: string): string {
  // Card images are resized through the CDN, and its `fm` param, not the
  // file's extension, decides what format comes back.
  const ext = (/[?&]fm=([a-z0-9]+)/i.exec(url)?.[1] ??
    /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1])?.toLowerCase();
  if (ext) {
    if (ext === "svg") return "image/svg+xml";
    if (ext === "jpg") return "image/jpeg";
    return `image/${ext}`;
  }
  return "image/jpeg";
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
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
