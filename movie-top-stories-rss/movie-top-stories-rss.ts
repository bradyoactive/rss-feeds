/**
 * The three biggest movie stories of each day, as RSS.
 *
 * No single site publishes a "top stories" list for film, so this works one
 * out. "Biggest" here means "covered by the most outlets": a casting rumour one
 * blog runs is small, a trailer or a death that every trade writes up the same
 * afternoon is big. Each day's film posts from seven outlets are grouped into
 * stories by the names in their headlines, and the stories that the most
 * outlets ran win.
 *
 * Sources: Deadline, Variety, The Hollywood Reporter, TheWrap, IndieWire,
 * JoBlo and ComicBook.com. All seven run WordPress and leave its REST API open,
 * which matters because their RSS feeds hold only the last few hours: Deadline's
 * film feed spans about four hours. The REST API takes a date range, so one
 * request (or two, on a busy Deadline day) returns a whole day's posts. Five of
 * the seven can be narrowed to film there (Deadline and Variety by their
 * "vertical" taxonomy, the others by category). IndieWire's categories are by
 * format, not medium, so its TV posts come along too. That is harmless: a
 * story needs two outlets to rank, and every outlet but IndieWire is filtered
 * to film, so a TV story IndieWire alone covers never does.
 *
 * Days run midnight to midnight New York time, and a day is published only
 * once it is over, so a day's three stories do not reshuffle while readers are
 * looking at them. The feed carries the last few days, three items each.
 *
 * Grouping is deliberately plain: two headlines are the same story when they
 * share at least two distinctive words, where distinctive means not on the
 * stop list and not common across that day's headlines. Names carry it —
 * "Tendo Nagenda", "Proximity" — and a headline that only shares "Oscar" and
 * "review" with another is kept apart.
 */

const TITLE = "Top Movie Stories";
const DESCRIPTION =
  "The three movie stories the most outlets covered each day, from Deadline, " +
  "Variety, THR, TheWrap, IndieWire, JoBlo and ComicBook.com.";
const ZONE = "America/New_York";

/** How many finished days the feed carries. */
export const DAYS = 3;
/** Stories per day. */
export const PER_DAY = 3;
/** A story run by a single outlet is not a big story, however long the day. */
const MIN_OUTLETS = 2;

/**
 * A day is fixed once it ends, so the only thing an hour of caching delays is
 * the new day's items appearing, by at most an hour after midnight.
 */
const CACHE_SECONDS = 60 * 60;

export interface Source {
  key: string;
  name: string;
  site: string;
  /** Query that narrows the posts endpoint to film, or "" for none. */
  filter: string;
}

/** Order breaks ties when choosing which outlet's headline leads a story. */
export const SOURCES: Source[] = [
  {
    key: "deadline",
    name: "Deadline",
    site: "https://deadline.com",
    filter: "vertical=524",
  },
  {
    key: "variety",
    name: "Variety",
    site: "https://variety.com",
    filter: "vertical=524",
  },
  {
    key: "thr",
    name: "The Hollywood Reporter",
    site: "https://www.hollywoodreporter.com",
    filter: "categories=59",
  },
  {
    key: "thewrap",
    name: "TheWrap",
    site: "https://www.thewrap.com",
    filter: "categories=12",
  },
  {
    key: "indiewire",
    name: "IndieWire",
    site: "https://www.indiewire.com",
    filter: "",
  },
  {
    key: "joblo",
    name: "JoBlo",
    site: "https://www.joblo.com",
    // Movie news, horror news, movie trailers, movie reviews.
    filter: "categories=26200,26213,83051,26196",
  },
  {
    key: "comicbook",
    name: "ComicBook.com",
    site: "https://comicbook.com",
    filter: "categories=26",
  },
];

export interface Post {
  source: string;
  title: string;
  link: string;
  ts: number;
}

export interface Story {
  /** YYYY-MM-DD, New York time. */
  day: string;
  rank: number;
  lead: Post;
  /** Every post in the story, lead included, one entry per post. */
  posts: Post[];
  outlets: number;
}

export default function (req: Request): Promise<Response> {
  return respond(new URL(req.url), Date.now());
}

/** The handler with the clock passed in, so tests can pick the day. */
export async function respond(url: URL, now: number): Promise<Response> {
  const days = finishedDays(now, DAYS);
  const after = dayStart(days[days.length - 1]);
  const before = dayStart(nextDay(days[0]));

  const results = await Promise.allSettled(
    SOURCES.map((s) => fetchSource(s, after, before)),
  );
  const posts: Post[] = [];
  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") posts.push(...r.value);
    else failed.push(`${SOURCES[i].name}: ${r.reason}`);
  });

  // A day's ranking is what readers keep, so publishing one built from too
  // few outlets would leave a worse list in their readers for good. One or
  // two outlets down still leaves a fair count.
  if (failed.length > 2) {
    return text(502, `Too many sources failed:\n${failed.join("\n")}`);
  }

  const stories = days.flatMap((day) => topStories(posts, day));
  return buildFeed(stories, url, now);
}

