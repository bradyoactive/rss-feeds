/**
 * Cloudflare Workers entry point. Each feed keeps its own directory and its
 * own default-exported handler; this file only routes `/<feed-name>` to it.
 */

import oneIotaNycRss from "./1iota-nyc-rss/1iota-nyc-rss.ts";
import anthropicEngineeringRss from "./anthropic-engineering-rss/anthropic-engineering-rss.ts";
import asanaEngineeringRss from "./asana-engineering-rss/asana-engineering-rss.ts";
import balkonQaRss from "./balkon-qa-rss/balkon-qa-rss.ts";
import figmaEngineeringRss from "./figma-engineering-rss/figma-engineering-rss.ts";
import filmspotlightRss from "./filmspotlight-rss/filmspotlight-rss.ts";
import harveyTechnicalRss from "./harvey-technical-rss/harvey-technical-rss.ts";
import hexEngineeringRss from "./hex-engineering-rss/hex-engineering-rss.ts";
import honeycombEngineeringRss from "./honeycomb-engineering-rss/honeycomb-engineering-rss.ts";
import linkedinEngineeringRss from "./linkedin-engineering-rss/linkedin-engineering-rss.ts";
import lovableRss from "./lovable-rss/lovable-rss.ts";
import mercuryEngRss from "./mercury-eng-rss/mercury-eng-rss.ts";
import mistralNewsRss from "./mistral-news-rss/mistral-news-rss.ts";
import modalEngineeringRss from "./modal-engineering-rss/modal-engineering-rss.ts";
import movieTopStoriesRss from "./movie-top-stories-rss/movie-top-stories-rss.ts";
import notionEngineeringRss from "./notion-engineering-rss/notion-engineering-rss.ts";
import openaiEngineeringRss from "./openai-engineering-rss/openai-engineering-rss.ts";
import pigeonsAndPlanesRss from "./pigeons-and-planes-rss/pigeons-and-planes-rss.ts";
import posthogEngineeringRss from "./posthog-engineering-rss/posthog-engineering-rss.ts";
import retoolEngineeringRss from "./retool-engineering-rss/retool-engineering-rss.ts";
import ripplingEngineeringRss from "./rippling-engineering-rss/rippling-engineering-rss.ts";
import robinhoodTechRss from "./robinhood-tech-rss/robinhood-tech-rss.ts";
import samsaraEngineeringRss from "./samsara-engineering-rss/samsara-engineering-rss.ts";
import secretNycRss from "./secret-nyc-rss/secret-nyc-rss.ts";
import shopifyEngineeringRss from "./shopify-engineering-rss/shopify-engineering-rss.ts";
import slickdealsSearchRss from "./slickdeals-search-rss/slickdeals-search-rss.ts";
import snapEngineeringRss from "./snap-engineering-rss/snap-engineering-rss.ts";
import snowflakeEngineeringRss from "./snowflake-engineering-rss/snowflake-engineering-rss.ts";
import stripeEngineeringRss from "./stripe-engineering-rss/stripe-engineering-rss.ts";
import traderjoesVeganFoodRss from "./traderjoes-vegan-food-rss/traderjoes-vegan-food-rss.ts";
import uberBackendRss from "./uber-backend-rss/uber-backend-rss.ts";

type Handler = (
  req: Request,
  env: Record<string, string | undefined>,
) => Promise<Response>;

const feeds: Record<string, Handler> = {
  "1iota-nyc-rss": oneIotaNycRss,
  "anthropic-engineering-rss": anthropicEngineeringRss,
  "asana-engineering-rss": asanaEngineeringRss,
  "balkon-qa-rss": balkonQaRss,
  "figma-engineering-rss": figmaEngineeringRss,
  "filmspotlight-rss": filmspotlightRss,
  "harvey-technical-rss": harveyTechnicalRss,
  "hex-engineering-rss": hexEngineeringRss,
  "honeycomb-engineering-rss": honeycombEngineeringRss,
  "linkedin-engineering-rss": linkedinEngineeringRss,
  "lovable-rss": lovableRss,
  "mercury-eng-rss": mercuryEngRss,
  "mistral-news-rss": mistralNewsRss,
  "modal-engineering-rss": modalEngineeringRss,
  "movie-top-stories-rss": movieTopStoriesRss,
  "notion-engineering-rss": notionEngineeringRss,
  "openai-engineering-rss": openaiEngineeringRss,
  "pigeons-and-planes-rss": pigeonsAndPlanesRss,
  "posthog-engineering-rss": posthogEngineeringRss,
  "retool-engineering-rss": retoolEngineeringRss,
  "rippling-engineering-rss": ripplingEngineeringRss,
  "robinhood-tech-rss": robinhoodTechRss,
  "samsara-engineering-rss": samsaraEngineeringRss,
  "secret-nyc-rss": secretNycRss,
  "shopify-engineering-rss": shopifyEngineeringRss,
  "slickdeals-search-rss": slickdealsSearchRss,
  "snap-engineering-rss": snapEngineeringRss,
  "snowflake-engineering-rss": snowflakeEngineeringRss,
  "stripe-engineering-rss": stripeEngineeringRss,
  "traderjoes-vegan-food-rss": traderjoesVeganFoodRss,
  "uber-backend-rss": uberBackendRss,
};

export default {
  fetch(
    req: Request,
    env: Record<string, string | undefined>,
  ): Promise<Response> | Response {
    const name = new URL(req.url).pathname.replace(/^\/+|\/+$/g, "");
    const handler = Object.hasOwn(feeds, name) ? feeds[name] : undefined;
    if (!handler) return new Response("Not found\n", { status: 404 });
    return handler(req, env);
  },
};
