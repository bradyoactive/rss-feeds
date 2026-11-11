/**
 * Offline tests for the parameterised Slickdeals feed.
 *
 *   deno test --allow-read test/slickdeals-search-rss.test.ts
 */

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { XMLValidator } from "npm:fast-xml-parser@4";

/** True when the document parses, otherwise the parser's complaint. */
function validate(xml: string): true | string {
  const r = XMLValidator.validate(xml);
  return r === true ? true : r.err.msg;
}
import {
  applyFilters,
  buildBody,
  buildFeed,
  type Deal,
  describeFilters,
  extractDeals,
  headline,
  type Options,
  parseOptions,
  parsePrice,
  title,
  windowComplete,
} from "../slickdeals-search-rss.ts";

const raw = JSON.parse(
  await Deno.readTextFile(
    new URL("./slickdeals-search.json", import.meta.url),
  ),
);
const deals = extractDeals(raw);
const NOW = new Date("2026-08-29T12:00:00Z");

/** Options as the val would build them for a bare request. */
const CLOCK = Date.parse("2026-08-29T12:00:00Z");

function opts(qs = ""): Options {
  return parseOptions(new URL(`https://example.val.run/?${qs}`), CLOCK);
}

/* -- parameters ----------------------------------------------------------- */

Deno.test("a bare request is valid and filters nothing", () => {
  const o = opts();
  assertEquals(o.rating, null);
  assertEquals(o.sort, "recent");
  assertEquals(o.minVotes, null);
  assertEquals(describeFilters(o), "no filters");
  assertEquals(title(o), "Slickdeals");
});

Deno.test("every documented parameter is read", () => {
  const o = opts(
    "q=laptop&rating=frontpage&sort=views&minVotes=10&minViews=500" +
      "&minComments=5&priceMin=20&priceMax=300&discount=40&forums=9,30" +
      "&stores=1&hideExpired=true&limit=25&pool=40&showStats=1",
  );
  assertEquals(o.q, "laptop");
  assertEquals(o.rating, "frontpage");
  assertEquals(o.sort, "views");
  assertEquals(o.minVotes, 10);
  assertEquals(o.minViews, 500);
  assertEquals(o.minComments, 5);
  assertEquals(o.priceMin, 20);
  assertEquals(o.priceMax, 300);
  assertEquals(o.discount, 40);
  assertEquals(o.forums, [9, 30]);
  assertEquals(o.stores, [1]);
  assertEquals(o.hideExpired, true);
  assertEquals(o.limit, 25);
  assertEquals(o.pool, 40);
  assertEquals(o.showStats, true);
});

Deno.test("bad values are rejected rather than silently ignored", () => {
  // The whole point: Slickdeals itself silently ignores unknown filter values,
  // so a typo there widens the feed instead of failing. This val must not.
  assertThrows(() => opts("rating=firedeals"), Error, "rating must be one of");
  assertThrows(() => opts("rating=25"), Error, "rating must be one of");
  assertThrows(() => opts("sort=cheapest"), Error, "sort must be one of");
  assertThrows(() => opts("minVotes=abc"), Error, "whole number");
  assertThrows(() => opts("minVotes=12abc"), Error, "whole number");
  assertThrows(() => opts("minVotes=1.5"), Error, "whole number");
  assertThrows(() => opts("minVotes=-3"), Error, "between");
  assertThrows(() => opts("discount=150"), Error, "between");
  assertThrows(() => opts("hideExpired=maybe"), Error, "true or false");
  assertThrows(() => opts("forums=9,abc"), Error, "numeric ids");
  assertThrows(() => opts("pool=99999"), Error, "between");
  assertThrows(
    () => opts("priceMin=100&priceMax=50"),
    Error,
    "above priceMax",
  );
});

Deno.test("blank parameters are treated as absent, not as zero", () => {
  // A reader that builds the URL from a form will send empty strings, and
  // minVotes=0 would still be a filter that drops nothing but changes the title.
  const o = opts("minVotes=&priceMax=&rating=&sort=&q=&forums=");
  assertEquals(o.minVotes, null);
  assertEquals(o.priceMax, null);
  assertEquals(o.rating, null);
  assertEquals(o.sort, "recent");
  assertEquals(o.forums, []);
  assertEquals(describeFilters(o), "no filters");
});

Deno.test("forums accept both csv and repeated keys", () => {
  assertEquals(opts("forums=9,30").forums, [9, 30]);
  assertEquals(opts("forums=9&forums=30").forums, [9, 30]);
});

