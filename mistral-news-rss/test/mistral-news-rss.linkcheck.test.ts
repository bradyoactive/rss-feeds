/**
 * Live link check for the Mistral feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/mistral-news-rss.linkcheck.test.ts
 */

import { extractPosts } from "../mistral-news-rss.ts";
import {
  assertAllServed,
  fixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const PAGE = "https://mistral.ai/news/";
const FEED = "https://mistral.ai/news/rss";
const HEADERS = { "user-agent": "mistral-rss-bridge (+https://val.town)" };

const posts = extractPosts(
  await fixture(import.meta, "mistral-news-page.html"),
  await fixture(import.meta, "mistral-news-rss.xml"),
);

const get = async (url: string) => {
  const res = await fetch(url, { headers: HEADERS });
  assert(res.ok, `${res.status} from ${url}`);
  return res.text();
};

liveTest("every post link resolves, trailing slash and all", async () => {
  // The page links a bare slug path; the trailing slash is the form the site
  // canonicalises to and the form the firehose keys its <link> on.
  const urls = posts.map((p) => `https://mistral.ai/news/${p.slug}/`);
  await assertAllServed(urls, "mistral post links");
});

liveTest("a sample of thumbnails resolve without the deploy id", async () => {
  // The val strips ?dpl= off every /_astro/ URL. If that param were load-bearing
  // rather than a cache buster, this is where the feed's images would go dark.
  const urls = sampleOf(posts.map((p) => p.image).filter(Boolean));
  assert(!urls.some((u) => u.includes("dpl=")), "stripped before the check");
  await assertAllServed(urls, "mistral thumbnails");
});

liveTest("?dpl= really is a no-op, in both directions", async () => {
  // The oracle for the strip above: the same bytes must come back with the
  // param, without it, and with a bogus one. If Astro ever starts keying on it,
  // dropping it stops being safe and this says so before readers see it.
  const bare = posts[0].image;
  const lengths = await Promise.all(
    [bare, `${bare}?dpl=6aa1d3faf09280034795e0d1`, `${bare}?dpl=deadbeef`].map(
      async (url) => {
        const res = await fetch(url, { method: "HEAD", headers: HEADERS });
        assert(res.ok, `${res.status} from ${url}`);
        return res.headers.get("content-length");
      },
    ),
  );
  assert(lengths[0] !== null, "the CDN states a length");
  assertEquals(new Set(lengths).size, 1, "same bytes with, without and bogus");
});

liveTest(
  "the listing and the firehose still describe the same posts",
  async () => {
    // The whole val is a join by slug across these two documents. If they ever
    // stop covering the same set, items start losing their date and summary
    // silently — which looks like a thinner feed, not like a failure.
    const [html, xml] = await Promise.all([get(PAGE), get(FEED)]);

    const onPage = new Set(
      [...html.matchAll(
        /<article\b[^>]*\bjs-post\b[\s\S]*?<a[^>]*href="\/news\/([^/"]+)\//g,
      )].map((m) => m[1]),
    );
    const inFeed = new Set(
      [...xml.matchAll(/<link>[^<]*\/news\/([^/<]+)\/?<\/link>/g)].map((m) =>
        m[1]
      ),
    );

    assert(onPage.size > 50, `page listed only ${onPage.size} posts`);
    assertEquals(
      [...onPage].filter((s) => !inFeed.has(s)),
      [],
      "posts on the page the firehose has not got",
    );
    assertEquals(
      [...inFeed].filter((s) => !onPage.has(s)),
      [],
      "posts in the firehose the page has not got",
    );
  },
);

liveTest("the live pair still yields both categories", async () => {
  // The categories live only in the page's markup, so a redesign empties this
  // feed rather than breaking it. Engineering is the thin one — two posts as of
  // this writing — so assert on both rather than on a total.
  const [html, xml] = await Promise.all([get(PAGE), get(FEED)]);
  const live = extractPosts(html, xml);

  const names = new Set(live.flatMap((p) => p.categories));
  assertEquals([...names].sort(), ["Engineering", "Research"], "both present");
  assert(live.length >= 20, `only ${live.length} posts survived the filter`);
  assert(live.every((p) => p.title && p.author && p.image), "fields are total");
  assert(
    live.filter((p) => p.ts !== null).length === live.length,
    "the join dated every post",
  );
});

liveTest("the Payload API this val used to read is still gone", async () => {
  // It answered until Mistral rebuilt on Astro. The media *file* route under
  // the same mount still works, which makes the mount look alive; only the
  // collection route settles it. If this ever 200s again, the one-query version
  // in this val's history is the better shape and worth restoring.
  const res = await fetch("https://mistral.ai/cms-media/api/posts?limit=1", {
    headers: HEADERS,
  });
  await res.body?.cancel();
  assertEquals(res.status, 404, "collection route");

  const media = await fetch(
    "https://mistral.ai/cms-media/api/media/file/ocr.svg",
    { method: "HEAD", headers: HEADERS },
  );
  await media.body?.cancel();
  assert(media.ok, `media route ${media.status} — the mount itself moved`);
});
