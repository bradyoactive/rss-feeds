/**
 * Offline tests for the BALKON Q&A feed. The fixture is a capture of the
 * listing. Refresh with:
 *
 *   curl -s "https://balkon.film/qa?city=nyc&events=qa&date=&theaters=alamo_drafthouse_downtown_brooklyn,alamo_drafthouse_lower_manhattan,amc_empire_25,amc_kips_bay_15,amc_lincoln_square_13,amc_village_7,angelika,film_at_lincoln_center,ifc_center,moma,momi,paris_theater" -o balkon-qa.html
 *
 * That curl is anonymous, so the fixture is the ~8-day window, not the longer
 * one the deployed val sees with BALKON_COOKIE. Keep it that way: a signed-in
 * capture would commit a session-bearing page for no gain, since the markup
 * of each item is the same either way.
 *
 * Note the counts below move whenever it is recaptured — it is a rolling
 * calendar, not an archive.
 *
 * Run: node --test test/balkon-qa-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  extractScreenings,
  renderRss,
  type Screening,
} from "../balkon-qa-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const html = await readFile(
  new URL("./balkon-qa.html", import.meta.url),
  "utf8",
);
const screenings = extractScreenings(html);
const find = (id: string) => screenings.find((s) => s.id.startsWith(id))!;

const NOW = new Date("2026-08-17T12:00:00Z");
const FEED_URL = "https://feed.val.run/balkon";

test("reads every screening in the listing", () => {
  assertEquals(screenings.length, 44, "screenings");
  assertEquals(
    screenings.length,
    (html.match(/<li class="screening-item">/g) ?? []).length,
    "every item on the page became a screening",
  );
  assert(
    screenings.every((s) => s.film && s.theater),
    "film and theater",
  );
  assertEquals(
    new Set(screenings.map((s) => s.id)).size,
    screenings.length,
    "ids are unique",
  );
});

test("reads every field of a known screening", () => {
  const s = find("wendigo|film_at_lincoln_center");
  assertEquals(s.film, "Wendigo", "film");
  assertEquals(s.theater, "Film at Lincoln Center", "theater");
  assertEquals(s.date, "2026-08-17", "date");
  assertEquals(s.times, ["6:30 PM"], "times");
  assertEquals(s.directors, ["Larry Fessenden"], "director");
  assertEquals(s.blurb, "Screening + Q&A with Larry Fessenden", "blurb");
  assertEquals(
    s.guests,
    [
      {
        name: "Larry Fessenden",
        role: "Actor",
        image:
          "https://image.tmdb.org/t/p/w185/imQGskBT7IjqHLVJDQFLR1h1UPH.jpg",
      },
    ],
    "guests",
  );
  assertEquals(s.link, "https://purchase.filmlinc.org/83576/83577", "tickets");
});

test("takes the date from the divider above the item", () => {
  // The date is nowhere in the item itself, so this is the one piece of state
  // the parse carries — and the failure mode if it breaks is every screening
  // landing on one day rather than an obvious crash.
  const byDate = new Map<string, number>();
  for (const s of screenings) byDate.set(s.date, (byDate.get(s.date) ?? 0) + 1);
  assertEquals(
    [...byDate.keys()].sort(),
    [
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
      "2026-08-24",
    ],
    "eight days, which is the whole anonymous window before the signup gate",
  );
  assert(byDate.size > 1, "screenings are spread across days, not lumped");
});

test("gets the year from the date strip, not from the divider", () => {
  // Dividers say "Mon · August 17" with no year. Only the strip's own links
  // state one, which is what keeps a December listing from being read as this
  // January.
  const december = `
    <a href="/qa?city=nyc&events=q%26a&date=2026-12-31"></a>
    <a href="/qa?city=nyc&events=q%26a&date=2027-01-01"></a>
    <ul>
      <li class="date-divider"><span>Thu · December 31</span></li>
      <li class="screening-item">
        <a href="/film/a" class="screening-title">A</a>
        <span class="theater-name"><a href="/theater/t">T</a></span>
      </li>
      <li class="date-divider"><span>Fri · January 1</span></li>
      <li class="screening-item">
        <a href="/film/b" class="screening-title">B</a>
        <span class="theater-name"><a href="/theater/t">T</a></span>
      </li>
    </ul>`;
  assertEquals(
    extractScreenings(december).map((s) => s.date),
    ["2026-12-31", "2027-01-01"],
    "the year rolls over with the calendar",
  );
});

test("drops a screening it cannot date", () => {
  // Better to lose an item than to file it under the wrong day.
  const orphan = `
    <a href="/qa?date=2026-08-17"></a>
    <li class="screening-item">
      <a href="/film/a" class="screening-title">A</a>
      <span class="theater-name"><a href="/theater/t">T</a></span>
    </li>`;
  assertEquals(extractScreenings(orphan).length, 0, "no divider, no item");
});

test("separates the showtime from its tag", () => {
  // Not every showtime is a Q&A — some are an intro — and the label is its own
  // element, so stripping the word "Q&A" would leave "intro 8:40 PM".
  const s = find("boyhood|ifc_center");
  assertEquals(s.times, ["6:15 PM", "8:40 PM (intro)"], "tagged when not Q&A");
  assert(
    !screenings.some((s) => s.times.some((t) => /^(q&a|intro)\b/i.test(t))),
    "no time starts with its own label",
  );
});

test("carries no sold-out status", () => {
  // Excluded on purpose: it flips while the screening sits in the feed, and
  // FreshRSS hashes item content to decide whether an entry changed — so
  // carrying it would re-date and resurface the item.
  assert(html.includes("sold-out"), "the page does mark some as sold out");
  const xml = renderRss({
    title: "T",
    description: "D",
    siteLink: "https://balkon.film/qa",
    feedUrl: FEED_URL,
    items: screenings,
    now: NOW,
  });
  assert(!/sold.?out/i.test(xml), "and none of it reaches the feed");
});

test("falls back to the film page when there is no ticket link", () => {
  const s = find("wild-inside|low_cinema");
  assertEquals(s.times, [], "this one has no showtime at all");
  assertEquals(
    s.link,
    "https://balkon.film/film/wild-inside",
    "still linkable",
  );
});

test("decodes the entities the page escapes", () => {
  assert(
    !screenings.some((s) => /&(amp|lt|gt|quot|#\d+);/.test(s.film + s.blurb)),
    "no entity survives into a film title or blurb",
  );
  assert(
    screenings.some((s) => s.blurb.includes("Q&A")),
    "and Q&amp;A comes back as Q&A",
  );
});

test("survives markup that is not the listing", () => {
  assertEquals(extractScreenings("").length, 0, "empty");
  assertEquals(extractScreenings("<html>nope</html>").length, 0, "not it");
  assertEquals(
    extractScreenings(
      '<a href="?date=2026-08-17"></a><li class="date-divider"><span>Mon · August 17</span></li>' +
        '<li class="screening-item">no film link</li>',
    ).length,
    0,
    "an item without a film link is dropped",
  );
});

const feed = (query = "") =>
  buildFeed(screenings, new URL(`${FEED_URL}${query}`), NOW).text();

test("serves the listing", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 44, "every screening");
  assert(
    body.includes("<title>BALKON — NYC Q&amp;As</title>"),
    "channel title",
  );
  assert(
    body.includes(
      "<link>https://balkon.film/qa?city=nyc&amp;events=qa&amp;date=&amp;theaters=alamo_drafthouse_downtown_brooklyn,alamo_drafthouse_lower_manhattan,amc_empire_25,amc_kips_bay_15,amc_lincoln_square_13,amc_village_7,angelika,film_at_lincoln_center,ifc_center,moma,momi,paris_theater</link>",
    ),
    "channel link is the listing this mirrors",
  );
  assert(
    body.includes(
      "<![CDATA[Wendigo — Film at Lincoln Center · Mon · August 17, 6:30 PM]]>",
    ),
    "an item title reads as film, theater, when",
  );
});

test("identifies an item by film, theater and day", () => {
  // The only val that sets an explicit id. The link is a ticket URL: a
  // screening can offer two, and they are not stable.
  const s = find("wendigo|film_at_lincoln_center");
  assertEquals(s.id, "wendigo|film_at_lincoln_center|2026-08-17");
  assert(
    !s.id.includes("6:30") && !s.id.includes("Fessenden"),
    "neither the showtime label nor the guest list is part of identity",
  );
});

test("emits guid isPermaLink=false, because the link is not the id", async () => {
  const body = await feed();
  assert(
    body.includes(
      '<guid isPermaLink="false">wendigo|film_at_lincoln_center|2026-08-17</guid>',
    ),
    "explicit id",
  );
  assert(
    body.includes("<link>https://purchase.filmlinc.org/83576/83577</link>"),
    "and the link still points at tickets",
  );
});

test("dates every item to the fetch, not to the screening", async () => {
  // These are future events. Dating them by showtime would sort the furthest
  // off to the top and reshuffle the feed as the calendar rolls; `now` means
  // "when this appeared in the listing", which is what FreshRSS stores on first
  // ingest and does not revise (its change hash excludes the date).
  const dates = [...(await feed()).matchAll(/<pubDate>([^<]+)</g)].map((m) =>
    Date.parse(m[1]),
  );
  assertEquals(new Set(dates).size, 1, "one timestamp across the feed");
  assertEquals(dates[0], NOW.getTime(), "and it is the fetch time");
});

test("orders items soonest first", async () => {
  // Every item shares a pubDate, so the order they are written in is the order
  // a reader shows them in.
  // Only item titles are CDATA-wrapped; the channel's is entity-escaped, so
  // every match here is an item.
  const titles = [
    ...(await feed()).matchAll(/<title><!\[CDATA\[(.*?)\]\]>/g),
  ].map((m) => m[1]);
  assertEquals(titles.length, screenings.length, "one title per screening");

  const days = titles.map((t) => /· \w+ · \w+ (\d+)/.exec(t)?.[1] ?? "");
  assert(days.every(Boolean), `every title states its day: ${titles[0]}`);
  const numbers = days.map(Number);
  assertEquals(
    numbers,
    [...numbers].sort((a, b) => a - b),
    "ascending by day — soonest first",
  );
});

test("self-link is canonical, ignoring junk query params", async () => {
  const body = await feed("?city=la&date=2026-01-01");
  assert(body.includes(`href="${FEED_URL}" rel="self"`), "bare self-link");
  assertEquals((body.match(/<item>/g) ?? []).length, 44, "params ignored");
});

test("names the image media type rather than letting it be guessed", async () => {
  const body = await feed();
  assert(body.includes('type="image/jpeg"'), "jpeg, not the invalid image/jpg");
  assert(!body.includes('type="image/jpg"'), "no bogus media type");
});

const SAMPLE: Screening = {
  id: "s|t|2026-08-17",
  film: "Tom & Jerry <live>",
  filmSlug: "s",
  theater: "IFC & Co",
  date: "2026-08-17",
  dayLabel: "Mon · August 17",
  times: ["6:30 PM"],
  directors: ["Ada & Grace"],
  blurb: 'He said "hi"',
  guests: [
    {
      name: "Ada",
      role: "Director",
      image: "https://image.tmdb.org/t/p/w185/a.jpg",
    },
  ],
  link: "https://tickets.example/1",
};

test("renders XML-safe output", () => {
  const bell = String.fromCharCode(7);
  const out = renderRss({
    title: "Feed & <friends>",
    description: 'Quote " and control',
    siteLink: "https://balkon.film/qa",
    feedUrl: FEED_URL,
    items: [SAMPLE],
    now: NOW,
  });

  // The library wraps item text in CDATA rather than escaping entities, so the
  // characters that used to need escaping now appear verbatim — what matters is
  // that they cannot terminate the section early.
  assert(
    out.includes("<![CDATA[Tom & Jerry <live> — IFC & Co"),
    "item title survives verbatim inside CDATA",
  );
  assert(!out.includes("]]]]"), "no stray CDATA breakout in ordinary text");

  // Control characters are illegal in XML 1.0 and the library does not strip
  // them, so the val must — one anywhere breaks the whole document.
  const dirty = renderRss({
    title: "T",
    description: "d",
    siteLink: "https://balkon.film/qa",
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE, film: `Bell${bell}here` }],
    now: NOW,
  });
  assert(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(dirty), "control chars stripped");
  assert(dirty.includes("Bellhere"), "and the rest of the title is kept");
});

test("omits optional elements when the screening lacks them", () => {
  const bare: Screening = {
    ...SAMPLE,
    times: [],
    directors: [],
    blurb: "",
    guests: [],
    theater: "",
  };
  const out = renderRss({
    title: "T",
    description: "D",
    siteLink: "https://balkon.film/qa",
    feedUrl: FEED_URL,
    items: [bare],
    now: NOW,
  });

  for (const tag of ["author", "category", "enclosure"]) {
    assert(!out.includes(`<${tag}`), `omits <${tag}> when empty`);
  }
  assertEquals(
    out.match(/<description>/g)?.length,
    1,
    "only the channel description",
  );
});
