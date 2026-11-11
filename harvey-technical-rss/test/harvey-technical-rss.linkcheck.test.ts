/**
 * Live link check for the Harvey feed. See ../../common/linkcheck.ts.
 *
 *   deno test --allow-read --allow-net test/harvey-technical-rss.linkcheck.test.ts
 */

import { extractPosts } from "../harvey-technical-rss.ts";
import {
  assertAllServed,
  jsonFixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await jsonFixture(import.meta, "harvey-sanity-technical.json"),
);

liveTest("every post link resolves", async () => {
  // The slug comes from Sanity, and the feed links the locale-free form while
  // the site itself links /en-US/blog/… — so nothing but a live fetch proves
  // the URL a reader follows actually resolves.
  const urls = posts.map((p) => `https://www.harvey.ai/blog/${p.slug}`);
  await assertAllServed(urls, "harvey post links");
});

liveTest("the tag page the channel links to exists", async () => {
  // /blog/tag/<bogus> is a real 404, so this proves the slug — and it is the
  // same slug the GROQ query filters on, so a rename would break both together.
  await assertAllServed(
    ["https://www.harvey.ai/blog/tag/technical"],
    "harvey tag page",
  );
});

liveTest("a sample of thumbnails resolve", async () => {
  // Sanity serves the original asset and we append auto=format; a malformed
  // query string would still look like a URL and fail only in a reader.
  await assertAllServed(
    sampleOf(posts.map((p) => p.image).filter(Boolean)),
    "harvey thumbnails",
  );
});
