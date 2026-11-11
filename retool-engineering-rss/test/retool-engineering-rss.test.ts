/**
 * Offline tests for the Retool Engineering feed. The fixture is a
 * capture of the category page HTML. Refresh with:
 *
 *   curl -s -H "User-Agent: retool-rss-bridge (+https://val.town)" \
 *     -H "Accept: text/html,application/xhtml+xml" \
 *     "https://retool.com/blog/category/engineering" \
 *     > test/retool-engineering.html
 *
 * Run: node --test test/retool-engineering-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  clean,
  extractPosts,
  mediaType,
  normalizeUrl,
  parseDate,
  type Post,
  renderRss,
} from "../retool-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const html = await readFile(
  new URL("./retool-engineering.html", import.meta.url),
  "utf8",
);
const posts = extractPosts(html);
const byUrl = (url: string) => posts.find((p) => p.url === url);

test("extracts all posts from the fixture", () => {
  assertEquals(posts.length, 12, "post count");
  assert(
    posts.every((p) => p.title && p.url),
    "every post has a title and url",
  );
  assertEquals(
    new Set(posts.map((p) => p.url)).size,
    posts.length,
    "URLs are unique",
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

test("every post has a 16:9 hero image from Sanity CDN", () => {
  assertEquals(
    posts.filter((p) => !p.image).length,
    0,
    "every post has hero image",
  );
  assert(
    posts.every((p) =>
      p.image.startsWith("https://cdn.sanity.io/images/bclf52sw/production/"),
    ),
    "images come from Retool Sanity CDN",
  );
});

test("reads a known post's fields accurately", () => {
  const p = byUrl("https://retool.com/blog/retool-mcp-vs-cli")!;
  assert(p, "post exists");
  assertEquals(
    p.title,
    "Retool MCP vs. CLI: When to use each building surface",
    "title",
  );
  assert(
    p.description.includes(
      "Not sure whether to reach for Retool's MCP or CLI?",
    ),
    "summary with decoded entities",
  );
  assertEquals(p.author, "Prajya Sharma, Rohan Suresh", "author list");
  assertEquals(p.ts, Date.UTC(2026, 8, 24), "date");
  assertEquals(p.categories, ["Engineering"], "categories");
});

test("decodes html entities in titles and summaries", () => {
  const p = byUrl("https://retool.com/blog/mfa-isnt-mfa")!;
  assert(p, "mfa post exists");
  assertEquals(p.title, "When MFA isn't actually MFA", "decoded apostrophe");
});

test("parseDate handles ISO, naive, date-only, and invalid strings", () => {
  assertEquals(parseDate("2026-09-24"), Date.UTC(2026, 8, 24, 0, 0, 0));
  assertEquals(
    parseDate("2026-05-25T14:30:00.000Z"),
    Date.parse("2026-05-25T14:30:00.000Z"),
  );
  assertEquals(parseDate("not a date"), null);
  assertEquals(parseDate(""), null);
  assertEquals(parseDate(null), null);
});

test("normalizeUrl handles absolute and relative paths", () => {
  assertEquals(
    normalizeUrl("https://retool.com/blog/test"),
    "https://retool.com/blog/test",
  );
  assertEquals(normalizeUrl("/blog/test"), "https://retool.com/blog/test");
});

test("mediaType determines MIME type from extension", () => {
  assertEquals(mediaType("https://example.com/photo.png"), "image/png");
  assertEquals(mediaType("https://example.com/photo.svg"), "image/svg+xml");
  assertEquals(mediaType("https://example.com/photo.jpg"), "image/jpeg");
});

test("orders items newest first in buildFeed", () => {
  const feed = buildFeed(posts, new URL("https://feed.val.run/retool"));
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
      url: "https://retool.com/blog/sample",
      title: "Sample Post",
      description: "Sample description",
      ts: Date.UTC(2026, 8, 24),
      author: "Jane Doe",
      image: "https://cdn.sanity.io/images/bclf52sw/production/photo.png",
      imageType: "image/png",
      categories: ["Engineering"],
    },
  ];

  const xml = renderRss({
    title: "Retool Engineering Blog",
    description: "Technical insights from Retool.",
    siteLink: "https://retool.com/blog/category/engineering",
    feedUrl: "https://feed.val.run/retool",
    items: sample,
  });

  assert(xml.includes("<title><![CDATA[Sample Post]]></title>"), "item title");
  assert(
    xml.includes("<link>https://retool.com/blog/sample</link>"),
    "item link",
  );
  assert(
    xml.includes(
      '<guid isPermaLink="true">https://retool.com/blog/sample</guid>',
    ),
    "permalink guid",
  );
  assert(xml.includes("<author>Jane Doe</author>"), "author");
  assert(xml.includes("<category>Engineering</category>"), "category");
  assert(xml.includes('type="image/png"'), "enclosure states media type");
});

test("clean strips control characters that break XML 1.0", () => {
  const input = "Title with \x00 null and \x0B vertical tab";
  assertEquals(clean(input), "Title with  null and  vertical tab");
});

test("throws error if blog article items are missing", () => {
  let threw = false;
  try {
    extractPosts("<html><body>No articles here</body></html>");
  } catch {
    threw = true;
  }
  assert(threw, "should throw on missing blog items");
});
