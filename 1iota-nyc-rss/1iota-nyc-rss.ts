/**
 * RSS feed for free TV-taping and screening tickets offered by 1iota in New
 * York City: The View, Tamron Hall, Seth Meyers, The Daily Show, Drew
 * Barrymore, LIVE with Kelly & Mark and the like, plus the odd film screening.
 *
 * Source: https://1iota.com/new-york
 *
 * The site is an Angular app that renders empty and fills itself from its
 * ticketing API at prod-tickets.1iota.com. Two of its endpoints are public and
 * need no parameters, and this feed reads both, in parallel:
 *
 *   /api/event/list   every upcoming taping in every city, in full (~500 KB)
 *   /api/locations    the cities those tapings are tagged with (~6 KB)
 *
 * WHERE: each event carries `projectLocationIds`, the same ids the site's own
 * location picker filters by. New York is two of them today — 125 "New York
 * City, NY" and 94 "Brooklyn, NY" — and they are read from /api/locations by
 * name rather than hard-coded, so a Queens or Bronx location 1iota adds later
 * joins the feed without a code change. The free-text `where` field was the
 * alternative and is worse: it spells the same place as both "New York, NY"
 * and "New York City, NY".
 *
 * WHAT: one item per taping. A show that tapes four days a week is four items,
 * which is the point — each date is requested separately and each has its own
 * page at /event/<id>. Sold-out tapings are left out: the feed is for finding
 * tickets, and a third of the listing at any time is already gone.
 *
 * Daytime talk shows are left out too (see DAYTIME): they are most of the
 * listing — The View alone tapes nearly every weekday — and this feed is for
 * late-night shows, specials and screenings. The API has no genre field and
 * taping time does not separate them (Tamron Hall tapes at 4 PM, Seth Meyers at
 * 2 PM), so the shows are named. Matching on the title rather than the project
 * id keeps a show out across seasons, which 1iota gives new project ids.
 *
 * Late-night shows (see LATE_NIGHT) are kept only once 1iota has named a guest
 * for that taping: the guest is what makes one Seth Meyers taping worth more
 * than the next, and most are posted weeks before anyone is booked. A taping
 * whose guests are announced later appears in the feed at that point.
 *
 * WHO: guests come from two places, merged. Each event's own `guests`, and
 * /api/celeb/appearances, which feeds the homepage's "Upcoming guests" strip
 * and is the only place some names are recorded — on 2026-11-18 it named 71
 * appearances the events' own lists did not, including the stars of a NYC
 * screening. It is a third request (~55 KB) but it is the complete answer to
 * "who is announced", which the late-night filter depends on. The names go in
 * the item title, the body, and one <category> each so a reader can filter on
 * them.
 *
 * PUBLISHED_AT: the API has no "posted" timestamp, and the taping time is the
 * wrong thing to date an item by — it would sort the furthest-off taping to the
 * top and make every new item appear to come from the future. So items carry
 * no <pubDate>; a reader stamps each one when it first sees it, which is
 * exactly when it was announced as far as the reader is concerned. Items are
 * ordered by event id, newest first: ids are allocated as tapings are posted.
 */

import { Feed, type Item } from "feed";

const SITE = "https://1iota.com";
const PAGE = `${SITE}/new-york`;
const API = "https://prod-tickets.1iota.com";
const EVENTS = `${API}/api/event/list`;
const LOCATIONS = `${API}/api/locations`;
const APPEARANCES = `${API}/api/celeb/appearances`;

/**
 * Tapings are posted a few times a week and fill up over days, so an hour is
 * fresh enough and spares 1iota half a megabyte per poll.
 */
const CACHE_SECONDS = 60 * 60;

/** The five boroughs, as 1iota names a location: "<place>, NY". */
const NYC =
  /^(new york( city)?|manhattan|brooklyn|queens|(the )?bronx|staten island),\s*ny$/i;

/**
 * Daytime talk shows that tape, or have taped, in New York, by how 1iota
 * starts their titles: "The View + The Weekend View - taping ends at 1:30p!"
 * is The View, and "Tamron Hall - Live Studio Audience -" is Tamron Hall.
 */
export const DAYTIME =
  /^(the view|tamron hall|the drew barrymore show|live with kelly|the kelly clarkson show|sherri|the jennifer hudson show|good morning america|gma3?\b|today\b|the today show)/i;

export function isDaytime(show: string): boolean {
  return DAYTIME.test(show);
}

