/**
 * Offline tests for the top movie stories feed. The fixture holds every film
 * post the seven sources published from 16 to 19 November 2026, New York time,
 * as their REST APIs return them (id, date_gmt, link and title only), keyed by
 * source. Refresh one source and day with, for example:
 *
 *   curl -s 'https://deadline.com/wp-json/wp/v2/posts?vertical=524&after=2026-11-19T05:00:00Z&before=2026-11-20T05:00:00Z&per_page=100&_fields=id,date_gmt,link,title'
 *
 * The stories asserted below are what those days' coverage was: Robert
 * Pattinson's casting as James Bond on the 16th, the Hunger Games and Cliff
 * Booth embargoes lifting on the 17th and 19th.
 *
 * Run: node --test test/movie-top-stories-rss.test.ts
 */

import { test } from "node:test";
import { XMLValidator } from "fast-xml-parser";
import {
  dayStart,
  extractPosts,
  finishedDays,
  kinds,
  plainText,
  type Post,
  renderRss,
  respond,
  segments,
  SOURCES,
  type Story,
  topStories,
} from "../movie-top-stories-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";
import { jsonFixture } from "../../common/linkcheck.ts";

const fixture: Record<string, unknown[]> = await jsonFixture(
  import.meta,
  "movie-posts.json",
);
const posts: Post[] = Object.entries(fixture).flatMap(([key, rows]) =>
  extractPosts(rows, key),
);

const titles = (s: Story) => s.posts.map((p) => p.title);
const has = (s: Story, re: RegExp) => titles(s).some((t) => re.test(t));

test("the fixture covers every source", () => {
  assertEquals(
    Object.keys(fixture).sort(),
    SOURCES.map((s) => s.key).sort(),
    "sources",
  );
  for (const [key, rows] of Object.entries(fixture)) {
    assert(rows.length > 40, `${key} has only ${rows.length} posts`);
  }
});

test("reads WordPress's rendered titles as plain text", () => {
  const [p] = extractPosts(
    [
      {
        id: 1,
        date_gmt: "2026-11-19T21:00:00",
        link: "https://example.com/a",
        title: {
          rendered:
            "Don&#8217;t Forget the <em>Other</em> &#8216;Heat&#8217; Movie &amp; More",
        },
      },
    ],
    "indiewire",
  );
  assertEquals(p.title, "Don’t Forget the Other ‘Heat’ Movie & More", "title");
  assertEquals(p.ts, Date.UTC(2026, 10, 19, 21), "date_gmt read as UTC");
  assertEquals(plainText("A&#x2019;s &hellip;"), "A’s …", "hex and named");
});

test("drops rows it cannot use rather than failing", () => {
  const rows = extractPosts(
    [
      null,
      "nope",
      { title: { rendered: "No link" }, date_gmt: "2026-11-19T00:00:00" },
      { title: { rendered: "Bad date" }, link: "https://x.com", date_gmt: "" },
      { title: { rendered: "" }, link: "https://x.com", date_gmt: "2026" },
      {
        title: { rendered: "Fine" },
        link: "https://x.com/fine",
        date_gmt: "2026-11-19T00:00:00",
      },
    ],
    "deadline",
  );
  assertEquals(
    rows.map((r) => r.title),
    ["Fine"],
    "rows kept",
  );
  assertEquals(extractPosts({ code: "rest_error" }, "deadline"), [], "error");
});

test("breaks headlines into runs of names", () => {
  assertEquals(
    segments(
      "‘The Further Mis-Adventures of Cliff Booth’ Review: Brad Pitt, David Fincher and Quentin Tarantino Mix a Cool Cocktail",
    ),
    [
      ["further", "mis", "adventures", "cliff", "booth"],
      ["brad", "pitt"],
      ["david", "fincher"],
      ["quentin", "tarantino", "mix", "cool", "cocktail"],
    ],
    "segments",
  );
  assertEquals(
    segments("Gérard Depardieu’s Appeal"),
    [["gerard", "depardieu", "appeal"]],
    "accents and possessives",
  );
  assertEquals(
    [...kinds("‘The Nightingale’ Trailer: Elle Fanning")],
    ["trailer"],
    "kind",
  );
});

