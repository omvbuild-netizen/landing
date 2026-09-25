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

export async function onRequestPost({ request, env }) {
  const cors = { "content-type": "application/json; charset=utf-8" };
  const chatId = env.CHAT_ID || DEFAULT_CHAT_ID;

  if (!env.BOT_TOKEN) {
    return new Response(JSON.stringify({ ok: false, error: "not_configured" }), { status: 500, headers: cors });
  }

  let data;
  try { data = await request.json(); }
  catch { return new Response(JSON.stringify({ ok: false, error: "bad_json" }), { status: 400, headers: cors }); }

  if (data.company) return new Response(JSON.stringify({ ok: true }), { headers: cors }); // спам-пастка

  const name = String(data.name || "").trim().slice(0, 80);
  const phone = String(data.phone || "").replace(/[^\d+]/g, "").slice(0, 20);
  if (name.length < 2 || !/^\+380\d{9}$/.test(phone)) {
    return new Response(JSON.stringify({ ok: false, error: "bad_input" }), { status: 400, headers: cors });
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

  const tg = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });

  if (!tg.ok) {
    return new Response(JSON.stringify({ ok: false, error: "telegram_failed" }), { status: 502, headers: cors });
  }
  return new Response(JSON.stringify({ ok: true }), { headers: cors });
}
