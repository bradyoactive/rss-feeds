/**
 * RSS feed for the NYC film Q&A listings on BALKON.
 *
 * Source: https://balkon.film/qa?city=nyc&events=qa&date=&theaters=alamo_drafthouse_downtown_brooklyn,alamo_drafthouse_lower_manhattan,amc_empire_25,amc_kips_bay_15,amc_lincoln_square_13,amc_village_7,angelika,film_at_lincoln_center,ifc_center,moma,momi,paris_theater
 *
 * Deploy on val.town as an HTTP val. No query params — the city and event type
 * are baked in; this serves NYC Q&As, soonest first.
 *
 * BALKON exposes no API (/api/*, .json, ?format=json and /feed all 404, and the
 * sitemap covers films, directors and theaters but no screenings), so this is
 * the second scraper in the collection after mercury. The markup makes up for
 * it: semantic class names, no framework payload, no attribute soup.
 *
 * Three things about this source are unlike the blogs:
 *
 *  1. **The date is not in the item.** It comes from the <div class="date-divider">
 *     above it, so parsing has to track position rather than read each item on
 *     its own. The dividers carry no year ("Mon · August 17") — the year comes
 *     from the date strip, whose links are ?date=YYYY-MM-DD.
 *
 *  2. **These are events, not posts.** See PUBLISHED_AT below.
 *
 *  3. **The page is gated after about a week.** An anonymous fetch sees a
 *     rolling window of ~8 days; later dates in the strip are locked behind a
 *     signup wall, and asking for one with ?date= returns an empty listing.
 *     Signed in, the same single page lists every date — about six weeks out
 *     when this was written — so the feed sends a session cookie when it has
 *     one (see SIGNED_IN below) and is otherwise the anonymous week.
 */

import { Feed, type Item } from "npm:feed@6.0.0";

const SITE = "https://balkon.film";
const SOURCE =
  `${SITE}/qa?city=nyc&events=qa&date=&theaters=alamo_drafthouse_downtown_brooklyn,alamo_drafthouse_lower_manhattan,amc_empire_25,amc_kips_bay_15,amc_lincoln_square_13,amc_village_7,angelika,film_at_lincoln_center,ifc_center,moma,momi,paris_theater`;

/**
 * How long a reader or CDN may reuse a response. Listings change daily but a
 * screening enters the listing a week or more before it happens, so a long
 * window costs no timeliness and is the only caching here — the in-memory kind
 * never survived val.town recycling an idle isolate.
 */
const CACHE_SECONDS = 60 * 60;

/**
 * SIGNED_IN: the `Cookie` request header of a logged-in browser session on
 * balkon.film (copy it from DevTools → Network), stored as a val.town env var.
 * It is a live session, so it belongs in the env var and never in this file.
 *
 * Nothing breaks when it lapses: the strip locks again, the feed shrinks back
 * to the anonymous week, and the handler logs a warning — the only signal that
 * the cookie needs replacing.
 */
const COOKIE_VAR = "BALKON_COOKIE";

export interface Screening {
  /** Stable identity: the same film, at the same theater, on the same day. */
  id: string;
  film: string;
  filmSlug: string;
  theater: string;
  /** ISO date of the screening, resolved from the date strip. */
  date: string;
  /** How the page prints the day, e.g. "Mon · August 17". */
  dayLabel: string;
  /** Start times as printed, e.g. ["6:30 PM"]. */
  times: string[];
  directors: string[];
  /** BALKON's own blurb, e.g. "Screening + Q&A with Larry Fessenden". */
  blurb: string;
  guests: { name: string; role: string; image: string }[];
  /** Where to buy, or the film's BALKON page when no ticket link is offered. */
  link: string;
}

export default async function (req: Request): Promise<Response> {
  const cookie = Deno.env.get(COOKIE_VAR)?.trim() || undefined;
  let html: string;
  try {
    html = await fetchPage(cookie);
  } catch (err) {
    return text(502, `Failed to fetch ${SOURCE}: ${err}`);
  }

  if (cookie && html.includes("date-cell-locked")) {
    console.warn(
      `${COOKIE_VAR} is set but BALKON still shows locked dates — the session has probably expired`,
    );
  }

  return buildFeed(extractScreenings(html), new URL(req.url), new Date());
}

