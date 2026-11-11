/**
 * Offline tests for the Asana Engineering Spotlight feed. The fixture is a
 * capture of the category page HTML. Refresh with:
 *
 *   curl -s -H "User-Agent: asana-rss-bridge (+https://val.town)" \
 *     -H "Accept: text/html,application/xhtml+xml" \
 *     "https://asana.com/inside-asana/engineering-spotlight" \
 *     > test/asana-engineering-spotlight.html
 *
 * Run: node --test test/asana-engineering-rss.test.ts
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
} from "../asana-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const html = await readFile(
  new URL("./asana-engineering-spotlight.html", import.meta.url),
  "utf8",
);
const posts = extractPosts(html);
const byPath = (path: string) => posts.find((p) => p.path === path);

test("extracts all posts from the fixture", () => {
  assertEquals(posts.length, 93, "post count");
  assert(
    posts.every((p) => p.title && p.path),
    "every post has a title and path",
  );
  assertEquals(
    new Set(posts.map((p) => p.path)).size,
    posts.length,
    "paths are unique",
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
    posts.every((p) => p.imageType === "image/jpeg"),
    "extensionless transform CDN images mapped to image/jpeg",
  );
});

test("reads a known post's fields accurately", () => {
  const p = byPath("/inside-asana/database-architecture-sharding-scaling")!;
  assert(p, "post exists");
  assertEquals(
    p.title,
    "Inside Asana's Database Architecture: Sharding, Data Flow, and Scaling Tradeoffs",
    "title",
  );
  assertEquals(p.author, "Spencer Yu", "author");
  assertEquals(p.ts, Date.parse("2026-10-10T00:00:00.000Z"), "date");
  assertEquals(p.categories, ["Engineering"], "categories");
  assertEquals(
    p.image,
    "https://assets.asana.biz/transform/b825d59d-4262-421e-9d36-f977a747e723/Engineering-Templates-16-9-1280-x-720-px-Full-Image-Logo-Blue-3",
    "image URL",
  );
});

test("captures secondary topic tags", () => {
  const p = byPath("/inside-asana/cut-browsers-agent-cost")!;
  assert(p, "post exists");
  assertEquals(p.author, "Frank Hidalgo", "guest author");
  assertEquals(
    p.categories,
    ["Engineering", "Artificial Intelligence (AI)"],
    "primary and secondary topics",
  );
});

test("handles posts outside /inside-asana/ prefix", () => {
  const p = byPath("/resources/scaling-lunadb")!;
  assert(p, "resources post found in engineering spotlight");
  assertEquals(
    p.title,
    "Scaling LunaDb, our in-house declarative data loading system",
    "title",
  );
  assertEquals(p.author, "Arvind Vijayakumar", "author");
  assertEquals(
    postUrl(p.path),
    "https://asana.com/resources/scaling-lunadb",
    "correct absolute URL",
  );
});

test("handles authorless posts without error", () => {
  const authorless = posts.filter((p) => !p.author);
  assert(
    authorless.length > 0,
    "some posts have no credited individual author",
  );
  const outagePost = byPath("/inside-asana/details-july-29-august-1-downtime");
  if (outagePost) {
    assertEquals(
      outagePost.author,
      "",
      "author is empty string when contributor is null",
    );
  }
});

test("parseDate handles ISO, naive, date-only, and invalid strings", () => {
  assertEquals(
    parseDate("2026-10-10T00:00:00.000Z"),
    Date.parse("2026-10-10T00:00:00.000Z"),
  );
  assertEquals(parseDate("2026-05-15"), Date.UTC(2026, 4, 15, 0, 0, 0));
  assertEquals(
    parseDate("2026-05-15T14:30:00"),
    Date.UTC(2026, 4, 15, 14, 30, 0),
  );
  assertEquals(parseDate("not a date"), null);
  assertEquals(parseDate(""), null);
  assertEquals(parseDate(null), null);
});

test("postUrl prepends SITE domain appropriately", () => {
  assertEquals(
    postUrl("/inside-asana/test-post"),
    "https://asana.com/inside-asana/test-post",
  );
  assertEquals(
    postUrl("inside-asana/test-post"),
    "https://asana.com/inside-asana/test-post",
  );
  assertEquals(postUrl("https://other.com/post"), "https://other.com/post");
});

test("mediaType determines MIME type from extension or defaults to image/jpeg", () => {
  assertEquals(mediaType("https://example.com/photo.png"), "image/png");
  assertEquals(mediaType("https://example.com/photo.webp"), "image/webp");
  assertEquals(mediaType("https://example.com/photo.jpg"), "image/jpeg");
  assertEquals(
    mediaType("https://assets.asana.biz/transform/123/banner"),
    "image/jpeg",
  );
});

test("orders items newest first in buildFeed", () => {
  const feed = buildFeed(posts, new URL("https://feed.val.run/asana"));
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
      path: "/inside-asana/test-post",
      title: "Test Post",
      description: "Test description",
      ts: Date.UTC(2026, 9, 10),
      author: "Jane Doe",
      image: "https://assets.asana.biz/transform/123/banner",
      imageType: "image/jpeg",
      categories: ["Engineering"],
    },
  ];

  const xml = renderRss({
    title: "Asana Engineering Blog",
    description: "Engineering spotlights from Asana.",
    siteLink: "https://asana.com/inside-asana/engineering-spotlight",
    feedUrl: "https://feed.val.run/asana",
    items: sample,
  });

  assert(xml.includes("<title><![CDATA[Test Post]]></title>"), "item title");
  assert(
    xml.includes("<link>https://asana.com/inside-asana/test-post</link>"),
    "item link",
  );
  assert(
    xml.includes(
      '<guid isPermaLink="true">https://asana.com/inside-asana/test-post</guid>',
    ),
    "permalink guid",
  );
  assert(xml.includes("<author>Jane Doe</author>"), "author");
  assert(xml.includes("<category>Engineering</category>"), "category");
  assert(xml.includes('type="image/jpeg"'), "enclosure states media type");
  assert(
    xml.includes('url="https://assets.asana.biz/transform/123/banner"'),
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
