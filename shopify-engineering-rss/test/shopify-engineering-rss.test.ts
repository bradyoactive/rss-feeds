/**
 * Offline tests for the Shopify Engineering feed. The fixture is a verbatim
 * capture of React Router's single-fetch payload for /latest. Refresh with:
 *
 *   curl -s https://shopify.engineering/latest.data -o shopify-latest.data.json
 *
 * Run: deno test --allow-read test/shopify-engineering-rss.test.ts
 */

import {
  buildFeed,
  decode,
  extractPosts,
  type Post,
  renderRss,
} from "../shopify-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const raw = JSON.parse(
  await Deno.readTextFile(
    new URL("./shopify-latest.data.json", import.meta.url),
  ),
);
const posts = extractPosts(raw);
const post = (handle: string) => posts.find((p) => p.handle === handle)!;

Deno.test("reads every article on the page", () => {
  assertEquals(posts.length, 20, "articles");
  assert(
    posts.every((p) => p.handle && p.title),
    "every post has a handle/title",
  );
  assertEquals(
    new Set(posts.map((p) => p.handle)).size,
    posts.length,
    "handles are unique",
  );
  assert(posts.every((p) => p.ts !== null), "every post is dated");
  assert(posts.every((p) => p.excerpt), "every post has an excerpt");
  assert(posts.every((p) => p.image), "every post has an image");
});

Deno.test("reads every field of a known item", () => {
  const p = post("mobile-e2e-testing");
  assertEquals(
    p.title,
    "How we raised mobile end-to-end test stability to 98%",
    "title",
  );
  assertEquals(p.ts, Date.parse("2026-08-12T20:02:35Z"), "ts");
  assertEquals(p.topics, ["Mobile"], "topics");
  assertEquals(p.imageType, "image/png", "media type derived from the URL");
  assert(
    p.image.startsWith("https://cdn.shopify.com/s/files/1/0779/4361/articles/"),
    "the article image, not the share image",
  );
  assert(
    p.excerpt.startsWith("We rebuilt our mobile end-to-end testing framework"),
    "excerpt",
  );
});

Deno.test("credits the authors metafield ahead of authorV2", () => {
  // This post's authorV2 is the house name; only the metafield names a person.
  assertEquals(post("mobile-e2e-testing").author, "Michael Garfinkle");
  // And the metafield is the only source that can hold more than one name.
  assertEquals(
    post("under-the-river").author,
    "Burke Libbey & Javier Moreno & River",
    "three authors, joined the way a byline reads",
  );
});

Deno.test("falls back to authorV2, then to the house name", () => {
  // No authors metafield on this one, but authorV2 names the writer.
  assertEquals(post("autoresearch").author, "David Cortés");
  // Neither source names anyone here, so the blog itself is the byline.
  assertEquals(post("tangle").author, "Shopify Engineering");
});

Deno.test("keeps Shopify's topics and drops its internal tags", () => {
  // The payload mixes displayed topics with workflow markers and with
  // author: slugs that duplicate the byline.
  assertEquals(
    post("quick").topics,
    ["Culture"],
    "author:alex-pilon, author:daniel-beauchamp and validated all dropped",
  );
  assertEquals(
    post("ucp").topics,
    ["AI & Machine Learning"],
    "short-cache dropped",
  );

  const emitted = new Set(posts.flatMap((p) => p.topics));
  assert(
    ![...emitted].some((t) => /^[a-z0-9:_-]+$/.test(t)),
    `a lowercase slug reached the topics: ${[...emitted].join(", ")}`,
  );
  assertEquals(
    [...emitted].sort(),
    [
      "AI & Machine Learning",
      "Apps",
      "Behind the Scenes",
      "Culture",
      "Development",
      "Infrastructure",
      "Mobile",
      "Security",
    ],
    "exactly the topics with a /topics/ page behind them",
  );
});

Deno.test("names jpg by its media type rather than its extension", () => {
  assertEquals(post("quick").imageType, "image/jpeg", "not image/jpg");
});

Deno.test("finds the articles without reaching through the route id", () => {
  // The route id is derived from a file path and is the likeliest thing to
  // drift, so extraction keys off __typename instead.
  const article = {
    __typename: "Article",
    handle: "moved",
    title: "Moved",
    publishedAt: "2026-01-01T00:00:00Z",
    excerpt: "e",
    tags: ["Infrastructure"],
    image: { url: "https://cdn.shopify.com/x.png" },
    authorV2: { name: "Ada" },
  };
  const relocated = [
    { "_1": 2 },
    "some-other-route",
    { "_3": 4 },
    "data",
    {
      "_5": 6,
    },
    "articles",
    [7],
    article,
  ];

  const [p] = extractPosts(relocated);
  assertEquals(p.handle, "moved", "found under an unfamiliar route id");
  assertEquals(p.author, "Ada");
});

Deno.test("decodes the turbo-stream encoding", () => {
  // deno-lint-ignore no-explicit-any
  const root = decode(raw) as any;
  assertEquals(Object.keys(root), ["root", "latest"], "route ids");

  // Keys are interned: "_12" means "the string at index 12".
  assertEquals(
    root.latest.data.articles.length,
    20,
    "objects rebuilt through their interned keys",
  );
  // -5 is null. This article's seo.title is one.
  assertEquals(
    root.latest.data.articles[0].seo.title,
    null,
    "-5 decodes to null",
  );
  // A two-element array led by a string is a tagged scalar, not two indices.
  assertEquals(
    root.latest.data.canonicalUrl,
    "https://shopify.engineering/latest",
    '["U", …] decodes to the URL it wraps',
  );
});

