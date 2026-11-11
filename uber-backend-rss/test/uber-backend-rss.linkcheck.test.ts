/**
 * Live link check for the Uber Backend feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/uber-backend-rss.linkcheck.test.ts
 */

import {
  categoryId,
  categoryNames,
  extractCategories,
  extractPosts,
  type Post,
  rpc,
} from "../uber-backend-rss.ts";
import {
  assertAllServed,
  jsonFixture,
  liveTest,
  sampleOf,
} from "../../common/linkcheck.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const CATEGORY_SLUG = "engineering/backend";
const LISTING = "https://www.uber.com/us/en/blog/engineering/backend/";

/**
 * www.uber.com answers 406 to a request that states no Accept, which a bare
 * HEAD does not. Everything under the apex needs this; the image CDN does not.
 */
const ACCEPT_HTML = { accept: "text/html" };

const posts = extractPosts(
  (await jsonFixture(import.meta, "uber-newsroom-backend.json")).data,
  categoryNames(
    extractCategories(
      (await jsonFixture(import.meta, "uber-newsroom-categories.json")).data,
    ),
  ),
);

/** The same two calls the val makes, so a check exercises the real path. */
async function livePosts(): Promise<Post[]> {
  const categories = extractCategories(
    await rpc("listCategories", { country: "US", locale: "en" }),
  );
  const id = categoryId(categories, CATEGORY_SLUG);
  if (!id) throw new Error(`no blog category at "${CATEGORY_SLUG}"`);
  const data = await rpc("getRelatedPages", {
    categoryIDFilters: [id],
    country: "US",
    locale: "en",
    paging: { limit: 500, token: "0" },
    sortKey: "PUBLISHED_AT",
    sortOrder: "DESC",
  });
  const total = (data as { totalCount?: number })?.totalCount ?? 0;
  const live = extractPosts(data, categoryNames(categories));
  if (total > live.length) {
    throw new Error(
      `the category now holds ${total} posts but only ${live.length} came ` +
        "back — the page size no longer covers it",
    );
  }
  return live;
}

liveTest("every post link resolves", async () => {
  await assertAllServed(
    sampleOf(posts.map((p) => p.url)),
    "uber post links",
    ACCEPT_HTML,
  );
});

liveTest("a sample of images resolve", async () => {
  await assertAllServed(
    sampleOf(posts.map((p) => p.image).filter(Boolean)),
    "uber images",
  );
});

liveTest("the category page the channel links to exists", async () => {
  await assertAllServed([LISTING], "uber category page", ACCEPT_HTML);
});

liveTest("the RPC still answers, csrf header and all", async () => {
  // Without x-csrf-token the endpoint replies 403 "Missing csrf token."; with
  // one, any value passes. If that ever tightens into a real token this is
  // where it shows up, rather than as an empty feed.
  const live = await livePosts();
  assert(live.length > 50, `only ${live.length} posts came back`);
  const strays = live.filter((p) => !p.categories.includes("Backend"));
  assertEquals(strays.length, 0, "nothing outside the category leaked in");
  assert(live.every((p) => p.ts !== null), "every live post is dated");
});

liveTest("a call with no csrf header is still refused", async () => {
  // Pinning the reason the header is there. If this starts passing, the header
  // can go; if the *value* starts mattering, the check above fails first.
  const res = await fetch("https://www.uber.com/api/listCategories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const body = await res.text();
  assertEquals(res.status, 403, "status");
  assert(/csrf/i.test(body), `body mentions csrf: ${body.slice(0, 80)}`);
});

liveTest("the feed's first page matches the cards Uber renders", async () => {
  // The one real oracle here. The listing renders 12 cards, and each states the
  // post's title and its category tags — so this pins three things the offline
  // suite can only assume: that PUBLISHED_AT DESC is the order the site uses,
  // that `title` (not `ogTitle`) is what the cards print, and that the category
  // tags are alphabetical.
  const res = await fetch(LISTING, { headers: ACCEPT_HTML });
  if (!res.ok) throw new Error(`listing: HTTP ${res.status}`);
  const html = await res.text();

  const cards = html.split('data-testid="newsroom-article-feed-card"').slice(1)
    .flatMap((card) => {
      const link =
        /<a [^>]*href="(https:\/\/www\.uber\.com\/us\/en\/blog\/[^"]*)"[^>]*>([^<]+)<\/a>/
          .exec(card);
      if (!link) return [];
      const tags = [
        ...card.matchAll(/data-baseweb="tag"[^>]*><span title="([^"]*)"/g),
      ]
        .map((m) => unescapeHtml(m[1]));
      return [{ url: link[1], title: unescapeHtml(link[2]), tags }];
    });

  assert(cards.length >= 10, `only ${cards.length} cards were readable`);

  const live = await livePosts();
  for (const [i, card] of cards.entries()) {
    const post = live[i];
    assertEquals(post?.url, card.url, `card ${i + 1} URL`);
    assertEquals(post.title, card.title, `card ${i + 1} title`);
    assertEquals(post.categories, card.tags, `card ${i + 1} categories`);
  }
});

/**
 * The cards are compared against text the RPC hands back already decoded, so
 * the scraped side has to be decoded too or every title holding an entity
 * mismatches. Uber writes apostrophes as the *hex* reference `&#x27;` — the
 * decimal branch alone left "Evolving Uber&#x27;s Compute Platform" as-is and
 * failed the comparison, so both numeric forms are covered here.
 *
 * `&amp;` is unescaped last: doing it first would turn a literal `&amp;#x27;`
 * into `&#x27;` and then into an apostrophe the page never wrote.
 */
function unescapeHtml(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(
      /&#x([0-9a-f]+);/gi,
      (_, h) => String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim()
    .replace(/\s+/g, " ");
}
