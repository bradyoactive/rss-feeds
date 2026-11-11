/**
 * RSS feed for the Backend category of the Uber engineering blog.
 *
 * Source: https://www.uber.com/us/en/blog/engineering/backend/
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves that
 * category, newest first.
 *
 * Uber publishes no feed anywhere on the blog: /blog/feed, /blog/rss.xml,
 * /blog/atom.xml and friends all answer 406, and no page carries a
 * <link rel="alternate" type="application/rss+xml">.
 *
 * The site is Uber's own Fusion.js app ("uber-sites"), not Next.js, so there is
 * no page-data or flight payload to read. What it does expose is the app's
 * **RPC endpoint** — fusion-plugin-rpc mounts every registered method at
 * `POST /api/<method>` — and the listing is built from two of them:
 *
 *   listCategories   → the whole category tree, so the Backend category's id
 *                      can be looked up by slug and every id on a post can be
 *                      turned back into the name the site prints on the card
 *   getRelatedPages  → the posts themselves, filtered, sorted and paged
 *
 * Two requests, ~100 ms each, and the second returns all 120 posts at once —
 * so there is no per-post fetch and no pagination loop.
 *
 * The one non-obvious part is `x-csrf-token`. Without that header the endpoint
 * answers 403 "Missing csrf token."; with it, *any* value is accepted. The
 * plugin relies on the browser same-origin rules rather than on the token's
 * contents, so there is nothing here to keep in sync with the site.
 *
 * No item carries a description, and that is the API's answer rather than a
 * shortcut: getRelatedPages and getPageArticleMetadata return the same seven
 * fields, none of them an excerpt, and the site's own cards print only the
 * category tags, the title and the date. A <description> would have to come
 * from fetching all 120 article pages, which is the pattern these vals dropped.
 */

import { Feed, type Item } from "feed";

const SITE = "https://www.uber.com";
/** The blog is served per country/locale and its URLs carry that prefix. */
const COUNTRY = "US";
const LOCALE = "en";
const RPC = `${SITE}/api`;

/**
 * The category is resolved by slug at runtime rather than pinned by id. Its id
 * is a UUID the newsroom CMS owns, and matching on the *name* would be worse:
 * names are display strings and are not unique across namespaces.
 */
const CATEGORY_SLUG = "engineering/backend";
/** Categories exist for the blog, the newsroom and legal pages alike. */
const NAMESPACE = "blog";
const CATEGORY_URL = `${SITE}/us/en/blog/${CATEGORY_SLUG}/`;

/**
 * One request. Backend holds 120 posts of the 761 under Engineering, and the
 * endpoint honours a limit well past that — 1000 returns all 761 — so this is
 * headroom, not a cap. `totalCount` comes back alongside, and the live check
 * fails if it ever exceeds this.
 */
const PAGE_SIZE = 500;

/**
 * How long a reader or CDN may reuse a response. These blogs publish a handful
 * of times a month and FreshRSS polls at most hourly, so a long window costs
 * nothing in freshness and is the only caching left in these vals — the
 * in-memory kind never survived val.town recycling an idle isolate.
 */
const CACHE_SECONDS = 12 * 60 * 60;

