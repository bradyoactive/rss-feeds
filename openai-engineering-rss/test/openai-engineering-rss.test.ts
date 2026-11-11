/**
 * Offline tests for the OpenAI engineering feed. The fixture is a capture of
 * https://openai.com/news/rss.xml cut down to ten items, four of them tagged
 * Engineering, with the channel header and closing tags left as captured.
 *
 * Run: node --test test/openai-engineering-rss.test.ts
 */

import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { XMLValidator } from "fast-xml-parser";
import {
  engineeringOnly,
  inCategory,
  rewriteChannel,
} from "../openai-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const news = await readFile(
  new URL("./openai-news-trimmed.xml", import.meta.url),
  "utf8",
);
const out = engineeringOnly(news);
const items = (xml: string) => xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];

test("keeps exactly the Engineering items, byte for byte", () => {
  const kept = items(out);
  assertEquals(kept.length, 4, "engineering items");
  const source = items(news).filter((i) => i.includes("[Engineering]"));
  assertEquals(kept, source, "items copied unchanged and in order");
});

test("the result is well-formed XML", () => {
  assertEquals(XMLValidator.validate(out), true, "XMLValidator");
});

test("describes the engineering feed, not the full news feed", () => {
  const head = out.slice(0, out.indexOf("<item>"));
  assert(
    head.includes("<title><![CDATA[OpenAI Engineering News]]></title>"),
    "title",
  );
  assert(
    head.includes(
      "<description><![CDATA[The OpenAI engineering blog]]></description>",
    ),
    "description",
  );
  assert(
    head.includes("<link>https://openai.com/news/engineering</link>"),
    "link",
  );
  assert(
    head.includes(
      'href="https://openai.com/news/engineering/rss.xml" rel="self"',
    ),
    "self link",
  );
  assert(
    !head.includes("<image>"),
    "no <image>, as the engineering feed has none",
  );
  assert(!head.includes("OpenAI News"), "nothing left of the news channel");
});

test("keeps the document's namespaces and closing tags", () => {
  assert(out.startsWith(news.slice(0, news.indexOf("<channel>"))), "prolog");
  assert(out.trimEnd().endsWith("</channel>\n</rss>"), "closing tags");
});

test("matches the category exactly, CDATA-wrapped or not", () => {
  const item = (c: string) => `<item><category>${c}</category></item>`;
  assert(inCategory(item("<![CDATA[Engineering]]>"), "Engineering"), "CDATA");
  assert(inCategory(item("Engineering"), "Engineering"), "plain");
  assert(
    !inCategory(item("<![CDATA[Engineering Leadership]]>"), "Engineering"),
    "prefix",
  );
  assert(!inCategory(item("<![CDATA[Research]]>"), "Engineering"), "other");
  assert(
    inCategory(
      "<item><category>Research</category><category>Engineering</category></item>",
      "Engineering",
    ),
    "second of several",
  );
});

test("an empty selection still renders a valid channel", () => {
  const none = news.replaceAll("[Engineering]", "[Research]");
  const xml = engineeringOnly(none);
  assertEquals(items(xml).length, 0, "no items");
  assertEquals(XMLValidator.validate(xml), true, "XMLValidator");
});

test("refuses a document with no items rather than guessing", () => {
  let threw = false;
  try {
    engineeringOnly("<html><body>challenge</body></html>");
  } catch {
    threw = true;
  }
  assert(threw, "should throw");
});

test("rewriteChannel leaves an item-free header alone apart from the channel fields", () => {
  const head = news.slice(0, news.indexOf("<item>"));
  const rewritten = rewriteChannel(head);
  assert(rewritten.includes("<generator>OpenAI</generator>"), "generator kept");
  assert(rewritten.includes("<language>"), "language kept");
});