Deno.test("prices may be written with $ and commas", () => {
  assertEquals(opts("priceMax=$1,299").priceMax, 1299);
});

Deno.test("the pool defaults to the most one request returns", () => {
  assertEquals(opts().pool, 100);
  assertEquals(opts("minViews=100").pool, 100);
  assertEquals(opts("rating=firedeal&minVotes=100").pool, 100);
  // An explicit pool always wins, but cannot exceed what the API serves.
  assertEquals(opts("minViews=100&pool=50").pool, 50);
  assertThrows(() => opts("pool=101"), Error, "between 1 and 100");
});

/* -- the request body ------------------------------------------------------ */

Deno.test("only server-side filters reach the API", () => {
  const body = buildBody(
    opts("q=tv&rating=frontpage&discount=40&forums=9&stores=1&minViews=99"),
  );
  assertEquals(body.searchTerm, "tv");
  assertEquals(body.rating, "frontpage");
  assertEquals(body.discount, 40);
  assertEquals(body.forums, [9]);
  assertEquals(body.stores, [1]);
  // Client-side only: these have no server vocabulary at all.
  assert(!("minViews" in body));
  assert(!("priceMin" in body));
  assert(!("viewsCount" in body));
});

Deno.test("rating is sent as a string", () => {
  // An int 400s.
  assertEquals(typeof buildBody(opts("rating=5")).rating, "string");
});

Deno.test("a local sort is not sent to the API", () => {
  // The API ignores sort=views, which would leave the pool in recency order
  // anyway — but sending it invites a future server-side meaning to silently
  // reorder the pool underneath the local sort.
  assertEquals(buildBody(opts("sort=views")).sort, "recent");
  assertEquals(buildBody(opts("sort=popular")).sort, "popular");
  assertEquals(buildBody(opts("sort=relevance")).sort, "relevance");
});

Deno.test("omitted filters are omitted from the body entirely", () => {
  const body = buildBody(opts());
  assertEquals(Object.keys(body).sort(), ["page", "perPage", "sort"]);
});

/* -- parsing --------------------------------------------------------------- */

Deno.test("prices parse out of every shape the API returns", () => {
  assertEquals(parsePrice("$17"), 17);
  assertEquals(parsePrice("$1,299.00"), 1299);
  assertEquals(parsePrice("$2.70"), 2.7);
  assertEquals(parsePrice("from $5"), 5);
  assertEquals(parsePrice("4 for $2.70"), 2.7);
  // No amount to read: these must stay null rather than become 0, or every one
  // of them would satisfy any priceMax.
  assertEquals(parsePrice("50% Off"), null);
  assertEquals(parsePrice(""), null);
  assertEquals(parsePrice("Free"), null);
});

Deno.test("the fixture parses into complete deals", () => {
  assert(deals.length > 20, `only ${deals.length} deals parsed`);
  for (const d of deals) {
    assert(d.id !== "", "a deal parsed without an id");
    assert(d.url.startsWith("https://slickdeals.net/"), `bad url ${d.url}`);
    assert(d.title !== "", `deal ${d.id} has no title`);
    assert(Number.isFinite(d.votes) && d.votes >= 0);
    assert(Number.isFinite(d.views) && d.views >= 0);
    assert(Number.isFinite(d.comments) && d.comments >= 0);
  }
});

Deno.test("relative thread paths become absolute", () => {
  const [d] = extractDeals({
    deals: [{ threadId: 1, dealTitle: "x", dealThreadUrl: "/f/1-thing" }],
  });
  assertEquals(d.url, "https://slickdeals.net/f/1-thing");
});

Deno.test("rows without an id or a link are skipped, not half-parsed", () => {
  const got = extractDeals({
    deals: [
      { threadId: 1, dealTitle: "ok", dealThreadUrl: "/f/1-a" },
      { dealTitle: "no id", dealThreadUrl: "/f/2-b" },
      { threadId: 3, dealTitle: "no link" },
    ],
  });
  assertEquals(got.map((d) => d.id), ["1"]);
});

Deno.test("duplicate thread ids collapse", () => {
  const got = extractDeals({
    deals: [
      { threadId: 1, dealTitle: "a", dealThreadUrl: "/f/1-a" },
      { threadId: 1, dealTitle: "a again", dealThreadUrl: "/f/1-a" },
    ],
  });
  assertEquals(got.length, 1);
});