test("New York days begin at local midnight on either side of DST", () => {
  // DST ended at 2am on 1 November 2026.
  assertEquals(dayStart("2026-10-31"), Date.UTC(2026, 9, 31, 4), "EDT");
  assertEquals(dayStart("2026-11-01"), Date.UTC(2026, 10, 1, 4), "the switch");
  assertEquals(dayStart("2026-11-02"), Date.UTC(2026, 10, 2, 5), "EST");
  assertEquals(dayStart("2026-03-08"), Date.UTC(2026, 2, 8, 5), "spring");
});

test("publishes only days that have ended in New York", () => {
  // 10pm on the 19th in New York is already the 20th in UTC.
  assertEquals(
    finishedDays(Date.UTC(2026, 10, 20, 3), 3),
    ["2026-11-18", "2026-11-17", "2026-11-16"],
    "late evening",
  );
  assertEquals(
    finishedDays(Date.UTC(2026, 10, 20, 5, 30), 1),
    ["2026-11-19"],
    "just after midnight",
  );
});

test("19 November: the Cliff Booth reviews, The Nightingale, Night Nurse", () => {
  const [one, two, three, ...rest] = topStories(posts, "2026-11-19");
  assertEquals(rest.length, 0, "three stories");

  assertEquals(one.outlets, 6, "Cliff Booth outlets");
  assert(
    titles(one).every((t) => /Cliff Booth/.test(t)),
    "every Cliff Booth post and nothing else",
  );

  assert(
    titles(two).every((t) => /Nightingale/.test(t)),
    "The Nightingale trailer",
  );
  assertEquals(two.outlets, 4, "Nightingale outlets");

  assert(
    titles(three).every((t) => /Night Nurse|Rosario Dawson/.test(t)),
    "Night Nurse",
  );
  assert(
    !has(three, /Odyssey|Nolan/),
    "Nolan's deleted scenes are another story, though both mention cuts",
  );
});

test("a film title in common is not enough on its own", () => {
  const all = topStories(posts, "2026-11-19", 99);
  const hmma = all.find((s) => has(s, /Hollywood Music in Media/i))!;
  assert(hmma, "the HMMA winners are a story");
  assert(
    !has(hmma, /Oscar Predictions|Making of/),
    "‘La Bola Negra’ pieces stay out of the HMMA story",
  );
  assert(
    !has(hmma, /Should the Oscars/),
    "nor Diane Warren's Oscar think piece",
  );
});

test("16 November: Robert Pattinson is James Bond, led by the news itself", () => {
  const [one] = topStories(posts, "2026-11-16");
  assertEquals(one.outlets, 7, "every outlet ran it");
  assert(one.posts.length >= 25, `only ${one.posts.length} posts`);
  assert(/Bond|007/.test(one.lead.title), `lead was "${one.lead.title}"`);
  assert(
    one.lead.ts === Math.min(...one.posts.map((p) => p.ts)) ||
      one.lead.ts - Math.min(...one.posts.map((p) => p.ts)) < 3 * 3600_000,
    "the lead is among the first posts on it",
  );
});

test("17 November: reviews and first reactions group by the kind of post", () => {
  const top = topStories(posts, "2026-11-17", 6);
  const hunger = top.find((s) => has(s, /Hunger Games/))!;
  assert(hunger && hunger.rank === 1, "the Hunger Games reviews lead the day");
  const reactions = top.find((s) => has(s, /First Reactions/i))!;
  assert(reactions, "Cliff Booth's first reactions are a story");
  assertEquals(
    reactions.posts.filter((p) => /first reactions/i.test(p.title)).length,
    5,
    "all five first-reactions posts together",
  );
  assert(
    !has(reactions, /Bond|Pattinson/),
    "Brad Pitt's Bond comments are a different story",
  );
});

test("ties come out the same whatever order posts arrive in", () => {
  const a = topStories(posts, "2026-11-19", 9).map((s) => s.lead.link);
  const b = topStories([...posts].reverse(), "2026-11-19", 9).map(
    (s) => s.lead.link,
  );
  assertEquals(b, a, "order");
});

