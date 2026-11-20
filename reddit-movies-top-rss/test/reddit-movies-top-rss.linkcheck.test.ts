/**
 * Live checks for the r/movies top-of-the-week feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/reddit-movies-top-rss.linkcheck.test.ts
 *
 * Reddit refuses anonymous requests from most servers. Set REDDIT_CLIENT_ID and
 * REDDIT_CLIENT_SECRET to run these anywhere; without them they run only from
 * an address Reddit lets through.
 */

import handler from "../reddit-movies-top-rss.ts";
import { liveTest } from "../../common/linkcheck.ts";

const env = {
  REDDIT_CLIENT_ID: process.env.REDDIT_CLIENT_ID,
  REDDIT_CLIENT_SECRET: process.env.REDDIT_CLIENT_SECRET,
};

liveTest("the feed fetches and lists 25 posts", async () => {
  const res = await handler(
    new Request("https://feeds.example/reddit-movies-top-rss"),
    env,
  );
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body}`);
  const items = body.match(/<item>/g)?.length ?? 0;
  if (items < 20) throw new Error(`only ${items} items — suspiciously few`);
});