Deno.test("a malformed payload yields an empty list rather than throwing", () => {
  assertEquals(extractDeals(null), []);
  assertEquals(extractDeals({}), []);
  assertEquals(extractDeals({ deals: "nope" }), []);
});

/* -- filtering ------------------------------------------------------------- */

Deno.test("each threshold keeps only rows at or above it", () => {
  for (const n of [1, 5, 50]) {
    for (const d of applyFilters(deals, opts(`minVotes=${n}`))) {
      assert(d.votes >= n, `${d.id} has ${d.votes} votes, wanted >= ${n}`);
    }
    for (const d of applyFilters(deals, opts(`minViews=${n}`))) {
      assert(d.views >= n);
    }
    for (const d of applyFilters(deals, opts(`minComments=${n}`))) {
      assert(d.comments >= n);
    }
  }
});

Deno.test("a threshold of zero is inclusive", () => {
  assertEquals(applyFilters(deals, opts("minVotes=0")).length, deals.length);
});

Deno.test("price bounds are inclusive and drop unpriceable rows", () => {
  const bounded = applyFilters(deals, opts("priceMin=10&priceMax=50"));
  for (const d of bounded) {
    assert(d.price !== null, `${d.id} has no price but passed a bound`);
    assert(d.price >= 10 && d.price <= 50, `${d.id} at ${d.price}`);
  }
  // The fixture deliberately contains rows with "", "50% Off" and "from $X".
  const unpriceable = deals.filter((d) => d.price === null);
  assert(unpriceable.length > 0, "fixture lost its unpriceable rows");
  for (const d of unpriceable) {
    assert(!bounded.some((b) => b.id === d.id));
  }
});

Deno.test("an unpriced row survives when no price bound is set", () => {
  const all = applyFilters(deals, opts("limit=500"));
  assert(all.some((d) => d.price === null));
});

Deno.test("hideExpired removes expired deals, and is off by default", () => {
  assert(deals.some((d) => d.expired), "fixture lost its expired rows");
  assert(applyFilters(deals, opts("limit=500")).some((d) => d.expired));
  assertEquals(
    applyFilters(deals, opts("hideExpired=true&limit=500")).filter((d) =>
      d.expired
    ).length,
    0,
  );
});

Deno.test("filters compose rather than override one another", () => {
  const o = opts(
    "minVotes=1&minViews=1&priceMax=1000&hideExpired=true&limit=500",
  );
  for (const d of applyFilters(deals, o)) {
    assert(d.votes >= 1 && d.views >= 1 && !d.expired);
    assert(d.price !== null && d.price <= 1000);
  }
});

/* -- sorting --------------------------------------------------------------- */

Deno.test("local sorts order descending by their metric", () => {
  for (
    const [sort, get] of [
      ["views", (d: Deal) => d.views],
      ["votes", (d: Deal) => d.votes],
      ["comments", (d: Deal) => d.comments],
    ] as const
  ) {
    const got = applyFilters(deals, opts(`sort=${sort}&limit=500`));
    for (let i = 1; i < got.length; i++) {
      assert(
        get(got[i - 1]) >= get(got[i]),
        `${sort} out of order at ${i}`,
      );
    }
  }
});

Deno.test("price sorts ascend, and -price descends", () => {
  const asc = applyFilters(deals, opts("sort=price&priceMin=0&limit=500"));
  for (let i = 1; i < asc.length; i++) {
    assert(asc[i - 1].price! <= asc[i].price!, `ascending broke at ${i}`);
  }
  const desc = applyFilters(deals, opts("sort=-price&priceMin=0&limit=500"));
  for (let i = 1; i < desc.length; i++) {
    assert(desc[i - 1].price! >= desc[i].price!, `descending broke at ${i}`);
  }
});

Deno.test("unpriced rows sort last, never first", () => {
  // Sorting by price without a bound keeps them in the set; treating null as 0
  // would put every one of them at the top of a cheapest-first feed.
  const asc = applyFilters(deals, opts("sort=price&limit=500"));
  const firstNull = asc.findIndex((d) => d.price === null);
  if (firstNull !== -1) {
    assert(
      asc.slice(firstNull).every((d) => d.price === null),
      "a priced deal sorted after an unpriced one",
    );
  }
});

Deno.test("the default sort leaves the API's order alone", () => {
  const got = applyFilters(deals, opts("limit=500"));
  assertEquals(got.map((d) => d.id), deals.map((d) => d.id));
});

Deno.test("limit caps the feed and defaults to 50", () => {
  assertEquals(opts().limit, 50);
  assertEquals(applyFilters(deals, opts("limit=5")).length, 5);
});

