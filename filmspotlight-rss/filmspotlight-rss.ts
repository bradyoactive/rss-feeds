/**
 * RSS feed for NYC Film Spotlight — screenings with in-person Q&As.
 *
 * Source: https://filmspotlight.org/
 *
 * Deploy on val.town as an HTTP val. The feed serves upcoming events at
 * selected theaters (AMC, Regal, Alamo Drafthouse, Angelika, IFC Center,
 * Paris Cinema/Theater, MoMA, Film at Lincoln Center, and MoMI), newest
 * announcement first.
 *
 * The site is a static Next.js export: every page renders empty and fills
 * itself from the site's own JSON API, so there is nothing to scrape. The
 * homepage calls exactly one endpoint for its listing, and this val calls the
 * same one:
 *
 *   /api/analysis/future   every event with a screening still to come
 *
 * It needs no parameters and returns each event in full — title, venue,
 * presenters, both descriptions, poster, RSVP link, every screening date, and
 * `created_at`. One request, ~175 KB, about a third of a second.
 *
 * There is also `/api/upcoming?start=&end=` plus `/api/event/<id>`, which is
 * what the `/upcoming` table uses, and it is what this val read first: 1 + 110
 * requests where this takes 1. Worse than slow, it was wrong — bounding the
 * window by date meant asking for a `start` of yesterday to survive the
 * UTC/Eastern offset, which dragged in ten events that had already happened and
 * whose screening rows had been purged, so they rendered with no dates at all.
 * `future` is defined by having a screening left rather than by a date, so the
 * question the feed wants to ask is the one the endpoint already answers.
 *
 * PUBLISHED_AT: these are future events, so the screening date is the wrong
 * thing to date an item by; it would sort the furthest-off event to the top and
 * reshuffle the feed as the calendar rolls. `created_at` is when Film Spotlight
 * first recorded the event, which is exactly the "first seen" the feed wants —
 * and being their timestamp rather than ours it is *stable*, so an edit to a
 * description cannot move an item that a reader has already filed.
 */

import { Feed, type Item } from "feed";

const SITE = "https://filmspotlight.org";
const API = `${SITE}/api/analysis/future`;

/**
 * How long a reader or CDN may reuse a response. Announcements arrive a few
 * times a week and FreshRSS polls at most hourly, so a long window costs
 * nothing and is the only caching here — the in-memory kind never survived
 * val.town recycling an idle isolate.
 */
const CACHE_SECONDS = 12 * 60 * 60;

export interface Event {
  id: number;
  title: string;
  location: string;
  description: string;
  /** Who is appearing, as Film Spotlight writes it. */
  presenters: string;
  /** Every screening still to come: ISO date plus who is there. */
  screenings: { date: string; appearance: string }[];
  /** When Film Spotlight recorded the event; the feed's pubDate. */
  createdAt: number | null;
  /** Where to book, on the theater's own site. */
  rsvp: string;
  image: string;
  imageType: string;
}

export default async function (req: Request): Promise<Response> {
  let events: Event[];
  try {
    events = extractEvents(await fetchEvents());
  } catch (err) {
    return text(502, `Failed to fetch ${API}: ${err}`);
  }

  return buildFeed(events, new URL(req.url));
}

/** Pure half of the handler: events in, RSS response out. */
export function buildFeed(events: Event[], url: URL): Response {
  const xml = renderRss({
    title: "NYC Film Spotlight",
    description:
      "Film screenings with in-person discussions and Q&A sessions in New York City.",
    siteLink: SITE,
    feedUrl: `${url.origin}${url.pathname}`,
    items: events,
  });

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
}

