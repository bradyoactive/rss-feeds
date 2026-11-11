/**
 * Live link check for the Lovable feed. See ../../common/linkcheck.ts.
 *
 *   deno test --allow-read --allow-net test/lovable-rss.linkcheck.test.ts
 */

import { extractPosts, selectPosts } from "../lovable-rss.ts";
import {
  assertAllServed,
  fixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = selectPosts(
  extractPosts(await fixture(import.meta, "lovable-blog-rss.xml")),
);

liveTest("every post link resolves", async () => {
  // Links come straight from Lovable's feed rather than being built here, so
  // this is really a check that their feed points at pages that exist.
  await assertAllServed(posts.map((p) => p.link), "lovable post links");
});

liveTest("the category page the channel links to exists", async () => {
  await assertAllServed(
    ["https://lovable.dev/blog?category=inside+lovable"],
    "lovable category page",
  );
});

liveTest("the source feed is still served and still categorised", async () => {
  // The whole val is a filter over this one document. If it stops carrying
  // <category>, the feed silently empties — so check the content, not just a 200.
  const res = await fetch("https://lovable.dev/blog/rss.xml");
  if (!res.ok) throw new Error(`lovable rss.xml: HTTP ${res.status}`);
  const xml = await res.text();
  const live = selectPosts(extractPosts(xml));
  if (live.length === 0) {
    throw new Error(
      "lovable rss.xml served but no item is categorised Inside Lovable",
    );
  }
  // Sanity-check a sample of what the live feed currently links to.
  await assertAllServed(
    sampleOf(live.map((p) => p.link)),
    "lovable live post links",
  );
});
