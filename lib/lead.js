/**
 * Обробка заявки з лендінгу → Telegram, HubSpot і TikTok Events API.
 * Одна реалізація, яку використовують і Worker (worker.js), і Pages Function
 * (functions/api/lead.js) — щоб логіка не розходилась.
 * Зміни «Статусу ліда» з HubSpot у TikTok передає lib/status.js.
 *
 * Змінні оточення (Cloudflare → Settings → Variables and Secrets):
 *   BOT_TOKEN           — токен бота з @BotFather, тип Secret. ОБОВ'ЯЗКОВО.
 *   CHAT_ID             — необов'язково: якщо не задати, береться DEFAULT_CHAT_ID нижче.
 *   HUBSPOT_TOKEN       — сервісний ключ HubSpot (Development → Keys → Service Keys), тип Secret.
 *                         Без нього заявки просто не потрапляють у HubSpot.
 *   TIKTOK_EVENTS_TOKEN — токен Events API пікселя з TikTok Events Manager, тип Secret.
 *                         Без нього подія йде лише з браузера (пікселем).
 *   TIKTOK_PIXEL_CODE   — необов'язково: код пікселя, за замовчуванням DEFAULT_PIXEL_CODE.
 *
 * Токени в код не вписувати: репозиторій публічний.
 */

// Група «Княжичі ліди». Щоб змінити чат — задайте CHAT_ID у змінних оточення.
export const DEFAULT_CHAT_ID = "-5484943327";

// Піксель «Час Додому сайт» у рекламному кабінеті «Час додому». Код публічний.
export const DEFAULT_PIXEL_CODE = "DATMVURC77U98OIJUO3G";

// Відповіді на питання у формі — ті самі, що й в Instant Form у TikTok.
// Ключ приходить з форми (value радіокнопки) і так само записується
// у властивість HubSpot «Купівля на Лівому березі»; текст іде в Telegram.
export const INTENTS = {
  buy_3m: "Так, планую купити протягом 3 місяців",
  choosing: "Так, але поки обираю",
  elsewhere: "Ні, шукаю в іншому місці"
};

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

export const json = (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: HEADERS });

const esc = (t) => String(t).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

export const clip = (v, n) => String(v || "").trim().slice(0, n);

const chatOf = (env) => env.CHAT_ID || DEFAULT_CHAT_ID;

export const pixelOf = (env) => env.TIKTOK_PIXEL_CODE || DEFAULT_PIXEL_CODE;

export const log = (what, extra) => console.log(JSON.stringify({ lead: what, ...extra }));

/** «05.10 12:10» за київським часом — для поля «TikTok: передано». */
export function kyivTime(d = new Date()) {
  try {
    return d.toLocaleString("uk-UA", {
      timeZone: "Europe/Kiev", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
    }).replace(",", "");
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  }
}

const tg = (env, method, payload) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Діагностика. GET /api/lead — чи задеплоєний обробник і які токени задані.
 * GET /api/lead?check=1 — додатково питає Telegram, чи бачить бот групу.
 * Токени не розкриваються — лише true/false.
 */
export async function health(request, env) {
  const out = {
    ok: true,
    fn: "lead",
    token_set: Boolean(env.BOT_TOKEN),
    hubspot_set: Boolean(env.HUBSPOT_TOKEN),
    tiktok_events_set: Boolean(env.TIKTOK_EVENTS_TOKEN),
    pixel: pixelOf(env),
    chat_id: chatOf(env),
    // лише імена змінних, щоб видно було описку в назві. Значень тут немає.
    bindings: Object.keys(env).sort()
  };

  if (new URL(request.url).searchParams.get("check") === "1" && env.BOT_TOKEN) {
    try {
      const r = await tg(env, "getChat", { chat_id: chatOf(env) });
      const j = await r.json();
      out.telegram = j.ok
        ? { ok: true, title: j.result && j.result.title, type: j.result && j.result.type }
        : { ok: false, code: j.error_code, description: j.description };
    } catch {
      out.telegram = { ok: false, description: "fetch_failed" };
    }
  }

  return json(out);
}

/* ---------------------------------------------------------------- HubSpot */

const HUBSPOT = "https://api.hubapi.com/crm/v3/objects/contacts";