export interface Post {
  /** Absolute, e.g. "https://www.uber.com/us/en/blog/query-gpt/". */
  url: string;
  title: string;
  /** Publication time in ms, or null when the record carried no usable date. */
  ts: number | null;
  image: string;
  imageType: string;
  /** The names the site prints on the card, e.g. ["Backend", "Engineering"]. */
  categories: string[];
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  namespace: string;
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    const categories = extractCategories(
      await rpc("listCategories", { country: COUNTRY, locale: LOCALE }),
    );
    const id = categoryId(categories, CATEGORY_SLUG);
    if (!id) {
      return text(
        502,
        `No category is published at "${CATEGORY_SLUG}" in the ` +
          `"${NAMESPACE}" namespace — the newsroom tree has changed.`,
      );
    }
    posts = extractPosts(
      await rpc("getRelatedPages", {
        categoryIDFilters: [id],
        country: COUNTRY,
        locale: LOCALE,
        paging: { limit: PAGE_SIZE, token: "0" },
        sortKey: "PUBLISHED_AT",
        sortOrder: "DESC",
      }),
      categoryNames(categories),
    );
  } catch (err) {
    return text(502, `Failed to fetch ${RPC}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));

  const xml = renderRss({
    title: "Uber Engineering — Backend",
    description: "Posts in the Backend category of the Uber engineering blog.",
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
 * Calls one of the app's RPC methods.
 *
 * The endpoint replies 200 with `{status:"failure"}` for a rejected call rather
 * than a 4xx, so the status line alone proves nothing and the envelope is
 * checked too.
 */
export async function rpc(method: string, args: unknown): Promise<unknown> {
  const res = await fetch(`${RPC}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Presence is the whole check; the value is never read. See the header.
      "x-csrf-token": "uber-rss-bridge",
      "user-agent": "uber-rss-bridge (+https://val.town)",
      accept: "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);

  const body = await res.json();
  const status = obj(body)?.status;
  if (status !== "success") {
    throw new Error(
      `${method}: ${JSON.stringify(status ?? body).slice(0, 200)}`,
    );
  }
  return obj(body)?.data;
}

/** Reads the listCategories result — a flat list spanning every namespace. */
export function extractCategories(payload: unknown): Category[] {
  return list(payload)
    .map((row) => ({
      id: str(row.ID),
      name: str(row.name),
      slug: str(row.slug),
      namespace: str(row.theNamespace),
    }))
    .filter((c) => c.id && c.name);
}

/** The id of the blog category at `slug`, or "" when the tree no longer has it. */
export function categoryId(categories: Category[], slug: string): string {
  return (
    categories.find((c) => c.namespace === NAMESPACE && c.slug === slug)?.id ??
    ""
  );
}

export function categoryNames(categories: Category[]): Map<string, string> {
  return new Map(categories.map((c) => [c.id, c.name]));
}

/**
 * Reads the getRelatedPages result.
 *
 * Every post names its categories by id only, so `names` turns them back into
 * the words a reader sees. An id with no entry is dropped rather than printed
 * raw — a bare UUID in <category> would be worse than no category at all.
 */
export function extractPosts(
  payload: unknown,
  names: Map<string, string> = new Map(),
): Post[] {
  const byUrl = new Map<string, Post>();

  for (const row of list(obj(payload)?.relatedPages)) {
    const fullURL = str(row.fullURL);
    // `title` and `ogTitle` differ on a dozen posts; the cards render `title`,
    // and it is the better-kept of the two — typographic apostrophes, current
    // wording — while ogTitle is whatever the share card was written with.
    const title = str(row.title);
    if (!fullURL || !title) continue;

    const url = postUrl(fullURL);
    if (byUrl.has(url)) continue;

    const ts = Date.parse(str(row.publishedAt));
    const image = str(row.ogImageURL);

    byUrl.set(url, {
      url,
      title,
      ts: Number.isFinite(ts) ? ts : null,
      image,
      imageType: mediaType(image),
      // Alphabetical, which is the order the site's own cards print them in —
      // the API returns the ids in neither that order nor a stable one.
      categories: (Array.isArray(row.categoryIDs) ? row.categoryIDs : [])
        .map((id) => names.get(str(id)) ?? "")
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, "en")),
    });
  }

  return [...byUrl.values()];
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
      link: p.url,
      // `date` is typed as required but is optional at runtime; an item without
      // one simply gets no <pubDate>, which is right for a post we could not date.
      ...(p.ts !== null ? { date: new Date(p.ts) } : {}),
      // No description and no author: the newsroom API carries neither. See the
      // file header — this is the API's answer, not an omission.
      category: p.categories.map((name) => ({ name: clean(name) })),
      image: p.image
        ? { url: p.image, type: p.imageType || undefined }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

/**
 * `fullURL` comes back without a scheme ("www.uber.com/us/en/blog/…/"), and on
 * a record that already carries one this leaves it alone.
 */
function postUrl(fullURL: string): string {
  return /^https?:\/\//i.test(fullURL) ? fullURL : `https://${fullURL}`;
}

/**
 * The image's media type, or "" when the URL does not say.
 *
 * Worth stating rather than leaving to the library, which would guess
 * "image/jpg" — not a real type — from a .jpg. Every asset on tb-static carries
 * an extension; the five in use here are jpg, jpeg, png, webp and gif.
 */
function mediaType(url: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (!ext) return "";
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(obj).filter((x) => x !== null) : [];
}

/**
 * Trims, and collapses internal whitespace runs. The collapse is not cosmetic:
 * one title is stored as "Upgrading Uber’s MySQL Fleet  to version 8.0", and
 * HTML folds that double space where a feed reader would print it.
 */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
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
