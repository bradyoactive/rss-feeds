/**
 * Live checks for the 1iota NYC feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test 1iota-nyc-rss/test/1iota-nyc-rss.linkcheck.test.ts
 */

import { extractTapings, eventUrl, nycLocationIds } from "../1iota-nyc-rss.ts";
import {
  assertAllServed,
  jsonFixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const API = "https://prod-tickets.1iota.com";

async function get(path: string) {
  const res = await fetch(`${API}${path}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function live() {
  const [events, locations] = await Promise.all([
    get("/api/event/list"),
    get("/api/locations"),
  ]);
  return extractTapings(events, nycLocationIds(locations));
}

liveTest("both endpoints still answer, with New York tapings", async () => {
  const tapings = await live();
  if (tapings.length < 5) {
    throw new Error(`only ${tapings.length} NYC tapings — suspiciously few`);
  }
});

liveTest("every taping page the feed links to exists", async () => {
  await assertAllServed(
    sampleOf((await live()).map((t) => eventUrl(t.id))),
    "1iota event pages",
  );
});

liveTest("a sample of show images resolve", async () => {
  await assertAllServed(
    sampleOf((await live()).map((t) => t.image).filter(Boolean), 8),
    "1iota images",
  );
});

liveTest("the page the channel links to exists", async () => {
  await assertAllServed(["https://1iota.com/new-york"], "1iota NYC page");
});

liveTest("the fixture still matches the shape the API serves", async () => {
  const captured = await jsonFixture(import.meta, "1iota-event-list.json");
  const payload = await get("/api/event/list");
  if (!Array.isArray(payload)) {
    throw new Error("the endpoint no longer returns a bare array");
  }
  for (const field of [
    "eventId",
    "title",
    "subTitle",
    "startDateUtc",
    "localStartDay",
    "when",
    "where",
    "projectLocationIds",
    "isSoldOut",
  ]) {
    if (!(field in captured[0])) throw new Error(`fixture lacks ${field}`);
    if (!(field in payload[0])) {
      throw new Error(`the records no longer carry ${field}`);
    }
  }
});
