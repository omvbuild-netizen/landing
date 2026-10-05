/**
 * «Статус ліда» з HubSpot → TikTok, без Zapier.
 *
 * Кожні 5 хвилин (Cron Trigger у wrangler.jsonc) Worker шукає в HubSpot контакти,
 * змінені за останні 3 дні, де «Статус ліда» — Кваліфікований, Перегляд
 * призначено, Угода або Нецільовий, і надсилає в TikTok ті статуси, яких ще
 * немає в полі «TikTok: передано»:
 *   • у CRM Event Set «Час Додому HubSpot» — для всіх лідів: заявки з Instant Form
 *     TikTok зіставляє за lead ID, заявки з сайту — за click ID і телефоном.
 *     У TikTok Events Manager кожен статус прив'язується до етапу воронки;
 *   • у піксель сайту — лише для заявок із сайту: «Перегляд призначено» → Schedule,
 *     «Угода» → Purchase. Це глибші події для оптимізації кампанії на сайт.
 *
 * Поле «TikTok: передано» — і звіт, і позначка «вже надіслано»: статус іде в TikTok,
 * якщо поле не починається з його назви. Тому:
 *   • TikTok прийняв — у полі «Кваліфікований → TikTok ✓ · 05.10 12:10»;
 *   • TikTok відхилив — у полі текст помилки, повторів немає. Щоб надіслати ще раз,
 *     очистіть поле;
 *   • TikTok не відповів (збій мережі) — поле не чіпаємо, спроба за 5 хвилин.
 * «Новий» не надсилається: про саму заявку TikTok уже знає.
 *
 * Чому не вебхук: сервісний ключ HubSpot (Development → Keys → Service Keys) робить
 * лише API-запити — вебхуків і client secret у нього немає, а legacy-застосунки
 * HubSpot для нових акаунтів уже не створює.
 *
 * Змінні оточення (Cloudflare → Settings → Variables and Secrets):
 *   HUBSPOT_TOKEN       — сервісний ключ HubSpot, той самий, що й для заявок.
 *   TIKTOK_EVENTS_TOKEN — той самий токен Events API, що й для пікселя.
 *   TIKTOK_CRM_TOKEN    — токен CRM Event Set (Events Manager → «Час Додому HubSpot» →
 *                         Settings → Generate Access Token). Токен пікселя CRM Event
 *                         Set не приймає: 40001 No permission to operate event source.
 *                         Без TIKTOK_CRM_TOKEN пробуємо TIKTOK_EVENTS_TOKEN.
 *   TIKTOK_CRM_EVENT_SET_ID — необов'язково: інший CRM Event Set.
 */

import { clip, hubspot, json, kyivTime, log, mark, noteSync, pixelOf, sha256 } from "./lead.js";

// CRM Event Set «Час Додому HubSpot» у рекламному кабінеті «Час додому». ID не секретний.
export const DEFAULT_CRM_EVENT_SET_ID = "7690863133832822804";

const TRACK_URL = "https://business-api.tiktok.com/open_api/v1.3/event/track/";

// Значення поля «Статус ліда» (sales_lead_status) → підписи як у HubSpot.
// Ключі йдуть у TikTok як назви CRM-подій.
export const STATUSES = {
  new: "Новий",
  qualified: "Кваліфікований",
  viewing_booked: "Перегляд призначено",
  deal: "Угода",
  unqualified: "Нецільовий"
};

// Статуси, які передаємо в TikTok.
const TO_SEND = ["qualified", "viewing_booked", "deal", "unqualified"];

// Для заявок із сайту ці статуси ще й ідуть у піксель стандартними подіями.
export const PIXEL_EVENTS = {
  viewing_booked: { event: "Schedule", properties: { content_name: "viewing" } },
  deal: { event: "Purchase", properties: { content_name: "house_knyazhychi", value: 100000, currency: "USD" } }
};

