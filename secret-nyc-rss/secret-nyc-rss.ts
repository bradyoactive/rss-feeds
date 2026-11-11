/**
 * Proxy for Secret NYC's RSS feed, narrowed to the "Things to do" category.
 *
 * The site is WordPress, so the category has its own real feed and there is
 * nothing to filter: `/things-to-do/feed/` is the canonical URL
 * (`/category/things-to-do/feed/` 301s to it) and it is category id 5,
 * 4686 posts, per `/wp-json/wp/v2/categories?slug=things-to-do`. Verified
 * 2026-09-10: 10 items, every one of them carrying
 * `<category><![CDATA[Things to do]]></category>`.
 *
 * Taking the site's own category feed rather than filtering the mixed one at
 * `/feed/` is what keeps the feed full: the mixed feed is also 10 items, of
 * which only 5 were "Things to do", so filtering it would halve the feed and
 * drop older matching posts that the category feed still carries.
 *
 * This is a passthrough, not a bridge — no parsing, no validation, no
 * rewriting. The one repair on the way through is the control-character strip:
 * an author pasted a DC4 (\x14) into a post, and control characters are
 * illegal in XML 1.0 even inside CDATA, so the whole document failed to parse.
 * That one line is the reason this val exists.
 */

const SOURCE = "https://secretnyc.co/things-to-do/feed/";

export default async function (): Promise<Response> {
  try {
    const response = await fetch(SOURCE, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; ValTown/1.0)",
        "Accept": "application/rss+xml, application/xml, text/xml",
      },
    });

    if (!response.ok) {
      return new Response(`Failed to fetch feed: ${response.statusText}`, {
        status: response.status,
      });
    }

    const xml = await response.text();

    return new Response(
      // deno-lint-ignore no-control-regex
      xml.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ""),
      {
        status: 200,
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          // Cache the result for 30 minutes to reduce load on the target server
          "Cache-Control": "s-maxage=1800, stale-while-revalidate",
        },
      },
    );
  } catch (error) {
    return new Response(`Internal Server Error: ${(error as Error).message}`, {
      status: 500,
    });
  }
}
