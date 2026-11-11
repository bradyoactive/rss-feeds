/**
 * Live checks for the parameterised Slickdeals feed. See ../../common/linkcheck.ts.
 *
 *   deno test --allow-read --allow-net test/slickdeals-search-rss.linkcheck.test.ts
 *
 * Most of these are not link checks at all. This val's whole design rests on
 * measured facts about the POST endpoint — that it honours `sort`, that its
 * `discount` is an arbitrary threshold rather than the GET form's 10/25/50/75
 * enum, that it ignores price, that it serves 100 rows a request. Every one of those is
 * undocumented and could change silently, and each would degrade the feed
 * without erroring: a `discount` that quietly became an enum would return
 * *more* deals than asked for, not fewer.
 */

import { assert, assertEquals } from "jsr:@std/assert@1";
import handler, {
  applyFilters,
  type Deal,
  extractDeals,
  fetchDeals,
  parseOptions,
  resolveImageTypes,
  windowComplete,
} from "../slickdeals-search-rss.ts";
import { assertAllServed, liveTest, sampleOf } from "../../common/linkcheck.ts";

const UA = "slickdeals-rss-bridge (+https://val.town)";
const API = "https://slickdeals.net/web-api/search/deals/";

function opts(qs: string) {
  return parseOptions(new URL(`https://example.val.run/?${qs}`));
}

