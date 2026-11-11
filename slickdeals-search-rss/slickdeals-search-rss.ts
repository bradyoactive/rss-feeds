/**
 * Parameterised RSS feed for Slickdeals search.
 *
 * One HTTP val that serves any Slickdeals search as a feed. Every parameter is
 * optional; with no query string at all it serves the newest deals site-wide.
 *
 *   /?rating=frontpage&minViews=5000&priceMax=100&sort=views
 *
 * ## Which filters the API applies, and which this val applies itself
 *
 * Slickdeals' JSON API lives at /web-api/search/deals/ and speaks two unrelated
 * vocabularies. The GET form takes the search page's query string verbatim and
 * supports price and date, but is **hard-capped at 40 results with no paging**.
 * The POST form takes a flat JSON body, has **no price and no date filter**, but
 * serves up to 100 rows per request. (It was 1000 until November 2026, when
 * `perPage` started being silently clamped to 100. It does page — ten pages of
 * 100 — but this val makes a single request and leans on `rating` to narrow
 * the pool instead.)
 *
 * This val uses POST. Client-side thresholds (views, votes, comments) are only
 * as good as the pool they are applied to, and a 40-row pool makes "5000+ views"
 * meaningless. Trading the server-side price filter for a deeper pool is the
 * right side of that trade — so price is filtered here instead.
 *
 *   server-side (POST)   q, rating, discount, forums, stores, categories,
 *                        sort (recent/popular/relevance only)
 *   client-side (here)   minVotes, minViews, minComments, priceMin, priceMax,
 *                        hideExpired, sort by views/votes/comments/price
 *
 * Measured 2026-08-29, and each one is a correction to what the sibling vals'
 * notes claimed:
 *
 *   - **POST does support `sort`.** `sort=popular` returns an entirely different
 *     (all-time) set. Only `recent`, `popular` and `relevance` are real; `views`,
 *     `comments` and `price` are silently ignored, which is why sorting by those
 *     is done here.
 *   - **POST's `discount` is a true arbitrary threshold**, unlike the GET form's
 *     10/25/50/75 enum: `discount=30` yields a floor of 29, `discount=90` a floor
 *     of 89. (One low, because the API compares the unrounded percentage while
 *     the field it returns is rounded.)
 *   - **`expired` is unreliable** — `expired:false` still returned an expired row
 *     in a 200-row sample, so `hideExpired` is enforced here on `isExpired`.
 *
 * `rating` is the one filter worth preferring over its client-side equivalent:
 * it is applied before the 100-row cap, so `rating=firedeal&minVotes=100` sees
 * the newest 100 fire deals, where `minVotes=100` alone only sees the newest
 * 100 deals of any kind — about four hours' worth, none of them old enough to
 * have reached 100 votes.
 * Its tiers are floors, not labels, and they drift — `firedeal` measured a floor
 * of 76 votes one day and 52 the next. Use `minVotes` for an exact cutoff.
 *
 * There is no views filter anywhere in either vocabulary, and no sort by views:
 * `minViews` cannot be pushed to the server at all.
 *
 * ## Date filtering, and the one place this val can mislead you
 *
 * POST has no date filter either, so `days`/`hours`/`since`/`until` are applied
 * here — and unlike the other client-side filters, this one has a *reach* limit
 * worth understanding. The API serves at most 100 rows per request and this val
 * makes one, so the pool is a hard ceiling, not a paging window.
 *
 * How far back 100 rows reach depends entirely on how much the server-side
 * filters narrowed things first (measured 2026-11-08):
 *
 *   no filter          4.5 hours       discount=60        22 hours
 *   rating=popular     10 hours        rating=frontpage   1.5 days
 *   forums=9           4.6 hours       rating=firedeal    5.7 days
 *   rating=5           19 hours        q=laptop           12 days
 *
 * So `?days=7` alone cannot work: the pool only holds 4.5 hours of deals, and a
 * naive implementation would return those and look successful. This val instead
 * compares the requested window against the oldest row it actually received and
 * reports the shortfall — in the `x-window-complete` response header and in the
 * feed's own description, where a reader will see it. Narrowing server-side
 * (`rating`, `q`, `discount`, `forums`) is what extends the reach.
 *
 * A date bound also changes which rows to ask for. `sort=popular` is a
 * *selection*, not just an ordering — it returns the all-time most popular, which
 * a recent window would filter down to almost nothing. So whenever a date bound
 * is set the pool is fetched newest-first and the requested sort is applied here
 * instead, which makes "most upvoted deals of the last three days" mean what it
 * should.
 */

