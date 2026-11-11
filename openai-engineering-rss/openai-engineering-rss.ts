/**
 * The OpenAI engineering blog's RSS feed, rebuilt from OpenAI's full news feed.
 *
 * OpenAI publishes the engineering feed itself at /news/engineering/rss.xml,
 * but Cloudflare bot management answers almost every client there with a 403
 * challenge. What it lets through is decided by the client's TLS fingerprint,
 * not its network or headers: Deno got through, which is why this was once a
 * plain passthrough on val.town, while Node, curl, PHP and Cloudflare Workers
 * are all challenged, from any network.
 *
 * The full news feed at /news/rss.xml is not challenged, and it tags every item
 * with its category. Keeping the items tagged "Engineering" reproduces the
 * engineering feed exactly — measured 2026-11-11: 23 of 23 links, none extra.
 * So this fetches the full feed (about 840 KB, every post OpenAI has published)
 * and cuts it down with plain string scanning rather than an XML parse, which
 * keeps the CPU cost of a big document small.
 *
 * Items are copied through byte for byte; only the channel header is rewritten
 * to describe the engineering feed. Control characters are stripped on the way
 * out, as before: they are illegal in XML 1.0 even inside CDATA, so a single
 * one upstream would make the whole document unparseable.
 */

const SOURCE = "https://openai.com/news/rss.xml";

/** OpenAI's own spelling of the category the engineering feed is built from. */
const CATEGORY = "Engineering";

/** How the engineering feed's own channel describes itself. */
const CHANNEL = {
  title: "OpenAI Engineering News",
  description: "The OpenAI engineering blog",
  link: "https://openai.com/news/engineering",
  self: "https://openai.com/news/engineering/rss.xml",
};

export default async function (): Promise<Response> {
  const res = await fetch(SOURCE, {
    headers: {
      accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
      "user-agent": "openai-rss-proxy (+https://feeds.brady.town)",
    },
  });
  const xml = await res.text();

  if (!res.ok) {
    return text(502, `Upstream ${res.status} from ${SOURCE}`);
  }

  let out: string;
  try {
    out = engineeringOnly(xml);
  } catch (err) {
    return text(502, `Unexpected feed from ${SOURCE}: ${err}`);
  }

  return new Response(out.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ""), {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}

/**
 * The full news feed cut down to its Engineering items, with the channel
 * header rewritten to match the engineering feed's. Everything before the
 * first item and after the last one is kept, so namespaces, <image>,
 * <language> and the closing tags survive untouched.
 */
export function engineeringOnly(xml: string): string {
  const first = xml.indexOf("<item>");
  const lastClose = xml.lastIndexOf("</item>");
  if (first < 0 || lastClose < first) {
    throw new Error("no <item> elements");
  }
  const head = xml.slice(0, first);
  const tail = xml.slice(lastClose + "</item>".length);

  const kept: string[] = [];
  let at = first;
  while (at >= 0 && at < lastClose) {
    const end = xml.indexOf("</item>", at);
    if (end < 0) break;
    const item = xml.slice(at, end + "</item>".length);
    if (inCategory(item, CATEGORY)) kept.push(item);
    at = xml.indexOf("<item>", end);
  }

  // Keep the indentation the source used between items.
  const gap = /\n[ \t]*$/.exec(head)?.[0] ?? "\n";
  return rewriteChannel(head) + kept.join(gap) + tail;
}

/** Whether an item carries `<category>name</category>`, CDATA-wrapped or not. */
export function inCategory(item: string, name: string): boolean {
  for (const m of item.matchAll(/<category\b[^>]*>([\s\S]*?)<\/category>/g)) {
    const value = m[1]
      .replace(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/, "$1")
      .trim();
    if (value === name) return true;
  }
  return false;
}

/**
 * Points the channel's title, description and links at the engineering feed,
 * and drops the <image> block, which the engineering feed does not carry.
 */
export function rewriteChannel(head: string): string {
  return head
    .replace(/\n?[ \t]*<image>[\s\S]*?<\/image>/, "")
    .replace(
      /<title>[\s\S]*?<\/title>/,
      `<title><![CDATA[${CHANNEL.title}]]></title>`,
    )
    .replace(
      /<description>[\s\S]*?<\/description>/,
      `<description><![CDATA[${CHANNEL.description}]]></description>`,
    )
    .replace(/<link>[^<]*<\/link>/, `<link>${CHANNEL.link}</link>`)
    .replace(
      /(<atom:link\b[^>]*\bhref=")[^"]*("[^>]*rel="self")/,
      `$1${CHANNEL.self}$2`,
    );
}

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