async function fetchEvents(): Promise<unknown> {
  const res = await fetch(API, {
    headers: {
      "user-agent": "filmspotlight-rss-bridge (+https://val.town)",
      accept: "application/json",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Theaters allowed in the feed:
 * - AMC
 * - Regal
 * - Alamo Drafthouse
 * - Angelika (Angelika Film Center, Village East by Angelika)
 * - IFC Center
 * - Paris Cinema / Paris Theater
 * - MoMA / Museum of Modern Art
 * - Film at Lincoln Center
 * - MoMI / Museum of the Moving Image
 */
export const ALLOWED_THEATERS: readonly RegExp[] = [
  /\bamc\b/i,
  /\bregal\b/i,
  /\balamo(\s+drafthouse)?\b/i,
  /\bangelika\b/i,
  /\bifc(\s+center)?\b/i,
  /\bparis\s*(theater|theatre|cinema)?\b/i,
  /\bmoma\b/i,
  /\bmuseum\s+of\s+modern\s+art\b/i,
  /\blincoln\s+center\b/i,
  /\bmomi\b/i,
  /\bmuseum\s+of\s+the\s+moving\s+image\b/i,
];

export function isAllowedTheater(location: string): boolean {
  if (!location) return false;
  return ALLOWED_THEATERS.some((re) => re.test(location));
}

/**
 * Reads the event records for allowed theaters.
 *
 * An event with no screening left is dropped. The endpoint should not return
 * one — that is what "future" means — but it is also the shape a past event
 * takes once its screening rows are purged, and an item with no date in it is
 * of no use to a reader.
 *
 * Events at theaters outside the allowed set are dropped.
 */
export function extractEvents(
  payload: unknown,
  theaterFilter: (location: string) => boolean = isAllowedTheater,
): Event[] {
  const byId = new Map<number, Event>();

  for (const row of list(payload)) {
    const id = Number(row.id);
    const title = str(row.event_title) || str(row.film_title);
    if (!Number.isFinite(id) || !title || byId.has(id)) continue;

    const location = str(row.event_location);
    if (!theaterFilter(location)) continue;

    const screenings = list(row.screenings).map((s) => ({
      date: str(s.date),
      appearance: str(s.in_person_appearence),
    })).filter((s) => s.date);
    if (!screenings.length) continue;

    // Not carried: hit_count. It moves on every page view, and an item whose
    // content changes is one FreshRSS re-writes — churn for a number no reader
    // asked for.
    const image = str(row.og_image) || str(row.poster_image);
    const createdAt = Date.parse(str(row.created_at));

    byId.set(id, {
      id,
      title,
      location,
      description: str(row.event_description) || str(row.film_description),
      presenters: str(row.event_presenters),
      screenings,
      createdAt: Number.isFinite(createdAt) ? createdAt : null,
      rsvp: str(row.link_to_rsvp),
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
  items: Event[];
}): string {
  // Newest announcement first, which is what the dates mean here.
  const items = [...feed.items].sort((a, b) =>
    (b.createdAt ?? 0) - (a.createdAt ?? 0)
  );
  const dates = items.map((e) => e.createdAt).filter((ts) => ts !== null);

  const out = new Feed({
    title: clean(feed.title),
    description: clean(feed.description),
    link: feed.siteLink,
    language: "en",
    updated: new Date(dates.length ? Math.max(...dates) : Date.now()),
    feedLinks: { rss: feed.feedUrl },
    generator: false,
  });

  for (const e of items) {
    out.addItem({
      title: clean(e.title),
      // Neither `id` nor `guid`: Film Spotlight gives every event a permanent
      // page, so the link is the identity and <guid isPermaLink="true"> holds
      // it. The RSVP link would not do — it points at the theater's vendor.
      link: eventUrl(e.id),
      ...(e.createdAt !== null ? { date: new Date(e.createdAt) } : {}),
      description: clean(describe(e)) || undefined,
      author: e.presenters ? [{ name: clean(e.presenters) }] : undefined,
      category: e.location ? [{ name: clean(e.location) }] : [],
      image: e.image
        ? { url: e.image, type: e.imageType || undefined }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

/**
 * The item body: when and where before what, because for an event those are
 * the parts a reader decides on.
 */
function describe(e: Event): string {
  const when = e.screenings.map((s) =>
    s.appearance ? `${s.date} — ${s.appearance}` : s.date
  );
  return [
    when.length ? `${e.location}: ${when.join("; ")}` : e.location,
    e.description,
    e.rsvp ? `Tickets: ${e.rsvp}` : "",
  ].filter(Boolean).join("\n\n");
}

function eventUrl(id: number): string {
  return `${SITE}/event/${id}`;
}

/** TMDB serves .jpg; naming the type stops "image/jpg" being guessed from it. */
function mediaType(url: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase();
  if (!ext) return "";
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : null;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(obj).filter((x) => x !== null) : [];
}

/** Editor-entered text can carry stray whitespace the rendered page trimmed. */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
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
