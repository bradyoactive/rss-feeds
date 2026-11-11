/**
 * Offline tests for the LinkedIn Engineering feed. The fixture is a
 * capture of the blog page HTML. Refresh with:
 *
 *   curl -s -H "User-Agent: linkedin-rss-bridge (+https://val.town)" \
 *     -H "Accept: text/html,application/xhtml+xml" \
 *     "https://www.linkedin.com/blog/engineering" \
 *     > test/linkedin-engineering.html
 *
 * Run: node --test test/linkedin-engineering-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  clean,
  extractCategory,
  extractPosts,
  normalizeUrl,
  parseDate,
  type Post,
  renderRss,
} from "../linkedin-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const html = await readFile(
  new URL("./linkedin-engineering.html", import.meta.url),
  "utf8",
);
const posts = extractPosts(html);
const byUrl = (url: string) => posts.find((p) => p.url === url);

test("extracts all posts from the fixture", () => {
  assertEquals(posts.length, 15, "unique post count");
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

test("reads a known post's fields accurately", () => {
  const p = byUrl(
    "https://www.linkedin.com/blog/engineering/infrastructure/scaling-spark-and-flink-shuffle-at-linkedin-with-apache-celeborn",
  )!;
  assert(p, "post exists");
  assertEquals(
    p.title,
    "Scaling Spark and Flink Shuffle at LinkedIn with Apache Celeborn",
    "title",
  );
  assertEquals(p.author, "Aravind Patnam", "author");
  assertEquals(p.ts, Date.parse("Oct 14, 2026"), "date");
  assertEquals(p.categories, ["Engineering", "Infrastructure"], "categories");
});

test("handles authorless posts with default byline", () => {
  const p = byUrl(
    "https://www.linkedin.com/blog/engineering/culture/career-stories--the-math-music-connection-in-data-science",
  )!;
  assert(p, "post exists");
  assertEquals(p.author, "LinkedIn Engineering", "default author");
});

test("extractCategory parses topics from URLs correctly", () => {
  assertEquals(
    extractCategory(
      "https://www.linkedin.com/blog/engineering/infrastructure/post-slug",
    ),
    "Infrastructure",
  );
  assertEquals(
    extractCategory("https://www.linkedin.com/blog/engineering/ai/post-slug"),
    "AI",
  );
  assertEquals(
    extractCategory(
      "https://www.linkedin.com/blog/engineering/data-science/post-slug",
    ),
    "Data Science",
  );
  assertEquals(extractCategory("https://www.linkedin.com/other"), "");
});

test("normalizeUrl handles absolute and relative paths", () => {
  assertEquals(
    normalizeUrl("https://www.linkedin.com/blog/engineering/post"),
    "https://www.linkedin.com/blog/engineering/post",
  );
  assertEquals(
    normalizeUrl("/blog/engineering/post"),
    "https://www.linkedin.com/blog/engineering/post",
  );
});

test("parseDate handles English dates and ISO strings", () => {
  assertEquals(parseDate("Oct 14, 2026"), Date.parse("Oct 14, 2026"));
  assertEquals(parseDate("2026-10-14"), Date.UTC(2026, 9, 14, 0, 0, 0));
  assertEquals(parseDate("not a date"), null);
  assertEquals(parseDate(""), null);
});

test("orders items newest first in buildFeed", () => {
  const feed = buildFeed(posts, new URL("https://feed.val.run/linkedin"));
  assertEquals(feed.status, 200);
  assertEquals(
    feed.headers.get("content-type"),
    "application/rss+xml; charset=utf-8",
  );
  assertEquals(feed.headers.get("cache-control"), "public, max-age=43200");
});

test("renderRss produces valid RSS 2.0 with permalinks", () => {
  const sample: Post[] = [
    {
      url: "https://www.linkedin.com/blog/engineering/infrastructure/sample",
      title: "Sample Post",
      description: "Sample description",
      ts: Date.UTC(2026, 9, 14),
      author: "Jane Doe",
      categories: ["Engineering", "Infrastructure"],
    },
  ];

  const xml = renderRss({
    title: "LinkedIn Engineering Blog",
    description: "Technical insights from LinkedIn.",
    siteLink: "https://www.linkedin.com/blog/engineering",
    feedUrl: "https://feed.val.run/linkedin",
    items: sample,
  });

  assert(xml.includes("<title><![CDATA[Sample Post]]></title>"), "item title");
  assert(
    xml.includes(
      "<link>https://www.linkedin.com/blog/engineering/infrastructure/sample</link>",
    ),
    "item link",
  );
  assert(
    xml.includes(
      '<guid isPermaLink="true">https://www.linkedin.com/blog/engineering/infrastructure/sample</guid>',
    ),
    "permalink guid",
  );
  assert(xml.includes("<author>Jane Doe</author>"), "author");
  assert(xml.includes("<category>Infrastructure</category>"), "category");
});

test("clean strips control characters that break XML 1.0", () => {
  const input = "Title with \x00 null and \x0B vertical tab";
  assertEquals(clean(input), "Title with  null and  vertical tab");
});

test("throws error if grid posts are missing", () => {
  let threw = false;
  try {
    extractPosts("<html><body>No posts here</body></html>");
  } catch {
    threw = true;
  }
  assert(threw, "should throw on missing grid posts");
});
