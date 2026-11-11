/**
 * Live link check for the Asana feed. See ../../common/linkcheck.ts.
 *
 *   deno test --allow-read --allow-net test/asana-engineering-rss.linkcheck.test.ts
 */

import { buildFeed, extractPosts, postUrl } from "../asana-engineering-rss.ts";
import {
  assertAllServed,
  channelLink,
  fixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await fixture(import.meta, "asana-engineering-spotlight.html"),
);

liveTest("a sample of post links resolve", async () => {
  const urls = sampleOf(posts.map((p) => postUrl(p.path)));
  await assertAllServed(urls, "asana post links");
});

liveTest("a sample of hero thumbnails resolve", async () => {
  const images = sampleOf(posts.map((p) => p.image).filter(Boolean));
  await assertAllServed(images, "asana thumbnails");
});

liveTest("the category page the channel links to exists", async () => {
  const res = buildFeed(
    posts,
    new URL("https://feed.val.run/asana"),
  );
  await assertAllServed(
    [channelLink(await res.text())],
    "asana engineering category page",
  );
});

liveTest(
  "the live category page still server-renders Next.js cards",
  async () => {
    const res = await fetch(
      "https://asana.com/inside-asana/engineering-spotlight",
      {
        headers: {
          "user-agent": "asana-rss-bridge (+https://val.town)",
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
