/**
 * Live link check for the PostHog Engineering feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/posthog-engineering-rss.linkcheck.test.ts
 */

import { extractPosts } from "../posthog-engineering-rss.ts";
import {
  assertAllServed,
  jsonFixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await jsonFixture(import.meta, "posthog-strapi-engineering.json"),
);

liveTest("every post link resolves", async () => {
  // Strapi stores the path with its section ("/newsletter/foo"), and PostHog
  // serves posts from the site root rather than under /blog — the one thing
  // about these URLs that has to be taken on faith offline.
  await assertAllServed(
    posts.map((p) => `https://posthog.com${p.path}`),
    "posthog post links",
  );
});

liveTest("a sample of featured images resolve", async () => {
  await assertAllServed(
    sampleOf(posts.map((p) => p.image).filter(Boolean)),
    "posthog featured images",
  );
});

liveTest("the tag page the channel links to exists", async () => {
  await assertAllServed(
    ["https://posthog.com/blog?tag=Engineering"],
    "posthog tag page",
  );
});

liveTest("the Strapi query still answers with tagged posts", async () => {
  // The whole val rests on this host staying open and on the filter shape
  // staying valid — Strapi answers a malformed filter with everything rather
  // than an error, so the count matters as much as the status.
  const params = new URLSearchParams([
    ["populate[0]", "post_tags"],
    ["sort[0]", "date:desc"],
    ["pagination[limit]", "100"],
    ["filters[$and][0][$or][0][post_category][folder][$eq]", "blog"],
    ["filters[$and][0][$or][1][crosspost_categories][folder][$eq]", "blog"],
    ["filters[$and][1][post_tags][label][$in][0]", "Engineering"],
  ]);
  const res = await fetch(
    `https://better-animal-d658c56969.strapiapp.com/api/posts?${params}`,
    { headers: { accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`strapi: HTTP ${res.status}`);
  const body = await res.json();
  const live = extractPosts(body);
  if (live.length === 0) throw new Error("the query matched no tagged posts");
  if (live.length !== body.data.length) {
    throw new Error(
      `Strapi returned ${body.data.length} records but only ${live.length} ` +
        "carry the tag — the server-side filter has stopped applying",
    );
  }
});
