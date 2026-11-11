/**
 * Offline tests for the Samsara feed. Fixtures are real captures — refresh with:
 *
 *   curl -sL "https://www.samsara.com/blog/category/engineering-at-samsara" \
 *     -o samsara-engineering.html
 *   curl -sL -H "Authorization: Bearer $SAMSARA_CTFL_TOKEN" \
 *     "https://cdn.contentful.com/spaces/bx9krvy0u3sx/environments/master/entries?content_type=blogPost&order=-fields.publishDate&include=2&limit=50&fields.blogCategory%5Bin%5D=Engineering%20At%20Samsara" \
 *     -o samsara-contentful-engineering.json
 *
 * Run: deno test --allow-read test/samsara-engineering-rss.test.ts
 */

import handler, {
  buildFeed,
  extractCredentials,
  extractPosts,
  type Post,
  renderRss,
} from "../samsara-engineering-rss.ts";
import { assert, assertEquals } from "../../common/assert.ts";

const pageHtml = await Deno.readTextFile(
  new URL("./samsara-engineering.html", import.meta.url),
);
const payload = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "./samsara-contentful-engineering.json",
      import.meta.url,
    ),
  ),
);
const posts = extractPosts(payload);

Deno.test("extracts every post in the category", () => {
  // `total` is 15 and the request asked for 50, so there is no page to follow.
  assertEquals(payload.total, posts.length, "no unread page of entries");
  assertEquals(posts.length, 15, "post count");
  assert(
    posts.every((p) => p.slug && p.title && p.ts && p.description),
    "every post has a slug, title, date and description",
  );
  assertEquals(
    new Set(posts.map((p) => p.slug)).size,
    posts.length,
    "slugs are unique",
  );

  const first = posts[0];
  assertEquals(
    first.slug,
    "from-reports-to-real-time-intervention-building-a-voice-agent-for-missed-vehicle-inspections",
    "slug",
  );
  // publishDate is date-only, so the entry lands on UTC midnight.
  assertEquals(first.ts, Date.parse("2026-08-12T00:00:00Z"), "ts");
  assert(
    first.description.startsWith("How Samsara engineers built"),
    "description comes from metaDescription",
  );
});

Deno.test("resolves author and categories through includes", () => {
  assert(posts.every((p) => p.author), "every post has an author");
  assertEquals(posts[0].author, "Praveen Murugesan", "author");
  assertEquals(posts[0].categories, ["Engineering At Samsara"], "categories");

  // Posts routinely carry a second category, and every one carries the filter.
  assert(
    posts.every((p) => p.categories.includes("Engineering At Samsara")),
    "every post is in the requested category",
  );
  assert(
    posts.some((p) => p.categories.includes("Life At Samsara")),
    "second category survives",
  );
});

Deno.test("absolutizes asset URLs and takes their declared type", () => {
  assert(
    posts.every((p) =>
      p.image.startsWith("https://images.ctfassets.net/bx9krvy0u3sx/")
    ),
    "protocol-relative asset URLs are made absolute",
  );
  assertEquals(
    posts[0].image,
    "https://images.ctfassets.net/bx9krvy0u3sx/3ftEKwk8o4kjBcmiPaY6xL/64a6ee6226f1079c30536babfcf25ce3/field_notes_2_meta_image1.png",
    "image URL",
  );
  // Taken from the asset's own file metadata, not guessed from the extension.
  assertEquals(posts[0].imageType, "image/png", "image type");
  assert(
    posts.some((p) => p.imageType === "image/jpeg"),
    "types vary by asset",
  );
});

