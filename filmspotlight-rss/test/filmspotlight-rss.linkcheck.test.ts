/**
 * Live link check for the NYC Film Spotlight feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/filmspotlight-rss.linkcheck.test.ts
 *
 * The fixture is a rolling calendar rather than an archive, so the checks that
 * matter run against the live API; the fixture is used only where a comparison
 * against what was captured is the point.
 */

import { extractEvents } from "../filmspotlight-rss.ts";
import {
  assertAllServed,
  jsonFixture,
  liveTest,
  sampleOf,
  todayIn,
} from "../../common/linkcheck.ts";

const SITE = "https://filmspotlight.org";
const API = `${SITE}/api/analysis/future`;

async function live() {
  const res = await fetch(API, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${API}: HTTP ${res.status}`);
  const events = extractEvents(await res.json());
  if (events.length === 0) {
    throw new Error(`${API} answered but listed nothing`);
  }
  return events;
}

liveTest(
  "the endpoint still answers with events, unparameterised",
  async () => {
    const events = await live();
    if (events.length < 10) {
      throw new Error(`only ${events.length} events — suspiciously few`);
    }
  },
);

liveTest("every event still carries created_at", async () => {
  // The whole date design rests on this one field. If it disappears every item
  // loses its pubDate and the feed silently reorders itself.
  const undated = (await live()).filter((e) => e.createdAt === null);
  if (undated.length) {
    throw new Error(
      `${undated.length} events have no usable created_at, e.g. ${
        undated[0].title
      }`,
    );
  }
});

liveTest("'future' still means what the val relies on it meaning", async () => {
  // The val reads this endpoint instead of the date-bounded one precisely
  // because it is defined by having a screening left rather than by a date.
  // If past events start appearing, that reasoning has stopped holding.
  const today = todayIn();
  const past = (await live()).filter((e) =>
    e.screenings.every((s) => s.date < today),
  );
  if (past.length) {
    throw new Error(
      `${past.length} events have no screening left, e.g. ${past[0].title} ` +
        `(${past[0].screenings.map((s) => s.date).join(", ")})`,
    );
  }
});

liveTest("every event page the feed links to exists", async () => {
  const events = await live();
  await assertAllServed(
    sampleOf(events.map((e) => `${SITE}/event/${e.id}`)),
    "filmspotlight event pages",
  );
});

liveTest("a sample of posters resolve", async () => {
  const events = await live();
  await assertAllServed(
    sampleOf(events.map((e) => e.image).filter(Boolean), 8),
    "filmspotlight posters",
  );
});

// Deliberately not checked: the RSVP links. The val copies `link_to_rsvp`
// verbatim rather than building it, so a 404 there is Film Spotlight's stale
// data, not a bug this suite can catch — one currently points at a Paris
// Theater page retired since 2025. The event-page check above covers the links
// the val does assemble.

liveTest("the page the channel links to exists", async () => {
  await assertAllServed([SITE], "filmspotlight homepage");
});

liveTest("the fixture still matches the shape the API serves", async () => {
  const captured = await jsonFixture(import.meta, "filmspotlight-future.json");
  const res = await fetch(API);
  const payload = await res.json();
  if (!Array.isArray(payload)) {
    throw new Error("the endpoint no longer returns a bare array");
  }
  for (const field of Object.keys(captured[0])) {
    if (!(field in payload[0])) {
      throw new Error(`the records no longer carry ${field}`);
    }
  }
});
