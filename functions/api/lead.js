/**
 * Cloudflare Pages Function — приймає заявку й надсилає її в Telegram.
 * Шлях: /api/lead
 *
 * Змінні оточення (Settings → Variables and Secrets):
 *   BOT_TOKEN — токен бота з @BotFather, тип Secret. ОБОВ'ЯЗКОВО.
 *   CHAT_ID   — необов'язково: якщо не задати, береться DEFAULT_CHAT_ID нижче.
 *
 * Токен у код не вписувати: цей файл лежить у публічному репозиторії.
 */

// Група «Княжичі ліди». Щоб змінити чат — задайте CHAT_ID у змінних оточення.
const DEFAULT_CHAT_ID = "-5484943327";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

const json = (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: JSON_HEADERS });

/**
 * Діагностика. GET /api/lead — чи взагалі задеплоєна функція і чи заданий токен.
 * GET /api/lead?check=1 — додатково питає Telegram, чи бачить бот цей чат.
 * Токен не розкривається — лише true/false.
 */
export async function onRequestGet({ request, env }) {
  const chatId = env.CHAT_ID || DEFAULT_CHAT_ID;
  const out = {
    ok: true,
    fn: "lead",
    token_set: Boolean(env.BOT_TOKEN),
    chat_id: chatId
  };

  const url = new URL(request.url);
  if (url.searchParams.get("check") === "1" && env.BOT_TOKEN) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getChat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId })
      });
      const j = await r.json();
      out.telegram = j.ok
        ? { ok: true, title: j.result && j.result.title, type: j.result && j.result.type }
        : { ok: false, code: j.error_code, description: j.description };
    } catch (e) {
      out.telegram = { ok: false, description: "fetch_failed" };
    }
  }

  return json(out);
}

export async function onRequestPost({ request, env }) {
  const chatId = env.CHAT_ID || DEFAULT_CHAT_ID;

  if (!env.BOT_TOKEN) return json({ ok: false, error: "not_configured" }, 500);

  let data;
  try { data = await request.json(); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }

  if (data.company) return json({ ok: true }); // спам-пастка

  const name = String(data.name || "").trim().slice(0, 80);
  const phone = String(data.phone || "").replace(/[^\d+]/g, "").slice(0, 20);
  if (name.length < 2 || !/^\+380\d{9}$/.test(phone)) {
    return json({ ok: false, error: "bad_input" }, 400);
  }

  const pretty = phone.replace(/^\+380(\d{2})(\d{3})(\d{2})(\d{2})$/, "+380 $1 $2 $3 $4");
  const esc = (t) => String(t).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

  const lines = [
    "\u{1F3E1} <b>Новий лід — Княжичі</b>",
    "",
    `<a href="tel:${phone}">${pretty}</a>`,
    esc(name)
  ];
  if (data.payment) lines.push(esc(data.payment));
  if (data.page) lines.push("", `<i>${esc(data.page)}</i>`);

  let tg, body;
  try {
    tg = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    body = await tg.json();
  } catch {
    return json({ ok: false, error: "telegram_unreachable" }, 502);
  }

  // Telegram віддає 200 з {"ok":false} на логічні помилки — перевіряємо тіло, не лише статус.
  if (!body || body.ok !== true) {
    return json({ ok: false, error: "telegram_failed", description: body && body.description }, 502);
  }
  return json({ ok: true });
}