import { Feed, type Item } from "feed";

const SITE = "https://slickdeals.net";
const API_URL = `${SITE}/web-api/search/deals/`;
const UA = "slickdeals-rss-bridge (+https://val.town)";

/**
 * How long a reader or CDN may reuse a response. Fifteen minutes: these are
 * deals that sell out, so a stale answer is worth less here than in a blog feed.
 */
const CACHE_SECONDS = 15 * 60;

/**
 * The zone Slickdeals timestamps are published in. A bare `since=2026-08-25` is
 * resolved against this rather than UTC, so a day means the site's day.
 */
const SITE_TZ = "America/Los_Angeles";

/**
 * The API's hard ceiling on one response, measured — `perPage:1000` returns 100.
 * It was 1000 until November 2026.
 */
const MAX_POOL = 100;

/** Ratings the API accepts. Anything else is rejected rather than silently ignored. */
const RATINGS = [
  "firedeal",
  "frontpage",
  "popular",
  "1",
  "2",
  "3",
  "4",
  "5",
] as const;

/** Sorts the API performs itself. */
const API_SORTS = ["recent", "popular", "relevance"] as const;
/** Sorts this val performs, because the API ignores them. */
const LOCAL_SORTS = ["views", "votes", "comments", "price", "-price"] as const;

export type Rating = typeof RATINGS[number];
export type Sort = typeof API_SORTS[number] | typeof LOCAL_SORTS[number];

export interface Options {
  q: string;
  rating: Rating | null;
  sort: Sort;
  minVotes: number | null;
  minViews: number | null;
  minComments: number | null;
  priceMin: number | null;
  priceMax: number | null;
  /** Minimum percent off, pushed to the API. */
  discount: number | null;
  /** Lower bound on posting time in ms, or null. */
  since: number | null;
  /** Upper bound on posting time in ms, or null. */
  until: number | null;
  /** How the window was written, for the feed's description. */
  window: string;
  forums: number[];
  stores: number[];
  hideExpired: boolean;
  /** Rows to ask the API for before filtering. */
  pool: number;
  /** Items to put in the feed. */
  limit: number;
  /** Whether to print vote/view/comment counts in each item's body. */
  showStats: boolean;
}

/** One deal, as this val cares about it. */
export interface Deal {
  id: string;
  title: string;
  /** The card's second line — "+ Free S&H", "w/ S&S". Often empty. */
  extra: string;
  url: string;
  image: string;
  /** The thumbnail's media type, once resolveImageTypes has asked the CDN. */
  imageType?: string;
  ts: number | null;
  author: string;
  store: string;
  listPrice: string;
  finalPrice: string;
  /** `finalPrice` as a number, or null when it carried no parseable amount. */
  price: number | null;
  discount: number | null;
  votes: number;
  views: number;
  comments: number;
  expired: boolean;
}

class BadRequest extends Error {}

/* -------------------------------------------------------------------------- */
/* parameters                                                                  */
/* -------------------------------------------------------------------------- */

function int(
  params: URLSearchParams,
  name: string,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
): number | null {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return null;
  // Number() rather than parseInt(): parseInt("12abc") is 12, which would let a
  // typo through as a filter the caller did not write.
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new BadRequest(`${name} must be a whole number, got "${raw}"`);
  }
  if (n < min || n > max) {
    throw new BadRequest(`${name} must be between ${min} and ${max}, got ${n}`);
  }
  return n;
}

