/**
 * Live link check for the Samsara feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/samsara-engineering-rss.linkcheck.test.ts
 */

import { extractPosts } from "../samsara-engineering-rss.ts";
import {
  assertAllServed,
  jsonFixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await jsonFixture(import.meta, "samsara-contentful-engineering.json"),
);

liveTest("every post link resolves", async () => {
  // Only 15 posts, so check them all. The slug comes from Contentful's
  // blogPageSlug rather than from any URL the page rendered, so nothing but a
  // live fetch proves the two agree.
  const urls = posts.map((p) => `https://www.samsara.com/blog/${p.slug}`);
  await assertAllServed(urls, "samsara post links");
});

liveTest("the category page the channel links to exists", async () => {
  // This page is load-bearing beyond the channel link: it is where the val
  // reads its Contentful credentials, so if it moves the feed falls back to a
  // baked-in token that will eventually be rotated out from under it.
  await assertAllServed(
    ["https://www.samsara.com/blog/category/engineering-at-samsara"],
    "samsara category page",
  );
});

liveTest("a sample of cover images resolve", async () => {
  await assertAllServed(
    sampleOf(posts.map((p) => p.image).filter(Boolean)),
    "samsara cover images",
  );
});
