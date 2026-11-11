/**
 * Live link check for the Retool feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/retool-engineering-rss.linkcheck.test.ts
 */

import { buildFeed, extractPosts } from "../retool-engineering-rss.ts";
import {
  assertAllServed,
  channelLink,
  fixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await fixture(import.meta, "retool-engineering.html"),
);

liveTest("a sample of post links resolve", async () => {
  const urls = sampleOf(posts.map((p) => p.url));
  await assertAllServed(urls, "retool post links");
});

liveTest("a sample of hero thumbnails resolve", async () => {
  const images = sampleOf(posts.map((p) => p.image).filter(Boolean));
  await assertAllServed(images, "retool thumbnails");
});

liveTest(
  "the engineering category page the channel links to exists",
  async () => {
    const res = buildFeed(
      posts,
      new URL("https://feed.val.run/retool"),
    );
    await assertAllServed(
      [channelLink(await res.text())],
      "retool engineering category page",
    );
  },
);

liveTest(
  "the live engineering category page still renders articles",
  async () => {
    const res = await fetch(
      "https://retool.com/blog/category/engineering",
      {
        headers: {
          "user-agent": "retool-rss-bridge (+https://val.town)",
          accept: "text/html,application/xhtml+xml",
        },
      },
    );
    if (!res.ok) throw new Error(`category page: HTTP ${res.status}`);
    const html = await res.text();
    const live = extractPosts(html);
    if (!live.length) throw new Error("live page yielded no posts");
    if (live.some((p) => p.ts === null)) {
      throw new Error("a live post carried an unparseable publication date");
    }
  },
);
