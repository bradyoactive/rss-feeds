/**
 * Offline tests for the r/movies top-of-the-week feed.
 *
 * The fixture is NOT a capture. Reddit refused every request from the sandbox
 * this was written in, so `reddit-movies-top-week.json` is a hand-built
 * Listing in Reddit's documented shape, with one of each case the parser has
 * to handle: a stickied megathread, a self post, a link post with and without
 * a preview, a spoiler, an NSFW post, a control character, a comment (`t1`)
 * mixed in, a duplicate, and more than 25 posts. Replace it with a real one
 * when you can reach Reddit:
 *
 *   curl -s -A 'web:rss-feeds:v1.0' \
 *     'https://www.reddit.com/r/movies/top.json?t=week&limit=25&raw_json=1' \
 *     -o test/reddit-movies-top-week.json
 *
 * Run: node --test test/reddit-movies-top-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";
import { buildFeed, extractPosts } from "../reddit-movies-top-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const fixture = JSON.parse(
  await readFile(
    new URL("./reddit-movies-top-week.json", import.meta.url),
    "utf8",
  ),
);
const posts = extractPosts(fixture);
const post = (id: string) => posts.find((p) => p.id === id)!;

const FEED_URL = "https://feeds.example/reddit-movies-top-rss";

test("keeps the top 25 posts in ranking order", () => {
  assertEquals(posts.length, 25, "post count");
  assertEquals(posts[0].id, "abc001", "first after the sticky");
  assertEquals(posts[24].id, "abc00p", "25th (ids are base 36)");
  assertEquals(new Set(posts.map((p) => p.id)).size, 25, "unique");
});

test("drops stickies and non-posts", () => {
  assert(!post("abc000"), "the stickied megathread is dropped");
  assert(
    posts.every((p) => p.id !== "cmt1"),
    "a t1 comment is not a post",
  );
});

test("reads link and self posts", () => {
  const link = post("abc001");
  assertEquals(
    link.permalink,
    "https://www.reddit.com/r/movies/comments/abc001/weekly_post_number_1/",
    "permalink",
  );
  assertEquals(link.url, "https://variety.com/2026/film/news/story-1/", "url");
  assertEquals(link.author, "user_1", "author");
  assertEquals(link.flair, "News", "flair");
  assertEquals(link.createdAt, (1763100000 + 3600) * 1000, "createdAt");
  assert(link.image.startsWith("https://external-preview.redd.it/"), "image");
  assertEquals(link.imageType, "image/jpeg", "type from path, not query");

  const self = post("abc002");
  assert(self.isSelf, "is self");
  assertEquals(self.url, "", "self posts have no outbound url");
  assertEquals(self.image, "", "'self' thumbnail is a placeholder");
  assert(self.selftextHtml.includes("<em>this</em>"), "self-text HTML kept");

  assertEquals(
    post("abc003").image,
    "https://b.thumbs.redditmedia.com/yt.jpg",
    "falls back to the thumbnail without a preview",
  );
});

test("spoiler and NSFW posts get no image", () => {
  assertEquals(post("abc004").image, "", "spoiler");
  assertEquals(post("abc005").image, "", "nsfw");
});

test("renders valid RSS", async () => {
  const res = buildFeed(posts, new URL(FEED_URL));
  assertEquals(
    res.headers.get("content-type"),
    "application/rss+xml; charset=utf-8",
    "content-type",
  );
  const xml = await res.text();
  assert(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(xml), "no control characters");

  const doc = new XMLParser({ ignoreAttributes: false }).parse(xml);
  const items = doc.rss.channel.item;
  assertEquals(items.length, 25, "items");
  assertEquals(items[0].title, "Weekly post number 1", "first title");
  assertEquals(
    items[0].link,
    "https://www.reddit.com/r/movies/comments/abc001/weekly_post_number_1/",
    "item link",
  );
  assert(
    items[0].description.includes('href="https://variety.com/'),
    "link posts point at their target",
  );
  assert(items[0].description.includes("Link: variety.com"), "named by host");
  assertEquals(items[0].category, "News", "flair as category");

  const spoiler = items.find((i: any) => i.link.includes("abc004"));
  assertEquals(spoiler.title, "[Spoiler] Weekly post number 4", "marked");
  assert(!spoiler.description.includes("twist"), "spoiler text withheld");

  const self = items.find((i: any) => i.link.includes("abc002"));
  assert(!self.description.includes("Link:"), "no outbound link on self post");
  assert(self.description.includes("<em>this</em>"), "self-text rendered");

  assertEquals(
    items.find((i: any) => i.link.includes("abc006")).title,
    "Bell character & <tags>",
    "control character stripped, markup escaped",
  );
});

test("an empty or malformed payload yields no posts", () => {
  assertEquals(extractPosts(null).length, 0, "null");
  assertEquals(extractPosts({ data: {} }).length, 0, "no children");
  assertEquals(extractPosts({ data: { children: "x" } }).length, 0, "junk");
});
