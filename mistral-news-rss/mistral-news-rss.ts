/**
 * RSS feed for the engineering and research writing on the Mistral news blog.
 *
 * Source: https://mistral.ai/news/?categories=engineering,research
 *
 * Deploy on val.town as an HTTP val. No query params — the feed serves those
 * two categories, newest first.
 *
 * Mistral publishes https://mistral.ai/news/rss (the old /rss.xml now redirects
 * there), but it is one undifferentiated firehose: every post regardless of
 * subject, with not a single <category> element to tell them apart. The filter
 * that feed refuses to give you is the whole point of this val.
 *
 * This used to read Payload CMS at /cms-media/api/posts, which served the
 * categories, dates, bylines and summaries in one query. **That API is gone**:
 * mistral.ai was rebuilt on Astro, and every collection route under the mount
 * now answers 404 — `posts`, `media`, `categories` alike — while the media
 * *file* route it also serves (/cms-media/api/media/file/…) still works, so the
 * mount being alive is not evidence the read API is. Don't go looking for a new
 * collection slug; there isn't one.
 *
 * What replaced it is two fetches, which is what this bridge did before the API
 * was ever found:
 *
 *   /news/     the listing page — the categories, and nothing else has them.
 *              The category filter runs in the browser, so the page has to ship
 *              the whole corpus: all 84 posts, each an <article> carrying
 *              data-categories, the title, byline and thumbnail.
 *   /news/rss  the firehose — publication timestamps and summaries.
 *
 * The join is by slug and it is exact: both sources currently list the same 84
 * posts, and their dates agree on all 84 (the page prints the day, the feed the
 * instant, so the feed's is the one worth keeping).
 *
 * **Most items have no description, and that is the source's answer, not a gap
 * in this scraper.** Only 24 of the 84 posts carry one — 7 of the 41 in these
 * two categories. Fetching each post page to recover the rest was measured and
 * returns *nothing*: where the feed has a summary the page's meta description
 * is the same string (7/7), and where the feed has none the page serves the
 * site-wide boilerplate ("The most powerful AI platform for enterprises…")
 * (34/34), which would be worse than an empty description. 41 requests, zero
 * information. The listing page's own blurb is likewise a strict subset of the
 * feed's — 17 posts, all 24 of which the feed already covers, and fuller there.
 */

import { Feed, type Item } from "feed";

const SITE = "https://mistral.ai";
/** The listing page. Trailing slash required; /news 301s to it. */
const PAGE = `${SITE}/news/`;
/** The unfiltered feed, joined onto the page for dates and summaries. */
const FEED = `${SITE}/news/rss`;
/** The combination this feed exists to subscribe to. */
const CATEGORIES = ["engineering", "research"];

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
  /** Publication time in ms, or null when neither source carried a date. */
  ts: number | null;
  author: string;
  image: string;
  /** Display names as the site spells them, e.g. ["Engineering"]. */
  categories: string[];
}

