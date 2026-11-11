/**
 * Offline tests for the NYC Film Spotlight feed. The fixture is the one API
 * response the val reads. Refresh with:
 *
 *   curl -s https://filmspotlight.org/api/analysis/future -o filmspotlight-future.json
 *
 * The counts below move whenever it is recaptured — this is a rolling calendar.
 *
 * Run: deno test --allow-read test/filmspotlight-rss.test.ts
 */

import {
  buildFeed,
  type Event,
  extractEvents,
  isAllowedTheater,
  renderRss,
} from "../filmspotlight-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("./filmspotlight-future.json", import.meta.url),
  ),
);
const events = extractEvents(fixture);
const event = (id: number) => events.find((e) => e.id === id)!;

const FEED_URL = "https://feed.val.run/filmspotlight";

Deno.test("reads events matching the allowed theaters and only those", () => {
  assertEquals(fixture.length, 114, "records the API returned");
  assertEquals(events.length, 35, "events read at allowed theaters");
  assert(events.every((e) => e.title), "every event has a title");
  assertEquals(new Set(events.map((e) => e.id)).size, events.length, "unique");
  assert(events.every((e) => e.description), "every event has a description");
  assert(events.every((e) => e.screenings.length), "and at least one date");
  assert(
    events.every((e) => isAllowedTheater(e.location)),
    "every event is at an allowed theater",
  );
});

Deno.test("theater filter matches all requested theaters and excludes others", () => {
  const allowed = [
    "AMC Empire 25",
    "AMC Lincoln Square 13",
    "AMC Magic Johnson Harlem 9",
    "AMC 34th Street 14",
    "Regal Union Square",
    "Regal Essex Crossing",
    "Alamo Drafthouse",
    "Alamo Drafthouse Cinema",
    "Angelika Film Center",
    "Village East by Angelika",
    "IFC Center",
    "IFC",
    "Paris Theater",
    "Paris Cinema",
    "The Paris Theatre",
    "MoMA, Floor T2/T1, Theater 1",
    "MoMA, The Roy and Niuta Titus Theater 1",
    "The Roy and Niuta Titus Theater 1, MoMA",
    "Museum of Modern Art",
    "Film at Lincoln Center",
    "Lincoln Center",
    "Museum of the Moving Image",
    "Museum of the Moving Image, Redstone Theater",
    "MoMI",
    "MOMI",
  ];
  for (const loc of allowed) {
    assert(isAllowedTheater(loc), `expected "${loc}" to be allowed`);
  }

  const disallowed = [
    "Almost Drafthouse",
    "92NY",
    "American Museum of Natural History",
    "Anthology Film Archives",
    "Cinema Village",
    "DCTV Firehouse Cinema",
    "Film Forum",
    "Film Noir Cinema",
    "Metrograph",
    "Nitehawk Cinema",
    "Quad Cinema",
    "Roxy Cinema",
    "Spectacle Theater",
    "",
  ];
  for (const loc of disallowed) {
    assert(!isAllowedTheater(loc), `expected "${loc}" to be disallowed`);
  }
});

Deno.test("extractEvents drops events from non-allowed theaters", () => {
  const records = [
    {
      id: 1,
      event_title: "At IFC",
      event_location: "IFC Center",
      screenings: [{ date: "2026-09-01" }],
    },
    {
      id: 2,
      event_title: "At Nitehawk",
      event_location: "Nitehawk Cinema",
      screenings: [{ date: "2026-09-01" }],
    },
    {
      id: 3,
      event_title: "At Film Forum",
      event_location: "Film Forum",
      screenings: [{ date: "2026-09-01" }],
    },
  ];
  const extracted = extractEvents(records);
  assertEquals(extracted.map((e) => e.title), ["At IFC"]);
});

Deno.test("reads every field of a known event", () => {
  const e = event(4087);
  assertEquals(e.title, "Wendigo with Larry Fessenden (Director)");
  assertEquals(e.location, "Film at Lincoln Center");
  assertEquals(e.presenters, "Larry Fessenden (Director)");
  assertEquals(e.createdAt, Date.parse("2026-07-21T11:04:29.611176+00:00"));
  assertEquals(e.screenings, [{
    date: "2026-08-17",
    appearance: "Larry Fessenden (Director)",
  }]);
  assertEquals(e.rsvp, "https://www.filmlinc.org/films/wendigo/");
  assert(
    e.description.startsWith("This special 25th-anniversary screening"),
    "event description",
  );
});