/**
 * Pure half of the handler. `now` is passed in rather than read here so the
 * tests can pin it.
 */
export function buildFeed(
  screenings: Screening[],
  url: URL,
  now: Date,
): Response {
  const xml = renderRss({
    title: "BALKON — NYC Q&As",
    description:
      "Film screenings with a Q&A in New York City, from BALKON's listings.",
    siteLink: SOURCE,
    feedUrl: `${url.origin}${url.pathname}`,
    items: screenings,
    now,
  });

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
}

async function fetchPage(cookie?: string): Promise<string> {
  const res = await fetch(SOURCE, {
    headers: {
      "user-agent": "balkon-rss-bridge (+https://val.town)",
      accept: "text/html",
      ...(cookie ? { cookie } : {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * Walks the listing in document order, carrying the date forward.
 *
 * One alternation matches both markers so the two stay interleaved exactly as
 * the page has them; a screening is attributed to whichever divider it last
 * passed. Screenings before any divider are dropped rather than guessed at.
 */
export function extractScreenings(html: string): Screening[] {
  const dates = dateLookup(html);
  const marker =
    /<li[^>]*class="date-divider"[^>]*>\s*<span>([^<]*)<|<li[^>]*class="screening-item"[^>]*>([\s\S]*?)<\/li>/g;

  const screenings: Screening[] = [];
  let dayLabel = "";

  for (const match of html.matchAll(marker)) {
    const [, divider, item] = match;
    if (divider !== undefined) {
      dayLabel = decode(divider).trim();
      continue;
    }
    const date = dates.get(monthDayOf(dayLabel));
    if (!date) continue;

    const screening = readItem(item, date, dayLabel);
    if (screening) screenings.push(screening);
  }

  return screenings;
}

/**
 * "August 17" → "2026-08-17", built from the date strip's own links.
 *
 * Those links are the only place on the page that states a year, which is what
 * keeps this correct across a December/January boundary.
 */
function dateLookup(html: string): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const [, iso] of html.matchAll(/[?&]date=(\d{4}-\d{2}-\d{2})/g)) {
    const [year, month, day] = iso.split("-").map(Number);
    lookup.set(`${MONTHS[month - 1]} ${day}`, iso);
    // Referenced so a malformed year cannot silently produce a valid key.
    if (!Number.isFinite(year)) lookup.delete(`${MONTHS[month - 1]} ${day}`);
  }
  return lookup;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "Mon · August 17" → "August 17", the part the date strip can be keyed on. */
function monthDayOf(dayLabel: string): string {
  const match = /([A-Z][a-z]+)\s+(\d{1,2})/.exec(dayLabel);
  return match ? `${match[1]} ${Number(match[2])}` : "";
}

function readItem(
  item: string,
  date: string,
  dayLabel: string,
): Screening | null {
  const film =
    /<a href="\/film\/([^"]+)"[^>]*class="screening-title"[^>]*>([^<]*)</
      .exec(item);
  if (!film) return null;

  const filmSlug = film[1];
  const theater =
    /<span class="theater-name">\s*<a href="\/theater\/([^"]+)"[^>]*>([^<]*)</
      .exec(item);

  // Deliberately not captured: the "sold-out" class on a showtime. It flips
  // while the screening sits in the feed, and FreshRSS hashes an item's content
  // to decide whether it changed — so carrying it would re-date and resurface
  // the item for news that is stale by the time it is read.
  const times: string[] = [];
  let link = "";
  for (
    const [, href, , inner] of item.matchAll(
      /<a href="([^"]*)"[^>]*class="showtime([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
    )
  ) {
    // The tag is its own element and is not always "Q&A" — a screening can
    // also carry an "intro". Removing the element rather than the word keeps
    // the time clean and the label intact.
    const tag = textOf(inner, "showtime-tag");
    const time = stripTags(
      inner.replace(/<span class="showtime-tag"[\s\S]*?<\/span>/, ""),
    );
    if (time) {
      times.push(tag && !/^q&a$/i.test(tag) ? `${time} (${tag})` : time);
    }
    if (!link && href.trim()) link = decode(href).trim();
  }

  const guests = [
    ...item.matchAll(/<a class="qa-guest-card"[^>]*>([\s\S]*?)<\/a>/g),
  ].map(([, card]) => ({
    name: textOf(card, "qa-guest-card-name"),
    role: textOf(card, "qa-guest-card-role"),
    image: decode(/<img[^>]*src="([^"]*)"/.exec(card)?.[1] ?? ""),
  })).filter((guest) => guest.name);

  const meta =
    /<div class="screening-meta">([\s\S]*?)<\/div>/.exec(item)?.[1] ??
      "";

  return {
    id: `${filmSlug}|${theater?.[1] ?? "unknown"}|${date}`,
    film: decode(film[2]).trim(),
    filmSlug,
    theater: decode(theater?.[2] ?? "").trim(),
    date,
    dayLabel,
    times,
    directors: [...meta.matchAll(/<a[^>]*>([^<]*)<\/a>/g)]
      .map(([, name]) => decode(name).trim()).filter(Boolean),
    blurb: stripTags(
      /<div class="screening-description[^"]*">([\s\S]*?)<\/div>/.exec(item)
        ?.[1] ?? "",
    ),
    guests,
    link: link || `${SITE}/film/${filmSlug}`,
  };
}

