/**
 * Точка входу Worker'а.
 *
 * Статику (index.html, /img/*, іконки) віддає біндинг ASSETS —
 * Worker запускається лише тоді, коли під шлях немає файлу.
 * Динамічні маршрути:
 *   /api/lead    — заявка з сайту → Telegram, HubSpot, TikTok (lib/lead.js)
 *   /api/hubspot — діагностика синхронізації статусів (lib/status.js)
 * Раз на 5 хвилин (cron у wrangler.jsonc) — «Статус ліда» з HubSpot → TikTok.
 */

import { handleLead, log } from "./lib/lead.js";
import { handleHubspot, syncStatuses } from "./lib/status.js";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    // ctx потрібен, щоб HubSpot і TikTok дописувались уже після відповіді
    if (pathname === "/api/lead") return handleLead(request, env, ctx);
    if (pathname === "/api/hubspot") return handleHubspot(request, env);

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncStatuses(env).catch((e) => log("status_sync_failed", { description: String(e) })));
  }
};