/**
 * Late-night shows, which the feed keeps only when a guest is announced. The
 * same set 1iota's homepage files under LATE NIGHT, plus the other late-night
 * shows that tape in New York, by how their titles begin.
 */
export const LATE_NIGHT =
  /^(the tonight show|late night with|the late show|the daily show|last week tonight|jimmy kimmel|after midnight|saturday night live|watch what happens live|real time with bill maher|gutfeld)/i;

export function isLateNight(show: string): boolean {
  return LATE_NIGHT.test(show);
}

export interface Taping {
  id: number;
  /** The show, e.g. "Late Night with Seth Meyers". */
  show: string;
  /** The episode hook 1iota adds, e.g. "NEW YEARS DATING SHOW!". */
  subtitle: string;
  /** UTC instant the taping starts. */
  start: number;
  /** Local wall-clock labels as 1iota prints them: "Tue, Dec 08", "2:00 PM". */
  day: string;
  time: string;
  where: string;
  /** "16+"; tapings are age-restricted and readers need to know. */
  age: string;
  guests: string[];
  /** HTML, as 1iota writes it. */
  description: string;
  /** "Request Tickets", "Join Waitlist", …: what the page lets you do. */
  action: string;
  image: string;
  imageType: string;
}

export default async function (req: Request): Promise<Response> {
  let tapings: Taping[];
  try {
    const [events, locations, appearances] = await Promise.all([
      getJson(EVENTS),
      getJson(LOCATIONS),
      getJson(APPEARANCES),
    ]);
    tapings = extractTapings(
      events,
      nycLocationIds(locations),
      Date.now(),
      guestsByEvent(appearances),
    );
  } catch (err) {
    return text(502, `Failed to fetch ${API}: ${err}`);
  }
  return buildFeed(tapings, new URL(req.url));
}

/** Pure half of the handler: tapings in, RSS response out. */
export function buildFeed(tapings: Taping[], url: URL): Response {
  const xml = renderRss({
    title: "1iota — New York City",
    description:
      "Free tickets to late-night TV tapings, specials and screenings in New York City, from 1iota.",
    siteLink: PAGE,
    feedUrl: `${url.origin}${url.pathname}`,
    items: tapings,
  });
  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: {
      "user-agent": "1iota-nyc-rss (+https://feeds.brady.town)",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

/** The location ids that are in New York City, read from /api/locations. */
export function nycLocationIds(payload: unknown): Set<number> {
  const ids = new Set<number>();
  for (const row of list(payload)) {
    const id = Number(row.id);
    if (Number.isFinite(id) && NYC.test(str(row.location))) ids.add(id);
  }
  // An empty set would silently serve an empty feed. Better to fail loudly.
  if (!ids.size) throw new Error("no New York location in /api/locations");
  return ids;
}

/** Names per event id from /api/celeb/appearances, one row per appearance. */
export function guestsByEvent(payload: unknown): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const row of list(payload)) {
    const id = Number(row.eventId);
    const name = str(row.name);
    if (!Number.isFinite(id) || !name) continue;
    out.set(id, [...(out.get(id) ?? []), name]);
  }
  return out;
}

/**
 * Reads the tapings at `locations`, dropping sold-out ones and any that have
 * already started. The endpoint only lists upcoming tapings, but it is cached
 * for an hour, and an item for this morning's show is of no use by noon.
 */
