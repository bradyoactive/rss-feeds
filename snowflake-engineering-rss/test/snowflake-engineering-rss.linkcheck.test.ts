/**
 * Live link check for the Snowflake feed. See ../../common/linkcheck.ts.
 *
 *   deno test --allow-read --allow-net test/snowflake-engineering-rss.linkcheck.test.ts
 */

import { buildFeed, extractPosts } from "../snowflake-engineering-rss.ts";
import {
  assertAllServed,
  channelLink,
  jsonFixture,
  liveTest,
} from "../../common/linkcheck.ts";

const posts = extractPosts(
  await jsonFixture(import.meta, "snowflake-aem-core-platform.json"),
);

liveTest("every post link resolves", async () => {
  // Only 9 posts, so check them all. The path comes from the AEM filter
  // response rather than from any URL the site rendered, and the val prefixes
  // the public host onto an authoring-side path — neither is provable offline.
  const urls = posts.map((p) => `https://www.snowflake.com${p.path}`);
  await assertAllServed(urls, "snowflake post links");
});

liveTest("the category page the channel links to exists", async () => {
  const xml = await buildFeed(
    posts,
    new URL("https://feed.val.run/snowflake"),
  ).text();
  await assertAllServed([channelLink(xml)], "snowflake category page");
});

liveTest("the filter endpoint still answers with this category", async () => {
  // The one request the val makes. Its address is a component path inside an
  // authored template, so a site rebuild can move it without any redirect —
  // and the val would then serve an empty feed rather than an error.
  const params = new URLSearchParams({
    pagePath:
      "/content/snowflake-site/global/en/blog/engineering/core-platform",
    offset: "0",
    pageSize: "9",
    orderBy: "customPublicationDate",
    sortOrder: "desc",
  });
  const res = await fetch(
    "https://publish-p57963-e462109.adobeaemcloud.com/conf/snowflake-site" +
      "/settings/wcm/templates/blog-category-page/structure/_jcr_content/root" +
      "/responsivegrid/container/flexible_column_cont" +
      `/flexible_column_content_container_1/blog_category_filter.filter.json?${params}`,
    { headers: { accept: "application/json" } },
  );
  if (!res.ok) throw new Error(`filter endpoint: HTTP ${res.status}`);

  const live = extractPosts(await res.json());
  if (!live.length) throw new Error("filter endpoint returned no usable cards");
  if (live.some((p) => p.ts === null)) {
    throw new Error(
      "a live card carried a date parseDate could not read — the display " +
        "format has changed",
    );
  }
});
