/**
 * Proxy for the OpenAI engineering blog's RSS feed.
 *
 * The feed is fine; it is Cloudflare bot management that answers a reader with
 * a 403 challenge. val.town egress is not challenged, so this just fetches it.
 *
 * **The fetch has to state headers, and that is the whole trick.** A bare
 * `fetch(SOURCE)` from val.town is challenged exactly like a reader is — 403,
 * `cf-mitigated: challenge`, 9.9 KB of branded interstitial that looks enough
 * like an OpenAI error page to read as "they took the feed down". Passing any
 * `headers` init at all gets a 200 back, deterministically: measured 12/12
 * against both this feed and the DoorDash one, which broke the same day for the
 * same reason. Deno sends the identical header *values* either way — an echo
 * server sees the same wildcard Accept header from both — so what Cloudflare
 * fingerprints is the shape of the request Deno emits when the caller supplies
 * headers, not anything readable in them. That makes the block below
 * load-bearing and non-obvious: deleting it looks like tidying, and silently
 * returns the feed to serving an HTML challenge page.
 *
 * The per-category feed is real and still published — /news/engineering/rss.xml
 * answers with 19 items. The firehose at /news/rss.xml is 717 KB of everything
 * OpenAI writes and does tag its items, so it would serve as a fallback, but
 * there is nothing to fall back from while the narrow one exists.
 *
 * Two repairs on the way through, and no more — this is a passthrough, not a
 * bridge, so it gets no parsing, no validation and no rewriting:
 *
 *  - A failed fetch is reported as a failure. It used to hand the challenge
 *    page straight to the reader under a 200 and an
 *    "application/rss+xml" label, which is how this stayed broken quietly.
 *  - Control characters are stripped. They are illegal in XML 1.0 even inside
 *    CDATA, so one pasted into a post anywhere upstream makes the whole
 *    document unparseable. This cost the DoorDash proxy a feed once; it is one
 *    line, and it is the only transformation worth making on a passthrough.
 */

const SOURCE = "https://openai.com/news/engineering/rss.xml";

export default async function (): Promise<Response> {
  const res = await fetch(SOURCE, {
    headers: {
      accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.8",
      "user-agent": "openai-rss-proxy (+https://val.town)",
    },
  });
  const xml = await res.text();

  if (!res.ok) {
    return new Response(`Upstream ${res.status} from ${SOURCE}`, {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(xml.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ""), {
    headers: { "content-type": "application/rss+xml; charset=utf-8" },
  });
}