/**
 * TMDB serves headshots as .jpg. Stating the type keeps the library from
 * guessing "image/jpg" from the extension, which is not a real media type.
 */
function mediaType(url: string): string | undefined {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (!ext) return undefined;
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

/** The text of the first `<span class="…">` carrying the given class. */
function textOf(html: string, className: string): string {
  const match = new RegExp(`class="${className}"[^>]*>([^<]*)<`).exec(html);
  return decode(match?.[1] ?? "").trim();
}

function stripTags(html: string): string {
  return decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

export function renderRss(feed: {
  title: string;
  description: string;
  siteLink: string;
  feedUrl: string;
  items: Screening[];
  now: Date;
}): string {
  const out = new Feed({
    title: clean(feed.title),
    description: clean(feed.description),
    link: feed.siteLink,
    language: "en",
    updated: feed.now,
    feedLinks: { rss: feed.feedUrl },
    generator: false,
  });

  // Soonest first. Every item carries the same date (see below), so the order
  // they are written in is the order a reader shows them in.
  const items = [...feed.items].sort((a, b) =>
    a.date.localeCompare(b.date) || a.film.localeCompare(b.film)
  );

  for (const s of items) {
    out.addItem({
      title: clean(titleOf(s)),
      link: s.link,
      // The one val that sets an explicit id, so <guid isPermaLink="false">.
      // The link is a ticket URL: not unique (a screening can offer two) and
      // not stable. Identity is film + theater + day instead.
      id: s.id,
      // PUBLISHED_AT: these are future events, and dating them by showtime
      // would sort the furthest-off screening to the top and reshuffle the feed
      // as the calendar rolls. `now` instead means "when this appeared in the
      // listing". FreshRSS keeps it: its change detection hashes link, title,
      // author, content and enclosures — never the date — so re-serving a new
      // `now` every poll does not move an entry that is already stored.
      date: feed.now,
      description: clean(describe(s)) || undefined,
      author: s.guests.length
        ? [{ name: clean(s.guests.map((g) => g.name).join(" & ")) }]
        : undefined,
      category: s.theater ? [{ name: clean(s.theater) }] : [],
      image: s.guests[0]
        ? { url: s.guests[0].image, type: mediaType(s.guests[0].image) }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

/** "Wendigo — Film at Lincoln Center · Mon · August 17, 6:30 PM" */
function titleOf(s: Screening): string {
  const when = [s.dayLabel, s.times.join(" & ")].filter(Boolean).join(", ");
  return [s.film, s.theater].filter(Boolean).join(" — ") +
    (when ? ` · ${when}` : "");
}

function describe(s: Screening): string {
  const lines = [s.blurb];
  if (s.guests.length) {
    lines.push(
      "With " +
        s.guests.map((g) => g.role ? `${g.name} (${g.role})` : g.name)
          .join(", "),
    );
  }
  if (s.directors.length) lines.push(`Directed by ${s.directors.join(", ")}`);
  return lines.filter(Boolean).join(" · ");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
};

function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
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
 * just its own item. Scraped text is exactly where one would come from.
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
