/**
 * Live link check for the Mercury feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/mercury-eng-rss.linkcheck.test.ts
 */

import {
  buildFeed,
  extractDetail,
  extractIndex,
  type Post,
} from "../mercury-eng-rss.ts";
import {
  assertAllServed,
  channelLink,
  fixture,
  liveTest,
} from "../../common/linkcheck.ts";

const stubs = extractIndex(
  await fixture(import.meta, "mercury-eng-search.html"),
  "Eng Blog",
);

liveTest("every post link resolves", async () => {
  // Only 8 posts, so check them all.
  const urls = stubs.map((s) => `https://mercury.com/blog/${s.slug}`);
  await assertAllServed(urls, "mercury post links");
});

liveTest("the cover image from a post page resolves", async () => {
  const detail = extractDetail(
    await fixture(import.meta, "mercury-post-ghciwatch.html"),
  );
  // Entity-decoding the og:image is the failure mode here: a URL still holding
  // "&amp;" looks fine in the feed and 404s (or serves the wrong size) in a reader.
  await assertAllServed([detail.image], "mercury cover image");
});

liveTest(
  "the search page the channel links to lists actual posts",
  async () => {
    // Mercury's listing is a search query, not a directory path, so the channel
    // <link> carries the topic as a parameter and a wrong one fails silently:
    // ?topics=eng-blog — the slug rather than the display name — returns a
    // perfectly good 200 with no posts in it. (Encoding is the forgiving part;
    // Eng+Blog and Eng%20Blog are equivalent.) Checking the status alone would
    // therefore prove nothing, so this also insists the page names posts the feed
    // claims are in that topic.
    const posts: Post[] = stubs.map((s) => ({
      ...s,
      description: "",
      ts: null,
      image: "",
    }));
    const xml = await buildFeed(
      posts,
      new URL("https://feed.val.run/mercury"),
    ).text();
    const link = channelLink(xml);

    await assertAllServed([link], "mercury search page");

    const res = await fetch(link);
    const html = await res.text();
    const slugs =
      stubs.map((s) => s.slug).filter((slug) => html.includes(slug)).length;
    if (!slugs) {
      throw new Error(
        `mercury search page served but listed none of its ${stubs.length} posts: ${link}`,
      );
    }
  },
);