Deno.test("degrades on an entry missing its optional fields", () => {
  const bare = extractPosts({
    items: [
      { sys: { id: "1" }, fields: { title: "No slug" } },
      {
        sys: { id: "2" },
        fields: {
          title: "Bare",
          blogPageSlug: "bare",
          // Links whose targets never made it into `includes`.
          author: { sys: { id: "gone", linkType: "Entry" } },
          metaImage: { sys: { id: "gone", linkType: "Asset" } },
        },
      },
    ],
  });

  assertEquals(bare.length, 1, "the untitled/unslugged entry is dropped");
  assertEquals(bare[0], {
    slug: "bare",
    title: "Bare",
    description: "",
    ts: null,
    author: "",
    image: "",
    imageType: "",
    categories: [],
  }, "bare post");
  assertEquals(extractPosts({}).length, 0, "an empty payload yields nothing");
});

Deno.test("falls back from metaDescription and metaImage", () => {
  const [post] = extractPosts({
    items: [{
      sys: { createdAt: "2025-01-02T03:04:05Z" },
      fields: {
        title: "T",
        blogPageSlug: "t",
        summary: "Opening paragraph.",
        backgroundImage: { sys: { id: "hdr", linkType: "Asset" } },
      },
    }],
    includes: {
      Asset: [{
        sys: { id: "hdr" },
        fields: {
          file: {
            url: "//images.ctfassets.net/x/h.jpg",
            contentType: "image/jpeg",
          },
        },
      }],
    },
  });

  assertEquals(
    post.description,
    "Opening paragraph.",
    "summary as description",
  );
  assertEquals(
    post.image,
    "https://images.ctfassets.net/x/h.jpg",
    "header image",
  );
  assertEquals(
    post.ts,
    Date.parse("2025-01-02T03:04:05Z"),
    "createdAt as date",
  );
});

Deno.test("reads Contentful credentials from the Nuxt config blob", () => {
  assertEquals(extractCredentials(pageHtml), {
    spaceId: "bx9krvy0u3sx",
    accessToken:
      "9247925a3764b651e63f560743ccc11a2f3d8d478143e2431409232986436f5f",
    environment: "master",
  }, "credentials");

  // The flattened pair is the same credentials, and outlives a nesting change.
  assertEquals(
    extractCredentials(
      'window.__NUXT__.config={public:{ctflProdSpaceId:"sp",ctflAccessToken:"tok"}}',
    ),
    { spaceId: "sp", accessToken: "tok", environment: "master" },
    "flattened credentials, default environment",
  );
  assertEquals(
    extractCredentials("<html>no config here</html>"),
    null,
    "nothing to discover",
  );
});

const feed = async (query = "") => {
  const res = buildFeed(posts, new URL(`https://feed.val.run/samsara${query}`));
  return { status: res.status, body: await res.text() };
};

const itemCount = (xml: string) => (xml.match(/<item>/g) ?? []).length;

Deno.test("serves the feed", async () => {
  const { status, body } = await feed("");
  assertEquals(status, 200, "status");
  assertEquals(itemCount(body), 15, "all posts");
  assert(
    body.includes("<title>Samsara Blog — Engineering At Samsara</title>"),
    "channel title",
  );
  assert(
    body.includes(
      "<link>https://www.samsara.com/blog/category/engineering-at-samsara</link>",
    ),
    "channel link",
  );
  assert(
    body.includes(
      '<guid isPermaLink="true">https://www.samsara.com/blog/advancing-industrial-asset-tracking</guid>',
    ),
    "item guid",
  );
  assert(
    body.includes("<category>Engineering At Samsara</category>"),
    "category",
  );
  assert(
    body.includes("<author>Praveen Murugesan</author>"),
    "byline",
  );
});

Deno.test("orders items newest first", async () => {
  const dates = [...(await feed("")).body.matchAll(/<pubDate>([^<]+)</g)].map((
    m,
  ) => Date.parse(m[1]));
  assertEquals(dates, [...dates].sort((a, b) => b - a), "descending by date");
});

