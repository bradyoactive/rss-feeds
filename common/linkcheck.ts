/**
 * Shared machinery for the per-feed live link checks.
 *
 * The offline suites can only prove a URL is well-formed, not that anything is
 * served at it. Every thumbnail host was wrong once — the Lovable feed built
 * `lovable.dev/content/…`, which 404s, when the assets actually live on
 * `assets.lovable.dev` — and no amount of fixture testing would have caught it.
 *
 * Each feed keeps its own `<val-name>/test/<val-name>.linkcheck.test.ts`, so a
 * failure names the feed by its file and a feed's checks travel with it. The
 * fixtures live in that same `test/` directory, which is why `fixture()` below
 * still resolves them as siblings of the test rather than of the val.
 *
 * These hit the network, so they are declared with `liveTest`, which skips them
 * unless LIVE=1 is set. One glob then serves both moods — offline runs report
 * them as skipped, and setting LIVE=1 turns them on:
 *
 *   npm test              (live checks skip)
 *   npm run test:live     (live checks run)
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";

/** How many URLs to spot-check when a feed has more than it is worth fetching. */
export const SAMPLE = 12;

const online = process.env.LIVE === "1";

/**
 * A test that needs the network. Skipped rather than failed when LIVE=1 is
 * not set: these files sit alongside the offline suites and are caught by the
 * same glob, and a check that cannot run is not a check that failed.
 */
export function liveTest(name: string, fn: () => Promise<void>) {
  test(name, { skip: !online }, fn);
}

/**
 * Today's date as YYYY-MM-DD in `timeZone`, defaulting to the one both listing
 * feeds are published in.
 *
 * `new Date().toISOString().slice(0, 10)` is the obvious way to write this and
 * is wrong for these checks: between 8pm and midnight in New York it already
 * reads as tomorrow in UTC, so tonight's screenings look like they have already
 * happened and the checks that assert a listing holds nothing stale fail every
 * evening. en-CA is the locale that formats a date the ISO way.
 */
export function todayIn(timeZone = "America/New_York"): string {
  return new Date().toLocaleDateString("en-CA", { timeZone });
}

/** An even spread rather than the first n, so no distinct URL shape is missed. */
export function sampleOf<T>(items: T[], n: number = SAMPLE): T[] {
  if (items.length <= n) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

/** 0 stands for "the request never completed", which counts as unreachable. */
async function status(url: string, headers?: HeadersInit): Promise<number> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers,
    });
    await res.body?.cancel();
    return res.status;
  } catch {
    return 0;
  }
}

/**
 * `headers` is for hosts that will not answer a bare HEAD. www.uber.com replies
 * 406 unless the request states an Accept, so its checks pass one; every other
 * feed leaves this off and sends what it always sent.
 */
export async function assertAllServed(
  urls: string[],
  label: string,
  headers?: HeadersInit,
) {
  const results = await Promise.all(
    urls.map(async (url) => ({ url, status: await status(url, headers) })),
  );
  const broken = results.filter((r) => r.status < 200 || r.status >= 400);
  if (broken.length) {
    throw new Error(
      `${label}: ${broken.length}/${urls.length} unreachable\n` +
        broken.map((b) => `  ${b.status} ${b.url}`).join("\n"),
    );
  }
}

/** Reads a fixture that sits beside the test that asks for it. */
export function fixture(meta: ImportMeta, name: string): Promise<string> {
  return readFile(new URL(`./${name}`, meta.url), "utf8");
}

/** Same, for the captures that are JSON payloads rather than markup. */
export async function jsonFixture(
  meta: ImportMeta,
  name: string,
): Promise<any> {
  return JSON.parse(await fixture(meta, name));
}

/**
 * The channel <link> a feed actually emits, pulled back out of its own XML.
 *
 * Building the URL by hand in a test only proves the test can build it; taking
 * it from the rendered feed proves the thing readers will follow. Worth the
 * indirection because these links are per-site guesswork — Samsara's category
 * slug is not slugify(its name), and Mercury's is plus-encoded.
 */
export function channelLink(xml: string): string {
  return /<channel>[\s\S]*?<link>([^<]*)<\/link>/
    .exec(xml)![1]
    .replace(/&amp;/g, "&");
}