Deno.test("dates an item by when it was announced, not when it screens", () => {
  // The heart of this feed. Dating by screening would sort the furthest-off
  // event to the top and reshuffle the whole feed as the calendar rolls;
  // created_at is Film Spotlight's own record of first seeing the event.
  const e = event(4087);
  const firstScreening = Date.parse(e.screenings[0].date);
  assert(
    e.createdAt! < firstScreening,
    "announced before it screens, as an announcement should be",
  );
  assert(events.every((e) => e.createdAt !== null), "every event is dated");

  // And the dates span a real history rather than clustering at fetch time.
  const span = Math.max(...events.map((e) => e.createdAt!)) -
    Math.min(...events.map((e) => e.createdAt!));
  assert(
    span > 300 * 86_400_000,
    "announcements spread over months, so these are theirs not ours",
  );
});

Deno.test("orders items newest announcement first", async () => {
  const dates = [...(await feed()).matchAll(/<pubDate>([^<]+)</g)]
    .map((m) => Date.parse(m[1]));
  assertEquals(dates, [...dates].sort((a, b) => b - a), "descending");
  assertEquals(dates.length, events.length, "one date per event");
});

Deno.test("prefers the event blurb but falls back to the film synopsis", () => {
  const both = {
    id: 1,
    event_title: "T",
    event_location: "IFC Center",
    event_description: "About this evening",
    film_description: "About the film",
    created_at: "2026-01-01T00:00:00Z",
    screenings: [{ date: "2026-09-01" }],
  };
  assertEquals(extractEvents([both])[0].description, "About this evening");
  assertEquals(
    extractEvents([{ ...both, event_description: null }])[0].description,
    "About the film",
    "the synopsis when there is no blurb",
  );
});

Deno.test("carries no hit count", () => {
  // Excluded on purpose: it moves with every page view, and a changed item is
  // one FreshRSS rewrites — churn for a number no reader asked for.
  assert(
    fixture.some((d: { hit_count?: number }) => d.hit_count),
    "the API does report it",
  );
  const xml = renderRss({
    title: "T",
    description: "D",
    siteLink: "https://filmspotlight.org",
    feedUrl: FEED_URL,
    items: events,
  });
  assert(!/hit[_ ]?count/i.test(xml), "and none of it reaches the feed");
});

Deno.test("lists every screening of a multi-night event", () => {
  const multi = events.find((e) => e.screenings.length > 1)!;
  assert(multi.screenings.length > 1, "found one");
  const xml = renderRss({
    title: "T",
    description: "D",
    siteLink: "https://filmspotlight.org",
    feedUrl: FEED_URL,
    items: [multi],
  });
  for (const s of multi.screenings) {
    assert(xml.includes(s.date), `${s.date} is in the body`);
  }
});

Deno.test("takes the poster when there is no social image", () => {
  const posterOnly = {
    id: 1,
    event_title: "T",
    event_location: "IFC Center",
    created_at: "2026-01-01T00:00:00Z",
    screenings: [{ date: "2026-09-01" }],
    poster_image: "https://image.tmdb.org/t/p/original/p.jpg",
  };
  assertEquals(
    extractEvents([posterOnly])[0].image,
    "https://image.tmdb.org/t/p/original/p.jpg",
  );
  assertEquals(
    extractEvents([{ ...posterOnly, og_image: "https://x/og.png" }])[0].image,
    "https://x/og.png",
    "the social image wins when both are set",
  );
});

Deno.test("names the image media type rather than letting it be guessed", () => {
  const withImage = events.filter((e) => e.image);
  assertEquals(withImage.length, 27, "events with an image");
  assert(
    withImage.every((e) => e.imageType.startsWith("image/")),
    "every one states a type",
  );
  assert(
    !withImage.some((e) => e.imageType === "image/jpg"),
    "jpeg, not the invalid image/jpg",
  );
});

Deno.test("drops an event with no screening left", () => {
  // This is the shape a past event takes once its screening rows are purged.
  // The endpoint should never return one, but the date-bounded API this val
  // used to read did, and those items rendered with no date anywhere in them.
  const kept = {
    id: 1,
    event_title: "Kept",
    event_location: "IFC Center",
    created_at: "2026-01-01T00:00:00Z",
    screenings: [{ date: "2026-09-01", in_person_appearence: "Ada" }],
  };
  const past = { ...kept, id: 2, event_title: "Past", screenings: [] };
  assertEquals(
    extractEvents([kept, past]).map((e) => e.title),
    ["Kept"],
    "only the one with a date",
  );
  assert(
    events.every((e) => e.screenings.length),
    "and nothing dateless survives from the live capture",
  );
});

Deno.test("skips records that are not events", () => {
  const withHoles = [
    null,
    {
      id: 1,
      event_title: "Kept",
      event_location: "IFC Center",
      created_at: "2026-01-01T00:00:00Z",
      screenings: [{ date: "2026-09-01" }],
    },
    undefined,
    { id: 2 },
    "not an object",
  ];
  assertEquals(extractEvents(withHoles).map((e) => e.title), ["Kept"]);
});