Deno.test("tells an interned key from a literal underscore key", () => {
  // "_12" means "the string at index 12", but `__typename` is a literal key —
  // and it is the one the article search keys off, so reading it as an index
  // would quietly hide every article.
  // deno-lint-ignore no-explicit-any
  const out = decode([{ "_1": 2 }, "wrapped", {
    __typename: "Article",
  }]) as any;
  assertEquals(out.wrapped, { __typename: "Article" });
});

Deno.test("resolves a shared index to one object rather than a copy", () => {
  // The payload references the same subtree from many places; the decoder
  // memoises, which is what keeps it linear.
  const shared = [{ "_1": 2, "_3": 2 }, "left", { "_4": 5 }, "right", "n", 42];
  // deno-lint-ignore no-explicit-any
  const out = decode(shared) as any;
  assertEquals(out.left, { n: 42 }, "decoded once");
  assert(out.left === out.right, "and both references point at it");
});

Deno.test("survives input that is not the payload we asked for", () => {
  assertEquals(extractPosts([]).length, 0, "empty");
  assertEquals(extractPosts(null).length, 0, "null");
  assertEquals(extractPosts({ articles: [] }).length, 0, "not an array");
  assertEquals(
    extractPosts([{ "_1": 2 }, "x", [{
      __typename: "Article",
      title: "no handle",
    }]])
      .length,
    0,
    "articles without a handle are dropped",
  );
});

const feed = (query = "") =>
  buildFeed(posts, new URL(`https://feed.val.run/shopify${query}`)).text();

Deno.test("serves the latest articles", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 20, "every article");
  assert(
    body.includes("<title>Shopify Engineering</title>"),
    "channel title",
  );
  assert(
    body.includes("<link>https://shopify.engineering/latest</link>"),
    "channel link is the page the feed mirrors",
  );
  assert(
    body.includes(
      '<guid isPermaLink="true">https://shopify.engineering/mobile-e2e-testing',
    ),
    "handles are served from the site root",
  );
  assertEquals(
    (body.match(/<enclosure/g) ?? []).length,
    20,
    "every item carries its image",
  );
});

Deno.test("orders items newest first", async () => {
  const dates = [...(await feed()).matchAll(/<pubDate>([^<]+)</g)].map((m) =>
    Date.parse(m[1])
  );
  assertEquals(dates, [...dates].sort((a, b) => b - a), "descending by date");
});

Deno.test("self-link is canonical, ignoring junk query params", async () => {
  const body = await feed("?limit=5&tag=Mobile&utm_source=x");
  assert(
    body.includes('href="https://feed.val.run/shopify" rel="self"'),
    "bare self-link",
  );
  assertEquals((body.match(/<item>/g) ?? []).length, 20, "params ignored");
});

const SITE_LINK = "https://shopify.engineering/latest";
const FEED_URL = "https://feed.val.run/shopify";
const SAMPLE_ITEM: Post = {
  handle: "s",
  title: "Tom & Jerry <live>",
  excerpt: 'He said "hi"',
  ts: Date.parse("2026-08-12T20:02:35Z"),
  author: "Ada & Grace",
  image: "https://cdn.shopify.com/s/files/1/0779/4361/articles/a.png",
  imageType: "image/png",
  topics: ["Infrastructure"],
};

Deno.test("renders XML-safe output", () => {
  const bell = String.fromCharCode(7);
  const out = renderRss({
    title: "Feed & <friends>",
    description: 'Quote " and control',
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [SAMPLE_ITEM],
  });

  // The library wraps item text in CDATA rather than escaping entities, so the
  // characters that used to need escaping now appear verbatim — what matters is
  // that they cannot terminate the section early.
  assert(
    out.includes("<![CDATA[Tom & Jerry <live>]]>"),
    "item title survives verbatim inside CDATA",
  );
  assert(!out.includes("]]]]"), "no stray CDATA breakout in ordinary text");
  assert(out.includes("<pubDate>"), "RFC-822 pubDate");
  assert(out.includes('type="image/png"'), "enclosure states the media type");

  // Control characters are illegal in XML 1.0 and the library does not strip
  // them, so the val must — one anywhere breaks the whole document.
  const dirty = renderRss({
    title: `T${bell}`,
    description: "d",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE_ITEM, title: `Bell${bell}here` }],
  });
  // deno-lint-ignore no-control-regex
  assert(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(dirty), "control chars stripped");
  assert(dirty.includes("Bellhere"), "and the rest of the title is kept");
});

Deno.test("a CDATA breakout in the source cannot escape the section", () => {
  const out = renderRss({
    title: "T",
    description: "d",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE_ITEM, title: "before ]]> after" }],
  });
  assert(out.includes("]]]]><![CDATA[>"), "breakout split");
  assert(!/\]\]>\s*after/.test(out), "no early termination");
});

Deno.test("omits optional elements when the item lacks them", () => {
  const bare: Post = {
    handle: "bare",
    title: "Bare",
    excerpt: "",
    ts: null,
    author: "",
    image: "",
    imageType: "",
    topics: [],
  };
  const out = renderRss({
    title: "T",
    description: "D",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [bare],
  });

  for (const tag of ["pubDate", "author", "category", "enclosure"]) {
    assert(!out.includes(`<${tag}`), `omits <${tag}> when empty`);
  }
  assertEquals(
    out.match(/<description>/g)?.length,
    1,
    "only the channel description",
  );
});
