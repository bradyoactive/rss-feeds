/**
 * Live check for the OpenAI engineering feed. See ../../common/linkcheck.ts.
 *
 *   LIVE=1 node --test test/openai-engineering-rss.linkcheck.test.ts
 */

import { engineeringOnly } from "../openai-engineering-rss.ts";
import { assert } from "../../common/assert.ts";
import { liveTest } from "../../common/linkcheck.ts";

liveTest(
  "the full news feed is served and still tags Engineering posts",
  async () => {
    const res = await fetch("https://openai.com/news/rss.xml");
    assert(res.ok, `news feed answered ${res.status}`);
    const kept = engineeringOnly(await res.text()).match(/<item>/g) ?? [];
    assert(kept.length >= 10, `only ${kept.length} Engineering items`);
  },
);