/** Pure half of the handler: stories in, RSS response out. */
export function buildFeed(stories: Story[], url: URL, now: number): Response {
  const xml = renderRss(stories, `${url.origin}${url.pathname}`, now);
  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
}

// ---------------------------------------------------------------- fetching

const PAGE_SIZE = 100;
/**
 * Deadline posts about forty film stories a day, so three days is two pages.
 * This is a ceiling, not a target.
 */
const MAX_PAGES = 4;

async function fetchSource(
  s: Source,
  after: number,
  before: number,
): Promise<Post[]> {
  const out: Post[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams({
      after: new Date(after).toISOString(),
      before: new Date(before).toISOString(),
      per_page: String(PAGE_SIZE),
      page: String(page),
      orderby: "date",
      _fields: "id,date_gmt,link,title",
    });
    const filter = s.filter ? `&${s.filter}` : "";
    const res = await fetch(
      `${s.site}/wp-json/wp/v2/posts?${params}${filter}`,
      {
        headers: {
          accept: "application/json",
          "user-agent": "movie-top-stories-rss (+https://feeds.brady.town)",
        },
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload: unknown = await res.json();
    out.push(...extractPosts(payload, s.key));
    const pages = Number(res.headers.get("x-wp-totalpages") ?? "1");
    const got = Array.isArray(payload) ? payload.length : 0;
    if (page >= pages || got < PAGE_SIZE) break;
  }
  return out;
}

/** Reads one REST page. Rows missing a title, link or date are dropped. */
export function extractPosts(payload: unknown, source: string): Post[] {
  if (!Array.isArray(payload)) return [];
  const out: Post[] = [];
  for (const raw of payload) {
    const row = obj(raw);
    const title = plainText(str(obj(row.title).rendered));
    const link = str(row.link);
    // date_gmt carries no zone marker; it is UTC.
    const ts = Date.parse(`${str(row.date_gmt)}Z`);
    if (!title || !/^https:\/\//.test(link) || !Number.isFinite(ts)) continue;
    out.push({ source, title, link, ts });
  }
  return out;
}

// ---------------------------------------------------------------- ranking

/**
 * Words that say what kind of post it is, or that any headline might use,
 * rather than what it is about. Two headlines sharing only these are two
 * stories.
 */
const STOP = new Set(
  [
    // Grammar.
    "a an the and or but nor of in on at to for from by with as is are was " +
      "were be been being am it its this that these those his her hers he she " +
      "him they them their theirs our ours your yours you we us i my me mine " +
      "who whom whose what why how when where which than then so not no yes up " +
      "out over under into onto about after before amid during until while " +
      "off all any both each few more most other some such own same too very " +
      "just only also even still yet ever never again once here there now " +
      "will would can could may might must shall should do does did done has " +
      "have had having get gets got getting go goes going went gone",
    // Ordinary words a headline uses for anything.
    "new first last next one two three four five six seven eight nine ten " +
      "big biggest great greatest good best better top little old young " +
      "real right left long short high low full free open late early " +
      "make makes made making take takes took taking give gives gave come " +
      "comes came coming bring brings brought keep keeps kept see sees seen " +
      "look looks looking like likes feel feels felt want wants wanted need " +
      "needs think thinks know knows knew tell tells told ask asks asked " +
      "call calls called play plays played playing work works worked working " +
      "back down way ways thing things time times life lives people world " +
      "every everything everyone nothing something anything far really why " +
      "year years day days week weeks month months night tonight today " +
      "wouldn couldn shouldn don doesn didn isn aren wasn won ve ll re",
    // The business of film news.
    "film films movie movies pic pics feature features trailer trailers " +
      "teaser clip clips footage photo photos poster posters image images " +
      "review reviews reaction reactions critic critics star stars starring " +
      "starred cast casts casting joins join joined set sets lands landed " +
      "release releases released releasing date dates exclusive says say said " +
      "reveal reveals revealed director directors directing direct directs " +
      "directed directorial debut deal deals acquired acquires acquire buys buy " +
      "bought sells sold rights sequel prequel remake reboot spinoff franchise " +
      "adaptation based show shows series season seasons tv episode streaming " +
      "watch theaters theatrical box office opening weekend oscar oscars " +
      "award awards winner winners wins win nominations nominee nominees " +
      "festival fest premiere screening update details talks talk interview " +
      "official officially news brief role roles character characters " +
      "drama comedy horror thriller documentary doc biopic animated action " +
      "dies dead death died age obituary studio studios exec executive " +
      "producer producers produce production writer writers script plus " +
      "hollywood industry fans fan reacts audience audiences",
  ]
    .join(" ")
    .split(" "),
);

/**
 * A headline as runs of meaningful words: lowercase, accents and possessives
 * gone, stop words dropped. A run breaks at a comma, a quote mark, an
 * ampersand or "and", so "Brad Pitt, David Fincher and Quentin Tarantino" is
 * three runs and "‘La Bola Negra’" is one.
 */
export function segments(title: string): string[][] {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .split(/[,;&"“”‘’|()[\]]|\s(?:and|with|or|plus)\s|\s[–—-]\s/u)
    .map((part) =>
      part.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w)),
    )
    .filter((seg) => seg.length > 0);
}

/**
 * What kind of post a headline announces. These words are stop words for
 * matching names, but two posts about the same title that are both trailers,
 * or both reviews, are the same story even when the title is all they share:
 * "‘Cliff Booth’ First Reactions" and "‘The Further Mis-Adventures of Cliff
 * Booth’: First Reactions" have nothing else in common.
 */
const KINDS: Record<string, string> = {
  trailer: "trailer",
  trailers: "trailer",
  teaser: "trailer",
  review: "review",
  reviews: "review",
  reaction: "reactions",
  reactions: "reactions",
  poster: "poster",
  posters: "poster",
  dies: "death",
  died: "death",
  dead: "death",
  death: "death",
  obituary: "death",
  box: "box office",
};

export function kinds(title: string): Set<string> {
  const out = new Set<string>();
  for (const w of title.toLowerCase().split(/[^\p{L}]+/u)) {
    if (Object.hasOwn(KINDS, w)) out.add(KINDS[w]);
  }
  return out;
}

/** Every meaningful word in a headline, once. */
export function tokens(title: string): string[] {
  return [...new Set(segments(title).flat())];
}

/**
 * How many runs of `segs` consist of words found in `other`. A name or title
 * counts once however many words it has: "La Bola Negra" is one thing two
 * headlines share, not three.
 *
 * `strong` says whether any shared run is a name rather than a stray word: two
 * words or more ("Sam Altman"), or the whole of its segment, which is how a
 * one-word title in quotes ("‘Madden’") comes out of segments().
 */
function sharedRuns(
  segs: string[][],
  other: Set<string>,
): { runs: number; strong: boolean } {
  let runs = 0;
  let strong = false;
  for (const seg of segs) {
    let len = 0;
    for (let k = 0; k <= seg.length; k++) {
      if (k < seg.length && other.has(seg[k])) {
        if (len++ === 0) runs++;
        continue;
      }
      if (len >= 2 || (len > 0 && len === seg.length)) strong = true;
      len = 0;
    }
  }
  return { runs, strong };
}

/**
 * The top stories of one day. Posts outside it are ignored, so the whole
 * fetched window can be passed in.
 */
export function topStories(all: Post[], day: string, limit = PER_DAY): Story[] {
  const start = dayStart(day);
  const end = dayStart(nextDay(day));
  const posts = all
    .filter((p) => p.ts >= start && p.ts < end)
    // Stable order makes ties come out the same on every run.
    .sort((a, b) => a.ts - b.ts || a.link.localeCompare(b.link));

  // No "too common today" cut-off on top of the stop list: the words that
  // turn up in the most headlines on a given day are the names of its biggest
  // story, which is the one thing this must not throw away.
  const segs = posts.map((p) => segments(p.title));
  const keys = segs.map((ss) => new Set(ss.flat()));
  const kind = posts.map((p) => kinds(p.title));
  const sameKind = (i: number, j: number) =>
    [...kind[i]].some((k) => kind[j].has(k));

  const parent = posts.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]));
  // Two headlines are one story when they share two names or titles, at
  // least one of them unmistakable, or one unmistakable name and the kind of
  // post. Runs are counted both ways and the lower kept, as a run in one
  // headline can be split by a comma in the other.
  const link = (i: number, j: number) => {
    const a = sharedRuns(segs[i], keys[j]);
    const b = sharedRuns(segs[j], keys[i]);
    return { n: Math.min(a.runs, b.runs), strong: a.strong && b.strong };
  };
  const shared = (i: number, j: number) => link(i, j).n;
  for (let i = 0; i < posts.length; i++) {
    for (let j = i + 1; j < posts.length; j++) {
      const l = link(i, j);
      if (l.strong && (l.n >= 2 || (l.n >= 1 && sameKind(i, j)))) {
        parent[find(j)] = find(i);
      }
    }
  }

  const groups = new Map<number, number[]>();
  posts.forEach((_, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), i]);
  });

  const order = new Map(SOURCES.map((s, i) => [s.key, i]));

  const ranked = [...groups.values()]
    .map((members) => {
      const outlets = new Set(members.map((i) => posts[i].source));
      // The story is led by the first post to break it, among those that are
      // plainly about it: a day-long story collects think pieces and asides
      // whose headlines only touch it, so posts sharing less than half as
      // much with the rest as the best-connected one are passed over.
      const scored = members.map((i) => ({
        i,
        score: members.reduce((n, j) => n + (i === j ? 0 : shared(i, j)), 0),
      }));
      const best = Math.max(...scored.map((m) => m.score));
      const lead = scored
        .filter((m) => m.score * 2 >= best)
        .sort(
          (a, b) =>
            posts[a.i].ts - posts[b.i].ts ||
            order.get(posts[a.i].source)! - order.get(posts[b.i].source)!,
        )[0].i;
      return {
        members,
        lead,
        outlets: outlets.size,
        first: Math.min(...members.map((i) => posts[i].ts)),
      };
    })
    .filter((g) => g.outlets >= MIN_OUTLETS)
    .sort(
      (a, b) =>
        b.outlets - a.outlets ||
        b.members.length - a.members.length ||
        a.first - b.first,
    )
    .slice(0, limit);

  return ranked.map((g, n) => ({
    day,
    rank: n + 1,
    lead: posts[g.lead],
    posts: [...g.members]
      .sort(
        (a, b) =>
          order.get(posts[a].source)! - order.get(posts[b].source)! ||
          posts[a].ts - posts[b].ts,
      )
      .map((i) => posts[i]),
    outlets: g.outlets,
  }));
}