Deno.test("self-link is canonical, ignoring junk query params", async () => {
  // ?category= and ?limit= are gone; passing them should change nothing.
  const { body } = await feed("?category=safety&limit=5&utm_source=x");
  assert(
    body.includes('href="https://feed.val.run/samsara" rel="self"'),
    "bare self-link",
  );
  assertEquals(itemCount(body), 15, "params ignored");
});

const SITE_LINK =
  "https://www.samsara.com/blog/category/engineering-at-samsara";
const FEED_URL = "https://feed.val.run/samsara";
const SAMPLE_ITEM: Post = {
  slug: "s",
  title: "Tom & Jerry <live>",
  description: 'He said "hi"',
  ts: Date.parse("2026-08-12T00:00:00Z"),
  author: "Ada & Grace",
  image: "https://images.ctfassets.net/x/y.png",
  imageType: "image/png",
  categories: ["Engineering At Samsara"],
};

Deno.test("renders XML-safe output", () => {
  const bell = String.fromCharCode(7);
  const xml = renderRss({
    title: "Feed & <friends>",
    description: 'Quote " and control',
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [SAMPLE_ITEM],
  });

  // The library wraps text in CDATA rather than escaping entities, so the
  // characters that used to need escaping now appear verbatim — what matters is
  // that they cannot terminate the section early.
  assert(
    xml.includes("<![CDATA[Tom & Jerry <live>]]>"),
    "item title survives verbatim inside CDATA",
  );
  assert(!xml.includes("]]]]"), "no stray CDATA breakout in ordinary text");
  assert(
    xml.includes("<pubDate>"),
    "RFC-822 pubDate",
  );
  // Control characters are illegal in XML 1.0 and the library does not strip
  // them, so the val must — one anywhere breaks the whole document.
  const dirty = renderRss({
    title: `T${bell}`,
    description: "d",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE_ITEM, title: `Bell${bell}here` }],
  });
  // deno-lint-ignore no-control-regex
  assert(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(dirty), "control chars stripped");
  assert(dirty.includes("Bellhere"), "and the rest of the title is kept");
});

Deno.test("a CDATA breakout in the source cannot escape the section", () => {
  // "]]>" inside a title would end the CDATA early and corrupt the document;
  // the library splits it, and this pins that it still does.
  const xml = renderRss({
    title: "T",
    description: "d",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [{ ...SAMPLE_ITEM, title: "before ]]> after" }],
  });
  assert(xml.includes("]]]]><![CDATA[>"), "breakout split");
  assert(!/\]\]>\s*after/.test(xml), "no early termination");
});
Deno.test("omits optional elements when the post lacks them", () => {
  const xml = renderRss({
    title: "T",
    description: "D",
    siteLink: "https://www.samsara.com/blog",
    feedUrl: "https://www.samsara.com/blog",
    items: [{
      slug: "bare",
      title: "Bare",
      description: "",
      ts: null,
      author: "",
      image: "",
      imageType: "",
      categories: [],
    }],
  });

  for (const tag of ["pubDate", "category", "dc:creator", "media:content"]) {
    assert(!xml.includes(`<${tag}`), `omits <${tag}> when empty`);
  }
  assertEquals(
    xml.match(/<description>/g)?.length,
    1,
    "only the channel description",
  );
});

Deno.test("emits an enclosure without a type when the asset had none", () => {
  // Contentful normally states contentType; when it does not, the library is
  // left to infer, and the item must still carry its image.
  const [post] = extractPosts({
    items: [{
      sys: { createdAt: "2026-01-01" },
      fields: {
        title: "T",
        blogPageSlug: "t",
        metaImage: { sys: { id: "a", linkType: "Asset" } },
      },
    }],
    includes: {
      Asset: [{
        sys: { id: "a" },
        fields: { file: { url: "//images.ctfassets.net/x/y" } },
      }],
    },
  });
  assertEquals(post.imageType, "", "no declared type");

  const xml = renderRss({
    title: "T",
    description: "D",
    siteLink: SITE_LINK,
    feedUrl: FEED_URL,
    items: [post],
  });
  assert(
    xml.includes('url="https://images.ctfassets.net/x/y"'),
    "the image is still emitted",
  );
});
/**
 * The token-rotation path, driven through a stubbed fetch so it stays offline.
 * Records every request so the tests can assert on which hosts were touched and
 * in what order — the whole point of the design is that the blog is *not*
 * touched unless Contentful rejects the baked-in token.
 */
