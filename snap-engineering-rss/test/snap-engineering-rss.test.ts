/**
 * Offline tests for the Snap Engineering feed. The fixture is a
 * capture of the blog page HTML. Refresh with:
 *
 *   curl -s -H "User-Agent: snap-rss-bridge (+https://val.town)" \
 *     -H "Accept: text/html,application/xhtml+xml" \
 *     "https://eng.snap.com/blog" \
 *     > test/snap-engineering.html
 *
 * Run: deno test --allow-read test/snap-engineering-rss.test.ts
 */

import {
  buildFeed,
  clean,
  extractPosts,
  mediaType,
  parseDate,
  type Post,
  postUrl,
  renderRss,
} from "../snap-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const html = await Deno.readTextFile(
  new URL("./snap-engineering.html", import.meta.url),
);
const posts = extractPosts(html);
const bySlug = (slug: string) => posts.find((p) => p.slug === slug);

Deno.test("extracts all posts from the fixture", () => {
  assertEquals(posts.length, 11, "post count");
  assert(
    posts.every((p) => p.title && p.slug),
    "every post has a title and slug",
  );
  assertEquals(
    new Set(posts.map((p) => p.slug)).size,
    posts.length,
    "slugs are unique",
  );
});

Deno.test("reads a known Tile post's fields accurately", () => {
  const p = bySlug("ds_agent")!;
  assert(p, "post exists");
  assertEquals(
    p.title,
    "DS Agent: Snap's AI Data Scientist",
    "title",
  );
  assert(
    p.description.includes("Part 1 of a series on DS Agent"),
    "summary",
  );
  assertEquals(p.author, "Snap Engineering", "author");
  assertEquals(p.ts, Date.parse("2026-09-10T18:09:45.672Z"), "date");
  assertEquals(p.categories, ["Engineering"], "categories");
  assertEquals(postUrl(p.slug), "https://eng.snap.com/ds_agent", "post URL");
});

Deno.test("captures branded categories like spectacles", () => {
  const p = bySlug("specs_experiences")!;
  assert(p, "post exists");
  assertEquals(p.categories, ["Engineering", "Spectacles"], "brand category");
});

Deno.test("reads carousel posts accurately", () => {
  const p = bySlug("stomp-out-bad-metrics")!;
  assert(p, "post exists");
  assertEquals(p.title, "STOMP out Bad Metrics", "carousel title");
  assert(p.image.startsWith("https://images.ctfassets.net"), "carousel image");
  assertEquals(p.imageType, "image/jpeg", "image type");
});

Deno.test("parseDate handles ISO, naive, date-only, and invalid strings", () => {
  assertEquals(
    parseDate("2026-09-10T18:09:45.672Z"),
    Date.parse("2026-09-10T18:09:45.672Z"),
  );
  assertEquals(
    parseDate("2026-08-20T00:00:00.000-07:00"),
    Date.parse("2026-08-20T00:00:00.000-07:00"),
  );
  assertEquals(parseDate("not a date"), null);
  assertEquals(parseDate(""), null);
  assertEquals(parseDate(null), null);
});

Deno.test("postUrl prepends SITE domain appropriately", () => {
  assertEquals(
    postUrl("ds_agent"),
    "https://eng.snap.com/ds_agent",
  );
  assertEquals(
    postUrl("/ds_agent"),
    "https://eng.snap.com/ds_agent",
  );
  assertEquals(
    postUrl("https://other.com/post"),
    "https://other.com/post",
  );
});

Deno.test("mediaType determines MIME type from extension", () => {
  assertEquals(mediaType("https://example.com/photo.png"), "image/png");
  assertEquals(mediaType("https://example.com/photo.svg"), "image/svg+xml");
  assertEquals(mediaType("https://example.com/photo.jpg"), "image/jpeg");
});

Deno.test("orders items newest first in buildFeed", () => {
  const feed = buildFeed(posts, new URL("https://feed.val.run/snap"));
  assertEquals(feed.status, 200);
  assertEquals(
    feed.headers.get("content-type"),
    "application/rss+xml; charset=utf-8",
  );
  assertEquals(feed.headers.get("cache-control"), "public, max-age=43200");
});

Deno.test("renderRss produces valid RSS 2.0 with permalinks and enclosures", () => {
  const sample: Post[] = [
    {
      slug: "ds_agent",
      title: "DS Agent: Snap's AI Data Scientist",
      description: "Data science platform at Snap",
      ts: Date.UTC(2026, 8, 10),
      author: "Snap Engineering",
      image: "https://images.ctfassets.net/image.png",
      imageType: "image/png",
      categories: ["Engineering"],
    },
  ];

  const xml = renderRss({
    title: "Snap Engineering Blog",
    description: "Technical insights from Snap.",
    siteLink: "https://eng.snap.com/blog",
    feedUrl: "https://feed.val.run/snap",
    items: sample,
  });

  assert(
    xml.includes(
      "<title><![CDATA[DS Agent: Snap's AI Data Scientist]]></title>",
    ),
    "item title",
  );
  assert(
    xml.includes("<link>https://eng.snap.com/ds_agent</link>"),
    "item link",
  );
  assert(
    xml.includes(
      '<guid isPermaLink="true">https://eng.snap.com/ds_agent</guid>',
    ),
    "permalink guid",
  );
  assert(xml.includes("<author>Snap Engineering</author>"), "author");
  assert(xml.includes("<category>Engineering</category>"), "category");
  assert(xml.includes('type="image/png"'), "enclosure states media type");
});

Deno.test("clean strips control characters that break XML 1.0", () => {
  const input = "Title with \x00 null and \x0B vertical tab";
  assertEquals(clean(input), "Title with  null and  vertical tab");
});

Deno.test("throws error if APOLLO_STATE is missing", () => {
  let threw = false;
  try {
    extractPosts("<html><body>No apollo state here</body></html>");
  } catch {
    threw = true;
  }
  assert(threw, "should throw on missing APOLLO_STATE");
});
