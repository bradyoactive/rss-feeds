/**
 * Live link check for the Rippling feed. See ../../common/linkcheck.ts.
 *
 *   deno test --allow-read --allow-net test/rippling-engineering-rss.linkcheck.test.ts
 */

import { extractPosts } from "../rippling-engineering-rss.ts";
import {
  assertAllServed,
  jsonFixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await jsonFixture(import.meta, "rippling-algolia-engineering.json"),
);

liveTest("every post link resolves", async () => {
  // A 404 here usually means the fixture has gone stale rather than that the
  // feed is broken: Rippling withdrew a post mid-session once, and the live
  // feed dropped it immediately while this capture kept it. Re-capture the
  // fixture and see whether the URL is still in it before reading anything
  // into a failure.
  const urls = posts.map((p) => `https://www.rippling.com/blog/${p.slug}`);
  await assertAllServed(urls, "rippling post links");
});

liveTest("a sample of hero images resolve", async () => {
  await assertAllServed(
    sampleOf(posts.map((p) => p.image).filter(Boolean)),
    "rippling hero images",
  );
});