function stubFetch(reply: (url: string, token: string) => Response) {
  const calls: Array<{ url: string; token: string }> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const token = String(
      (init?.headers as Record<string, string>)?.authorization ?? "",
    ).replace("Bearer ", "");
    calls.push({ url, token });
    return Promise.resolve(reply(url, token));
  };
  return { calls, restore: () => (globalThis.fetch = real) };
}

const CDN = "https://cdn.contentful.com";
const SITE = "https://www.samsara.com";
const BAKED =
  "9247925a3764b651e63f560743ccc11a2f3d8d478143e2431409232986436f5f";
const ROTATED =
  "f00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeed";

const entriesJson = () =>
  new Response(
    JSON.stringify({
      items: [{
        sys: { createdAt: "2026-01-01" },
        fields: {
          blogPageSlug: "s",
          title: "T",
          publishDate: "2026-01-01",
          blogCategory: ["Engineering At Samsara"],
        },
      }],
    }),
    { status: 200 },
  );

const unauthorized = () =>
  new Response(JSON.stringify({ sys: { id: "AccessTokenInvalid" } }), {
    status: 401,
  });

Deno.test("the happy path never touches the blog", async () => {
  const { calls, restore } = stubFetch(() => entriesJson());
  try {
    const res = await handler(new Request("https://feed.val.run/samsara"));
    assertEquals(res.status, 200, "status");
    assertEquals(calls.length, 1, "exactly one upstream request");
    assert(calls[0].url.startsWith(CDN), "and it went to Contentful");
    assertEquals(calls[0].token, BAKED, "using the baked-in token");
  } finally {
    restore();
  }
});

Deno.test("a rejected token is re-read from the blog and retried", async () => {
  // Contentful accepts only the rotated token; the blog now advertises it.
  const { calls, restore } = stubFetch((url, token) => {
    if (url.startsWith(CDN)) {
      return token === ROTATED ? entriesJson() : unauthorized();
    }
    return new Response(
      `<script>window.__NUXT__={};window.__NUXT__.config={public:{ctfl:{spaceId:"bx9krvy0u3sx",accessToken:"${ROTATED}",environment:"master"}}}</script>`,
      { status: 200 },
    );
  });
  try {
    const res = await handler(new Request("https://feed.val.run/samsara"));
    assertEquals(res.status, 200, "recovered");
    assertEquals(calls.length, 3, "401, then the page, then a retry");
    assertEquals(calls[0].token, BAKED, "tries the baked-in token first");
    assert(calls[1].url.startsWith(SITE), "falls back to the blog page");
    assertEquals(calls[2].token, ROTATED, "retries with the rotated token");
    assert((await res.text()).includes("<item>"), "and serves a real feed");
  } finally {
    restore();
  }
});

Deno.test("a rotation the blog cannot explain fails loudly", async () => {
  // 401 everywhere and a page with no credentials in it: better a 502 than an
  // empty feed that looks like Samsara stopped publishing.
  const { calls, restore } = stubFetch((url) =>
    url.startsWith(CDN)
      ? unauthorized()
      : new Response("<html>no config here</html>", { status: 200 })
  );
  try {
    const res = await handler(new Request("https://feed.val.run/samsara"));
    assertEquals(res.status, 502, "surfaced, not swallowed");
    assertEquals(calls.length, 2, "one 401 and one look at the page");
    assert((await res.text()).includes("401"), "the body names the cause");
  } finally {
    restore();
  }
});
