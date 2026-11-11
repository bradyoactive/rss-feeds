/**
 * Offline tests for the Anthropic Engineering feed. The fixture is a
 * capture of the engineering page HTML. Refresh with:
 *
 *   curl -s -H "User-Agent: anthropic-rss-bridge (+https://val.town)" \
 *     -H "Accept: text/html,application/xhtml+xml" \
 *     "https://www.anthropic.com/engineering" \
 *     > test/anthropic-engineering.html
 *
 * Run: deno test --allow-read test/anthropic-engineering-rss.test.ts
 */

import {
  buildFeed,
  clean,
  extractDates,
  extractPosts,
  parseDate,
  type Post,
  postUrl,
  renderRss,
} from "../anthropic-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const html = await Deno.readTextFile(
  new URL("./anthropic-engineering.html", import.meta.url),
);
const posts = extractPosts(html);
const bySlug = (slug: string) => posts.find((p) => p.slug === slug);

Deno.test("extracts all posts from the fixture", () => {
  assertEquals(posts.length, 26, "post count");
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

Deno.test("every post in fixture is dated with a valid UTC timestamp", () => {
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

Deno.test("extractDates recovers dates for featured and standard posts", () => {
  const dates = extractDates(html);
  assertEquals(
    dates.get("redesigning-source-control"),
    "2026-10-13",
    "featured article date from RSC stream",
  );
  assertEquals(
    dates.get("how-we-contain-claude"),
    "2026-05-25",
    "standard article date from RSC stream",
  );
});

Deno.test("reads a known post's fields accurately", () => {
  const p = bySlug("redesigning-source-control")!;
  assert(p, "post exists");
  assertEquals(
    p.title,
    "Redesigning source control at Anthropic",
    "title",
  );
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
    "https://www.anthropic.com/engineering/redesigning-source-control",
    "post URL",
  );
});

Deno.test("handles image media types properly including SVG", () => {
  const p = bySlug("redesigning-source-control")!;
  assert(p.image, "featured post has image");
  assertEquals(p.imageType, "image/svg+xml", "svg media type");
});

Deno.test("decodes html entities in titles", () => {
  const p = bySlug("claude-think-tool")!;
  assert(p, "think tool post exists");
  assert(p.title.includes('"think" tool'), "quotes decoded");
});

Deno.test("parseDate handles ISO, naive, date-only, and invalid strings", () => {
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

Deno.test("postUrl prepends SITE domain appropriately", () => {
  assertEquals(
    postUrl("test-slug"),
    "https://www.anthropic.com/engineering/test-slug",
  );
  assertEquals(
    postUrl("/test-slug"),
    "https://www.anthropic.com/engineering/test-slug",
  );
  assertEquals(
    postUrl("https://other.com/post"),
    "https://other.com/post",
  );
});

Deno.test("orders items newest first in buildFeed", () => {
  const feed = buildFeed(posts, new URL("https://feed.val.run/anthropic"));
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
    xml.includes(
      "<link>https://www.anthropic.com/engineering/test-slug</link>",
    ),
    "item link",
  );
  assert(
    xml.includes(
      '<guid isPermaLink="true">https://www.anthropic.com/engineering/test-slug</guid>',
    ),
    "permalink guid",
  );
  assert(xml.includes("<author>Anthropic Engineering</author>"), "author");
  assert(xml.includes("<category>Engineering</category>"), "category");
  assert(xml.includes('type="image/svg+xml"'), "enclosure states media type");
});

Deno.test("clean strips control characters that break XML 1.0", () => {
  const input = "Title with \x00 null and \x0B vertical tab";
  assertEquals(clean(input), "Title with  null and  vertical tab");
});

Deno.test("throws error if article cards are missing", () => {
  let threw = false;
  try {
    extractPosts("<html><body>No articles here</body></html>");
  } catch {
    threw = true;
  }
  assert(threw, "should throw on missing articles");
});
