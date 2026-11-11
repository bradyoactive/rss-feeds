/**
 * Live link check for the Honeycomb feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/honeycomb-engineering-rss.linkcheck.test.ts
 */

import { extractPosts, GROQ } from "../honeycomb-engineering-rss.ts";
import {
  assertAllServed,
  jsonFixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const SANITY =
  "https://927dxq0h.apicdn.sanity.io/v2021-10-21/data/query/production";

const posts = extractPosts(
  await jsonFixture(import.meta, "honeycomb-sanity-software-engineering.json"),
);

async function livePosts() {
  const res = await fetch(`${SANITY}?query=${encodeURIComponent(GROQ)}`);
  if (!res.ok) throw new Error(`sanity: HTTP ${res.status}`);
  return extractPosts(await res.json());
}

liveTest("every post link resolves", async () => {
  await assertAllServed(
    sampleOf(posts.map((p) => `https://www.honeycomb.io/blog/${p.slug}`)),
    "honeycomb post links",
  );
});

liveTest("a sample of images resolve", async () => {
  await assertAllServed(
    sampleOf(posts.map((p) => p.image).filter(Boolean)),
    "honeycomb images",
  );
});

liveTest("the topic page the channel links to exists", async () => {
  await assertAllServed(
    ["https://www.honeycomb.io/blog?topic=Software+Engineering"],
    "honeycomb topic page",
  );
});

liveTest(
  "the dataset is still readable and the topic still matches",
  async () => {
    // An unauthenticated Sanity read of a private dataset returns an empty
    // result rather than an error, so "no posts" is what being locked out looks
    // like — and it is also what a renamed topic slug looks like.
    const live = await livePosts();
    if (live.length === 0) {
      throw new Error(
        "the query answered with nothing — either the dataset was closed or " +
          "the software-engineering topic slug changed",
      );
    }
    const untagged = live.filter(
      (p) => !p.topics.includes("Software Engineering"),
    );
    if (untagged.length) {
      throw new Error(`${untagged.length} posts came back without the topic`);
    }
  },
);

liveTest("images still resolve through the assetImage wrapper", async () => {
  // mainImage.asset is null on every article; only mainImage.image.asset works.
  // If the schema flattens, this fails rather than quietly dropping thumbnails.
  const live = await livePosts();
  const withoutImage = live.filter((p) => !p.image);
  if (withoutImage.length > live.length / 2) {
    throw new Error(
      `${withoutImage.length}/${live.length} articles resolved no image — ` +
        "the assetImage nesting has probably changed",
    );
  }
});
