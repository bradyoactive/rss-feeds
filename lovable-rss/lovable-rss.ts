/**
 * RSS feed for the “Inside Lovable” category of the Lovable blog.
 *
 * Source: https://lovable.dev/blog?category=inside+lovable
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves that
 * category, newest first.
 *
 * Lovable does publish https://lovable.dev/blog/rss.xml, and unusually for
 * these bridges it carries a <category> on nearly every item — so this val is
 * only a filter over it, not a scraper. That replaced reading post metadata out
 * of the blog index's RSC payload, which meant walking JS object literals with
 * a string-aware brace matcher and undoing JS escapes by hand.
 *
 * What the official feed does not carry is images: no media:content, no
 * enclosure, nothing. Items here therefore have no thumbnail, which is a
 * deliberate trade for not parsing an undocumented payload.
 *
 * Category spelling is inconsistent at the source — 49 items say
 * "Announcements" and 3 say "announcements" — so matching normalises, and the
 * channel title uses whichever spelling the matched items mostly use.
 */

import { Feed, type Item } from "feed";

const SITE = "https://lovable.dev";
const FEED_XML = `${SITE}/blog/rss.xml`;
const CATEGORY = "inside lovable";
const CATEGORY_URL = `${SITE}/blog?category=inside+lovable`;

/**
 * How long a reader or CDN may reuse a response. These blogs publish a handful
 * of times a month and FreshRSS polls at most hourly, so a long window costs
 * nothing in freshness and is the only caching left in these vals — the
 * in-memory kind never survived val.town recycling an idle isolate.
 */
const CACHE_SECONDS = 12 * 60 * 60;

export interface Post {
  /** The post URL as Lovable publishes it; used verbatim as link and guid. */
  link: string;
  title: string;
  description: string;
  /** Publication time in ms, or null when the item had no parseable date. */
  ts: number | null;
  author: string;
  category: string;
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    posts = extractPosts(await fetchFeed());
  } catch (err) {
    return text(502, `Failed to fetch ${FEED_XML}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const matching = selectPosts(posts);
  const items = [...matching].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const label = matching.length
    ? dominantSpelling(matching.map((p) => p.category))
    : "Inside Lovable";

  const xml = renderRss({
    title: `Lovable Blog — ${label}`,
    description: `Posts in the “${label}” category of the Lovable blog.`,
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

async function fetchFeed(): Promise<string> {
  const res = await fetch(FEED_XML, {
    headers: {
      "user-agent": "lovable-rss-bridge (+https://val.town)",
      accept: "application/rss+xml, application/xml",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** The items this feed carries: one category, matched loosely on spelling. */
export function selectPosts(posts: Post[]): Post[] {
  return posts.filter((p) => normalize(p.category) === CATEGORY);
}

/**
 * Reads Lovable's own feed. Items are split on the element boundary first so a
 * field can never be read out of a neighbouring item, and every value is
 * entity-decoded — the source escapes `&` and `'` in titles.
 */
export function extractPosts(xml: string): Post[] {
  const byLink = new Map<string, Post>();

  for (const chunk of xml.split("<item>").slice(1)) {
    const item = chunk.split("</item>")[0];
    const link = element(item, "link");
    const title = element(item, "title");
    if (!link || !title || byLink.has(link)) continue;

    const ts = Date.parse(element(item, "pubDate"));

    byLink.set(link, {
      link,
      title,
      description: element(item, "description"),
      ts: Number.isFinite(ts) ? ts : null,
      author: element(item, "dc:creator"),
      category: element(item, "category"),
    });
  }

  return [...byLink.values()];
}

/** First `<name>` in `item`, CDATA-aware and entity-decoded. */
function element(item: string, name: string): string {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(item);
  if (!match) return "";
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(match[1]);
  return decodeEntities(cdata ? cdata[1] : match[1]).trim();
}

/**
 * Which spelling to *display*, so the channel title reads the way the posts
 * themselves mostly write it rather than however the newest one did.
 */
function dominantSpelling(spellings: string[]): string {
  const counts = new Map<string, number>();
  for (const s of spellings) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0][0];
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
      link: p.link,
      // `date` is typed as required but is optional at runtime; an item without
      // one simply gets no <pubDate>, which is right for a post we could not date.
      ...(p.ts !== null ? { date: new Date(p.ts) } : {}),
      description: clean(p.description) || undefined,
      author: p.author ? [{ name: clean(p.author) }] : undefined,
      category: p.category ? [{ name: clean(p.category) }] : undefined,
      // No image: the source feed carries none, for any item.
    } as Item);
  }

  return out.rss2();
}

function normalize(s: string): string {
  return s.replace(/\+/g, " ").trim().toLowerCase().replace(/\s+/g, " ");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
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
