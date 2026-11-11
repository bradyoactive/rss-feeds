/**
 * Live link check for the LinkedIn feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/linkedin-engineering-rss.linkcheck.test.ts
 */

import { buildFeed, extractPosts } from "../linkedin-engineering-rss.ts";
import {
  assertAllServed,
  channelLink,
  fixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await fixture(import.meta, "linkedin-engineering.html"),
);

liveTest("a sample of post links resolve", async () => {
  const urls = sampleOf(posts.map((p) => p.url));
  await assertAllServed(urls, "linkedin post links");
});

liveTest("the engineering portal the channel links to exists", async () => {
  const res = buildFeed(posts, new URL("https://feed.val.run/linkedin"));
  await assertAllServed(
    [channelLink(await res.text())],
    "linkedin engineering blog portal",
  );
});

liveTest("the live engineering blog still renders grid posts", async () => {
  const res = await fetch("https://www.linkedin.com/blog/engineering", {
    headers: {
      "user-agent": "linkedin-rss-bridge (+https://val.town)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`blog portal: HTTP ${res.status}`);
  const html = await res.text();
  const live = extractPosts(html);
  if (!live.length) throw new Error("live page yielded no posts");
  if (live.some((p) => p.ts === null)) {
    throw new Error("a live post carried an unparseable publication date");
  }
});