// Наскільки далеко назад шукати зміни. Із запасом: якщо TikTok лежав кілька
// годин, статуси дійдуть, щойно він підніметься.
const LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;

const FIELDS = [
  "sales_lead_status", "tiktok_sync_status", "phone",
  "tiktok_lead_id", "tiktok_click_id", "lead_source_channel", "lead_page_url"
];

const crmSetOf = (env) => env.TIKTOK_CRM_EVENT_SET_ID || DEFAULT_CRM_EVENT_SET_ID;
const crmTokenOf = (env) => env.TIKTOK_CRM_TOKEN || env.TIKTOK_EVENTS_TOKEN;

/* ---------------------------------------------------------------------- TikTok */

/**
 * Один запит до Events API. Мережевий збій або 5xx повторюємо один раз; якщо й
 * тоді не вийшло — transient: true, і контакт обробиться наступним запуском.
 */
async function track(token, payload) {
  let last = { ok: false, transient: true, message: "unreachable" };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(TRACK_URL, {
        method: "POST",
        headers: { "access-token": token, "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = await r.json().catch(() => null);
      if (r.ok && body && body.code === 0) return { ok: true };
      if (r.status < 500 && body) return { ok: false, code: body.code, message: clip(body.message, 200) };
      last = { ok: false, transient: true, code: r.status, message: body ? clip(body.message, 200) : "" };
    } catch (e) {
      last = { ok: false, transient: true, message: clip(String(e), 200) };
    }
    if (attempt === 0) await new Promise((res) => setTimeout(res, 800));
  }
  return last;
}

/** Телефон у форматі E.164 (+380…), як його хешує TikTok. Порожній, якщо не схоже на номер. */
export function e164(phone) {
  let s = String(phone || "").replace(/[^\d+]/g, "");
  if (/^380\d{9}$/.test(s)) s = "+" + s;
  if (/^0\d{9}$/.test(s)) s = "+38" + s;
  return /^\+\d{10,15}$/.test(s) ? s : "";
}

/** Чи вже передавали цей статус: поле «TikTok: передано» починається з його назви. */
export const alreadySent = (status, note) =>
  Boolean(STATUSES[status]) && String(note || "").startsWith(`${STATUSES[status]} → `);

/* --------------------------------------------------------------------- HubSpot */

/** Контакти, у яких змінили статус і він ще не дійшов до TikTok. */
export async function pending(env) {
  const out = [];
  let after;
  for (let page = 0; page < 3; page++) {
    const r = await hubspot(env, "/search", "POST", {
      filterGroups: [{
        filters: [
          { propertyName: "lastmodifieddate", operator: "GTE", value: String(Date.now() - LOOKBACK_MS) },
          { propertyName: "sales_lead_status", operator: "IN", values: TO_SEND }
        ]
      }],
      properties: FIELDS,
      sorts: [{ propertyName: "lastmodifieddate", direction: "DESCENDING" }],
      limit: 100,
      ...(after ? { after } : {})
    });
    if (!r.ok) throw new Error(`hubspot_search_${r.status}`);
    const body = await r.json();
    for (const c of body.results || []) {
      const p = c.properties || {};
      if (TO_SEND.includes(p.sales_lead_status) && !alreadySent(p.sales_lead_status, p.tiktok_sync_status)) {
        out.push({ ...p, id: String(c.id) });
      }
    }
    after = body.paging && body.paging.next && body.paging.next.after;
    if (!after) break;
  }
  return out;
}

/** Один контакт → TikTok, результат — у поле «TikTok: передано». */
export async function sendStatus(env, c) {
  const status = c.sales_lead_status;
  const label = STATUSES[status];
  const phone = e164(c.phone);
  const leadId = String(c.tiktok_lead_id || "").trim();
  const ttclid = String(c.tiktok_click_id || "").trim();

  if (!phone && !leadId && !ttclid) {
    await noteSync(env, c.id, `${label} → у TikTok не передано: немає телефону чи TikTok ID · ${kyivTime()}`);
    return { skipped: "no_ids" };
  }

  const user = {};
  if (phone) user.phone = await sha256(phone);
  if (ttclid) user.ttclid = ttclid;

  const eventTime = Math.floor(Date.now() / 1000);
  // Той самий статус того самого контакту — той самий event_id: повтор TikTok відкине.
  const eventId = `hs-${c.id}-${status}`;

  const crmEvent = { event: status, event_time: eventTime, event_id: eventId, user };
  if (leadId) crmEvent.lead = { lead_id: leadId, lead_event_source: "HubSpot" };
  const crm = await track(crmTokenOf(env), { event_source: "crm", event_source_id: crmSetOf(env), data: [crmEvent] });

  let pixel = null;
  const px = PIXEL_EVENTS[status];
  if (px && c.lead_source_channel === "website" && env.TIKTOK_EVENTS_TOKEN) {
    const webEvent = { event: px.event, event_time: eventTime, event_id: eventId, user, properties: px.properties };
    if (c.lead_page_url) webEvent.page = { url: c.lead_page_url };
    pixel = await track(env.TIKTOK_EVENTS_TOKEN, { event_source: "web", event_source_id: pixelOf(env), data: [webEvent] });
  }

  if (crm.transient || (pixel && pixel.transient)) {
    log("status_retry_later", { id: c.id, status, crm, pixel });
    return { retry: true };
  }

  await noteSync(env, c.id, `${label} → TikTok ${mark(crm)}${pixel ? `, піксель ${mark(pixel)}` : ""} · ${kyivTime()}`);
  const ok = crm.ok && (!pixel || pixel.ok);
  log(ok ? "status_sent" : "status_failed", { id: c.id, status, crm, pixel });
  return { ok, crm, pixel };
}

/** Cron, кожні 5 хвилин: усі нові статуси → TikTok. */
export async function syncStatuses(env) {
  if (!env.HUBSPOT_TOKEN || !crmTokenOf(env)) return { skipped: "not_configured" };
  const list = await pending(env);
  const stats = { pending: list.length, sent: 0, failed: 0, skipped: 0, retry: 0 };
  for (const c of list) {
    try {
      const r = await sendStatus(env, c);
      if (r.retry) stats.retry++;
      else if (r.skipped) stats.skipped++;
      else if (r.ok) stats.sent++;
      else stats.failed++;
    } catch (e) {
      stats.retry++;
      log("status_error", { id: c.id, description: String(e) });
    }
  }
  if (list.length) log("status_sync", stats);
  return stats;
}

/* ------------------------------------------------------------------- маршрути */

/**
 * GET /api/hubspot — що налаштовано (лише true/false, без значень).
 * GET /api/hubspot?check=1 — додатково: чи відповідає HubSpot і скільки статусів
 * чекають на відправку в TikTok.
 */
export async function statusHealth(request, env) {
  const out = {
    ok: true,
    fn: "hubspot",
    schedule: "*/5 * * * *",
    hubspot_set: Boolean(env.HUBSPOT_TOKEN),
    tiktok_set: Boolean(crmTokenOf(env)),
    crm_token: env.TIKTOK_CRM_TOKEN ? "TIKTOK_CRM_TOKEN" : env.TIKTOK_EVENTS_TOKEN ? "TIKTOK_EVENTS_TOKEN" : null,
    crm_event_set: crmSetOf(env)
  };
  if (new URL(request.url).searchParams.get("check") === "1" && env.HUBSPOT_TOKEN) {
    try {
      out.pending = (await pending(env)).length;
      out.hubspot = { ok: true };
    } catch (e) {
      out.hubspot = { ok: false, error: String((e && e.message) || e) };
    }
  }
  return json(out);
}

/** Спільний роутер для /api/hubspot. */
export function handleHubspot(request, env) {
  if (request.method === "GET") return statusHealth(request, env);
  return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", allow: "GET" }
  });
}