function money(params: URLSearchParams, name: string): number | null {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw.replace(/[$,]/g, ""));
  if (!Number.isFinite(n) || n < 0) {
    throw new BadRequest(`${name} must be a non-negative amount, got "${raw}"`);
  }
  return n;
}

function bool(
  params: URLSearchParams,
  name: string,
  fallback: boolean,
): boolean {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new BadRequest(`${name} must be true or false, got "${raw}"`);
}

/** A decimal quantity, for `days=0.5`. */
function num(
  params: URLSearchParams,
  name: string,
  { min = 0 } = {},
): number | null {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new BadRequest(`${name} must be a number, got "${raw}"`);
  }
  if (n <= min) throw new BadRequest(`${name} must be greater than ${min}`);
  return n;
}

/** The UTC offset `SITE_TZ` is at on a given instant, in ms. DST-correct. */
function offsetMs(ts: number): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: SITE_TZ,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(ts))
    .find((p) => p.type === "timeZoneName")?.value ?? "";
  // "GMT-07:00" in summer, "GMT-08:00" in winter, bare "GMT" at UTC.
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
}

/**
 * A wall-clock time in `SITE_TZ` as an instant. Sampled twice because the offset
 * depends on the instant it is being applied to — near a DST boundary the first
 * guess can land on the wrong side of the change.
 */
function instantOf(date: string, hour: number, minute: number): number {
  const wall = Date.parse(
    `${date}T${String(hour).padStart(2, "0")}:${
      String(minute).padStart(2, "0")
    }:00Z`,
  );
  if (!Number.isFinite(wall)) return NaN;
  const first = wall - offsetMs(wall);
  return wall - offsetMs(first);
}

/**
 * A `since`/`until` bound. A bare date resolves in the site's zone — to the
 * start of that day for a lower bound, the end of it for an upper one, so
 * `until=2026-08-25` includes the whole of the 25th.
 */
function boundary(
  params: URLSearchParams,
  name: string,
  endOfDay: boolean,
): number | null {
  const raw = params.get(name)?.trim();
  if (!raw) return null;
  // The last minute of the day is 23:59, so an upper bound takes it plus its
  // own 59.999s — otherwise a deal posted at 23:59:30 falls outside a window
  // that names its date.
  const ts = /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? instantOf(raw, endOfDay ? 23 : 0, endOfDay ? 59 : 0) +
      (endOfDay ? 59_999 : 0)
    : Date.parse(raw);
  if (!Number.isFinite(ts)) {
    throw new BadRequest(
      `${name} must be YYYY-MM-DD or an ISO timestamp, got "${raw}"`,
    );
  }
  return ts;
}

function idList(params: URLSearchParams, name: string): number[] {
  // Accepts both ?forums=9,30 and repeated ?forums=9&forums=30.
  const raw = params.getAll(name).flatMap((v) => v.split(","));
  const out: number[] = [];
  for (const part of raw) {
    const s = part.trim();
    if (s === "") continue;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 0) {
      throw new BadRequest(`${name} must be numeric ids, got "${part}"`);
    }
    out.push(n);
  }
  return out;
}

