/**
 * Cloudflare Pages Function для /api/hubspot (діагностика).
 *
 * Зараз проєкт задеплоєний як Worker (див. wrangler.jsonc + worker.js), тож
 * цей файл не використовується. Лишається на випадок переїзду на Pages —
 * логіка спільна, у lib/status.js. Зверніть увагу: у Pages немає cron, тож
 * після переїзду синхронізацію статусів треба запускати окремим Worker'ом.
 */

import { statusHealth } from "../../lib/status.js";

export const onRequestGet = ({ request, env }) => statusHealth(request, env);
