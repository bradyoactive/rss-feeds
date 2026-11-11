/**
 * Offline tests for the Anthropic Engineering feed. The fixture is a
 * capture of the engineering page HTML. Refresh with:
 *
 *   curl -s -H "User-Agent: anthropic-rss-bridge (+https://val.town)" \
 *     -H "Accept: text/html,application/xhtml+xml" \
 *     "https://www.anthropic.com/engineering" \
 *     > test/anthropic-engineering.html
 *
 * Run: node --test test/anthropic-engineering-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  clean,
  extractPayload,
  extractPosts,
  parseDate,
  type Post,
  postUrl,
  renderRss,
} from "../anthropic-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const html = await readFile(
  new URL("./anthropic-engineering.html", import.meta.url),
  "utf8",
);
const posts = extractPosts(html);
const bySlug = (slug: string) => posts.find((p) => p.slug === slug);

test("extracts all posts from the fixture", () => {
  assertEquals(posts.length, 24, "post count");
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

test("extractPayload recovers dates and summaries from the RSC stream", () => {
  const payload = extractPayload(html);
  assertEquals(
    payload.get("redesigning-source-control")?.date,
    "2026-10-13",
    "date from RSC stream",
  );
  assertEquals(
    payload.get("components-of-agent-memory")?.summary,
    "For Claude to learn from experience, it has to decide what’s worth remembering before it knows what’s next. Here’s how “dreaming” helps it organize memory and correct mistakes.",
    "summary unescaped from RSC stream",
  );
});

test("reads a known post's fields accurately", () => {
  const p = bySlug("redesigning-source-control")!;
  assert(p, "post exists");
  assertEquals(p.title, "Redesigning source control at Anthropic", "title");
  assertEquals(
    p.description,
    "As our merges per day grew more than tenfold, source control became our biggest development bottleneck. Here, we share how we migrated to an in-house version control system in five months.",
    "summary",
  );
  assertEquals(p.author, "Anthropic Engineering", "author");
  assertEquals(p.ts, Date.UTC(2026, 9, 13), "date");
  assertEquals(p.categories, ["Engineering", "AI"], "categories");
  assertEquals(
    postUrl(p.slug),
    "https://www.anthropic.com/research/redesigning-source-control",
    "post URL",
  );
});

test("takes the image media type from the CDN's fm param", () => {
  const p = bySlug("redesigning-source-control")!;
  assert(p.image.startsWith("https://assets.claude.com/"), "card image");
  assert(!p.image.includes("&amp;"), "entities in src decoded");
  assertEquals(p.imageType, "image/webp", "fm=webp wins over .jpg");
});

test("decodes html entities in titles", () => {
  const [p] = extractPosts(
    '<article><time>Mar 20, 2025</time><h3><a href="/research/claude-think-tool">The &quot;think&quot; tool</a></h3></article>',
  );
  assertEquals(p.title, 'The "think" tool', "quotes decoded");
  assertEquals(p.ts, Date.UTC(2025, 2, 20), "printed date read as UTC");
});

test("parseDate handles ISO, naive, date-only, and invalid strings", () => {
  assertEquals(parseDate("2026-10-13"), Date.UTC(2026, 9, 13, 0, 0, 0));
  assertEquals(
    parseDate("2026-05-25T14:30:00.000Z"),
    Date.parse("2026-05-25T14:30:00.000Z"),
  );
  assertEquals(parseDate("Oct 13, 2026"), Date.UTC(2026, 9, 13));
  assertEquals(parseDate("not a date"), null);
  assertEquals(parseDate(""), null);
  assertEquals(parseDate(null), null);
});

test("postUrl prepends SITE domain appropriately", () => {
  assertEquals(
    postUrl("test-slug"),
    "https://www.anthropic.com/research/test-slug",
  );
  assertEquals(
    postUrl("/test-slug"),
    "https://www.anthropic.com/research/test-slug",
  );
  assertEquals(postUrl("https://other.com/post"), "https://other.com/post");
});

test("orders items newest first in buildFeed", () => {
  const feed = buildFeed(posts, new URL("https://feed.val.run/anthropic"));
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
      slug: "test-slug",
      title: "Test Slug",
      description: "Test description",
      ts: Date.UTC(2026, 9, 13),
      author: "Anthropic Engineering",
      image: "https://www-cdn.anthropic.com/images/4zrzovbb/website/photo.svg",
      imageType: "image/svg+xml",
      categories: ["Engineering", "AI"],
    },
  ];

  const xml = renderRss({
    title: "Anthropic Engineering Blog",
    description: "Technical insights from Anthropic.",
    siteLink: "https://www.anthropic.com/engineering",
    feedUrl: "https://feed.val.run/anthropic",
    items: sample,
  });

  assert(xml.includes("<title><![CDATA[Test Slug]]></title>"), "item title");
  assert(
    xml.includes("<link>https://www.anthropic.com/research/test-slug</link>"),
    "item link",
  );
  assert(
    xml.includes(
      '<guid isPermaLink="true">https://www.anthropic.com/research/test-slug</guid>',
    ),
    "permalink guid",
  );
  assert(xml.includes("<author>Anthropic Engineering</author>"), "author");
  assert(xml.includes("<category>Engineering</category>"), "category");
  assert(xml.includes('type="image/svg+xml"'), "enclosure states media type");
});

test("clean strips control characters that break XML 1.0", () => {
  const input = "Title with \x00 null and \x0B vertical tab";
  assertEquals(clean(input), "Title with  null and  vertical tab");
});

test("throws error if article cards are missing", () => {
  let threw = false;
  try {
    extractPosts("<html><body>No articles here</body></html>");
  } catch {
    threw = true;
  }
  assert(threw, "should throw on missing articles");
});
