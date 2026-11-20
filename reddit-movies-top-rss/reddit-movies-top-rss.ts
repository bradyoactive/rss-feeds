/**
 * RSS feed for the top 25 posts of the week on r/movies.
 *
 * Source: https://www.reddit.com/r/movies/top/?t=week
 *
 * Reddit's listing JSON is the whole source: `/r/movies/top?t=week&limit=25`
 * returns every post with its title, author, flair, score, link, preview
 * image and self-text already rendered to HTML. One request.
 *
 * Reddit refuses anonymous requests from datacenter addresses — the sandbox
 * this was written in got a 403 from www/old/api.reddit.com alike, and a
 * login redirect from old.reddit.com — and Cloudflare's egress is a datacenter
 * address. So the val authenticates when it can:
 *
 *   REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET   a "script" app from
 *     https://www.reddit.com/prefs/apps, used for an app-only
 *     (client_credentials) token against oauth.reddit.com. No user account
 *     is involved and the token only reads public data.
 *
 * Without them it tries the anonymous endpoint anyway and, if Reddit says no,
 * answers 502 with a message naming the two variables.
 *
 * PUBLISHED_AT: `created_utc`, when the post was submitted. Stable, and it
 * keeps a reader's view in posting order even as the ranking reshuffles.
 *
 * Not carried: score and comment count. Both move every few minutes, and an
 * item whose content changes is one FreshRSS rewrites — churn for a number the
 * ranking already expresses by the post being in the feed at all.
 */

import { Feed, type Item } from "feed";

const SUBREDDIT = "movies";
const LIMIT = 25;
const SITE = "https://www.reddit.com";
const LISTING_PATH = `/r/${SUBREDDIT}/top?t=week&limit=${LIMIT}&raw_json=1`;

/**
 * Reddit asks API clients for a unique, descriptive User-Agent and throttles
 * generic ones hardest.
 */
const USER_AGENT = "web:rss-feeds.reddit-movies-top:v1.0 (RSS bridge)";

/**
 * The weekly top list turns over slowly — a post needs hours to climb into it
 * — and FreshRSS polls at most hourly, so an hour costs no timeliness and
 * keeps well clear of Reddit's rate limits.
 */
const CACHE_SECONDS = 60 * 60;

const ID_VAR = "REDDIT_CLIENT_ID";
const SECRET_VAR = "REDDIT_CLIENT_SECRET";

export interface Post {
  /** Reddit's base-36 id, e.g. "1gq3x7a". */
  id: string;
  title: string;
  author: string;
  /** The comments page on reddit.com — the item's identity. */
  permalink: string;
  /** Where a link post points; empty for a self post. */
  url: string;
  isSelf: boolean;
  /** Post flair, e.g. "News", "Trailers", "Review". */
  flair: string;
  /** Self-text as Reddit rendered it, already HTML. */
  selftextHtml: string;
  /** Submission time in ms. */
  createdAt: number;
  image: string;
  imageType: string;
  nsfw: boolean;
  spoiler: boolean;
}

export default async function (
  req: Request,
  env: Record<string, string | undefined> = {},
): Promise<Response> {
  const id = env[ID_VAR]?.trim();
  const secret = env[SECRET_VAR]?.trim();

  let posts: Post[];
  try {
    posts = extractPosts(await fetchListing(id, secret));
  } catch (err) {
    const hint =
      id && secret
        ? ""
        : ` — Reddit blocks anonymous requests from servers; set ${ID_VAR} and ${SECRET_VAR}`;
    return text(502, `Failed to fetch r/${SUBREDDIT} top posts: ${err}${hint}`);
  }

  return buildFeed(posts, new URL(req.url));
}

/** Pure half of the handler: posts in, RSS response out. */
export function buildFeed(posts: Post[], url: URL): Response {
  const xml = renderRss({
    title: `r/${SUBREDDIT} — top of the week`,
    description: `The ${LIMIT} highest-voted posts on r/${SUBREDDIT} over the past week.`,
    siteLink: `${SITE}/r/${SUBREDDIT}/top/?t=week`,
    feedUrl: `${url.origin}${url.pathname}`,
    items: posts,
  });

  return new Response(xml, {
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": `public, max-age=${CACHE_SECONDS}`,
    },
  });
}