/* -- the feed -------------------------------------------------------------- */

Deno.test("the feed is well-formed RSS with one item per deal", () => {
  const o = opts("limit=5");
  const xml = buildFeed(applyFilters(deals, o), o, NOW);
  assert(xml.startsWith("<?xml"));
  assert(xml.includes("<rss"));
  assertEquals(xml.match(/<item>/g)?.length, 5);
  assertEquals(xml.match(/<\/item>/g)?.length, 5);
});

Deno.test("items carry a link, a date and a JPEG enclosure", () => {
  const o = opts("limit=8");
  const picked = applyFilters(deals, o);
  const xml = buildFeed(picked, o, NOW);
  for (const d of picked) {
    assert(xml.includes(d.url), `${d.id} missing from the feed`);
  }
  assert(xml.includes("<pubDate>"));
  const enclosures = [...xml.matchAll(/<enclosure[^>]*\surl="([^"]+)"/g)];
  assert(enclosures.length > 0, "no enclosures emitted");
  assert(xml.includes('type="image/jpeg"'), "enclosure type not declared");
});

Deno.test("a resolved thumbnail type replaces the JPEG default", () => {
  const o = opts("limit=2");
  const [png, unresolved] = applyFilters(deals, o).filter((d) => d.image);
  const xml = buildFeed(
    [{ ...png, imageType: "image/png" }, unresolved],
    o,
    NOW,
  );
  const types = [...xml.matchAll(/<enclosure[^>]*\stype="([^"]+)"/g)]
    .map((m) => m[1]);
  assertEquals(types, ["image/png", "image/jpeg"]);
});

Deno.test("stats are in the body by default, and can be turned off", () => {
  // On by request: Brady de-dupes by link URL, so the churn is harmless. It is
  // still churn — FreshRSS hashes the body, so these rewrite nearly every entry
  // on nearly every poll.
  const o = opts("limit=500");
  assertEquals(o.showStats, true);
  const shown = buildFeed(applyFilters(deals, o), o, NOW);
  assert(/[\d,]+ votes? · [\d,]+ views? · [\d,]+ comments?/.test(shown));

  // Singulars and thousands separators, since this line is in every item.
  const one = buildFeed(
    [{ ...deals[0], votes: 1, views: 1, comments: 1 }],
    o,
    NOW,
  );
  assert(
    one.includes("1 vote · 1 view · 1 comment"),
    "counts are not pluralised",
  );
  const many = buildFeed(
    [{ ...deals[0], votes: 12345, views: 12345, comments: 2 }],
    o,
    NOW,
  );
  assert(many.includes("12,345 votes"), "large counts are not grouped");

  const off = opts("showStats=0&limit=500");
  const plain = buildFeed(applyFilters(deals, off), off, NOW);
  assert(!/\d+ votes/.test(plain), "vote counts survived showStats=0");
  assert(!/\d+ views/.test(plain), "view counts survived showStats=0");
});

/* -- the date window ------------------------------------------------------- */

Deno.test("relative windows resolve against the clock", () => {
  assertEquals(opts("days=1").since, CLOCK - 86_400_000);
  assertEquals(opts("days=0.5").since, CLOCK - 43_200_000);
  assertEquals(opts("hours=6").since, CLOCK - 6 * 3_600_000);
  assertEquals(opts("days=3").window, "past 3 days");
  assertEquals(opts("days=1").window, "past 1 day");
  assertEquals(opts("hours=1").window, "past 1 hour");
});

Deno.test("a bare since/until date resolves in the site's zone", () => {
  // Not UTC: Slickdeals publishes in Pacific, so "since 2026-08-25" must mean
  // midnight Pacific (07:00Z in summer), not midnight UTC.
  assertEquals(
    opts("since=2026-08-25").since,
    Date.parse("2026-08-25T07:00:00Z"),
  );
  // An upper bound takes the end of the day, so until=<date> includes that day.
  assertEquals(
    opts("until=2026-08-25").until,
    Date.parse("2026-08-26T06:59:59.999Z"),
  );
});

Deno.test("the zone offset follows DST rather than being fixed", () => {
  // Pacific is -07:00 in August and -08:00 in January. A hardcoded offset would
  // put every winter bound an hour out.
  assertEquals(
    opts("since=2026-01-15").since,
    Date.parse("2026-01-15T08:00:00Z"),
  );
});