export function extractTapings(
  payload: unknown,
  locations: Set<number>,
  now: number = Date.now(),
  appearances: Map<number, string[]> = new Map(),
): Taping[] {
  const byId = new Map<number, Taping>();

  for (const row of list(payload)) {
    const id = Number(row.eventId);
    const show = tidy(str(row.title));
    if (!Number.isFinite(id) || !show || byId.has(id)) continue;

    const at = Array.isArray(row.projectLocationIds)
      ? row.projectLocationIds.map(Number)
      : [];
    if (!at.some((l) => locations.has(l))) continue;
    if (row.isSoldOut === true) continue;
    if (isDaytime(show)) continue;

    // startDateUtc carries no zone designator, but it is UTC: 2:00 PM in New
    // York is "T19:00:00" in December. Without the Z it would parse as local.
    const iso = str(row.startDateUtc);
    const start = Date.parse(
      /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`,
    );
    if (!Number.isFinite(start) || start < now) continue;

    // Event's own list first, in 1iota's billing order, then any the
    // appearances feed adds. Compared without case or spacing, since editors
    // type the same name twice ("La La Anthony " and "La La Anthony").
    const guests: string[] = [];
    const seen = new Set<string>();
    for (const name of [
      ...list(row.guests).map((g) => str(g.name)),
      ...(appearances.get(id) ?? []).map(str),
    ]) {
      const key = name.toLowerCase().replace(/\s+/g, " ");
      if (!name || seen.has(key)) continue;
      seen.add(key);
      guests.push(name.replace(/\s+/g, " "));
    }
    if (isLateNight(show) && !guests.length) continue;

    // Not carried: the request-form switches (isGroupEnabled, maxTickets,
    // isPhotoRequired …). They change as a taping fills, and an item whose
    // content changes is one a reader re-marks unread.
    const image = absolute(str(row.imageUrl));
    byId.set(id, {
      id,
      show,
      subtitle: tidy(str(row.subTitle)),
      start,
      day: str(row.localStartDay),
      time: str(row.when),
      where: str(row.where),
      age: str(row.age),
      guests,
      description: str(row.description),
      action: str(row.buttonLabel),
      image,
      imageType: mediaType(image),
    });
  }

  return [...byId.values()];
}

export function renderRss(feed: {
  title: string;
  description: string;
  siteLink: string;
  feedUrl: string;
  items: Taping[];
}): string {
  // Newest posted first; ids are allocated as tapings are posted.
  const items = [...feed.items].sort((a, b) => b.id - a.id);

  const out = new Feed({
    title: clean(feed.title),
    description: clean(feed.description),
    id: feed.siteLink,
    link: feed.siteLink,
    language: "en",
    feedLinks: { rss: feed.feedUrl },
    generator: false,
  });

  for (const t of items) {
    out.addItem({
      title: clean(itemTitle(t)),
      // The event page is permanent and unique per taping, so it is both the
      // link and the guid. No `date`: see PUBLISHED_AT above.
      link: eventUrl(t.id),
      description: clean(describe(t)),
      category: [t.show, ...t.guests].map((name) => ({ name: clean(name) })),
      image: t.image
        ? { url: t.image, type: t.imageType || undefined }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

/**
 * "Late Night with Seth Meyers: Adam Driver, Betty Gilpin — Mon, Nov 23,
 * 2:00 PM". The guests and date belong in the title: they are what tells one
 * taping of a show from the next, and a list of twelve items all called "Late
 * Night with Seth Meyers" is unreadable. A subtitle, when there is one, comes
 * first, with the guests after it in parentheses.
 */
export function itemTitle(t: Taping): string {
  const who = t.guests.join(", ");
  let name = t.show;
  if (t.subtitle) name += `: ${t.subtitle}${who ? ` (${who})` : ""}`;
  else if (who) name += `: ${who}`;
  const when = [t.day, t.time].filter(Boolean).join(", ");
  return when ? `${name} — ${when}` : name;
}

/** When, where and who before the show's boilerplate blurb. */
function describe(t: Taping): string {
  const facts = [
    [t.day, t.time].filter(Boolean).join(" at "),
    t.where,
    t.age ? `Ages ${t.age}` : "",
  ].filter(Boolean);
  return [
    `<p><strong>${esc(facts.join(" · "))}</strong></p>`,
    t.guests.length ? `<p>Guests: ${esc(t.guests.join(", "))}</p>` : "",
    t.description,
    `<p><a href="${eventUrl(t.id)}">${esc(t.action || "Request tickets")} on 1iota</a></p>`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function eventUrl(id: number): string {
  return `${SITE}/event/${id}`;
}

/**
 * Collapses the whitespace and dangling dashes 1iota's editors leave in titles:
 * "Tamron Hall - Live Studio Audience -  " reads as "Tamron Hall - Live Studio
 * Audience".
 */
function tidy(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/[\s\-–—]+$/, "")
    .replace(/^[\s\-–—+]+/, "")
    .trim();
}

/** Some image URLs are protocol-relative ("//d1r8….cloudfront.net/…"). */
function absolute(url: string): string {
  return url.startsWith("//") ? `https:${url}` : url;
}

/**
 * The media host resizes on a trailing "/w=350", so the extension is not always
 * at the end. Naming the type also stops "image/jpg" being guessed.
 */
function mediaType(url: string): string {
  const ext = /\.([a-z0-9]+)(?:\/w=\d+)?(?:[?#]|$)/i
    .exec(url)?.[1]
    ?.toLowerCase();
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

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Strips the characters that are illegal in XML 1.0. The feed library passes
 * them through, and one anywhere makes the whole document unparseable.
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
