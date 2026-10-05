/**
 * Cloudflare Pages Function для /api/hubspot.
 *
 * Зараз проєкт задеплоєний як Worker (див. wrangler.jsonc + worker.js), тож
 * цей файл не використовується. Лишається на випадок переїзду на Pages —
 * логіка спільна, у lib/status.js.
 */

import { hubspotHealth, hubspotWebhook } from "../../lib/status.js";

export const onRequestGet = ({ request, env }) => hubspotHealth(request, env);
export const onRequestPost = ({ request, env, waitUntil }) => hubspotWebhook(request, env, { waitUntil });