export default async function (req: Request): Promise<Response> {
  let posts: Post[];
  try {
    const [page, feed] = await Promise.all([get(PAGE), get(FEED)]);
    posts = extractPosts(page, feed);
  } catch (err) {
    return text(502, `Failed to fetch ${PAGE}: ${err}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const items = [...posts].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  const names = displayNames(items);

  const xml = renderRss({
    title: `Mistral News — ${names.join(" & ")}`,
    description: `Posts in ${
      names.map((n) => `“${n}”`).join(" or ")
    } on the Mistral news blog — the category filter mistral.ai/news/rss does not offer.`,
    // Mistral's own nav links categories this way. The filter runs in the
    // browser, so a reader who follows it lands on the index either way.
    siteLink: `${PAGE}?categories=${CATEGORIES.join(",")}`,
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
 * Both sources are fetched with an explicit `headers` init on purpose. A bare
 * `fetch(url)` from val.town is the shape Cloudflare's bot management
 * challenges — it costs nothing to state what this is and what it wants, and
 * two of the sibling feeds went dark for exactly that reason.
 */
async function get(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "user-agent": "mistral-rss-bridge (+https://val.town)",
      accept:
        "text/html, application/rss+xml, application/xml;q=0.9, */*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

/**
 * Reads the listing page for the item set and its taxonomy, then joins the
 * firehose onto it by slug for the parts the page does not print.
 */
export function extractPosts(pageHtml: string, feedXml: string): Post[] {
  const enrich = readFeed(feedXml);
  const bySlug = new Map<string, Post>();

  for (const card of cards(pageHtml)) {
    const slug = one(/<a[^>]*href="\/news\/([^/"]+)\//, card);
    const title = str(
      one(/class="[^"]*\bjs-post-title\b[^"]*"[^>]*>([\s\S]*?)<\/h2>/, card),
    );
    if (!slug || !title || bySlug.has(slug)) continue;

    // The tag chip carries both halves of the taxonomy: the slug the filter
    // matches on, and the label the site prints. data-categories on the
    // <article> holds the same slugs, but only the chips have the names.
    const categories: string[] = [];
    for (
      const m of card.matchAll(
        /data-category-slug="([^"]*)"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g,
      )
    ) {
      if (CATEGORIES.includes(m[1])) categories.push(str(m[2]));
    }
    if (!categories.length) continue;

    const extra = enrich.get(slug);
    bySlug.set(slug, {
      slug,
      title,
      description: extra?.description ?? "",
      // The feed's instant when the join found one; otherwise the day the card
      // prints, which is coarser but was right on all 84 posts when checked.
      ts: extra?.ts ?? cardDate(card),
      author: str(one(/line-clamp-1">([^<]*)<\/p>/, card)).replace(
        /^By\s+/i,
        "",
      ),
      image: imageUrl(one(/<img[^>]*\ssrc="([^"]+)"/, card)),
      categories,
    });
  }

  return [...bySlug.values()];
}

/** Every post card on the listing, markup untouched. */
function cards(html: string): string[] {
  return html.match(
    /<article\b[^>]*class="[^"]*\bjs-post\b[^"]*"[^>]*>[\s\S]*?<\/article>/g,
  ) ?? [];
}

/** Summaries and publication instants from the firehose, keyed by slug. */
function readFeed(
  xml: string,
): Map<string, { ts: number | null; description: string }> {
  const out = new Map<string, { ts: number | null; description: string }>();

  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1];
    const slug = one(/<link>[^<]*\/news\/([^/<]+)\/?<\/link>/, item);
    if (!slug || out.has(slug)) continue;
    const ts = Date.parse(one(/<pubDate>([^<]*)<\/pubDate>/, item));
    out.set(slug, {
      ts: Number.isFinite(ts) ? ts : null,
      description: str(one(/<description>([\s\S]*?)<\/description>/, item)),
    });
  }

  return out;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * The card's own date, e.g. "September 9, 2026". Only reached for a post the
 * firehose has dropped; null rather than a guess on any other shape, since no
 * <pubDate> beats a wrong one.
 *
 * Pinned to UTC by hand rather than handed to `Date.parse`, which reads a bare
 * "September 9, 2026" as **local** midnight — five hours adrift on a laptop and
 * fine on val.town, which is the sort of difference that shows up only as a
 * test that passes on one machine. The day the card prints is the UTC day of
 * the feed's own timestamp on all 84 posts, so UTC is also the right answer.
 */
function cardDate(card: string): number | null {
  const printed = one(
    /<p class="text-body-small text-text-tertiary">([^<]*)<\/p>/,
    card,
  );
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(printed.trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  return Date.UTC(Number(m[3]), month, Number(m[2]));
}

/**
 * Astro serves thumbnails from /_astro with a `?dpl=<deploy id>` cache buster
 * that is a pure no-op — the same bytes come back without it, or with a bogus
 * one. It is dropped because it changes on **every mistral.ai deploy**, and
 * FreshRSS hashes an entry's enclosure URL into the attributes it compares:
 * leaving it on would rewrite, and re-unread, all 41 items every time Mistral
 * shipped an unrelated change to their website.
 */
function imageUrl(src: string): string {
  if (!src) return "";
  const url = src.replace(/[?&]dpl=[^&]*/, "");
  return /^https?:\/\//.test(url) ? url : `${SITE}${url}`;
}

/**
 * The categories this feed carries, as the site spells them, in the order
 * CATEGORIES lists them. One that no post currently uses drops out rather than
 * leaving a gap in the channel title.
 */
export function displayNames(posts: Post[]): string[] {
  const bySlug = new Map<string, string>();
  for (const p of posts) {
    for (const name of p.categories) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, name);
    }
  }
  return CATEGORIES.map((slug) => bySlug.get(slug)).filter((n) =>
    n !== undefined
  );
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
      category: p.categories.filter(Boolean).map((name) => ({
        name: clean(name),
      })),
      image: p.image || undefined,
    } as Item);
  }

  return out.rss2();
}

/** Slash-terminated: that is how the site links a post and how the feed keys it. */
function postUrl(slug: string): string {
  return `${SITE}/news/${slug}/`;
}

/** First capture of `re`, or "" — the shape every field read here wants. */
function one(re: RegExp, s: string): string {
  return re.exec(s)?.[1] ?? "";
}

/**
 * Editor-entered text arrives with whatever whitespace was typed — one title
 * and one byline in the current set have a trailing space — and the rendered
 * page trimmed it for us. Both sources also escape a handful of entities
 * (`&amp;`, `&apos;`, `&#39;`), which have to come back out before the feed
 * library escapes them again, or they ship double-encoded.
 */
function str(v: string): string {
  return v
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, h) => String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
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
