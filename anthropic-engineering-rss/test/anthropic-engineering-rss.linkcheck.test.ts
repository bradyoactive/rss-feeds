/**
 * Live link check for the Anthropic feed. See ../../common/linkcheck.ts.
 *
 *   deno test --allow-read --allow-net test/anthropic-engineering-rss.linkcheck.test.ts
 */

import {
  buildFeed,
  extractPosts,
  postUrl,
} from "../anthropic-engineering-rss.ts";
import {
  assertAllServed,
  channelLink,
  fixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await fixture(import.meta, "anthropic-engineering.html"),
);

liveTest("a sample of post links resolve", async () => {
  const urls = sampleOf(posts.map((p) => postUrl(p.slug)));
  await assertAllServed(urls, "anthropic post links");
});

liveTest("a sample of hero thumbnails resolve", async () => {
  const images = sampleOf(posts.map((p) => p.image).filter(Boolean));
  await assertAllServed(images, "anthropic thumbnails");
});

liveTest("the engineering portal the channel links to exists", async () => {
  const res = buildFeed(
    posts,
    new URL("https://feed.val.run/anthropic"),
  );
  await assertAllServed(
    [channelLink(await res.text())],
    "anthropic engineering portal",
  );
});

liveTest(
  "the live engineering portal still renders article cards",
  async () => {
    const res = await fetch(
      "https://www.anthropic.com/engineering",
      {
        headers: {
          "user-agent": "anthropic-rss-bridge (+https://val.town)",
          accept: "text/html,application/xhtml+xml",
        },
      },
    );
    if (!res.ok) throw new Error(`portal page: HTTP ${res.status}`);
    const html = await res.text();
    const live = extractPosts(html);
    if (!live.length) throw new Error("live page yielded no posts");
    if (live.some((p) => p.ts === null)) {
      throw new Error("a live post carried an unparseable publication date");
    }
  },
);