test("one outlet running a story twice does not make it big", () => {
  const p = (source: string, title: string, h: number): Post => ({
    source,
    title,
    link: `https://example.com/${source}/${h}`,
    ts: Date.UTC(2026, 10, 19, h),
  });
  const quiet = [
    p("deadline", "Zendaya & Tom Holland Join ‘Quiet Film’", 15),
    p("deadline", "Zendaya & Tom Holland Board ‘Quiet Film’ Sequel", 16),
  ];
  assertEquals(topStories(quiet, "2026-11-19").length, 0, "one outlet");
  const loud = [
    ...quiet,
    p("variety", "Zendaya, Tom Holland Set ‘Quiet Film’", 17),
  ];
  const [story] = topStories(loud, "2026-11-19");
  assertEquals(story.outlets, 2, "two outlets");
  assertEquals(story.posts.length, 3, "all three posts");
});

test("renders well-formed RSS, three items a day, #1 newest", () => {
  const days = ["2026-11-19", "2026-11-18", "2026-11-17"];
  const stories = days.flatMap((d) => topStories(posts, d));
  const xml = renderRss(stories, "https://feeds.brady.town/x", Date.now());
  assertEquals(XMLValidator.validate(xml), true, "XMLValidator");

  const guids = [...xml.matchAll(/<guid isPermaLink="false">([^<]+)</g)].map(
    (m) => m[1],
  );
  assertEquals(guids.length, 9, "items");
  assertEquals(guids[0], "movie-top-stories:2026-11-19:1", "first guid");
  assertEquals(new Set(guids).size, 9, "unique guids");

  const dates = [...xml.matchAll(/<pubDate>([^<]+)</g)].map((m) =>
    Date.parse(m[1]),
  );
  assert(
    dates.every((d, i) => i === 0 || d < dates[i - 1]),
    "dates descend, so readers show #1 above #2",
  );
  assertEquals(
    dates[0],
    dayStart("2026-11-20") - 60_000,
    "a day's #1 is dated a minute before it ends",
  );

  // The description is escaped HTML listing every outlet's post.
  const first = xml.slice(xml.indexOf("<item>"), xml.indexOf("</item>"));
  assert(first.includes("covered by 6 outlets"), "outlet count");
  assert(first.includes("&lt;li&gt;IndieWire: &lt;a href="), "IndieWire link");
});

test("the handler fetches each source for the right window", async () => {
  const realFetch = globalThis.fetch;
  const asked: URL[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    asked.push(url);
    const key = SOURCES.find((s) => s.site === url.origin)!.key;
    const after = Date.parse(url.searchParams.get("after")!);
    const before = Date.parse(url.searchParams.get("before")!);
    const rows = (fixture[key] as { date_gmt: string }[]).filter((r) => {
      const t = Date.parse(`${r.date_gmt}Z`);
      return t > after && t < before;
    });
    const page = Number(url.searchParams.get("page"));
    const slice = rows.slice((page - 1) * 100, page * 100);
    return new Response(JSON.stringify(slice), {
      headers: { "x-wp-totalpages": String(Math.ceil(rows.length / 100)) },
    });
  }) as typeof fetch;
  try {
    // 1am on the 20th, New York: the 17th to 19th are finished.
    const res = await respond(
      new URL("https://feeds.brady.town/movie-top-stories-rss"),
      Date.UTC(2026, 10, 20, 6),
    );
    assertEquals(res.status, 200, "status");
    const xml = await res.text();
    assertEquals((xml.match(/<item>/g) ?? []).length, 9, "items");
    assert(xml.includes("movie-top-stories:2026-11-17:3"), "oldest day");
    assert(!xml.includes(":2026-11-16:"), "nothing before the window");
    assertEquals(
      asked[0].searchParams.get("after"),
      "2026-11-17T05:00:00.000Z",
      "window start",
    );
    assert(
      asked.some((u) => u.searchParams.get("page") === "2"),
      "a busy source is read past its first page",
    );
    assert(
      asked
        .filter((u) => u.hostname === "deadline.com")
        .every((u) => u.searchParams.get("vertical") === "524"),
      "Deadline is narrowed to film",
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the handler gives up when most sources fail", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("down", { status: 503 })) as unknown as typeof fetch;
  try {
    const res = await respond(
      new URL("https://feeds.brady.town/movie-top-stories-rss"),
      Date.UTC(2026, 10, 20, 6),
    );
    assertEquals(res.status, 502, "status");
  } finally {
    globalThis.fetch = realFetch;
  }
});