Deno.test("full ISO timestamps are taken as given", () => {
  assertEquals(
    opts("since=2026-08-25T12:30:00Z").since,
    Date.parse("2026-08-25T12:30:00Z"),
  );
  assertEquals(
    opts("since=2026-08-25T12:30:00-07:00").since,
    Date.parse("2026-08-25T19:30:00Z"),
  );
});

Deno.test("competing ways to set the window start are refused", () => {
  // Rather than letting one silently win.
  assertThrows(() => opts("days=1&hours=6"), Error, "use one of them");
  assertThrows(() => opts("days=1&since=2026-08-25"), Error, "use one of them");
  assertThrows(
    () => opts("since=2026-08-28&until=2026-08-25"),
    Error,
    "starts after",
  );
  assertThrows(() => opts("since=yesterday"), Error, "YYYY-MM-DD");
  assertThrows(() => opts("days=0"), Error, "greater than 0");
  assertThrows(() => opts("days=-1"), Error, "greater than 0");
  assertThrows(() => opts("days=lots"), Error, "must be a number");
});

Deno.test("the window keeps only deals inside it", () => {
  const dated = deals.filter((d) => d.ts !== null);
  assert(dated.length > 5, "fixture has too few dated rows");
  const mid = dated.map((d) => d.ts!).sort((a, b) => a - b)[
    Math.floor(dated.length / 2)
  ];
  const o = { ...opts("limit=500"), since: mid };
  const got = applyFilters(deals, o);
  assert(got.length > 0 && got.length < dated.length, "the bound did nothing");
  for (const d of got) assert(d.ts !== null && d.ts >= mid);

  const upper = { ...opts("limit=500"), until: mid };
  for (const d of applyFilters(deals, upper)) {
    assert(d.ts !== null && d.ts <= mid);
  }
});

Deno.test("an undated deal is dropped by a window, like an unpriced one", () => {
  const rows = extractDeals({
    deals: [
      {
        threadId: 1,
        dealTitle: "dated",
        dealThreadUrl: "/f/1-a",
        threadIsoDatetime: "2026-08-28T00:00:00Z",
      },
      { threadId: 2, dealTitle: "undated", dealThreadUrl: "/f/2-b" },
    ],
  });
  assertEquals(rows.length, 2);
  const o = { ...opts(), since: Date.parse("2026-08-01T00:00:00Z") };
  assertEquals(applyFilters(rows, o).map((d) => d.id), ["1"]);
  // ...but survives when no window is set.
  assertEquals(applyFilters(rows, opts()).length, 2);
});

Deno.test("a date bound forces a newest-first pool", () => {
  // sort=popular is a selection, not an ordering: it returns the all-time most
  // popular, which a recent window would filter to almost nothing.
  assertEquals(buildBody(opts("sort=popular&days=3")).sort, "recent");
  assertEquals(buildBody(opts("sort=popular")).sort, "popular");
  // ...and the requested order is then applied locally instead.
  const o = { ...opts("sort=popular&limit=500"), since: 0 };
  const got = applyFilters(deals, o);
  for (let i = 1; i < got.length; i++) {
    assert(got[i - 1].votes >= got[i].votes, `not vote-ordered at ${i}`);
  }
});

Deno.test("no date filter is ever sent to the API", () => {
  // POST has no date vocabulary at all; sending one would be silently ignored.
  const body = buildBody(opts("days=3&until=2026-08-28"));
  for (const k of ["days", "since", "until", "date", "filters"]) {
    assert(!(k in body), `${k} leaked into the request body`);
  }
});

Deno.test("windowComplete reports whether the pool reached the window", () => {
  const full = Array.from({ length: 10 }, (_, i) => ({
    ...deals[0],
    id: String(i),
    ts: Date.parse("2026-08-29T00:00:00Z") - i * 3_600_000,
  }));
  const o = (qs: string) => ({ ...opts(qs), pool: 10 });

  // No window: nothing to be incomplete about.
  assertEquals(windowComplete(full, o("")), true);
  // The pool reaches back past the bound.
  assertEquals(
    windowComplete(full, {
      ...o(""),
      since: Date.parse("2026-08-28T22:00:00Z"),
    }),
    true,
  );
  // It does not.
  assertEquals(
    windowComplete(full, {
      ...o(""),
      since: Date.parse("2026-08-20T00:00:00Z"),
    }),
    false,
  );
  // A short pool means the API had nothing more, so the window is covered.
  assertEquals(
    windowComplete(full.slice(0, 3), {
      ...o(""),
      since: Date.parse("2020-01-01T00:00:00Z"),
    }),
    true,
  );
  // An upper bound alone leaves the window open-ended backwards.
  assertEquals(
    windowComplete(full, {
      ...o(""),
      until: Date.parse("2026-08-29T00:00:00Z"),
    }),
    false,
  );
});

