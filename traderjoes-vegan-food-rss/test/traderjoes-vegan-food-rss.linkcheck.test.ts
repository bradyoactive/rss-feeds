/**
 * Live link check for the Trader Joe's vegan food feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/traderjoes-vegan-food-rss.linkcheck.test.ts
 *
 * ## What this suite cannot check, and why
 *
 * Every other feed's link check ends with `assertAllServed` over the item
 * links. This one cannot. `www.traderjoes.com` is behind Akamai bot management
 * and answers **403 to every client that is not a real browser** — product
 * pages, images, robots.txt, the lot. Not 404-vs-200: a flat 403 for
 * everything, so even the weaker "assert the absence of 404" that the film
 * feeds fall back to for hostile ticket vendors would pass on a URL that does
 * not exist. An assertion that cannot fail is worse than no assertion, so
 * these checks do not pretend.
 *
 * What is reachable is `traderjoes.com/api/graphql` — the apex, which carries
 * no bot rule — and that turns out to be the better oracle anyway, because the
 * API's `published` flag *is* what decides whether a product page exists.
 * Probed by hand in a browser on 2026-09-06, the one client that can ask:
 *
 *   published: 1  chewy-thai-coconut-cakes-084084          200
 *                 granola-butter-084349                    200
 *   published: 0  vegan-pepperoni-076348                   404
 *                 meatless-ground-074786                   404
 *                 frooze-balls-peanut-butter-jelly-069092  404
 *                 regression-cocktail-10032021             404
 *
 * The same probe settled what the slug is worth, and the answer is: nothing to
 * reachability. The page resolves on the **trailing sku alone**.
 *
 *   zzzz-060216            200   a slug that is not the product's
 *   060216                 200   no slug at all
 *   jalapeno-sauce-000000  404   right slug, sku that does not exist
 *   060216-jalapeno-sauce  404   the url_key form: sku leads, so it is not found
 *
 * So a slugify drift would produce ugly links, not broken ones, and the only
 * thing that can put a dead link in this feed is an unpublished row. That is
 * exactly what the val re-checks and what the first check below watches.
 *
 * The checks therefore pin the things that would silently empty or poison the
 * feed — the endpoint answering, both filters still narrowing, and the fields
 * still being there — and leave the browser-only facts recorded above.
 */

import {
  CATEGORY_ID,
  CHARACTERISTIC,
  extractProducts,
  fetchProducts,
  productUrl,
} from "../traderjoes-vegan-food-rss.ts";
import { liveTest } from "../../common/linkcheck.ts";

const API_URL = "https://traderjoes.com/api/graphql";

/** A query the val does not send, for the checks that need a control group. */
async function count(filter: string): Promise<number> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query:
        `query { products(filter: { ${filter} }, pageSize: 1) { total_count } }`,
    }),
  });
  if (!res.ok) throw new Error(`${API_URL}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(`GraphQL: ${body.errors[0].message}`);
  }
  return body.data.products.total_count;
}

const CATEGORY = `category_id: { eq: "${CATEGORY_ID}" }`;
const VEGAN = `item_characteristics: { in: ["${CHARACTERISTIC}"] }`;
const PUBLISHED = `published: { eq: "1" }`;

liveTest(
  "the endpoint still answers with products the val can read",
  async () => {
    const { products, rowCount, totalCount } = extractProducts(
      await fetchProducts(),
    );
    if (products.length === 0) {
      throw new Error(
        "the API answered but no product survived extraction — either the " +
          "response shape or the published/characteristic filtering has changed",
      );
    }
    if (products.length !== rowCount) {
      throw new Error(
        `the server-side published filter let ${
          rowCount - products.length
        } unpublished rows through; their pages 404, so the val's own re-check ` +
          `is now the only thing keeping dead links out of the feed`,
      );
    }
    if (totalCount > rowCount) {
      throw new Error(
        `the listing has grown to ${totalCount} and the val's page size only ` +
          `returned ${rowCount} — raise PAGE_SIZE`,
      );
    }
    for (const p of products) {
      if (!p.title || !p.ts || !p.story || !p.image || !p.price) {
        throw new Error(
          `${p.sku} (${p.title}) is missing a field the feed uses`,
        );
      }
      if (!p.characteristics.includes(CHARACTERISTIC)) {
        throw new Error(`${p.sku} came through the characteristic filter`);
      }
    }
  },
);