export function parseOptions(url: URL, now: number = Date.now()): Options {
  const p = url.searchParams;

  const rating = p.get("rating")?.trim().toLowerCase() || null;
  if (rating !== null && !RATINGS.includes(rating as Rating)) {
    throw new BadRequest(
      `rating must be one of ${RATINGS.join(", ")} — got "${rating}". ` +
        "These are floors that drift over time; use minVotes for an exact cutoff.",
    );
  }

  const sort = (p.get("sort")?.trim().toLowerCase() || "recent") as Sort;
  const allSorts: string[] = [...API_SORTS, ...LOCAL_SORTS];
  if (!allSorts.includes(sort)) {
    throw new BadRequest(`sort must be one of ${allSorts.join(", ")}`);
  }

  // days, hours and since all set the same lower bound. Rather than silently
  // letting one win, refuse the ambiguity.
  const days = num(p, "days");
  const hours = num(p, "hours");
  const sinceParam = boundary(p, "since", false);
  const lower = [
    ["days", days],
    ["hours", hours],
    ["since", sinceParam],
  ].filter(([, v]) => v !== null);
  if (lower.length > 1) {
    throw new BadRequest(
      `${
        lower.map(([k]) => k).join(" and ")
      } all set the start of the window — ` +
        "use one of them",
    );
  }
  let since: number | null = null;
  let window = "";
  if (days !== null) {
    since = now - days * 86_400_000;
    window = `past ${days} day${days === 1 ? "" : "s"}`;
  } else if (hours !== null) {
    since = now - hours * 3_600_000;
    window = `past ${hours} hour${hours === 1 ? "" : "s"}`;
  } else if (sinceParam !== null) {
    since = sinceParam;
    window = `since ${p.get("since")!.trim()}`;
  }

  const until = boundary(p, "until", true);
  if (until !== null) {
    window = window
      ? `${window}, until ${p.get("until")!.trim()}`
      : `until ${p.get("until")!.trim()}`;
  }
  if (since !== null && until !== null && since > until) {
    throw new BadRequest("the window starts after it ends");
  }

  const priceMin = money(p, "priceMin");
  const priceMax = money(p, "priceMax");
  if (priceMin !== null && priceMax !== null && priceMin > priceMax) {
    throw new BadRequest(
      `priceMin (${priceMin}) is above priceMax (${priceMax})`,
    );
  }

  const opts: Options = {
    q: p.get("q")?.trim() ?? "",
    rating: rating as Rating | null,
    sort,
    minVotes: int(p, "minVotes"),
    minViews: int(p, "minViews"),
    minComments: int(p, "minComments"),
    priceMin,
    priceMax,
    discount: int(p, "discount", { min: 0, max: 100 }),
    since,
    until,
    window,
    forums: idList(p, "forums"),
    stores: idList(p, "stores"),
    hideExpired: bool(p, "hideExpired", false),
    pool: int(p, "pool", { min: 1, max: MAX_POOL }) ?? 0,
    limit: int(p, "limit", { min: 1, max: 500 }) ?? 50,
    showStats: bool(p, "showStats", true),
  };

  // A client-side threshold is only as good as the pool it reads, so default to
  // the deepest one the API allows. (This used to fall back to a cheaper pool
  // when every filter was server-side; at a 100-row ceiling there is nothing
  // cheaper worth having.)
  if (opts.pool === 0) opts.pool = MAX_POOL;
  return opts;
}

/* -------------------------------------------------------------------------- */
/* the API call                                                                */
/* -------------------------------------------------------------------------- */

export function buildBody(o: Options): Record<string, unknown> {
  const body: Record<string, unknown> = { perPage: o.pool, page: 1 };
  if (o.q) body.searchTerm = o.q;
  // A string: an int 400s.
  if (o.rating) body.rating = o.rating;
  if (o.discount !== null) body.discount = o.discount;
  if (o.forums.length) body.forums = o.forums;
  if (o.stores.length) body.stores = o.stores;
  // Only pass a sort the API performs; the others are done locally and passing
  // them would silently reorder the pool we then re-sort anyway.
  //
  // A date bound overrides even that. `sort=popular` selects the all-time most
  // popular deals, so pairing it with a recent window would filter a mostly-old
  // pool down to almost nothing. Newest-first is the only pool a date window can
  // be applied to honestly; the requested order is then restored locally.
  if (o.since !== null || o.until !== null) body.sort = "recent";
  else if ((API_SORTS as readonly string[]).includes(o.sort)) {
    body.sort = o.sort;
  } else body.sort = "recent";
  return body;
}

