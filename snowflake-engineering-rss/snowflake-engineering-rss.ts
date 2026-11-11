/**
 * RSS feed for the “Core Platform” category of the Snowflake engineering blog.
 *
 * Source: https://www.snowflake.com/en/blog/engineering/core-platform/
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves that
 * category, newest first.
 *
 * Snowflake's site is Adobe AEM, and the category page renders its cards from a
 * component-scoped JSON endpoint rather than from anything in the HTML: the
 * long `blog_category_filter.filter.json` path below is the address of one
 * component inside the page's authored structure, which is why it reads like a
 * filesystem path and why none of it is guessable. It takes the category as
 * `pagePath` — an authoring path under /content, not the public URL — and
 * answers with `{hits, totalMatches}`.
 *
 * The response is card data, not post data: each hit carries only what the
 * category page paints on a card, so there is no body, no excerpt and no hero
 * image to be had. Titles, links, dates, bylines and tags are the whole feed.
 *
 * Two shapes in here are worth knowing before editing:
 *
 *  - `publicationDate` is a *display* string, "SEP 08, 2026". `new Date()` will
 *    take it, but it reads it as local midnight, so the same post dates
 *    differently depending on where the code runs — UTC on val.town by
 *    accident, and the machine's zone under `deno test`. `parseDate` below
 *    reads it explicitly as UTC instead, so a post's date is a fact rather than
 *    a property of the host.
 *  - A hit's title lives at `title.lines[]` (an array, because the component
 *    supports a multi-line heading) and is *also* duplicated into
 *    `button.text`. The lines are the real field; the button text is the
 *    fallback for a card that somehow has no heading component.
 */

import { Feed, type Item } from "feed";

const SITE = "https://www.snowflake.com";
const CATEGORY_URL = `${SITE}/en/blog/engineering/core-platform/`;

/** The AEM publish instance the site's own category page calls. */
const AEM = "https://publish-p57963-e462109.adobeaemcloud.com";
/** Address of the filter component inside the authored category-page template. */
const FILTER =
  "/conf/snowflake-site/settings/wcm/templates/blog-category-page" +
  "/structure/_jcr_content/root/responsivegrid/container/flexible_column_cont" +
  "/flexible_column_content_container_1/blog_category_filter.filter.json";
/** The authoring path for the category, not its public URL. */
const PAGE_PATH =
  "/content/snowflake-site/global/en/blog/engineering/core-platform";

/**
 * One page, matching what the category page itself requests. The endpoint
 * reports ~103 posts in total behind this filter, so raising this is a
 * one-character change if the feed ever needs more history than the site's own
 * first page carries; at Snowflake's couple-of-posts-a-week it does not.
 */
const PAGE_SIZE = 9;

/**
 * How long a reader or CDN may reuse a response. These blogs publish a handful
 * of times a month and FreshRSS polls at most hourly, so a long window costs
 * nothing in freshness.
 */
const CACHE_SECONDS = 12 * 60 * 60;

export interface Post {
  title: string;
  /** Site-relative, as the API gives it: "/en/blog/engineering/…/". */
  path: string;
  /** Publication time in ms, or null when the card carried no usable date. */
  ts: number | null;
  authors: string[];
  /** Tag names as Snowflake spells them, e.g. ["Core Platform"]. */
  categories: string[];
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    posts = extractPosts(await query());
  } catch (err) {
    return text(502, `Failed to fetch ${AEM}${FILTER}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: "Snowflake Engineering Blog — Core Platform",
    description:
      "Core Platform engineering posts from the Snowflake engineering blog.",
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

async function query(): Promise<unknown> {
  const params = new URLSearchParams({
    pagePath: PAGE_PATH,
    offset: "0",
    pageSize: String(PAGE_SIZE),
    orderBy: "customPublicationDate",
    sortOrder: "desc",
  });
  const res = await fetch(`${AEM}${FILTER}?${params}`, {
    headers: {
      "user-agent": "snowflake-rss-bridge (+https://val.town)",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Reads the filter response. A card without a title or a link is not a post. */
export function extractPosts(payload: unknown): Post[] {
  const hits = (payload as { hits?: unknown })?.hits;
  const byPath = new Map<string, Post>();

  for (const raw of Array.isArray(hits) ? hits : []) {
    const hit = raw as Record<string, unknown>;
    const button = obj(hit.button);

    const title = headline(hit) || str(button.text);
    const path = str(obj(button.buttonLink).url);
    if (!title || !path || byPath.has(path)) continue;

    byPath.set(path, {
      title,
      path,
      ts: parseDate(str(hit.publicationDate)),
      authors: list(hit.authors)
        .map((a) => str(obj(obj(a).authorCta).text))
        .filter(Boolean),
      categories: list(hit.tags)
        .map((t) => str(obj(t).tagText))
        .filter(Boolean),
    });
  }

  return [...byPath.values()];
}

/** `title.lines` is an array so the component can wrap a heading over lines. */
function headline(hit: Record<string, unknown>): string {
  return list(obj(hit.title).lines).map(str).filter(Boolean).join(" ").trim();
}

const MONTHS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

/**
 * "SEP 08, 2026" → ms at UTC midnight.
 *
 * Deliberately not `Date.parse`: it accepts this format but resolves it in the
 * host's zone, which silently moves every date in the feed when the code runs
 * somewhere other than val.town. Anything that is not this exact shape returns
 * null and the item simply gets no <pubDate>.
 */
export function parseDate(display: string): number | null {
  const m = /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/.exec(display.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toUpperCase());
  if (month < 0) return null;

  const day = Number(m[2]);
  const year = Number(m[3]);
  const ts = Date.UTC(year, month, day);
  // Rejects "FEB 31" rather than letting Date.UTC roll it into March.
  return new Date(ts).getUTCDate() === day ? ts : null;
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
      author: p.authors.length
        ? p.authors.map((name) => ({ name: clean(name) }))
        : undefined,
      category: p.categories.map((name) => ({ name: clean(name) })),
    } as Item);
  }

  return out.rss2();
}

/** The API returns site-relative paths; an absolute one is passed through. */
function postUrl(path: string): string {
  return /^https?:\/\//.test(path) ? path : `${SITE}${path}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? v as Record<string, unknown>
    : {};
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
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
