/**
 * Live link check for the Pigeons & Planes feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/pigeons-and-planes-rss.linkcheck.test.ts
 */

import { buildFeed, extractPosts } from "../pigeons-and-planes-rss.ts";
import {
  assertAllServed,
  channelLink,
  jsonFixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await jsonFixture(import.meta, "pigeons-sanity-posts.json"),
);

liveTest("every post link resolves", async () => {
  // Only 20 posts, so check them all. The slug comes from `alias.current` in
  // Sanity rather than from any URL the site rendered, and the val builds
  // /read/<slug> around it — neither is provable offline.
  const urls = posts.map((p) =>
    `https://www.pigeonsandplanes.com/read/${p.slug}`
  );
  await assertAllServed(urls, "pigeons post links");
});

liveTest("the site the channel links to exists", async () => {
  const xml = await buildFeed(posts, new URL("https://feed.val.run/pnp"))
    .text();
  await assertAllServed([channelLink(xml)], "pigeons site link");
});

liveTest("a sample of thumbnails resolve", async () => {
  // `thumbnail.asset->url` is resolved by Sanity, so a wrong host here would be
  // the site's own doing rather than a URL this val assembled — but the Lovable
  // feed built a plausible-looking asset host that 404'd, so it is still worth
  // proving something is served.
  await assertAllServed(
    sampleOf(posts.map((p) => p.image).filter(Boolean)),
    "pigeons thumbnails",
  );
});

liveTest("the site's Sanity proxy still answers this projection", async () => {
  // The one request the val makes. It goes through the site's own
  // /api/sanity route rather than to Sanity directly, so a Next.js rebuild can
  // remove it without any redirect — and a projection that stops resolving
  // returns rows of nulls rather than an error, which reads offline as "the
  // blog published nothing".
  const groq = `*[_type == "post" && hidePost != true]
    | order(publishedAt desc) [0...20] {
      "title": coalesce(headlineRich[0].children[0].text, headline),
      "slug": alias.current,
      description,
      publishedAt,
      "image": thumbnail.asset->url,
      "imageType": thumbnail.asset->mimeType,
      "authors": authors[]->name
    }`;
  const res = await fetch(
    `https://www.pigeonsandplanes.com/api/sanity?query=${
      encodeURIComponent(groq)
    }`,
    { headers: { accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`sanity proxy: HTTP ${res.status}`);

  const live = extractPosts(await res.json());
  if (!live.length) throw new Error("sanity proxy returned no usable rows");
  if (live.every((p) => p.ts === null)) {
    throw new Error(
      "no live row carried a date — publishedAt stopped resolving",
    );
  }
  if (live.every((p) => !p.authors.length)) {
    throw new Error(
      "no live row carried a byline — authors[]->name stopped resolving",
    );
  }
  if (live.every((p) => !p.image)) {
    throw new Error(
      "no live row carried an image — thumbnail.asset->url stopped resolving",
    );
  }
  if (live.every((p) => !p.imageType)) {
    throw new Error(
      "no live row stated a media type — thumbnail.asset->mimeType stopped " +
        "resolving, and every enclosure would go out untyped",
    );
  }
});