async function fetchListing(id?: string, secret?: string): Promise<unknown> {
  const headers: Record<string, string> = {
    "user-agent": USER_AGENT,
    accept: "application/json",
  };
  let base = SITE;
  if (id && secret) {
    headers.authorization = `Bearer ${await token(id, secret)}`;
    base = "https://oauth.reddit.com";
  }
  const res = await fetch(`${base}${LISTING_PATH}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * App-only tokens last a day. An isolate that lives long enough reuses one;
 * one that is recycled just asks again, which is a single cheap request.
 */
let cached: { token: string; expires: number } | null = null;

async function token(id: string, secret: string): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const res = await fetch(`${SITE}/api/v1/access_token`, {
    method: "POST",
    headers: {
      "user-agent": USER_AGENT,
      authorization: `Basic ${btoa(`${id}:${secret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`token request: HTTP ${res.status}`);
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) throw new Error("token request: no access_token");
  cached = {
    token: body.access_token,
    expires: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return cached.token;
}

/**
 * Reads a Reddit Listing. Only links (`t3`) are posts; stickied announcements
 * are dropped because the mods pin them regardless of votes, and the feed is
 * about what the sub voted up.
 */
export function extractPosts(payload: unknown): Post[] {
  const children = list(obj(obj(payload)?.data)?.children);
  const seen = new Set<string>();
  const posts: Post[] = [];

  for (const child of children) {
    if (child.kind !== "t3") continue;
    const d = obj(child.data);
    if (!d) continue;

    const id = str(d.id);
    const title = str(d.title);
    const permalink = str(d.permalink);
    if (!id || !title || !permalink || seen.has(id) || d.stickied === true) {
      continue;
    }
    seen.add(id);

    const isSelf = d.is_self === true;
    const image = previewImage(d);
    const created = Number(d.created_utc);

    posts.push({
      id,
      title,
      author: str(d.author),
      permalink: new URL(permalink, SITE).href,
      url: isSelf ? "" : str(d.url_overridden_by_dest) || str(d.url),
      isSelf,
      flair: str(d.link_flair_text),
      selftextHtml: str(d.selftext_html),
      createdAt: Number.isFinite(created) ? created * 1000 : 0,
      image,
      imageType: mediaType(image),
      nsfw: d.over_18 === true,
      spoiler: d.spoiler === true,
    });
  }

  return posts.slice(0, LIMIT);
}

/**
 * The full-size preview, else the thumbnail when it is a real URL rather than
 * one of Reddit's placeholders ("self", "default", "nsfw", "spoiler").
 * Spoiler and NSFW posts get no image: Reddit blurs them, and a feed reader
 * would not.
 */
function previewImage(d: Record<string, unknown>): string {
  if (d.over_18 === true || d.spoiler === true) return "";
  const first = list(obj(d.preview)?.images)[0];
  const src = str(obj(first?.source)?.url);
  if (src.startsWith("https://")) return src;
  const thumb = str(d.thumbnail);
  return thumb.startsWith("https://") ? thumb : "";
}

export function renderRss(feed: {
  title: string;
  description: string;
  siteLink: string;
  feedUrl: string;
  items: Post[];
}): string {
  const dates = feed.items.map((p) => p.createdAt).filter(Boolean);
  const out = new Feed({
    title: clean(feed.title),
    description: clean(feed.description),
    link: feed.siteLink,
    language: "en",
    updated: new Date(dates.length ? Math.max(...dates) : Date.now()),
    feedLinks: { rss: feed.feedUrl },
    generator: false,
  });

  // Ranking order, as Reddit returned it: that is the point of a top list.
  for (const p of feed.items) {
    out.addItem({
      title: clean(p.spoiler ? `[Spoiler] ${p.title}` : p.title),
      link: p.permalink,
      ...(p.createdAt ? { date: new Date(p.createdAt) } : {}),
      description: clean(describe(p)),
      author: p.author ? [{ name: `u/${clean(p.author)}` }] : undefined,
      category: p.flair ? [{ name: clean(p.flair) }] : [],
      image: p.image
        ? { url: p.image, type: p.imageType || undefined }
        : undefined,
    } as Item);
  }

  return out.rss2();
}

/** HTML body: where a link post points, then the image, then any self-text. */
function describe(p: Post): string {
  const parts: string[] = [];
  if (p.url && !p.url.startsWith(p.permalink)) {
    const host = hostOf(p.url);
    parts.push(
      `<p><a href="${esc(p.url)}">${esc(host ? `Link: ${host}` : p.url)}</a></p>`,
    );
  }
  if (p.image) parts.push(`<p><img src="${esc(p.image)}" alt=""></p>`);
  if (p.selftextHtml && !p.spoiler) parts.push(p.selftextHtml);
  parts.push(`<p><a href="${esc(p.permalink)}">Comments on Reddit</a></p>`);
  return parts.join("\n");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function mediaType(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {}
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (!ext) return "";
  return `image/${ext === "jpg" ? "jpeg" : ext}`;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(obj).filter((x) => x !== null) : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Strips characters illegal in XML 1.0, which the feed library passes through. */
function clean(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
