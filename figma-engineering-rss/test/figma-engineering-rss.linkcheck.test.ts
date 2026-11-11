/**
 * Live link check for the Figma feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/figma-engineering-rss.linkcheck.test.ts
 */

import { extractPosts } from "../figma-engineering-rss.ts";
import {
  assertAllServed,
  jsonFixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await jsonFixture(import.meta, "figma-blog-search-index.json"),
);

liveTest("every post link resolves, trailing slash and all", async () => {
  // Paths are stored slash-terminated in the index and used verbatim, so this
  // checks the stored form rather than one the val assembled.
  await assertAllServed(
    posts.map((p) => `https://www.figma.com${p.path}`),
    "figma post links",
  );
});

liveTest("a sample of thumbnails resolve", async () => {
  await assertAllServed(
    sampleOf(posts.map((p) => p.image).filter(Boolean)),
    "figma thumbnails",
  );
});

liveTest("the tag page the channel links to exists", async () => {
  // Figma moved this once already: /blog/section/engineering/, which the old
  // val still linked to, now 404s. If it moves again this says so.
  await assertAllServed(
    ["https://www.figma.com/blog/engineering/"],
    "figma tag page",
  );
});

liveTest("the search index is still served and still tagged", async () => {
  // The whole val rests on this one static file. A 200 is not enough — if
  // Figma drops `labels` from it the feed silently empties, so check that the
  // live copy still yields posts and that it holds more than the fixture.
  const res = await fetch("https://www.figma.com/blogSearch/blog-data.json");
  if (!res.ok) throw new Error(`blog-data.json: HTTP ${res.status}`);
  const live = extractPosts(await res.json());
  if (live.length <= posts.length) {
    throw new Error(
      `blog-data.json served but yielded only ${live.length} tagged posts; ` +
        `the fixture subset alone has ${posts.length}`,
    );
  }
  await assertAllServed(
    sampleOf(live.map((p) => `https://www.figma.com${p.path}`)),
    "figma live post links",
  );
});
