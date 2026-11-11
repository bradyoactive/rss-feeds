/**
 * Live link check for the Modal feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/modal-engineering-rss.linkcheck.test.ts
 */

import { extractPosts } from "../modal-engineering-rss.ts";
import {
  assertAllServed,
  jsonFixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const DATA_URL = "https://modal.com/blog/__data.json";

const posts = extractPosts(
  await jsonFixture(import.meta, "modal-blog-data.json"),
);

async function livePosts() {
  const res = await fetch(DATA_URL, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`${DATA_URL}: HTTP ${res.status}`);
  return extractPosts(await res.json());
}

liveTest("every post link resolves", async () => {
  await assertAllServed(
    posts.map((p) => `https://modal.com/blog/${p.slug}`),
    "modal post links",
  );
});

liveTest("a sample of images resolve", async () => {
  await assertAllServed(
    sampleOf(posts.map((p) => p.image).filter(Boolean)),
    "modal images",
  );
});

liveTest("the category page the channel links to exists", async () => {
  await assertAllServed(
    ["https://modal.com/blog?category=Engineering"],
    "modal category page",
  );
});

liveTest("the data route still decodes into Engineering posts", async () => {
  // This is the val's single point of failure: an undocumented SvelteKit route
  // whose payload needs decoding. A shape change shows up here as zero posts
  // rather than as a quietly empty feed.
  const live = await livePosts();
  if (live.length === 0) {
    throw new Error(
      "the data route answered but decoded to no Engineering posts — either " +
        "the devalue shape or the `posts` key has changed",
    );
  }
  if (live.some((p) => p.category !== "Engineering")) {
    throw new Error("a post from another category came through the filter");
  }
  await assertAllServed(
    sampleOf(live.map((p) => `https://modal.com/blog/${p.slug}`)),
    "modal live post links",
  );
});
