/**
 * Live link check for the Robinhood Tech Blog feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/robinhood-tech-rss.linkcheck.test.ts
 */

import { buildFeed, extractPosts } from "../robinhood-tech-rss.ts";
import {
  assertAllServed,
  channelLink,
  jsonFixture,
  liveTest,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await jsonFixture(import.meta, "robinhood-contentful-tech-blog.json"),
);

liveTest("every post link resolves", async () => {
  // Contentful stores a bare slug; the /us/en/careers/blog/ prefix and the
  // trailing slash are the val's own doing, and nothing offline can check them.
  await assertAllServed(
    posts.map((p) => `https://robinhood.com/us/en/careers/blog/${p.slug}/`),
    "robinhood post links",
  );
});

liveTest("every featured image resolves", async () => {
  await assertAllServed(posts.map((p) => p.image), "robinhood images");
});

liveTest("the category page the channel links to exists", async () => {
  const xml = await buildFeed(posts, new URL("https://feed.val.run/x")).text();
  await assertAllServed([channelLink(xml)], "robinhood category page");
});

liveTest("the token still works and the query still finds posts", async () => {
  // This is the val's single point of failure: the delivery token is baked in,
  // and Robinhood ships it to browsers rather than exposing it somewhere the
  // val could re-read. A rotation shows up here as a 401 rather than as a
  // quietly empty feed.
  const params = new URLSearchParams({
    content_type: "careersBlogArticle",
    locale: "en-US",
    order: "-fields.publishDate",
    limit: "100",
    include: "2",
    "fields.categories.sys.id[in]": "3Yoj9Flwon0pteDV435r7U",
  });
  const res = await fetch(
    `https://cdn.contentful.com/spaces/1hpl803w8xsv/environments/master/entries?${params}`,
    {
      headers: {
        authorization: "Bearer c-uWotLcY4Kh6NTH4w15c0aH2n8cwxGTOvo98Nk8STE",
        accept: "application/json",
      },
    },
  );
  if (res.status === 401) {
    throw new Error("Contentful 401 — the baked-in delivery token was rotated");
  }
  if (!res.ok) throw new Error(`Contentful: HTTP ${res.status}`);

  const live = extractPosts(await res.json());
  if (live.length === 0) {
    throw new Error("the query answered but matched no Tech Blog posts");
  }
  await assertAllServed(
    live.map((p) => `https://robinhood.com/us/en/careers/blog/${p.slug}/`),
    "robinhood live post links",
  );
});
