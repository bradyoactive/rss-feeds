/**
 * Offline tests for the 1iota NYC feed. The fixtures are the three API
 * responses the feed reads, captured together on 2026-11-18. Refresh with:
 *
 *   curl -s https://prod-tickets.1iota.com/api/event/list -o 1iota-event-list.json
 *   curl -s https://prod-tickets.1iota.com/api/locations -o 1iota-locations.json
 *   curl -s https://prod-tickets.1iota.com/api/celeb/appearances -o 1iota-appearances.json
 *
 * The counts below move whenever they are recaptured — this is a rolling
 * calendar — and so does CAPTURED, which stands in for "now".
 *
 * Run: node --test 1iota-nyc-rss/test/1iota-nyc-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  eventUrl,
  extractTapings,
  guestsByEvent,
  isDaytime,
  isLateNight,
  itemTitle,
  nycLocationIds,
  renderRss,
  type Taping,
} from "../1iota-nyc-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const load = async (name: string) =>
  JSON.parse(await readFile(new URL(`./${name}`, import.meta.url), "utf8"));

const eventsFixture = await load("1iota-event-list.json");
const locationsFixture = await load("1iota-locations.json");
const appearancesFixture = await load("1iota-appearances.json");

/** Just before the fixture was captured, so nothing in it has started yet. */
const CAPTURED = Date.parse("2026-11-18T22:00:00Z");
const NYC = nycLocationIds(locationsFixture);
const APPEARANCES = guestsByEvent(appearancesFixture);
const tapings = extractTapings(eventsFixture, NYC, CAPTURED, APPEARANCES);
const taping = (id: number) => tapings.find((t) => t.id === id)!;

const FEED_URL = "https://feeds.brady.town/1iota-nyc-rss";

const record = (over: Record<string, unknown> = {}) => ({
  eventId: 1,
  title: "Show",
  subTitle: null,
  startDateUtc: "2026-12-01T15:00:00",
  localStartDay: "Tue, Dec 01",
  when: "10:00 AM",
  where: "New York, NY",
  projectLocationIds: [125],
  isSoldOut: false,
  ...over,
});

test("finds New York's locations by name, not by a hard-coded id", () => {
  assertEquals(
    [...NYC].sort((a, b) => a - b),
    [94, 125],
    "Brooklyn and New York City",
  );
  const ids = nycLocationIds([
    { id: 1, location: "Queens, NY" },
    { id: 2, location: "The Bronx, NY" },
    { id: 3, location: "Staten Island, NY" },
    { id: 4, location: "Rochester, NY" },
    { id: 5, location: "Newark, NJ" },
    { id: 6, location: "New York City, NY" },
  ]);
  assertEquals([...ids], [1, 2, 3, 6], "the boroughs and only them");
});

test("refuses to serve an empty feed when no location matches", () => {
  let threw = false;
  try {
    nycLocationIds([{ id: 1, location: "Burbank, CA" }]);
  } catch {
    threw = true;
  }
  assert(threw, "an unrecognisable locations list is an error");
});

test("reads the NYC tapings that can still be booked, and only those", () => {
  assertEquals(eventsFixture.length, 173, "records across every city");
  const nyc = eventsFixture.filter((e: { projectLocationIds: number[] }) =>
    e.projectLocationIds.some((l) => NYC.has(l)),
  );
  assertEquals(nyc.length, 116, "in New York");
  assertEquals(
    tapings.length,
    4,
    "bookable, not daytime, guests if late-night",
  );
  assertEquals(new Set(tapings.map((t) => t.id)).size, 4, "unique");
  assert(
    !tapings.some((t) => /CA$/.test(t.where)),
    "no Burbank or Los Angeles tapings",
  );
  assert(
    tapings.every((t) => t.day && t.time && t.description),
    "every taping has a day, a time and a description",
  );
});

test("reads every field of a known taping", () => {
  const t = taping(95981);
  assertEquals(t.show, "Late Night with Seth Meyers");
  assertEquals(t.subtitle, "");
  assertEquals(t.guests, ["Adam Driver", "Betty Gilpin"]);
  assertEquals(t.day, "Mon, Nov 23");
  assertEquals(t.time, "2:00 PM");
  assertEquals(t.where, "New York, NY");
  assertEquals(t.age, "16+");
  assertEquals(t.action, "Join Waitlist");
  assertEquals(
    t.start,
    Date.parse("2026-11-23T19:00:00Z"),
    "startDateUtc is UTC: 2 PM Eastern",
  );
  assertEquals(t.imageType, "image/jpeg", "type read past the /w=350 resize");
});

