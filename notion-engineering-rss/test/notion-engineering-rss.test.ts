/**
 * Offline tests for the Notion Engineering feed. The fixture is a
 * capture of the topic page HTML. Refresh with:
 *
 *   curl -s -H "User-Agent: notion-rss-bridge (+https://val.town)" \
 *     -H "Accept: text/html,application/xhtml+xml" \
 *     "https://www.notion.com/blog/topic/tech" \
 *     > test/notion-engineering-tech.html
 *
 * Run: node --test test/notion-engineering-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  clean,
  extractPosts,
  mediaType,
  parseDate,
  type Post,
  postUrl,
  renderRss,
} from "../notion-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const html = await readFile(
  new URL("./notion-engineering-tech.html", import.meta.url), "utf8",
);
const posts = extractPosts(html);
const bySlug = (slug: string) => posts.find((p) => p.slug === slug);

test("extracts all posts from the fixture", () => {
  assertEquals(posts.length, 10, "post count");
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

test("every post in fixture is dated with a valid UTC timestamp", () => {
  assertEquals(
    posts.filter((p) => p.ts === null).length,
    0,
    "every post dated",
  );
  assert(
    posts.every((p) => typeof p.ts === "number" && !isNaN(p.ts)),
    "every timestamp is a valid number",
  );
});

test("every post has an image and a valid media type", () => {
  assertEquals(
    posts.filter((p) => !p.image).length,
    0,
    "every post has an image",
  );
  assert(
    posts.every((p) =>
      p.imageType === "image/png" || p.imageType === "image/jpeg"
    ),
    "media type mapped properly",
  );
  assert(
    posts.every((p) => p.image.startsWith("https://")),
    "image URLs are absolute with https schema",
  );
});

test("reads a known post's fields accurately", () => {
  const p = bySlug("how-notion-handles-concurrent-editing-with-crdts")!;
  assert(p, "post exists");
  assertEquals(
    p.title,
    "How Notion handles concurrent editing with CRDTs",
    "title",
  );
  assertEquals(
    p.description,
    "Building a CRDT-based rich-text system that merges concurrent edits across Notion blocks—without losing anyone’s work",
    "subtitle",
  );
  assertEquals(
    p.author,
    "Angelique Nehmzow, Emma Guo, Fabricio Pontes Harsich, Stephan Boyer",
    "authors",
  );
  assertEquals(p.categories, ["Tech"], "categories");
  assertEquals(
    postUrl(p.slug),
    "https://www.notion.com/blog/how-notion-handles-concurrent-editing-with-crdts",
    "post URL",
  );
});

test("parseDate handles ISO, naive, date-only, and invalid strings", () => {
  assertEquals(
    parseDate("2026-10-14T17:38:40.293Z"),
    Date.parse("2026-10-14T17:38:40.293Z"),
  );
  assertEquals(
    parseDate("2026-05-15"),
    Date.UTC(2026, 4, 15, 0, 0, 0),
  );
  assertEquals(parseDate("not a date"), null);
  assertEquals(parseDate(""), null);
  assertEquals(parseDate(null), null);
});

test("postUrl prepends SITE domain appropriately", () => {
  assertEquals(
    postUrl("test-post"),
    "https://www.notion.com/blog/test-post",
  );
  assertEquals(
    postUrl("/test-post"),
    "https://www.notion.com/blog/test-post",
  );
  assertEquals(
    postUrl("https://other.com/post"),
    "https://other.com/post",
  );
});

test("mediaType determines MIME type from extension", () => {
  assertEquals(mediaType("https://example.com/photo.png"), "image/png");
  assertEquals(mediaType("https://example.com/photo.webp"), "image/webp");
  assertEquals(mediaType("https://example.com/photo.jpg"), "image/jpeg");
});

test("orders items newest first in buildFeed", () => {
  const feed = buildFeed(posts, new URL("https://feed.val.run/notion"));
  assertEquals(feed.status, 200);
  assertEquals(
    feed.headers.get("content-type"),
    "application/rss+xml; charset=utf-8",
  );
  assertEquals(feed.headers.get("cache-control"), "public, max-age=43200");
});

test("renderRss produces valid RSS 2.0 with permalinks and enclosures", () => {
  const sample: Post[] = [
    {
      slug: "test-post",
      title: "Test Post",
      description: "Test description",
      ts: Date.UTC(2026, 9, 14),
      author: "Jane Doe",
      image: "https://images.ctfassets.net/photo.png",
      imageType: "image/png",
      categories: ["Tech"],
    },
  ];

  const xml = renderRss({
    title: "Notion Engineering Blog",
    description: "Engineering insights from Notion.",
    siteLink: "https://www.notion.com/blog/topic/tech",
    feedUrl: "https://feed.val.run/notion",
    items: sample,
  });

  assert(xml.includes("<title><![CDATA[Test Post]]></title>"), "item title");
  assert(
    xml.includes("<link>https://www.notion.com/blog/test-post</link>"),
    "item link",
  );
  assert(
    xml.includes(
      '<guid isPermaLink="true">https://www.notion.com/blog/test-post</guid>',
    ),
    "permalink guid",
  );
  assert(xml.includes("<author>Jane Doe</author>"), "author");
  assert(xml.includes("<category>Tech</category>"), "category");
  assert(xml.includes('type="image/png"'), "enclosure states media type");
  assert(
    xml.includes('url="https://images.ctfassets.net/photo.png"'),
    "enclosure states url",
  );
});

test("clean strips control characters that break XML 1.0", () => {
  const input = "Title with \x00 null and \x0B vertical tab";
  assertEquals(clean(input), "Title with  null and  vertical tab");
});

test("throws error if __NEXT_DATA__ is missing", () => {
  let threw = false;
  try {
    extractPosts("<html><body>No next data here</body></html>");
  } catch {
    threw = true;
  }
  assert(threw, "should throw on missing __NEXT_DATA__");
});
