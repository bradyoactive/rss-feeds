/**
 * Live check for the top movie stories feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/movie-top-stories-rss.linkcheck.test.ts
 *
 * Each source's REST API must still answer, still honour its film filter, and
 * still return posts for yesterday; then the links the feed would publish
 * must be served.
 */

import {
  dayStart,
  extractPosts,
  finishedDays,
  nextDay,
  SOURCES,
  topStories,
  type Post,
} from "../movie-top-stories-rss.ts";
import { assert } from "../../common/assert.ts";
import {
  assertAllServed,
  isChallenged,
  liveTest,
} from "../../common/linkcheck.ts";

const [yesterday] = finishedDays(Date.now(), 1);
const after = new Date(dayStart(yesterday)).toISOString();
const before = new Date(dayStart(nextDay(yesterday))).toISOString();

const posts: Post[] = [];

for (const s of SOURCES) {
  liveTest(`${s.name} answers with yesterday's film posts`, async () => {
    const url =
      `${s.site}/wp-json/wp/v2/posts?after=${after}&before=${before}` +
      `&per_page=100&_fields=id,date_gmt,link,title` +
      (s.filter ? `&${s.filter}` : "");
    const res = await fetch(url);
    assert(res.ok, `${s.name} answered ${res.status}`);
    const rows = extractPosts(await res.json(), s.key);
    assert(rows.length >= 3, `${s.name} returned only ${rows.length} posts`);
    posts.push(...rows);
  });
}

liveTest("yesterday has three stories and their links are served", async () => {
  const stories = topStories(posts, yesterday);
  assert(stories.length === 3, `only ${stories.length} stories`);

  // JoBlo's article pages sit behind a Cloudflare bot challenge that 403s
  // every automated request, real path or not (its REST API does not), so
  // those links prove nothing either way and are left out.
  const links = stories.flatMap((s) => s.posts.map((p) => p.link));
  const hosts = [...new Set(links.map((l) => new URL(l).origin))];
  const challenged = new Set<string>();
  for (const h of hosts) if (await isChallenged(`${h}/`)) challenged.add(h);
  const checkable = links.filter((l) => !challenged.has(new URL(l).origin));
  assert(checkable.length > 0, "every story link is on a challenged host");
  await assertAllServed(checkable, "story links");
});