/** The first dollar amount in a price label, or null when there is none. */
export function parsePrice(text: string): number | null {
  // Covers "$17", "$1,299.00", "from $5", "4 for $2.70". Deliberately not
  // "50% Off" or "" — those carry no amount, and inventing 0 for them would put
  // every one of them under any priceMax the caller sets.
  const m = /\$\s*([\d,]+(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

interface ApiDeal {
  threadId?: number;
  dealTitle?: string;
  dealAdditionalInfo?: string;
  dealThreadUrl?: string;
  dealImageUrl?: string;
  threadIsoDatetime?: string;
  authorUserName?: string;
  storeName?: string;
  listPriceText?: string;
  finalPriceText?: string;
  discount?: number | null;
  socialVoteCount?: number;
  viewsCount?: number;
  socialCommentCount?: number;
  isExpired?: boolean;
}

export function extractDeals(payload: unknown): Deal[] {
  const rows = (payload as { deals?: ApiDeal[] })?.deals;
  if (!Array.isArray(rows)) return [];

  const seen = new Set<string>();
  const out: Deal[] = [];
  for (const row of rows) {
    const id = row?.threadId != null ? String(row.threadId) : "";
    const path = row?.dealThreadUrl ?? "";
    if (!id || !path || seen.has(id)) continue;
    seen.add(id);

    const ts = row.threadIsoDatetime ? Date.parse(row.threadIsoDatetime) : NaN;
    const finalPrice = (row.finalPriceText ?? "").trim();
    out.push({
      id,
      title: (row.dealTitle ?? "").trim(),
      extra: (row.dealAdditionalInfo ?? "").trim(),
      url: new URL(path, SITE).toString(),
      image: row.dealImageUrl ?? "",
      ts: Number.isFinite(ts) ? ts : null,
      author: (row.authorUserName ?? "").trim(),
      store: (row.storeName ?? "").trim(),
      listPrice: (row.listPriceText ?? "").trim(),
      finalPrice,
      price: parsePrice(finalPrice),
      discount: typeof row.discount === "number" ? row.discount : null,
      votes: row.socialVoteCount ?? 0,
      views: row.viewsCount ?? 0,
      comments: row.socialCommentCount ?? 0,
      expired: row.isExpired === true,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* client-side filtering and sorting                                           */
/* -------------------------------------------------------------------------- */

export function applyFilters(deals: Deal[], o: Options): Deal[] {
  let out = deals.filter((d) => {
    if (o.minVotes !== null && d.votes < o.minVotes) return false;
    if (o.minViews !== null && d.views < o.minViews) return false;
    if (o.minComments !== null && d.comments < o.minComments) return false;
    if (o.hideExpired && d.expired) return false;
    if (o.since !== null || o.until !== null) {
      // An undated row cannot be shown to fall inside the window, so it is
      // dropped rather than let through, exactly as an unparseable price is.
      if (d.ts === null) return false;
      if (o.since !== null && d.ts < o.since) return false;
      if (o.until !== null && d.ts > o.until) return false;
    }
    if (o.priceMin !== null || o.priceMax !== null) {
      // An unparseable price cannot be shown to satisfy the bound, so it is
      // dropped rather than let through — a "under $50" feed that includes
      // untested rows is worse than one that is short.
      if (d.price === null) return false;
      if (o.priceMin !== null && d.price < o.priceMin) return false;
      if (o.priceMax !== null && d.price > o.priceMax) return false;
    }
    return true;
  });

  const by = (f: (d: Deal) => number) => (a: Deal, b: Deal) => f(b) - f(a);
  // When a date bound forced a newest-first pool, the API never applied the
  // requested sort, so do it here. `relevance` has no local equivalent and is
  // left in the order the API returned.
  const dated = o.since !== null || o.until !== null;
  if (dated && o.sort === "popular") {
    return out.sort(by((d) => d.votes)).slice(0, o.limit);
  }
  switch (o.sort) {
    case "views":
      out = out.sort(by((d) => d.views));
      break;
    case "votes":
      out = out.sort(by((d) => d.votes));
      break;
    case "comments":
      out = out.sort(by((d) => d.comments));
      break;
    // Nulls are filtered out above whenever a price bound is set, but not when
    // sorting alone, so they are pushed to the end rather than compared.
    case "price":
      out = out.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
      break;
    case "-price":
      out = out.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
      break;
  }
  return out.slice(0, o.limit);
}

/**
 * Whether the pool actually reached back far enough to answer the window.
 *
 * The API serves 100 rows per request and this val makes one, so a window wider
 * than the pool's own span cannot be answered — and would otherwise look like a
 * successful, quietly truncated feed.
 */
export function windowComplete(pool: Deal[], o: Options): boolean {
  if (o.since === null && o.until === null) return true;
  // Fewer rows than we asked for means the API had nothing more to give, so
  // whatever the window was, we saw all of it.
  if (pool.length < o.pool) return true;
  const dated = pool.map((d) => d.ts).filter((t): t is number => t !== null);
  if (dated.length === 0) return false;
  const oldest = Math.min(...dated);
  // With only an upper bound the window runs infinitely far back, so a full
  // pool can never prove completeness.
  if (o.since === null) return false;
  return oldest <= o.since;
}

/* -------------------------------------------------------------------------- */
/* the feed                                                                    */
/* -------------------------------------------------------------------------- */

/** A human-readable account of what this feed is filtered to. */
export function describeFilters(o: Options): string {
  const bits: string[] = [];
  if (o.q) bits.push(`matching "${o.q}"`);
  if (o.window) bits.push(o.window);
  if (o.rating) bits.push(`rated ${o.rating}`);
  if (o.minVotes !== null) bits.push(`${o.minVotes}+ votes`);
  if (o.minViews !== null) bits.push(`${o.minViews}+ views`);
  if (o.minComments !== null) bits.push(`${o.minComments}+ comments`);
  if (o.discount !== null) bits.push(`${o.discount}%+ off`);
  if (o.priceMin !== null && o.priceMax !== null) {
    bits.push(`$${o.priceMin}–$${o.priceMax}`);
  } else if (o.priceMin !== null) bits.push(`over $${o.priceMin}`);
  else if (o.priceMax !== null) bits.push(`under $${o.priceMax}`);
  if (o.forums.length) bits.push(`forums ${o.forums.join("/")}`);
  if (o.stores.length) bits.push(`stores ${o.stores.join("/")}`);
  if (o.hideExpired) bits.push("excluding expired");
  return bits.length ? bits.join(", ") : "no filters";
}

export function title(o: Options): string {
  return bits(o) === "" ? "Slickdeals" : `Slickdeals — ${bits(o)}`;
}

function bits(o: Options): string {
  const d = describeFilters(o);
  return d === "no filters" ? "" : d;
}

function describe(d: Deal, o: Options): string {
  const parts: string[] = [];
  // The price itself is in the headline; only what it is compared against is
  // left here, to keep titles short enough to scan.
  if (d.finalPrice && d.listPrice && d.listPrice !== d.finalPrice) {
    parts.push(
      d.discount !== null
        ? `was ${d.listPrice}, ${d.discount}% off`
        : `was ${d.listPrice}`,
    );
  }
  if (d.store) parts.push(`at ${d.store}`);
  // Off by default. Vote, view and comment counts change on almost every poll,
  // and FreshRSS hashes the item body — printing them here would mark every
  // item updated and unread each time the feed is fetched. Opt in knowingly.
  if (o.showStats) {
    parts.push(
      [
        plural(d.votes, "vote"),
        plural(d.views, "view"),
        plural(d.comments, "comment"),
      ].join(" · "),
    );
  }
  if (d.expired) parts.push("Expired");
  return parts.join(" · ");
}

function plural(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
}

export function headline(d: Deal): string {
  // The card's second line usually qualifies the price, so it follows it:
  // "$17 + Free S&H", "$9.49 w/ S&S".
  const tail = [d.finalPrice, d.extra].filter(Boolean).join(" ");
  return tail ? `${d.title} — ${tail}` : d.title;
}

export function buildFeed(
  deals: Deal[],
  o: Options,
  now: Date,
  complete = true,
): string {
  // Said in the channel description rather than in an item: FreshRSS hashes
  // item bodies, and a warning that comes and goes would rewrite every entry.
  const shortfall = complete
    ? ""
    : ` — NOTE: this feed reads only the newest ${o.pool} results Slickdeals returns, so this window is only partly covered. Narrow it with rating, q, discount or forums to reach further back.`;
  const feed = new Feed({
    title: title(o),
    description: `Slickdeals search: ${
      describeFilters(o)
    }, sorted by ${o.sort}.${shortfall}`,
    id: `${SITE}/deals`,
    link: `${SITE}/deals`,
    language: "en",
    copyright: "Slickdeals, LLC",
    updated: now,
    generator: "slickdeals-search-rss",
  });

  for (const d of deals) {
    const item: Item = {
      title: headline(d),
      id: d.url,
      link: d.url,
      description: describe(d, o),
      date: d.ts !== null ? new Date(d.ts) : now,
    };
    if (d.author) item.author = [{ name: d.author }];
    if (d.image) {
      // FreshRSS renders an enclosure as an <img> based on exactly this type.
      // JPEG when unresolved: it is what nearly every thumbnail is.
      item.image = {
        url: d.image,
        type: d.imageType ?? "image/jpeg",
        length: 0,
      };
    }
    feed.addItem(item);
  }
  return feed.rss2();
}

/* -------------------------------------------------------------------------- */
/* handler                                                                     */
/* -------------------------------------------------------------------------- */

/** How long to wait on the CDN for one thumbnail's type before assuming JPEG. */
const IMAGE_TIMEOUT_MS = 3000;

/** How many thumbnails to ask about at once. */
const IMAGE_CONCURRENCY = 10;

/**
 * Asks the CDN what each thumbnail actually is. Every Slickdeals thumbnail URL
 * ends in ".thumb", which says nothing about its contents: most are JPEG, but
 * about 3 in 100 measured PNG (2026-11-08), and nothing in the API or the URL
 * tells them apart. Run on the feed's own items only, after filtering, so it
 * costs one HEAD per item shown rather than per row fetched. A failed or
 * non-image answer leaves the type unset, and the feed falls back to JPEG.
 */
export async function resolveImageTypes(deals: Deal[]): Promise<Deal[]> {
  const out = deals.map((d) => ({ ...d }));
  const todo = out.filter((d) => d.image);
  for (let i = 0; i < todo.length; i += IMAGE_CONCURRENCY) {
    await Promise.all(
      todo.slice(i, i + IMAGE_CONCURRENCY).map(async (d) => {
        try {
          const res = await fetch(d.image, {
            method: "HEAD",
            headers: { "user-agent": UA },
            signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
          });
          await res.body?.cancel();
          const type = res.headers.get("content-type")?.split(";")[0].trim();
          if (res.ok && type?.startsWith("image/")) d.imageType = type;
        } catch {
          // A thumbnail is not worth failing the feed over.
        }
      }),
    );
  }
  return out;
}

export async function fetchDeals(o: Options): Promise<Deal[]> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "user-agent": UA,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(buildBody(o)),
  });
  if (!res.ok) throw new Error(`${API_URL}: HTTP ${res.status}`);
  return extractDeals(await res.json());
}

export default async function (req: Request): Promise<Response> {
  let o: Options;
  try {
    o = parseOptions(new URL(req.url));
  } catch (err) {
    if (err instanceof BadRequest) {
      return new Response(`${err.message}\n`, {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw err;
  }

  const pool = await fetchDeals(o);
  const complete = windowComplete(pool, o);
  const deals = await resolveImageTypes(applyFilters(pool, o));
  return new Response(buildFeed(deals, o, new Date(), complete), {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
      // Lets a caller see how much of the pool survived without parsing the feed.
      "x-pool-size": String(o.pool),
      "x-pool-returned": String(pool.length),
      "x-item-count": String(deals.length),
      // false when the requested window is wider than the pool could reach.
      "x-window-complete": String(complete),
    },
  });
}