Deno.test("survives input that is not the API we asked for", () => {
  assertEquals(extractEvents([]).length, 0, "empty");
  assertEquals(extractEvents(null).length, 0, "null");
  assertEquals(extractEvents({ events: [] }).length, 0, "not an array");
  assertEquals(extractEvents([{}]).length, 0, "no id or title");
  const dup = {
    event_title: "A",
    event_location: "IFC Center",
    screenings: [{ date: "2026-09-01" }],
  };
  assertEquals(
    extractEvents([{ id: 1, ...dup }, { id: 1, ...dup, event_title: "B" }])
      .length,
    1,
    "a repeated id is taken once",
  );
});

const feed = (query = "") =>
  buildFeed(events, new URL(`${FEED_URL}${query}`)).text();

Deno.test("serves the listing", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 35, "every event");
  assert(body.includes("<title>NYC Film Spotlight</title>"), "channel title");
  assert(
    // The library normalises the channel link, adding the trailing slash.
    body.includes("<link>https://filmspotlight.org/</link>"),
    "channel link is the page this mirrors",
  );
});

Deno.test("links to the event page, not the ticket vendor", async () => {
  const body = await feed();
  assert(
    body.includes(
      '<guid isPermaLink="true">https://filmspotlight.org/event/4087</guid>',
    ),
    "the event page is a real permalink, so it doubles as the guid",
  );
  assert(
    body.includes("<link>https://filmspotlight.org/event/4087</link>"),
    "and as the link",
  );
  assert(
    body.includes("Tickets: https://www.filmlinc.org/films/wendigo/"),
    "the RSVP link is offered in the body instead",
  );
});

Deno.test("self-link is canonical, ignoring junk query params", async () => {
  const body = await feed("?start=2026-01-01&limit=5");
  assert(body.includes(`href="${FEED_URL}" rel="self"`), "bare self-link");
  assertEquals((body.match(/<item>/g) ?? []).length, 35, "params ignored");
});

const SAMPLE: Event = {
  id: 1,
  title: "Tom & Jerry <live>",
  location: "IFC & Co",
  description: 'He said "hi"',
  presenters: "Ada & Grace",
  screenings: [{ date: "2026-08-20", appearance: "Ada" }],
  createdAt: Date.parse("2026-08-03T11:05:41Z"),
  rsvp: "https://tickets.example/1",
  image: "https://image.tmdb.org/t/p/original/a.jpg",
  imageType: "image/jpeg",
};

Deno.test("renders XML-safe output", () => {
  const bell = String.fromCharCode(7);
  const out = renderRss({
    title: "Feed & <friends>",
    description: 'Quote " and control',
    siteLink: "https://filmspotlight.org",
    feedUrl: FEED_URL,
    items: [SAMPLE],
  });

  // The library wraps item text in CDATA rather than escaping entities, so the
  // characters that used to need escaping now appear verbatim — what matters is
  // that they cannot terminate the section early.
  assert(
    out.includes("<![CDATA[Tom & Jerry <live>]]>"),
    "item title survives verbatim inside CDATA",
  );
  assert(!out.includes("]]]]"), "no stray CDATA breakout in ordinary text");
  assert(out.includes('type="image/jpeg"'), "enclosure states the media type");

  // Control characters are illegal in XML 1.0 and the library does not strip
  // them, so the val must — one anywhere breaks the whole document.
  const dirty = renderRss({
    title: "T",
    description: "d",
    siteLink: "https://filmspotlight.org",
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE, title: `Bell${bell}here` }],
  });
  // deno-lint-ignore no-control-regex
  assert(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(dirty), "control chars stripped");
  assert(dirty.includes("Bellhere"), "and the rest of the title is kept");
});

Deno.test("a CDATA breakout in the source cannot escape the section", () => {
  const out = renderRss({
    title: "T",
    description: "d",
    siteLink: "https://filmspotlight.org",
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE, title: "before ]]> after" }],
  });
  assert(out.includes("]]]]><![CDATA[>"), "breakout split");
  assert(!/\]\]>\s*after/.test(out), "no early termination");
});

Deno.test("omits optional elements when the event lacks them", () => {
  const bare: Event = {
    ...SAMPLE,
    title: "Bare",
    location: "",
    description: "",
    presenters: "",
    screenings: [],
    createdAt: null,
    rsvp: "",
    image: "",
    imageType: "",
  };
  const out = renderRss({
    title: "T",
    description: "D",
    siteLink: "https://filmspotlight.org",
    feedUrl: FEED_URL,
    items: [bare],
  });

  for (const tag of ["pubDate", "author", "category", "enclosure"]) {
    assert(!out.includes(`<${tag}`), `omits <${tag}> when empty`);
  }
  assertEquals(
    out.match(/<description>/g)?.length,
    1,
    "only the channel description",
  );
});
