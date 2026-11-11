/**
 * Live link check for the Snap feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/snap-engineering-rss.linkcheck.test.ts
 */

import { buildFeed, extractPosts, postUrl } from "../snap-engineering-rss.ts";
import {
  assertAllServed,
  channelLink,
  fixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = extractPosts(await fixture(import.meta, "snap-engineering.html"));

liveTest("a sample of post links resolve", async () => {
  const urls = sampleOf(posts.map((p) => postUrl(p.slug)));
  await assertAllServed(urls, "snap post links");
});

liveTest("a sample of hero thumbnails resolve", async () => {
  const images = sampleOf(posts.map((p) => p.image).filter(Boolean));
  await assertAllServed(images, "snap thumbnails");
});

liveTest("the engineering blog the channel links to exists", async () => {
  const res = buildFeed(posts, new URL("https://feed.val.run/snap"));
  await assertAllServed(
    [channelLink(await res.text())],
    "snap engineering blog page",
  );
});

liveTest(
  "the live engineering blog still renders CONTENTFUL_RESULTS",
  async () => {
    const res = await fetch("https://eng.snap.com/blog", {
      headers: {
        "user-agent": "snap-rss-bridge (+https://val.town)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) throw new Error(`blog page: HTTP ${res.status}`);
    const html = await res.text();
    const live = extractPosts(html);
    if (!live.length) throw new Error("live page yielded no posts");
  },
);