liveTest("both filters still narrow, in both directions", async () => {
  // The failure this catches is silent and total: a Magento attribute filter
  // that stops matching does not error, it just stops filtering, and the feed
  // quietly becomes "every food product Trader Joe's sells".
  const everything = await count(CATEGORY);
  const vegan = await count(`${CATEGORY}, ${VEGAN}`);
  const published = await count(`${CATEGORY}, ${VEGAN}, ${PUBLISHED}`);

  if (!(published < vegan && vegan < everything)) {
    throw new Error(
      `each filter should narrow: ${everything} in the category, ${vegan} ` +
        `tagged ${CHARACTERISTIC}, ${published} of those published`,
    );
  }
  if (vegan > everything / 2) {
    throw new Error(
      `${vegan} of ${everything} products tagged ${CHARACTERISTIC} — that is ` +
        `too many to believe the filter is still applying`,
    );
  }
});

liveTest(
  "an unrecognised filter value returns nothing, not everything",
  async () => {
    // Slickdeals' API silently ignores filter values it does not recognise, so
    // this is worth establishing rather than assuming. Trader Joe's returns 0,
    // which means a typo'd characteristic would empty the feed loudly instead of
    // filling it with the unfiltered catalogue.
    const bogus = await count(
      `${CATEGORY}, item_characteristics: { in: ["Vegans"] }`,
    );
    if (bogus !== 0) {
      throw new Error(
        `an unknown characteristic matched ${bogus} products — the filter is ` +
          `being ignored rather than applied, so every value the val sends is ` +
          `now suspect`,
      );
    }
  },
);

liveTest(
  "www still refuses everything, which is why links go unchecked",
  async () => {
    // The premise of this whole suite. If Trader Joe's ever drops the bot rule,
    // this fails and the item links become checkable for real — so it is a
    // reminder to come back and write that check, not a check of its own.
    const res = await fetch(
      "https://www.traderjoes.com/home/products/pdp/chewy-thai-coconut-cakes-084084",
      {
        headers: { "user-agent": "traderjoes-rss-bridge (+https://val.town)" },
      },
    );
    await res.body?.cancel();
    if (res.status !== 403) {
      throw new Error(
        `www.traderjoes.com answered ${res.status} rather than the expected ` +
          `403 — the bot block may be gone, in which case this suite should ` +
          `assertAllServed over the item links like every other feed does`,
      );
    }
  },
);

liveTest("the apex serves the API but nothing else", async () => {
  // The val's single most load-bearing assumption, and a narrow one: the apex
  // is not a general-purpose mirror. If /api/graphql ever starts redirecting
  // to www like every other path does, the val stops working entirely.
  const res = await fetch(
    "https://traderjoes.com/home/products/pdp/chewy-thai-coconut-cakes-084084",
    { redirect: "manual" },
  );
  await res.body?.cancel();
  if (res.status !== 301) {
    throw new Error(
      `the apex answered a product page with ${res.status} rather than a 301 ` +
        `to www — if it now serves pages directly, the item links could point ` +
        `here and become checkable`,
    );
  }
  // No assertAllServed on API_URL itself: it answers a HEAD with a 500, which
  // is correct of it — the endpoint takes POST. The checks above reach it by
  // POST and are what prove it is up.
});

liveTest("the item links the val builds are at least well-formed", async () => {
  // Not a reachability check — see the header. The sku suffix is the half that
  // has to be right, and it is checked here across the whole live listing;
  // the slug half is cosmetic, so a stray character in it is worth catching
  // but is not an outage.
  const { products } = extractProducts(await fetchProducts());
  for (const p of products) {
    const url = productUrl(p);
    const slug = url.slice(url.lastIndexOf("/") + 1);
    if (!/^[0-9a-z-]+$/.test(slug)) {
      throw new Error(
        `${p.title} produced a slug with stray characters: ${slug}`,
      );
    }
    if (!slug.endsWith(`-${p.sku}`)) {
      throw new Error(`${p.title} produced a slug missing its sku: ${slug}`);
    }
  }
});

liveTest(
  "the category page the channel links to is the one being fed",
  async () => {
    // Cannot be fetched (www, 403), but it can be checked for agreement: the
    // page URL encodes the same category id and characteristic the val queries.
    const xml = await (await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query:
          `query { categories(filters: { ids: { eq: "${CATEGORY_ID}" } }) { items { uid name url_key } } }`,
      }),
    })).json();
    const category = xml.data?.categories?.items?.[0];
    if (category?.url_key !== "food") {
      throw new Error(
        `category ${CATEGORY_ID} is now "${category?.url_key}", not "food" — ` +
          `the channel link says /category/food-${CATEGORY_ID} and would be wrong`,
      );
    }
  },
);
