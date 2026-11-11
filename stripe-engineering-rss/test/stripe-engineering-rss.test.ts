/**
 * Offline tests for the Stripe Engineering feed. The fixture is a
 * capture of the topic page HTML. Refresh with:
 *
 *   curl -s -H "User-Agent: stripe-rss-bridge (+https://val.town)" \
 *     -H "Accept: text/html,application/xhtml+xml" \
 *     "https://stripe.dev/blog/topic/engineering" \
 *     > test/stripe-engineering.html
 *
 * Run: node --test test/stripe-engineering-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  clean,
  extractPosts,
  parseDate,
  type Post,
  postUrl,
  renderRss,
} from "../stripe-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const html = await readFile(
  new URL("./stripe-engineering.html", import.meta.url), "utf8",
);
const posts = extractPosts(html);
const bySlug = (slug: string) => posts.find((p) => p.slug === slug);

test("extracts only Engineering-tagged posts from the fixture", () => {
  assertEquals(posts.length, 26, "post count");
  assert(
    posts.every((p) => p.categories.includes("Engineering")),
    "every post is tagged Engineering",
  );
  assert(
    !bySlug("run-recurring-jobs-on-stripe-workflows"),
    "untagged posts are dropped",
  );
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

test("reads a known post's fields accurately", () => {
  const p = bySlug("modern-java-at-stripe-language-upgrades-as-a-service")!;
  assert(p, "post exists");
  assertEquals(
    p.title,
    "Modern Java at Stripe: Language upgrades as a service",
    "title",
  );
  assert(
    p.description.startsWith(
      "We all know the stereotypes of working at enterprise tech companies",
    ),
    "summary",
  );
  assertEquals(p.author, "Mahib Hosain, Cara Mecozzi", "author");
  assertEquals(p.ts, Date.UTC(2026, 4, 27), "date");
  assertEquals(p.categories, ["Engineering"], "categories");
  assertEquals(
    postUrl(p.slug),
    "https://stripe.dev/blog/modern-java-at-stripe-language-upgrades-as-a-service",
    "post URL",
  );
});

test("parseDate handles ISO, naive, date-only, and invalid strings", () => {
  assertEquals(
    parseDate("2026-10-13"),
    Date.UTC(2026, 9, 13, 0, 0, 0),
  );
  assertEquals(
    parseDate("2026-05-25T14:30:00.000Z"),
    Date.parse("2026-05-25T14:30:00.000Z"),
  );
  assertEquals(parseDate("not a date"), null);
  assertEquals(parseDate(""), null);
  assertEquals(parseDate(null), null);
});

test("postUrl prepends SITE domain appropriately", () => {
  assertEquals(
    postUrl("test-slug"),
    "https://stripe.dev/blog/test-slug",
  );
  assertEquals(
    postUrl("/test-slug"),
    "https://stripe.dev/blog/test-slug",
  );
  assertEquals(
    postUrl("https://other.com/post"),
    "https://other.com/post",
  );
});

test("orders items newest first in buildFeed", () => {
  const feed = buildFeed(posts, new URL("https://feed.val.run/stripe"));
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
      slug: "test-slug",
      title: "Test Slug",
      description: "Test description",
      ts: Date.UTC(2026, 9, 13),
      author: "Jane Doe",
      categories: ["Engineering"],
    },
  ];

  const xml = renderRss({
    title: "Stripe Engineering Blog",
    description: "Technical insights from Stripe.",
    siteLink: "https://stripe.dev/blog/topic/engineering",
    feedUrl: "https://feed.val.run/stripe",
    items: sample,
  });

  assert(xml.includes("<title><![CDATA[Test Slug]]></title>"), "item title");
  assert(
    xml.includes("<link>https://stripe.dev/blog/test-slug</link>"),
    "item link",
  );
  assert(
    xml.includes(
      '<guid isPermaLink="true">https://stripe.dev/blog/test-slug</guid>',
    ),
    "permalink guid",
  );
  assert(xml.includes("<author>Jane Doe</author>"), "author");
  assert(xml.includes("<category>Engineering</category>"), "category");
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
