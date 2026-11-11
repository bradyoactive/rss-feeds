/**
 * Offline tests for the Robinhood Tech Blog feed. The fixture is a verbatim
 * capture of the Contentful query the val makes. Refresh with:
 *
 *   curl -s -H "Authorization: Bearer <the token in the val>" \
 *     "https://cdn.contentful.com/spaces/1hpl803w8xsv/environments/master/entries?content_type=careersBlogArticle&locale=en-US&order=-fields.publishDate&limit=100&include=2&fields.categories.sys.id%5Bin%5D=3Yoj9Flwon0pteDV435r7U" \
 *     -o robinhood-contentful-tech-blog.json
 *
 * Run: node --test test/robinhood-tech-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  buildFeed,
  extractPosts,
  type Post,
  renderRss,
} from "../robinhood-tech-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const raw = JSON.parse(
  await readFile(
    new URL("./robinhood-contentful-tech-blog.json", import.meta.url), "utf8",
  ),
);
const posts = extractPosts(raw);
const post = (slug: string) => posts.find((p) => p.slug.startsWith(slug))!;

test("reads every entry in the category", () => {
  assertEquals(raw.total, 4, "entries Contentful reports");
  assertEquals(posts.length, 4, "posts");
  assert(posts.every((p) => p.slug && p.title), "every post has a slug/title");
  assertEquals(
    new Set(posts.map((p) => p.slug)).size,
    posts.length,
    "slugs are unique",
  );
  assert(posts.every((p) => p.ts !== null), "every post is dated");
  assert(posts.every((p) => p.description), "every post has a description");
  assert(posts.every((p) => p.image), "every post has a featured image");
});

test("reads every field of a known item", () => {
  const p = post("trajectory-optimization-for-ai-agents");
  assertEquals(
    p.title,
    "Trajectory Optimization for AI Agents: Optimizing the Chain, Not Just the Answer",
    "title",
  );
  assertEquals(p.ts, Date.parse("2026-08-05T00:00-07:00"), "ts");
  assertEquals(p.categories, ["Tech Blog"], "categories");
  assertEquals(p.imageType, "image/jpeg", "Contentful states the media type");
  assert(
    p.image.startsWith("https://images.ctfassets.net/1hpl803w8xsv/"),
    "image is absolute",
  );
});

test("resolves links through the includes rather than the entry", () => {
  // Contentful returns references as bare { sys: { id } } and puts the targets
  // in a sibling `includes` block, so every name here had to be looked up.
  const p = post("trajectory-optimization-for-ai-agents");
  assertEquals(
    p.author,
    "Chaofan Wang & Kirill Dubovitskiy & Davide Giovanardi",
    "three linked author entries, joined the way a byline reads",
  );
  assertEquals(post("how-we-evolved-robinhoods").author, "Edmond Wong", "one");
  assert(
    posts.every((p) => p.categories.length > 0),
    "every post resolved its category link too",
  );
});

test("makes protocol-relative asset URLs absolute", () => {
  // Contentful hands back //images.ctfassets.net/…, which a reader cannot fetch.
  assert(
    posts.every((p) => p.image.startsWith("https://")),
    "no image left protocol-relative",
  );
});

test("reads the offset each publishDate carries", () => {
  // These are stored with the author's own offset rather than in UTC, and two
  // of them differ. Reading them as local time would shift the post by hours.
  assertEquals(
    post("automating-database-safety").ts,
    Date.parse("2026-07-28T00:00+08:00"),
    "a +08:00 date lands the previous day in UTC",
  );
  assertEquals(
    new Date(post("automating-database-safety").ts!).toISOString(),
    "2026-07-27T16:00:00.000Z",
  );
});

test("summarises with the paragraph the category page prints", () => {
  // The page prints the body's opening paragraph under each title; the SEO
  // description is written for search engines and on one entry here it is a
  // heading and a sentence run together.
  const p = post("trajectory-optimization-for-ai-agents");
  assert(
    p.description.startsWith(
      "How Robinhood built a production optimization system",
    ),
    `first paragraph of the body, got: ${p.description.slice(0, 60)}`,
  );
});

test("joins the runs of a paragraph without inserting spaces", () => {
  // A linked or bolded phrase is its own text node inside the paragraph, so
  // the nodes join with nothing between them.
  const marked = {
    items: [{
      fields: {
        slug: "s",
        title: "T",
        publishDate: "2026-01-01T00:00Z",
        categories: [{ sys: { id: "cat" } }],
        content: {
          content: [
            {
              nodeType: "heading-1",
              content: [{ nodeType: "text", value: "H" }],
            },
            {
              nodeType: "paragraph",
              content: [{ nodeType: "text", value: "   " }],
            },
            {
              nodeType: "paragraph",
              content: [
                { nodeType: "text", value: "We sat down with " },
                {
                  nodeType: "hyperlink",
                  content: [{ nodeType: "text", value: "Ada" }],
                },
                { nodeType: "text", value: ", who built it." },
              ],
            },
          ],
        },
      },
    }],
    includes: {
      Entry: [{ sys: { id: "cat" }, fields: { name: "Tech Blog" } }],
    },
  };

  assertEquals(
    extractPosts(marked)[0].description,
    "We sat down with Ada, who built it.",
    "headings skipped, blank paragraph skipped, runs joined",
  );
});

test("falls back to the SEO description when there is no body", () => {
  const seoOnly = {
    items: [{
      fields: {
        slug: "s",
        title: "T",
        publishDate: "2026-01-01T00:00Z",
        categories: [{ sys: { id: "cat" } }],
        seo: { sys: { id: "seo" } },
      },
    }],
    includes: {
      Entry: [
        { sys: { id: "cat" }, fields: { name: "Tech Blog" } },
        {
          sys: { id: "seo" },
          fields: { seoDescription: "From the SEO entry" },
        },
      ],
    },
  };
  assertEquals(extractPosts(seoOnly)[0].description, "From the SEO entry");
});

test("keeps another category out even if the filter loosens", () => {
  // The query is already category-filtered, so this guards the case where that
  // filter is ever dropped or widened upstream.
  const mixed = {
    items: [
      {
        fields: {
          slug: "ours",
          title: "Ours",
          publishDate: "2026-01-01T00:00Z",
          categories: [{ sys: { id: "tech" } }],
        },
      },
      {
        fields: {
          slug: "theirs",
          title: "Theirs",
          publishDate: "2026-01-01T00:00Z",
          categories: [{ sys: { id: "community" } }],
        },
      },
    ],
    includes: {
      Entry: [
        { sys: { id: "tech" }, fields: { name: "Tech Blog" } },
        { sys: { id: "community" }, fields: { name: "Community" } },
      ],
    },
  };
  assertEquals(extractPosts(mixed).map((p) => p.slug), ["ours"]);
});

test("survives input that is not the response we asked for", () => {
  assertEquals(extractPosts(null).length, 0, "null");
  assertEquals(extractPosts({ items: [] }).length, 0, "empty");
  assertEquals(extractPosts([]).length, 0, "not a response body");
  assertEquals(
    extractPosts({ items: [{ fields: { title: "no slug" } }] }).length,
    0,
    "entries without a slug are dropped",
  );
  assertEquals(
    extractPosts({ items: [{ fields: { slug: "s", title: "T" } }] }).length,
    0,
    "an entry whose category link cannot be resolved is dropped",
  );
});

const feed = (query = "") =>
  buildFeed(posts, new URL(`https://feed.val.run/robinhood${query}`)).text();

test("serves the Tech Blog category", async () => {
  const body = await feed();
  assertEquals((body.match(/<item>/g) ?? []).length, 4, "every post");
  assert(
    body.includes("<title>Robinhood — Tech Blog</title>"),
    "channel title",
  );
  assert(
    body.includes(
      "<link>https://robinhood.com/us/en/careers/blog/category/tech-blog/</link>",
    ),
    "channel link is the category page",
  );
  assert(
    body.includes(
      '<guid isPermaLink="true">https://robinhood.com/us/en/careers/blog/trajectory-optimization',
    ),
    "posts live at /careers/blog/<slug>/, not under /category/",
  );
  assert(body.includes("<category>Tech Blog</category>"), "category");
  assertEquals(
    (body.match(/<enclosure/g) ?? []).length,
    4,
    "every item carries its featured image",
  );
});

test("orders items newest first", async () => {
  const dates = [...(await feed()).matchAll(/<pubDate>([^<]+)</g)].map((m) =>
    Date.parse(m[1])
  );
  assertEquals(dates, [...dates].sort((a, b) => b - a), "descending by date");
});

test("self-link is canonical, ignoring junk query params", async () => {
  const body = await feed("?category=community&limit=2&utm_source=x");
  assert(
    body.includes('href="https://feed.val.run/robinhood" rel="self"'),
    "bare self-link",
  );
  assertEquals((body.match(/<item>/g) ?? []).length, 4, "params ignored");
});

const SITE_LINK =
  "https://robinhood.com/us/en/careers/blog/category/tech-blog/";
const FEED_URL = "https://feed.val.run/robinhood";
const SAMPLE_ITEM: Post = {
  slug: "s",
  title: "Tom & Jerry <live>",
  description: 'He said "hi"',
  ts: Date.parse("2026-08-05T00:00-07:00"),
  author: "Ada & Grace",
  image: "https://images.ctfassets.net/1hpl803w8xsv/a.jpg",
  imageType: "image/jpeg",
  categories: ["Tech Blog"],
};

test("renders XML-safe output", () => {
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
  assert(out.includes('type="image/jpeg"'), "enclosure states the media type");

  // Control characters are illegal in XML 1.0 and the library does not strip
  // them, so the val must — one anywhere breaks the whole document.
  const dirty = renderRss({
    title: `T${bell}`,
    description: "d",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE_ITEM, title: `Bell${bell}here` }],
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
    items: [{ ...SAMPLE_ITEM, title: "before ]]> after" }],
  });
  assert(out.includes("]]]]><![CDATA[>"), "breakout split");
  assert(!/\]\]>\s*after/.test(out), "no early termination");
});

test("omits optional elements when the item lacks them", () => {
  const bare: Post = {
    slug: "bare",
    title: "Bare",
    description: "",
    ts: null,
    author: "",
    image: "",
    imageType: "",
    categories: [],
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
