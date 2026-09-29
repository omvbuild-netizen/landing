/**
 * Точка входу Worker'а.
 *
 * Статику (index.html, /img/*, іконки) віддає біндинг ASSETS —
 * Worker запускається лише тоді, коли під шлях немає файлу.
 * Єдиний динамічний маршрут — /api/lead.
 */

import { handleLead } from "./lib/lead.js";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    // ctx потрібен, щоб HubSpot і TikTok дописувались уже після відповіді відвідувачу
    if (pathname === "/api/lead") return handleLead(request, env, ctx);

    return env.ASSETS.fetch(request);
  }
};