// ---------------------------------------------------------------- rendering

export function renderRss(stories: Story[], feedUrl: string, now: number) {
  const names = new Map(SOURCES.map((s) => [s.key, s.name]));
  const items = stories.map((s) => {
    const list = s.posts
      .map(
        (p) =>
          `<li>${esc(names.get(p.source) ?? p.source)}: ` +
          `<a href="${esc(p.link)}">${esc(p.title)}</a></li>`,
      )
      .join("");
    const html =
      `<p>#${s.rank} on ${esc(longDate(s.day))}, covered by ${s.outlets} ` +
      `outlets.</p><ul>${list}</ul>`;
    // Newest first in a reader means the day's #1 should carry the latest
    // time, so each rank steps a minute back from the day's end.
    const date = new Date(dayStart(nextDay(s.day)) - s.rank * 60_000);
    return [
      "<item>",
      `<title>${esc(clean(s.lead.title))}</title>`,
      `<link>${esc(s.lead.link)}</link>`,
      // One slot per day and rank: if a late edit swaps the story in a slot,
      // readers keep what they already showed instead of growing a fourth.
      `<guid isPermaLink="false">movie-top-stories:${s.day}:${s.rank}</guid>`,
      `<pubDate>${date.toUTCString()}</pubDate>`,
      `<category>${esc(names.get(s.lead.source) ?? s.lead.source)}</category>`,
      `<description>${esc(clean(html))}</description>`,
      "</item>",
    ].join("\n    ");
  });

  const updated = stories.length
    ? Math.max(...stories.map((s) => dayStart(nextDay(s.day))))
    : now;

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${esc(TITLE)}</title>
    <link>${esc(feedUrl)}</link>
    <description>${esc(DESCRIPTION)}</description>
    <language>en</language>
    <lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>
    <atom:link href="${esc(feedUrl)}" rel="self" type="application/rss+xml"/>
${items.map((i) => `    ${i}`).join("\n")}
  </channel>
</rss>
`;
}

// ---------------------------------------------------------------- dates

/** YYYY-MM-DD in New York for a moment. en-CA formats dates the ISO way. */
export function dayOf(ts: number): string {
  return new Date(ts).toLocaleDateString("en-CA", { timeZone: ZONE });
}

export function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function prevDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** The instant a New York day begins. New York is UTC-4 or UTC-5. */
export function dayStart(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  for (const offset of [5, 4]) {
    const t = Date.UTC(y, m - 1, d, offset);
    const hour = new Date(t).toLocaleString("en-US", {
      timeZone: ZONE,
      hour: "numeric",
      hourCycle: "h23",
    });
    if (dayOf(t) === day && Number(hour) === 0) return t;
  }
  throw new Error(`no midnight found for ${day}`);
}

/** The `n` most recent days that have ended, newest first. */
export function finishedDays(now: number, n: number): string[] {
  const days: string[] = [];
  let day = prevDay(dayOf(now));
  for (let i = 0; i < n; i++, day = prevDay(day)) days.push(day);
  return days;
}

function longDate(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ---------------------------------------------------------------- helpers

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/** WordPress's rendered title is HTML: entities, and sometimes <em>. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code =
          e[1] === "x" || e[1] === "X"
            ? parseInt(e.slice(2), 16)
            : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Characters illegal in XML 1.0; one anywhere breaks the whole document. */
function clean(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : {};
}

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