test("drops sold-out tapings and ones that have started", () => {
  const out = extractTapings(
    [
      record({ eventId: 1, title: "Open" }),
      record({ eventId: 2, title: "Gone", isSoldOut: true }),
      record({
        eventId: 3,
        title: "Past",
        startDateUtc: "2026-11-01T15:00:00",
      }),
      record({ eventId: 4, title: "LA", projectLocationIds: [144] }),
    ],
    NYC,
    CAPTURED,
  );
  assertEquals(
    out.map((t) => t.show),
    ["Open"],
  );
});

test("tidies the dashes and spaces editors leave in titles", () => {
  const [t] = extractTapings(
    [
      record({
        title: "Screening + Q&A -  ",
        subTitle: "+ View Your Deal!",
      }),
    ],
    NYC,
    CAPTURED,
  );
  assertEquals(t.show, "Screening + Q&A");
  assertEquals(t.subtitle, "View Your Deal!");
  assertEquals(
    itemTitle(t),
    "Screening + Q&A: View Your Deal! — Tue, Dec 01, 10:00 AM",
  );
});

test("makes protocol-relative images absolute", () => {
  const [t] = extractTapings(
    [record({ imageUrl: "//d1r8mljd08gmy5.cloudfront.net/x/a.png/w=585" })],
    NYC,
    CAPTURED,
  );
  assertEquals(t.image, "https://d1r8mljd08gmy5.cloudfront.net/x/a.png/w=585");
  assertEquals(t.imageType, "image/png");
});

test("survives input that is not the API we asked for", () => {
  assertEquals(extractTapings([], NYC).length, 0, "empty");
  assertEquals(extractTapings(null, NYC).length, 0, "null");
  assertEquals(extractTapings({ events: [] }, NYC).length, 0, "not an array");
  assertEquals(
    extractTapings([null, "x", {}, record({ title: "" })], NYC, CAPTURED)
      .length,
    0,
    "no id or title",
  );
  assertEquals(
    extractTapings([record(), record({ title: "Again" })], NYC, CAPTURED)
      .length,
    1,
    "a repeated id is taken once",
  );
});

const feed = () => buildFeed(tapings, new URL(`${FEED_URL}?junk=1`)).text();

test("serves the listing, one item per taping", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 4, "every taping");
  assert(body.includes("<link>https://1iota.com/new-york</link>"), "channel");
  assert(body.includes(`href="${FEED_URL}" rel="self"`), "bare self-link");
});

test("links each taping to its own page, which is also its guid", async () => {
  const body = await feed();
  assert(
    body.includes(`<guid isPermaLink="true">${eventUrl(95981)}</guid>`),
    "guid",
  );
  assert(body.includes(`<link>${eventUrl(95981)}</link>`), "link");
});

test("orders newest-posted first and carries no invented dates", async () => {
  const body = await feed();
  const ids = [
    ...body.matchAll(/<link>https:\/\/1iota\.com\/event\/(\d+)</g),
  ].map((m) => Number(m[1]));
  assertEquals(
    ids,
    [...ids].sort((a, b) => b - a),
    "descending ids",
  );
  assert(!body.includes("<pubDate>"), "no pubDate: the API has no post date");
});

test("puts when, where, age and guests at the top of the body", async () => {
  const withGuests = tapings.find((t) => t.guests.length)!;
  const xml = renderRss({
    title: "T",
    description: "D",
    siteLink: "https://1iota.com/new-york",
    feedUrl: FEED_URL,
    items: [withGuests],
  });
  assert(xml.includes(`${withGuests.day} at ${withGuests.time}`), "when");
  assert(xml.includes(`Ages ${withGuests.age}`), "age");
  assert(xml.includes(withGuests.guests[0].replace(/&/g, "&amp;")), "guest");
});

const SAMPLE: Taping = {
  id: 1,
  show: "Tom & Jerry <live>",
  subtitle: "",
  start: CAPTURED,
  day: "Tue, Dec 01",
  time: "10:00 AM",
  where: "New York, NY",
  age: "18+",
  guests: ["Ada & Grace"],
  description: "<p>He said &ldquo;hi&rdquo;</p>",
  action: "Request Tickets",
  image: "https://media.1iota.com/project/1/a.jpg",
  imageType: "image/jpeg",
};

test("renders XML-safe output", () => {
  const bell = String.fromCharCode(7);
  const xml = renderRss({
    title: "Feed & <friends>",
    description: "D",
    siteLink: "https://1iota.com/new-york",
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE, show: `Bell${bell} & <show>` }],
  });
  assert(!xml.includes(bell), "control characters stripped");
  assert(xml.includes("Feed &amp; &lt;friends&gt;"), "channel title escaped");
  assert(xml.includes("Guests: Ada &amp; Grace"), "guest names escaped");
});