export const hubspot = (env, path, method, body) =>
  fetch(HUBSPOT + path, {
    method,
    headers: { authorization: `Bearer ${env.HUBSPOT_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

/**
 * Записує в контакт, що і коли пішло в TikTok, — поле «TikTok: передано»
 * (tiktok_sync_status). Так помилку видно прямо в HubSpot, без логів Cloudflare.
 */
export async function noteSync(env, id, text) {
  if (!env.HUBSPOT_TOKEN || !id) return;
  const r = await hubspot(env, `/${id}`, "PATCH", { properties: { tiktok_sync_status: clip(text, 300) } });
  if (!r.ok) log("hubspot_note_failed", { status: r.status, description: (await r.text()).slice(0, 300) });
}

/** «✓» або «✗ код: текст помилки» — для поля «TikTok: передано». */
export const mark = (res) =>
  res && res.ok ? "✓" : `✗ ${[res && res.code, res && res.message].filter(Boolean).join(": ")}`.trim();

/**
 * Створює контакт або оновлює наявний (шукаємо за телефоном, щоб повторна
 * заявка не плодила дублікати). «Статус ліда» ставимо «Новий» лише новим
 * контактам — у наявних його вже міг змінити менеджер.
 */
export async function saveToHubspot(env, lead) {
  if (!env.HUBSPOT_TOKEN) return { skipped: "no_token" };

  const props = {
    firstname: lead.name,
    phone: lead.phone,
    lead_source_channel: "website",
    lead_page_url: lead.page
  };
  if (lead.intent) props.lead_intent_left_bank = lead.intent;
  if (lead.ttclid) props.tiktok_click_id = lead.ttclid;
  if (lead.utm_campaign) props.utm_campaign = lead.utm_campaign;
  if (lead.utm_content) props.utm_content = lead.utm_content;

  const found = await hubspot(env, "/search", "POST", {
    filterGroups: [{ filters: [{ propertyName: "phone", operator: "EQ", value: lead.phone }] }],
    properties: ["phone"],
    limit: 1
  });
  const hits = found.ok ? await found.json() : null;
  const existing = hits && hits.results && hits.results[0];

  const r = existing
    ? await hubspot(env, `/${existing.id}`, "PATCH", { properties: props })
    : await hubspot(env, "", "POST", {
        properties: { ...props, sales_lead_status: "new", lifecyclestage: "lead" }
      });

  if (!r.ok) {
    const text = await r.text();
    log("hubspot_failed", { status: r.status, description: text.slice(0, 500) });
    return { ok: false, status: r.status };
  }
  const saved = await r.json();
  return { ok: true, id: saved.id, updated: Boolean(existing) };
}

/* ---------------------------------------------------------- TikTok Events API */

/**
 * Серверна копія подій пікселя. event_id той самий, що й у браузері, тож
 * TikTok рахує їх як одну подію, а сервер добирає ті, що заблокував браузер.
 * «Ні, шукаю в іншому місці» не надсилаємо — як і піксель.
 */
export async function sendToTiktok(env, lead, request) {
  if (!env.TIKTOK_EVENTS_TOKEN) return { skipped: "no_token" };
  if (!lead.intent || lead.intent === "elsewhere") return { skipped: "not_target" };

  const user = { phone: await sha256(lead.phone) };
  if (lead.ttclid) user.ttclid = lead.ttclid;
  if (lead.ttp) user.ttp = lead.ttp;
  const ip = request.headers.get("cf-connecting-ip");
  const ua = request.headers.get("user-agent");
  if (ip) user.ip = ip;
  if (ua) user.user_agent = ua;

  const base = {
    event_time: Math.floor(Date.now() / 1000),
    user,
    page: { url: lead.page, referrer: lead.referrer || undefined }
  };
  const data = [
    { ...base, event: "SubmitForm", event_id: lead.event_id,
      properties: { content_name: "viewing_form", status: lead.intent } }
  ];
  if (lead.intent === "buy_3m") {
    data.push({ ...base, event: "CompleteRegistration", event_id: `${lead.event_id}-hot`,
      properties: { content_name: "hot_lead", status: lead.intent } });
  }

  const r = await fetch("https://business-api.tiktok.com/open_api/v1.3/event/track/", {
    method: "POST",
    headers: { "access-token": env.TIKTOK_EVENTS_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ event_source: "web", event_source_id: pixelOf(env), data })
  });
  const body = await r.json().catch(() => null);
  if (!r.ok || !body || body.code !== 0) {
    log("tiktok_failed", { status: r.status, code: body && body.code, description: body && body.message });
    return { ok: false, code: body ? body.code : r.status, message: body ? body.message : "" };
  }
  return { ok: true };
}

/* ----------------------------------------------------------------- заявка */

export async function submit(request, env, ctx) {
  if (!env.BOT_TOKEN) return json({ ok: false, error: "not_configured" }, 500);

  let data;
  try { data = await request.json(); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }

  if (data.company) return json({ ok: true }); // спам-пастка

  const name = clip(data.name, 80);
  const phone = String(data.phone || "").replace(/[^\d+]/g, "").slice(0, 20);
  if (name.length < 2 || !/^\+380\d{9}$/.test(phone)) {
    return json({ ok: false, error: "bad_input" }, 400);
  }

  const lead = {
    name,
    phone,
    // Відповідь на «Розглядаєте купівлю будинку на Лівому березі…». Порожня — якщо
    // заявка прийшла зі старої версії сторінки з кешу; таку теж приймаємо.
    intent: INTENTS[data.intent] ? data.intent : "",
    // id події для склеювання пікселя з Events API; якщо щось дивне — генеруємо свій
    event_id: /^[\w-]{6,64}$/.test(String(data.event_id || "")) ? data.event_id : crypto.randomUUID(),
    ttclid: clip(data.ttclid, 200),
    ttp: clip(data.ttp, 200),
    utm_source: clip(data.utm_source, 100),
    utm_campaign: clip(data.utm_campaign, 200),
    utm_content: clip(data.utm_content, 200),
    page: clip(data.page, 1000),
    referrer: clip(data.referrer, 1000)
  };

  // HubSpot — окремо від Telegram: навіть якщо Telegram ляже, заявка збережеться в CRM.
  const saved = saveToHubspot(env, lead).catch((e) => {
    log("hubspot_error", { description: String(e) });
    return { ok: false };
  });
  const background = [saved];
  const later = (p) => (ctx && ctx.waitUntil ? ctx.waitUntil(p) : p);

  const pretty = phone.replace(/^\+380(\d{2})(\d{3})(\d{2})(\d{2})$/, "+380 $1 $2 $3 $4");
  const lines = [
    "\u{1F3E1} <b>Новий лід — Княжичі</b>",
    "",
    `<a href="tel:${phone}">${pretty}</a>`,
    esc(name)
  ];
  if (lead.intent) lines.push(`${lead.intent === "elsewhere" ? "⚠️" : "✅"} ${INTENTS[lead.intent]}`);
  if (data.payment) lines.push(esc(data.payment));
  const fromTiktok = lead.ttclid || /tiktok/i.test(lead.utm_source);
  if (fromTiktok || lead.utm_campaign) {
    const src = fromTiktok ? "з реклами TikTok" : `з реклами${lead.utm_source ? " " + esc(lead.utm_source) : ""}`;
    lines.push(`<i>${src}${lead.utm_campaign ? ": " + esc(lead.utm_campaign) : ""}</i>`);
  }
  if (lead.page) lines.push("", `<i>${esc(lead.page)}</i>`);

  let body;
  try {
    const r = await tg(env, "sendMessage", {
      chat_id: chatOf(env),
      text: lines.join("\n"),
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
    body = await r.json();
  } catch {
    await later(Promise.all(background));
    return json({ ok: false, error: "telegram_unreachable" }, 502);
  }

  // Telegram віддає 200 з {"ok":false} на логічні помилки — перевіряємо тіло, не лише статус.
  if (!body || body.ok !== true) {
    await later(Promise.all(background));
    return json({ ok: false, error: "telegram_failed", description: body && body.description }, 502);
  }

  // Подію в TikTok шлемо лише для успішної заявки — як і піксель у браузері.
  const sent = sendToTiktok(env, lead, request).catch((e) => {
    log("tiktok_error", { description: String(e) });
    return { ok: false, message: String(e) };
  });
  // Коли є і контакт, і відповідь TikTok — пишемо результат у поле «TikTok: передано».
  background.push(
    Promise.all([saved, sent])
      .then(([h, t]) => {
        if (!h || !h.ok || !h.id || !t || t.skipped) return;
        const what = lead.intent === "buy_3m" ? "Заявка (гаряча)" : "Заявка";
        return noteSync(env, h.id, `${what} → TikTok ${mark(t)} · ${kyivTime()}`);
      })
      .catch((e) => log("hubspot_note_error", { description: String(e) }))
  );
  await later(Promise.all(background));
  return json({ ok: true });
}

/** Спільний роутер для /api/lead. */
export function handleLead(request, env, ctx) {
  if (request.method === "GET")  return health(request, env);
  if (request.method === "POST") return submit(request, env, ctx);
  return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
    status: 405,
    headers: { ...HEADERS, allow: "GET, POST" }
  });
}
