/**
 * Точка входу Worker'а.
 *
 * Статику (index.html, /img/*, іконки) віддає біндинг ASSETS —
 * Worker запускається лише тоді, коли під шлях немає файлу.
 * Динамічні маршрути:
 *   /api/lead    — заявка з сайту → Telegram, HubSpot, TikTok (lib/lead.js)
 *   /api/hubspot — вебхук HubSpot: зміна «Статусу ліда» → TikTok (lib/status.js)
 */

import { handleLead } from "./lib/lead.js";
import { handleHubspot } from "./lib/status.js";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    // ctx потрібен, щоб HubSpot і TikTok дописувались уже після відповіді
    if (pathname === "/api/lead") return handleLead(request, env, ctx);
    if (pathname === "/api/hubspot") return handleHubspot(request, env, ctx);

    return env.ASSETS.fetch(request);
  }
};
