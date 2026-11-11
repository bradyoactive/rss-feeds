/**
 * Offline tests for the Modal Engineering feed. The fixture is Modal's
 * SvelteKit data response, captured verbatim except for the two trivial layout
 * nodes. It is large (~950 KB) because the encoding's string table *is* the
 * payload — trimming the post list would mean re-indexing every reference, and
 * the decoder is exactly what wants testing against the real graph. Refresh:
 *
 *   curl -s https://modal.com/blog/__data.json -o modal-blog-data.json
 *
 * Run: node --test test/modal-engineering-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  devalue,
  extractPosts,
  type Post,
  renderRss,
} from "../modal-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const raw = JSON.parse(
  await readFile(new URL("./modal-blog-data.json", import.meta.url), "utf8"),
);
const posts = extractPosts(raw);
const post = (slug: string) => posts.find((p) => p.slug === slug)!;

const FEED_URL = "https://feed.val.run/modal";
const feed = (query = "") =>
  buildFeed(posts, new URL(`${FEED_URL}${query}`)).text();

test("reads the Engineering posts and only those", () => {
  assertEquals(posts.length, 30, "Engineering posts");
  assert(posts.every((p) => p.category === "Engineering"), "one category");
  assert(posts.every((p) => p.slug && p.title), "every post has a slug/title");
  assertEquals(
    new Set(posts.map((p) => p.slug)).size,
    posts.length,
    "slugs are unique",
  );
  assert(posts.every((p) => p.ts !== null), "every post is dated");
  assert(posts.every((p) => p.description), "every post has a description");
  assert(posts.every((p) => p.image), "every post has an image");
});

test("filters a listing that holds every category", () => {
  // The category filter runs in the browser, so the payload is the whole blog
  // and the val has to do the narrowing itself.
  const all = (devalue(
    (raw.nodes as any[]).find((n) => n?.data?.length > 100).data,
  ) as any).posts;
  assertEquals(all.length, 130, "posts in the payload");
  const categories = new Set(all.map((p: { category: string }) => p.category));
  assert(
    categories.size > 1,
    `the payload spans ${categories.size} categories`,
  );
  assert(categories.has("News"), "including ones the feed must exclude");
});

test("reads every field of a known post", () => {
  const p = post("bringing-serverless-functions-closer-to-the-speed-of-wire");
  assertEquals(
    p.title,
    "Bringing serverless functions closer to the speed of wire",
    "title",
  );
  assertEquals(p.ts, Date.parse("2026-08-04"), "ts");
  assertEquals(p.minutes, 6, "read length");
  assertEquals(p.imageType, "image/webp", "media type from the extension");
  assert(p.image.startsWith("https://modal-cdn.com/"), "image");
  assert(p.description.startsWith("Modal’s Function Call data path"), "desc");
});

test("reads both date shapes the listing stores", () => {
  // Some records carry a bare "2026-08-04" and others a Z-suffixed instant.
  // Date.parse reads both as UTC; a naive datetime would have been read as
  // local time and shifted by however many hours the val happened to run at.
  const shapes = new Set(posts.map((p) => new Date(p.ts!).toISOString()));
  assert(shapes.size > 1, "several distinct instants");
  assertEquals(
    new Date(
      post("bringing-serverless-functions-closer-to-the-speed-of-wire").ts!,
    )
      .toISOString(),
    "2026-08-04T00:00:00.000Z",
    "a date-only value lands at UTC midnight",
  );
});

test("decodes SvelteKit's devalue encoding", () => {
  // Index 0 is the root and every integer elsewhere is an index into the same
  // array; unlike the turbo-stream the Shopify val reads, object keys here are
  // literal and only values are indices.
  assertEquals(
    devalue([{ a: 1, b: 2 }, "first", "second"]),
    { a: "first", b: "second" },
    "object values resolved through the table",
  );
  assertEquals(
    devalue([[1, 2], "x", "y"]),
    ["x", "y"],
    "arrays resolved the same way",
  );
});

test("resolves a shared index to one object rather than a copy", () => {
  // The payload references the same string and subtree from many places; the
  // decoder memoises, which is what keeps it linear on a few thousand entries.
  const out = devalue([{ left: 1, right: 1 }, { n: 2 }, 42]) as any;
  assertEquals(out.left, { n: 42 }, "decoded once");
  assert(out.left === out.right, "and both references point at it");
});

test("maps devalue's negative constants", () => {
  // -1 is undefined and -3 NaN; treating either as an index would read the
  // wrong end of the array.
  const out = devalue([
    { nothing: -1, notANumber: -3, real: 1 },
    "here",
  ]) as any;
  assertEquals(out.nothing, undefined, "-1");
  assert(Number.isNaN(out.notANumber), "-3");
  assertEquals(out.real, "here", "and ordinary indices still work");
});

test("finds the posts by shape, not by node position", () => {
  // Which node holds the /blog loader data depends on the layout tree, so the
  // val looks for the node with a `posts` array instead of indexing in.
  const moved = {
    nodes: [
      null,
      { type: "data", data: [{}] },
      {
        type: "data",
        data: [
          { posts: 1 },
          [2],
          {
            slug: 3,
            title: 4,
            category: 5,
            date: 6,
            description: 7,
            image: 8,
            published: 9,
          },
          "s",
          "T",
          "Engineering",
          "2026-01-01",
          "d",
          "https://x/a.webp",
          true,
        ],
      },
    ],
  };
  assertEquals(extractPosts(moved).map((p) => p.slug), ["s"]);
});

test("leaves an unpublished post out", () => {
  const record = (published: boolean) => ({
    nodes: [{
      type: "data",
      data: [
        { posts: 1 },
        [2],
        {
          slug: 3,
          title: 4,
          category: 5,
          date: 6,
          published: 7,
        },
        "s",
        "T",
        "Engineering",
        "2026-01-01",
        published,
      ],
    }],
  });
  assertEquals(extractPosts(record(true)).length, 1, "published");
  assertEquals(extractPosts(record(false)).length, 0, "unpublished");
});

test("resolves a site-relative image against modal.com", async () => {
  const payload = {
    nodes: [{
      type: "data",
      data: [
        { posts: 1 },
        [2],
        { slug: 3, title: 4, category: 5, date: 6, image: 7 },
        "s",
        "T",
        "Engineering",
        "2026-01-01",
        "/assets/blog/nvidia-vera.webp",
      ],
    }],
  };
  const posts = extractPosts(payload);
  assertEquals(
    posts[0].image,
    "https://modal.com/assets/blog/nvidia-vera.webp",
    "absolute image URL",
  );
  // A relative URL used to make the feed library throw and the feed 500.
  const res = buildFeed(posts, new URL("https://feed.val.run/modal"));
  assertEquals(res.status, 200, "feed renders");
  assert((await res.text()).includes("nvidia-vera.webp"), "enclosure kept");
});

test("survives input that is not the payload we asked for", () => {
  assertEquals(extractPosts(null).length, 0, "null");
  assertEquals(extractPosts({}).length, 0, "no nodes");
  assertEquals(extractPosts({ nodes: [] }).length, 0, "empty");
  assertEquals(extractPosts({ nodes: [{ data: [] }] }).length, 0, "empty node");
  assertEquals(devalue([]), null, "an empty table decodes to null");
});

test("serves the category", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 30, "every post");
  assert(body.includes("<title>Modal — Engineering</title>"), "channel title");
  assert(
    body.includes("<link>https://modal.com/blog?category=Engineering</link>"),
    "channel link is the page this mirrors",
  );
  assert(
    body.includes(
      '<guid isPermaLink="true">https://modal.com/blog/bringing-serverless-functions-closer-to-the-speed-of-wire</guid>',
    ),
    "item guid is the post URL",
  );
  assert(body.includes("<category>Engineering</category>"), "category");
  assertEquals(
    (body.match(/<enclosure/g) ?? []).length,
    30,
    "every item carries its image",
  );
});

test("carries the read length in the body", async () => {
  const body = await feed();
  assert(body.includes("· 6 min read]]>"), "appended after the description");
});

test("credits no author, because the listing names none", async () => {
  const body = await feed();
  assert(!body.includes("<author>"), "no invented byline");
});

test("orders items newest first", async () => {
  const dates = [...(await feed()).matchAll(/<pubDate>([^<]+)</g)].map((m) =>
    Date.parse(m[1])
  );
  assertEquals(dates, [...dates].sort((a, b) => b - a), "descending by date");
});

test("self-link is canonical, ignoring junk query params", async () => {
  const body = await feed("?category=News&limit=5");
  assert(body.includes(`href="${FEED_URL}" rel="self"`), "bare self-link");
  assertEquals((body.match(/<item>/g) ?? []).length, 30, "params ignored");
});

const SITE_LINK = "https://modal.com/blog?category=Engineering";
const SAMPLE: Post = {
  slug: "s",
  title: "Tom & Jerry <live>",
  description: 'He said "hi"',
  ts: Date.parse("2026-08-04"),
  image: "https://modal-cdn.com/blog/images/a.webp",
  imageType: "image/webp",
  category: "Engineering",
  minutes: 6,
};

test("renders XML-safe output", () => {
  const bell = String.fromCharCode(7);
  const out = renderRss({
    title: "Feed & <friends>",
    description: 'Quote " and control',
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [SAMPLE],
  });

  // The library wraps item text in CDATA rather than escaping entities, so the
  // characters that used to need escaping now appear verbatim — what matters is
  // that they cannot terminate the section early.
  assert(
    out.includes("<![CDATA[Tom & Jerry <live>]]>"),
    "item title survives verbatim inside CDATA",
  );
  assert(!out.includes("]]]]"), "no stray CDATA breakout in ordinary text");
  assert(out.includes('type="image/webp"'), "enclosure states the media type");

  // Control characters are illegal in XML 1.0 and the library does not strip
  // them, so the val must — one anywhere breaks the whole document.
  const dirty = renderRss({
    title: "T",
    description: "d",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE, title: `Bell${bell}here` }],
  });
  assert(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(dirty), "control chars stripped");
  assert(dirty.includes("Bellhere"), "and the rest of the title is kept");
});

test("a CDATA breakout in the source cannot escape the section", () => {
  const out = renderRss({
    title: "T",
    description: "d",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE, title: "before ]]> after" }],
  });
  assert(out.includes("]]]]><![CDATA[>"), "breakout split");
  assert(!/\]\]>\s*after/.test(out), "no early termination");
});

test("omits optional elements when the post lacks them", () => {
  const bare: Post = {
    slug: "bare",
    title: "Bare",
    description: "",
    ts: null,
    image: "",
    imageType: "",
    category: "",
    minutes: null,
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