async function post(body: unknown): Promise<Deal[]> {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "user-agent": UA,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${API}: HTTP ${res.status}`);
  return extractDeals(await res.json());
}

liveTest("every deal link resolves", async () => {
  const deals = await fetchDeals(opts("pool=40"));
  await assertAllServed(
    sampleOf(deals.map((d) => d.url)),
    "slickdeals thread links",
  );
});

liveTest(
  "a sample of thumbnails resolve, and get their real type",
  async () => {
    // FreshRSS renders an enclosure as an <img> based on exactly this type, and
    // thumbnails are a mix of JPEG and PNG behind the same ".thumb" suffix.
    const deals = await fetchDeals(opts("pool=40"));
    const picked = sampleOf(deals.filter((d) => d.image), 5);
    assert(picked.length > 0, "no thumbnails to check");
    await assertAllServed(picked.map((d) => d.image), "slickdeals thumbnails");
    for (const d of await resolveImageTypes(picked)) {
      const res = await fetch(d.image, { method: "HEAD" });
      const type = res.headers.get("content-type")?.split(";")[0].trim();
      await res.body?.cancel();
      assertEquals(d.imageType, type, `${d.image} resolved to the wrong type`);
      assert(
        ["image/jpeg", "image/png"].includes(type ?? ""),
        `${d.image} is ${type} — a new format the CDN now serves`,
      );
    }
  },
);

liveTest("the API still returns the three count fields", async () => {
  // minVotes/minViews/minComments are pure client-side filters. If any of these
  // fields disappeared they would all silently read 0 and the filters would
  // empty the feed rather than fail.
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "user-agent": UA,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ perPage: 20 }),
  });
  assert(res.ok, `HTTP ${res.status}`);
  const rows = (await res.json()).deals as Record<string, unknown>[];
  assert(rows.length > 0, "no deals returned");
  for (const f of ["socialVoteCount", "viewsCount", "socialCommentCount"]) {
    const present = rows.filter((r) => typeof r[f] === "number").length;
    assert(
      present === rows.length,
      `${f} is a number on only ${present}/${rows.length} rows`,
    );
  }
});

liveTest("one request still returns exactly 100 rows", async () => {
  // The default pool for every feed. If the ceiling dropped, every threshold
  // feed would quietly narrow — which is how they all went empty in November
  // 2026, when it fell from 1000 to 100 and this test was not being run. If it
  // rises, MAX_POOL can rise with it.
  const deals = await post({ perPage: 1000 });
  assertEquals(deals.length, 100, `perPage:1000 returned ${deals.length}`);
});

liveTest("POST still honours sort", async () => {
  // Undocumented and contradicted by the sibling val's notes, which claimed
  // POST had no sort at all. `popular` returns an all-time set; `recent` the
  // newest. If they ever match, sort=popular has become a no-op.
  const [recent, popular] = await Promise.all([
    post({ perPage: 20, sort: "recent" }),
    post({ perPage: 20, sort: "popular" }),
  ]);
  const overlap = recent.filter((r) => popular.some((p) => p.id === r.id));
  assert(
    overlap.length < recent.length / 2,
    `sort=popular returned ${overlap.length}/${recent.length} of the recent set`,
  );
});

liveTest("POST's discount is still an arbitrary threshold", async () => {
  // The GET form only accepts 10/25/50/75. This val passes the caller's number
  // straight through, which is only safe while POST keeps honouring it exactly.
  // Slickdeals compares the unrounded percentage and returns a rounded one, so
  // a floor one point low is expected and tolerated.
  for (const want of [30, 65]) {
    const deals = await post({ perPage: 100, discount: want });
    assert(deals.length > 0, `discount:${want} returned nothing`);
    const floor = Math.min(
      ...deals.map((d) => d.discount ?? Number.POSITIVE_INFINITY),
    );
    assert(
      floor >= want - 1,
      `discount:${want} returned a deal at ${floor}% — it may have become an enum`,
    );
  }
});

liveTest("POST still honours rating, and it is not a no-op", async () => {
  const [any, front] = await Promise.all([
    post({ perPage: 100 }),
    post({ perPage: 100, rating: "frontpage" }),
  ]);
  const anyFloor = Math.min(...any.map((d) => d.votes));
  const frontFloor = Math.min(...front.map((d) => d.votes));
  assert(front.length > 0, "rating=frontpage returned nothing");
  assert(
    frontFloor > anyFloor,
    `frontpage floor ${frontFloor} is no higher than the unfiltered ${anyFloor}`,
  );
});

liveTest(
  "POST still ignores price, so filtering it here is still right",
  async () => {
    // The reason this val uses POST at all: GET can filter price but caps at 40
    // rows. If POST ever gained a price filter, priceMin/priceMax should move
    // server-side and stop competing with the pool for reach.
    const deals = await post({ perPage: 100, priceMin: 500 });
    const cheap = deals.filter((d) => d.price !== null && d.price < 500);
    assert(
      cheap.length > 0,
      "POST appears to honour priceMin now — push price filtering to the server",
    );
  },
);

liveTest("the handler serves a filtered feed end to end", async () => {
  const res = await handler(
    new Request(
      "https://example.val.run/?rating=frontpage&minVotes=20&hideExpired=true" +
        "&sort=views&limit=10",
    ),
  );
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("content-type"),
    "application/rss+xml; charset=utf-8",
  );
  const xml = await res.text();
  assert(xml.startsWith("<?xml"), "not an XML document");
  assert(xml.includes("<rss"), "not an RSS feed");
  const items = xml.match(/<item>/g)?.length ?? 0;
  assert(items > 0, "the filtered feed came back empty");
  assert(items <= 10, `limit=10 produced ${items} items`);
});

liveTest("the live filters actually hold on live data", async () => {
  const o = opts(
    "minVotes=15&minViews=100&hideExpired=true&priceMax=500",
  );
  const got = applyFilters(await fetchDeals(o), o);
  assert(got.length > 0, "no live deal met a deliberately loose filter set");
  for (const d of got) {
    assert(d.votes >= 15, `${d.id} has ${d.votes} votes`);
    assert(d.views >= 100, `${d.id} has ${d.views} views`);
    assert(!d.expired, `${d.id} is expired`);
    assert(d.price !== null && d.price <= 500, `${d.id} at ${d.price}`);
  }
});

liveTest("a bad parameter is refused rather than ignored", async () => {
  const res = await handler(
    new Request("https://example.val.run/?rating=firedeals"),
  );
  assertEquals(res.status, 400);
  assert((await res.text()).includes("rating must be one of"));
});

liveTest("a narrow window is answered completely", async () => {
  // Two hours sits well inside the ~4.5h an unfiltered pool reaches back.
  const o = opts("hours=2");
  const pool = await fetchDeals(o);
  assert(
    windowComplete(pool, o),
    "two hours should be inside an unfiltered pool",
  );
  const got = applyFilters(pool, o);
  assert(got.length > 0, "no deals in the past two hours");
  for (const d of got) {
    assert(
      d.ts !== null && d.ts >= o.since!,
      `${d.id} is older than the window`,
    );
  }
});

liveTest("a window wider than the pool is reported, not faked", async () => {
  // An unfiltered pool reaches back a few hours, so 30 days cannot be covered.
  // The failure mode this guards against is returning those hours and looking
  // successful.
  const o = opts("days=30");
  const pool = await fetchDeals(o);
  assert(
    !windowComplete(pool, o),
    "30 unfiltered days now fit in one pool — the shortfall warning is stale",
  );
  const res = await handler(
    new Request("https://example.val.run/?days=30&limit=5"),
  );
  assertEquals(res.headers.get("x-window-complete"), "false");
  assert((await res.text()).includes("only partly covered"));
});

liveTest("narrowing server-side really does extend the reach", async () => {
  // The remedy the feed suggests when a window is short. rating=firedeal
  // measured ~5.7 days of reach against ~4.5 hours unfiltered; this asserts the
  // advice still holds rather than trusting a one-off measurement.
  const span = async (body: Record<string, unknown>) => {
    const deals = await post({ perPage: 100, sort: "recent", ...body });
    const ts = deals.map((d) => d.ts).filter((t): t is number => t !== null);
    return (Date.now() - Math.min(...ts)) / 3_600_000;
  };
  const [plain, narrowed] = await Promise.all([
    span({}),
    span({ rating: "firedeal" }),
  ]);
  assert(
    narrowed > plain * 2,
    `rating=firedeal reaches ${narrowed.toFixed(1)}h vs ${
      plain.toFixed(1)
    }h unfiltered ` +
      "— narrowing no longer extends reach, so the feed's advice is wrong",
  );
});

liveTest("a date window overrides the pool's sort order", async () => {
  // sort=popular selects the all-time most popular; pairing it with a recent
  // window has to fetch newest-first or the window filters it to nothing.
  const res = await handler(
    new Request("https://example.val.run/?sort=popular&days=2&limit=10"),
  );
  assertEquals(res.status, 200);
  const xml = await res.text();
  assert(
    (xml.match(/<item>/g)?.length ?? 0) > 0,
    "popular+recent came back empty",
  );
});

liveTest("stats are in the body by default", async () => {
  const res = await handler(new Request("https://example.val.run/?limit=5"));
  const xml = await res.text();
  assert(
    /[\d,]+ votes? · [\d,]+ views? · [\d,]+ comments?/.test(xml),
    "no stats in the body",
  );
});
