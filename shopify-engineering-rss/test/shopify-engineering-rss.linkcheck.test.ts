/**
 * Live link check for the Shopify Engineering feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/shopify-engineering-rss.linkcheck.test.ts
 */

import {
  decode,
  extractPosts,
  findArticles,
  topicUrl,
} from "../shopify-engineering-rss.ts";
import {
  assertAllServed,
  jsonFixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await jsonFixture(import.meta, "shopify-latest.data.json"),
);

liveTest("every post link resolves", async () => {
  // Shopify serves articles from the site root rather than under /blog, which
  // is the one thing about these URLs that has to be taken on faith offline.
  await assertAllServed(
    posts.map((p) => `https://shopify.engineering/${p.handle}`),
    "shopify post links",
  );
});

liveTest("a sample of images resolve", async () => {
  await assertAllServed(
    sampleOf(posts.map((p) => p.image).filter(Boolean)),
    "shopify article images",
  );
});

liveTest("the page the channel links to exists", async () => {
  await assertAllServed(
    ["https://shopify.engineering/latest"],
    "shopify latest page",
  );
});

liveTest(
  "the data route is still served and still holds articles",
  async () => {
    // The whole val rests on this route. A 200 is not enough: if React Router
    // stops answering it with the loader data the feed silently empties.
    const res = await fetch("https://shopify.engineering/latest.data");
    if (!res.ok) throw new Error(`latest.data: HTTP ${res.status}`);
    const live = extractPosts(await res.json());
    if (live.length === 0) {
      throw new Error("latest.data served but yielded no articles");
    }
    await assertAllServed(
      sampleOf(live.map((p) => `https://shopify.engineering/${p.handle}`)),
      "shopify live post links",
    );
  },
);

liveTest("every topic the feed emits has a topic page", async () => {
  // The topic filter is this val's one heuristic — keep a tag if it has an
  // uppercase letter. Shopify publishes /topics/<slug> for the topics it
  // displays and nothing for its internal markers, so those pages are the
  // authority. This direction catches a workflow tag sneaking through.
  await assertAllServed(
    [...new Set(posts.flatMap((p) => p.topics))].map(topicUrl),
    "shopify topic pages",
  );
});

liveTest("every tag the filter drops has no topic page", async () => {
  // The other direction, and the one that matters more: if Shopify ever ships
  // a topic in lower case the heuristic would silently drop a real category.
  // Run against the live payload rather than the fixture — a new tag shows up
  // there first, and this is the check that should notice it.
  const res = await fetch("https://shopify.engineering/latest.data");
  if (!res.ok) throw new Error(`latest.data: HTTP ${res.status}`);
  const payload = await res.json();

  const kept = new Set(extractPosts(payload).flatMap((p) => p.topics));
  const dropped = [
    ...new Set(
      findArticles(decode(payload))
        .flatMap((a) => (Array.isArray(a.tags) ? a.tags : []))
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t && !kept.has(t)),
    ),
  ];
  if (dropped.length === 0) {
    throw new Error("nothing was dropped, so this proves nothing");
  }

  const real: string[] = [];
  for (const tag of dropped) {
    const probe = await fetch(topicUrl(tag), { method: "HEAD" });
    await probe.body?.cancel();
    if (probe.ok) real.push(tag);
  }
  if (real.length) {
    throw new Error(`dropped tags that are real topics: ${real.join(", ")}`);
  }
});
