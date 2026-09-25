/**
 * Точка входу Worker'а.
 *
 * Статику (index.html, /img/*, іконки) віддає біндинг ASSETS —
 * Worker запускається лише тоді, коли під шлях немає файлу.
 * Єдиний динамічний маршрут — /api/lead.
 */

import { handleLead } from "./lib/lead.js";

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/lead") return handleLead(request, env);

    return env.ASSETS.fetch(request);
  }
};