Deno.test("an incomplete window is disclosed in the feed itself", () => {
  const o = opts("days=30");
  const xml = buildFeed(applyFilters(deals, o), o, NOW, false);
  assert(
    xml.includes("only partly covered"),
    "no shortfall warning in the feed",
  );
  assert(xml.includes("Narrow it with rating"), "no remedy suggested");
  // And stays out when the window was covered.
  assert(
    !buildFeed(applyFilters(deals, o), o, NOW, true).includes("partly covered"),
  );
});

Deno.test("the window appears in the feed title and description", () => {
  assertEquals(
    describeFilters(opts("days=3&rating=frontpage")),
    "past 3 days, rated frontpage",
  );
  assert(title(opts("days=3")).includes("past 3 days"));
});

Deno.test("the same input twice produces byte-identical output", () => {
  // Anything unstable here churns every entry in FreshRSS on every poll.
  const o = opts("limit=10");
  const picked = applyFilters(deals, o);
  assertEquals(buildFeed(picked, o, NOW), buildFeed(picked, o, NOW));
});

Deno.test("titles and descriptions describe the actual filters", () => {
  const o = opts("rating=frontpage&minViews=5000&priceMax=100");
  assertEquals(
    describeFilters(o),
    "rated frontpage, 5000+ views, under $100",
  );
  assert(title(o).startsWith("Slickdeals — "));
  const xml = buildFeed(applyFilters(deals, o), o, NOW);
  assert(xml.includes("5000+ views"));
});

Deno.test("a price range reads as a range, not as two bounds", () => {
  assertEquals(describeFilters(opts("priceMin=20&priceMax=50")), "$20–$50");
});

Deno.test("an empty result set still renders a valid feed", () => {
  const o = opts("minViews=99999999");
  const got = applyFilters(deals, o);
  assertEquals(got.length, 0);
  const xml = buildFeed(got, o, NOW);
  assert(xml.startsWith("<?xml"));
  assert(!xml.includes("<item>"));
});

Deno.test("the price is in the item title, not its body", () => {
  const [d] = extractDeals({
    deals: [{
      threadId: 1,
      dealTitle: "USB-C Charger",
      dealAdditionalInfo: "+ Free S&H",
      dealThreadUrl: "/f/1-x",
      finalPriceText: "$17",
      listPriceText: "$30",
      discount: 43,
      storeName: "Amazon",
    }],
  });
  assertEquals(headline(d), "USB-C Charger — $17 + Free S&H");
  const xml = buildFeed([d], opts("showStats=0"), NOW);
  assert(xml.includes("<description><![CDATA[was $30, 43% off · at Amazon]]>"));

  // Either half of the tail may be missing.
  assertEquals(headline({ ...d, extra: "" }), "USB-C Charger — $17");
  assertEquals(
    headline({ ...d, finalPrice: "" }),
    "USB-C Charger — + Free S&H",
  );
  assertEquals(headline({ ...d, finalPrice: "", extra: "" }), "USB-C Charger");
});

Deno.test("hostile deal text cannot break out of the XML", () => {
  // The library CDATA-wraps titles, so a literal "<script>" in the output is
  // inert text rather than markup. What actually matters is that nothing can
  // terminate the CDATA early — hence the "]]>" case, which the library escapes
  // by splitting the section.
  const nasty = extractDeals({
    deals: [{
      threadId: 9,
      dealTitle: 'Sale <script>alert("x")</script> & more',
      dealAdditionalInfo: "ends ]]> soon",
      dealThreadUrl: "/f/9-x",
      finalPriceText: "$5",
      storeName: "A&B <b>Co</b>",
    }],
  });
  const xml = buildFeed(nasty, opts(), NOW);

  // Strip every CDATA section; anything hostile left behind is live markup.
  const outside = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  assert(!outside.includes("<script"), "a <script> tag reached live markup");
  assert(!outside.includes("<b>"), "deal markup reached live markup");

  // And the document as a whole must still parse.
  assertEquals(validate(xml), true, "the feed is not well-formed XML");
});

Deno.test("the fixture feed is well-formed XML", () => {
  const o = opts("limit=500&showStats=true");
  assertEquals(validate(buildFeed(applyFilters(deals, o), o, NOW)), true);
});
