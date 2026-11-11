/**
 * Live link check for the Hex feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/hex-engineering-rss.linkcheck.test.ts
 */

import { extractPosts } from "../hex-engineering-rss.ts";
import {
  assertAllServed,
  jsonFixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await jsonFixture(import.meta, "hex-sanity-engineering.json"),
);

liveTest("every post link resolves", async () => {
  // Only 14 posts, so check them all. The slug comes from Sanity rather than
  // from any URL the site rendered, and the feed appends the trailing slash
  // Hex canonicalises to — neither is provable offline.
  const urls = posts.map((p) => `https://hex.tech/blog/${p.slug}/`);
  await assertAllServed(urls, "hex post links");
});

liveTest("the category page the channel links to exists", async () => {
  // The same slug the GROQ query filters on, so a rename breaks both together.
  await assertAllServed(
    ["https://hex.tech/blog/category/engineering/"],
    "hex category page",
  );
});

liveTest("a sample of hero images resolve", async () => {
  await assertAllServed(
    sampleOf(posts.map((p) => p.image).filter(Boolean)),
    "hex hero images",
  );
});