test("leaves daytime talk shows out, however 1iota decorates the title", () => {
  const daytime = [
    "The View",
    "The View + The Weekend View - taping ends at 1:30p!",
    "The View - TOYS FOR TOTS",
    "Tamron Hall - Live Studio Audience",
    "The Drew Barrymore Show",
    "LIVE with Kelly & Mark",
    "The Kelly Clarkson Show",
    "Sherri",
    "Good Morning America",
  ];
  for (const s of daytime) assert(isDaytime(s), `"${s}" is daytime`);

  const kept = [
    "Late Night with Seth Meyers",
    "The Tonight Show",
    "The Daily Show",
    "Last Week Tonight with John Oliver",
    "NBC's Countdown to Macy's Thanksgiving Day Parade 2026",
    "Screening + Q&A",
    "New York Special Screening",
    "Saturday Night Live",
    "The Late Show with Stephen Colbert",
  ];
  for (const s of kept) assert(!isDaytime(s), `"${s}" is kept`);

  const shows = new Set(tapings.map((t) => t.show));
  assertEquals(
    [...shows].sort(),
    [
      "Late Night with Seth Meyers",
      "NBC's Countdown to Macy's Thanksgiving Day Parade 2026",
      "Screening + Q&A",
    ],
    "what survives from the capture",
  );
});

test("keeps a late-night taping only once a guest is announced", () => {
  for (const s of [
    "The Tonight Show",
    "Late Night with Seth Meyers",
    "The Daily Show",
    "The Late Show with Stephen Colbert",
    "Jimmy Kimmel Live!",
  ]) {
    assert(isLateNight(s), `"${s}" is late-night`);
  }
  for (const s of [
    "Screening + Q&A",
    "NBC's Countdown to Macy's",
    "The View",
  ]) {
    assert(!isLateNight(s), `"${s}" is not`);
  }

  const out = extractTapings(
    [
      record({ eventId: 1, title: "The Tonight Show" }),
      record({
        eventId: 2,
        title: "The Tonight Show",
        guests: [{ name: "Ada Lovelace" }],
      }),
      record({ eventId: 3, title: "The Daily Show" }),
      record({ eventId: 4, title: "Screening + Q&A" }),
    ],
    NYC,
    CAPTURED,
    new Map([[3, ["Grace Hopper"]]]),
  );
  assertEquals(
    out.map((t) => [t.id, t.guests]),
    [
      [2, ["Ada Lovelace"]],
      [3, ["Grace Hopper"]],
      [4, []],
    ],
    "guests from either source count; non-late-night needs none",
  );

  const lateNight = eventsFixture.filter(
    (e: { title: string; projectLocationIds: number[]; isSoldOut: boolean }) =>
      isLateNight(e.title.trim()) &&
      !e.isSoldOut &&
      e.projectLocationIds.some((l) => NYC.has(l)),
  );
  assertEquals(lateNight.length, 22, "bookable late-night tapings captured");
  assertEquals(
    tapings.filter((t) => isLateNight(t.show)).map((t) => t.id),
    [95980, 95981],
    "of which these two had guests",
  );
});

test("merges guests from the appearances feed without repeating anyone", () => {
  const altruists = taping(97690);
  assertEquals(
    altruists.guests,
    ["Anthony Boyle", "Ben McKenzie", "Graham Moore", "Julia Garner"],
    "named only by /api/celeb/appearances",
  );
  const [t] = extractTapings(
    [record({ guests: [{ name: "La La Anthony " }, { name: "Megan Hilty" }] })],
    NYC,
    CAPTURED,
    new Map([[1, ["La La  Anthony", "megan hilty", "John Legend"]]]),
  );
  assertEquals(t.guests, ["La La Anthony", "Megan Hilty", "John Legend"]);
});

test("puts the guests in the title and a category per guest", async () => {
  assertEquals(
    itemTitle(taping(95981)),
    "Late Night with Seth Meyers: Adam Driver, Betty Gilpin — Mon, Nov 23, 2:00 PM",
  );
  assertEquals(
    itemTitle(taping(97690)),
    "Screening + Q&A: The Altruists (Anthony Boyle, Ben McKenzie, Graham Moore, Julia Garner) — Thu, Nov 19, 6:30 PM",
    "after the subtitle when there is one",
  );
  const body = await buildFeed(tapings, new URL(FEED_URL)).text();
  for (const name of ["Adam Driver", "Betty Gilpin", "Julia Garner"]) {
    assert(body.includes(`<category>${name}</category>`), `${name} category`);
  }
  assert(
    body.includes("<p>Guests: Adam Driver, Betty Gilpin</p>"),
    "and in the body",
  );
});
