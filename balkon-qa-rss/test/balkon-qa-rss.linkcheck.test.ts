/**
 * Live link check for the BALKON Q&A feed. See ../../common/linkcheck.ts.
 *
 *   deno test --allow-read --allow-net test/balkon-qa-rss.linkcheck.test.ts
 *
 * The fixture here is a rolling calendar rather than an archive, so its links
 * go stale on their own: a screening that has happened may stop being served.
 * The checks that matter therefore run against the *live* listing, and the
 * fixture is used only for the shape comparison at the end.
 *
 * The live fetch is anonymous: the session cookie lives only in the val's env,
 * not here. So these check the ~8-day window, which shares its markup with
 * the signed-in listing, and the last test watches the gate itself.
 */

import { extractScreenings } from "../balkon-qa-rss.ts";
import {
  assertAllServed,
  fixture,
  liveTest,
  sampleOf,
  todayIn,
} from "../../common/linkcheck.ts";

const SOURCE =
  "https://balkon.film/qa?city=nyc&events=qa&date=&theaters=alamo_drafthouse_downtown_brooklyn,alamo_drafthouse_lower_manhattan,amc_empire_25,amc_kips_bay_15,amc_lincoln_square_13,amc_village_7,angelika,film_at_lincoln_center,ifc_center,moma,momi,paris_theater";

async function live() {
  const res = await fetch(SOURCE, { headers: { accept: "text/html" } });
  if (!res.ok) throw new Error(`${SOURCE}: HTTP ${res.status}`);
  return extractScreenings(await res.text());
}

liveTest("the listing still parses into dated screenings", async () => {
  const screenings = await live();
  if (screenings.length === 0) {
    throw new Error("the listing served, but no screening was parsed from it");
  }
  const days = new Set(screenings.map((s) => s.date));
  if (days.size < 2) {
    throw new Error(
      `every screening landed on ${[...days]} — the date-divider walk has ` +
        "probably broken, which is the failure this parse is most prone to",
    );
  }
  const undated = screenings.filter((s) => !/^\d{4}-\d{2}-\d{2}$/.test(s.date));
  if (undated.length) throw new Error(`unresolved dates: ${undated.length}`);
});

liveTest("the dates it resolves are the ones the strip offers", async () => {
  // The year comes from the date strip, and nothing offline can prove the two
  // still line up — a listing filed a year out would look perfectly valid.
  const screenings = await live();
  const today = todayIn();
  const stale = screenings.filter((s) => s.date < today);
  if (stale.length) {
    throw new Error(
      `screenings dated before today: ${stale.map((s) => s.date).join(", ")}`,
    );
  }
  const far = screenings.filter((s) => {
    const days = (Date.parse(s.date) - Date.parse(today)) / 86_400_000;
    return days > 60;
  });
  if (far.length) {
    throw new Error(
      `screenings more than 60 days out, so the year is probably wrong: ` +
        far.map((s) => s.date).join(", "),
    );
  }
});

liveTest("no ticket link is missing", async () => {
  // Ticket links go to the theaters' own vendors — veezi, Fandango, filmlinc
  // and friends — several of which refuse a bot outright. A 403 there says
  // nothing about the URL, so only a 404 counts as broken: that would mean the
  // val had assembled a link rather than passed one through.
  const screenings = await live();
  const missing: string[] = [];
  for (const url of sampleOf(screenings.map((s) => s.link))) {
    let status = 0;
    try {
      const res = await fetch(url, { redirect: "follow" });
      await res.body?.cancel();
      status = res.status;
    } catch { /* vendor refused the connection; not evidence of a bad URL */ }
    if (status === 404 || status === 410) missing.push(`${status} ${url}`);
  }
  if (missing.length) {
    throw new Error(
      `ticket links that do not exist:\n  ${missing.join("\n  ")}`,
    );
  }
});

liveTest("the film pages the fallback links point at exist", async () => {
  // These ones the val does assemble, from the slug, so they are checkable —
  // and balkon.film answers a plain request.
  const screenings = await live();
  await assertAllServed(
    sampleOf(
      screenings.map((s) => `https://balkon.film/film/${s.filmSlug}`),
      8,
    ),
    "balkon film pages",
  );
});

liveTest("a sample of guest headshots resolve", async () => {
  const screenings = await live();
  await assertAllServed(
    sampleOf(
      screenings.flatMap((s) => s.guests.map((g) => g.image)).filter(
        Boolean,
      ),
    ),
    "balkon guest headshots",
  );
});

liveTest("the listing the channel links to exists", async () => {
  await assertAllServed([SOURCE], "balkon listing");
});

liveTest("the signup gate has not closed further", async () => {
  // The anonymous window was ~8 days when this was written. If the gate
  // tightens, the feed quietly shrinks rather than breaking, so this is the
  // only thing that would tell us. It says nothing about the signed-in feed;
  // an expired cookie shows up as a warning in the val's logs instead.
  const days = new Set((await live()).map((s) => s.date)).size;
  const before = new Set(
    extractScreenings(await fixture(import.meta, "balkon-qa.html")).map((s) =>
      s.date
    ),
  ).size;
  if (days < before - 2) {
    throw new Error(
      `the anonymous window is now ${days} days, was ${before} when captured`,
    );
  }
});
