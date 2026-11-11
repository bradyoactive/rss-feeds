/**
 * Live link check for the Notion feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/notion-engineering-rss.linkcheck.test.ts
 */

import { buildFeed, extractPosts, postUrl } from "../notion-engineering-rss.ts";
import {
  assertAllServed,
  channelLink,
  fixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await fixture(import.meta, "notion-engineering-tech.html"),
);

liveTest("a sample of post links resolve", async () => {
  const urls = sampleOf(posts.map((p) => postUrl(p.slug)));
  await assertAllServed(urls, "notion post links");
});

liveTest("a sample of hero thumbnails resolve", async () => {
  const images = sampleOf(posts.map((p) => p.image).filter(Boolean));
  await assertAllServed(images, "notion thumbnails");
});

liveTest("the category page the channel links to exists", async () => {
  const res = buildFeed(
    posts,
    new URL("https://feed.val.run/notion"),
  );
  await assertAllServed(
    [channelLink(await res.text())],
    "notion engineering topic page",
  );
});

liveTest(
  "the live topic page still server-renders Next.js posts",
  async () => {
    const res = await fetch(
      "https://www.notion.com/blog/topic/tech",
      {
        headers: {
          "user-agent": "notion-rss-bridge (+https://val.town)",
          accept: "text/html,application/xhtml+xml",
        },
      },
    );
    if (!res.ok) throw new Error(`topic page: HTTP ${res.status}`);
    const html = await res.text();
    const live = extractPosts(html);
    if (!live.length) throw new Error("live page yielded no posts");
    if (live.some((p) => p.ts === null)) {
      throw new Error("a live post carried an unparseable publication date");
    }
  },
);
