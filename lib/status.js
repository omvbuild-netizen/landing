/**
 * «Статус ліда» з HubSpot → TikTok, без Zapier.
 *
 * Менеджер змінює «Статус ліда» в HubSpot → вебхук приватного застосунку HubSpot
 * викликає POST /api/hubspot → Worker перевіряє підпис, бере з контакту
 * TikTok lead ID, TikTok click ID і телефон і надсилає статус у TikTok:
 *   • у CRM Event Set «Час Додому HubSpot» — для всіх лідів: заявки з Instant Form
 *     TikTok зіставляє за lead ID, заявки з сайту — за click ID і телефоном.
 *     У TikTok Events Manager кожен статус прив'язується до етапу воронки;
 *   • у піксель сайту — лише для заявок із сайту: «Перегляд призначено» → Schedule,
 *     «Угода» → Purchase. Це глибші події для оптимізації кампанії на сайт.
 * Результат записується в контакт, у поле «TikTok: передано».
 * «Новий» не надсилається: про саму заявку TikTok уже знає.
 *
 * Змінні оточення (Cloudflare → Settings → Variables and Secrets):
 *   HUBSPOT_APP_SECRET  — Client secret того ж застосунку HubSpot (вкладка Auth),
 *                         тип Secret. Без нього вебхук не приймається.
 *   HUBSPOT_TOKEN       — той самий токен, що й для заявок.
 *   TIKTOK_EVENTS_TOKEN — той самий токен Events API, що й для пікселя.
 *   TIKTOK_CRM_TOKEN    — необов'язково: окремий токен CRM Event Set, якщо TikTok
 *                         не прийме для нього токен пікселя (тоді в полі
 *                         «TikTok: передано» буде помилка доступу).
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

// Для заявок із сайту ці статуси ще й ідуть у піксель стандартними подіями.
export const PIXEL_EVENTS = {
  viewing_booked: { event: "Schedule", properties: { content_name: "viewing" } },
  deal: { event: "Purchase", properties: { content_name: "house_knyazhychi", value: 100000, currency: "USD" } }
};

const crmSetOf = (env) => env.TIKTOK_CRM_EVENT_SET_ID || DEFAULT_CRM_EVENT_SET_ID;
const crmTokenOf = (env) => env.TIKTOK_CRM_TOKEN || env.TIKTOK_EVENTS_TOKEN;

/* ------------------------------------------------------------- підпис HubSpot */

const enc = new TextEncoder();

async function hmacBase64(key, message) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(message)));
  let s = "";
  for (const b of sig) s += String.fromCharCode(b);
  return btoa(s);
}

// Порівняння без витоку часу — щоб підпис не можна було підібрати посимвольно.
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * HubSpot підписує кожен запит client secret'ом застосунку. Приймаємо будь-яку з
 * трьох версій: v3 (X-HubSpot-Signature-v3: HMAC-SHA256 від методу, адреси, тіла
 * і часу запиту), v2 і v1 (X-HubSpot-Signature: SHA-256 від secret + тіло
 * або secret + метод + адреса + тіло).
 */
export async function verified(request, secret, body) {
  const v3 = request.headers.get("x-hubspot-signature-v3");
  const ts = request.headers.get("x-hubspot-request-timestamp");
  if (v3 && ts) {
    if (!(Math.abs(Date.now() - Number(ts)) <= 5 * 60 * 1000)) return false; // застарілий запит
    if (same(v3, await hmacBase64(secret, request.method + request.url + body + ts))) return true;
  }
  const sig = (request.headers.get("x-hubspot-signature") || "").toLowerCase();
  if (!sig) return false;
  return same(sig, await sha256(secret + body)) || same(sig, await sha256(secret + request.method + request.url + body));
}

/* ---------------------------------------------------------------------- TikTok */

/** Один запит до Events API; мережеві збої та 5xx повторюємо один раз. */
async function track(token, payload) {
  let last = { ok: false, message: "unreachable" };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(TRACK_URL, {
        method: "POST",
        headers: { "access-token": token, "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const body = await r.json().catch(() => null);
      if (r.ok && body && body.code === 0) return { ok: true };
      last = { ok: false, code: body ? body.code : r.status, message: body ? clip(body.message, 200) : "" };
      if (r.status < 500 && body) return last; // логічна помилка — повтор не допоможе
    } catch (e) {
      last = { ok: false, message: clip(String(e), 200) };
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

/**
 * Одна зміна статусу → TikTok. ev — подія з вебхука HubSpot
 * ({ objectId, propertyName, propertyValue, occurredAt, … }).
 */
export async function syncStatus(env, ev) {
  const status = String(ev.propertyValue || "");
  const label = STATUSES[status];
  if (!label || status === "new") return { skipped: "status" };

  const id = String(ev.objectId || "");
  if (!/^\d+$/.test(id)) return { skipped: "bad_id" };

  const r = await hubspot(
    env,
    `/${id}?properties=phone,tiktok_lead_id,tiktok_click_id,lead_source_channel,lead_page_url`,
    "GET"
  );
  if (!r.ok) {
    log("status_contact_failed", { id, status: r.status });
    return { ok: false, error: "contact" };
  }
  const c = (await r.json()).properties || {};
  const phone = e164(c.phone);
  const leadId = String(c.tiktok_lead_id || "").trim();
  const ttclid = String(c.tiktok_click_id || "").trim();

  if (!phone && !leadId && !ttclid) {
    await noteSync(env, id, `${label} → у TikTok не передано: немає телефону чи TikTok ID · ${kyivTime()}`);
    return { skipped: "no_ids" };
  }

  const user = {};
  if (phone) user.phone = await sha256(phone);
  if (ttclid) user.ttclid = ttclid;

  const eventTime = Math.floor((Number(ev.occurredAt) || Date.now()) / 1000);
  // Той самий статус того самого контакту — той самий event_id: повтор вебхука TikTok відкине.
  const eventId = `hs-${id}-${status}`;

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

  await noteSync(env, id, `${label} → TikTok ${mark(crm)}${pixel ? `, піксель ${mark(pixel)}` : ""} · ${kyivTime()}`);
  log(crm.ok && (!pixel || pixel.ok) ? "status_sent" : "status_failed", { id, status, crm, pixel });
  return { ok: crm.ok && (!pixel || pixel.ok), crm, pixel };
}

/* ------------------------------------------------------------------- маршрути */

/**
 * POST /api/hubspot — вебхук HubSpot. Відповідаємо одразу (HubSpot чекає лише 5 с),
 * а статуси надсилаємо у фоні.
 */
export async function hubspotWebhook(request, env, ctx) {
  if (!env.HUBSPOT_APP_SECRET || !env.HUBSPOT_TOKEN) {
    log("status_not_configured");
    return json({ ok: false, error: "not_configured" }, 500);
  }
  const body = await request.text();
  if (!(await verified(request, env.HUBSPOT_APP_SECRET, body))) {
    log("status_bad_signature");
    return json({ ok: false, error: "bad_signature" }, 401);
  }

  let events;
  try { events = JSON.parse(body); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }
  if (!Array.isArray(events)) events = [events];

  const ours = events.filter(
    (e) => e && e.propertyName === "sales_lead_status" && /propertyChange$/.test(String(e.subscriptionType || ""))
  );

  const job = (async () => {
    for (const ev of ours) {
      try { await syncStatus(env, ev); }
      catch (e) { log("status_error", { description: String(e) }); }
    }
  })();
  if (ctx && ctx.waitUntil) ctx.waitUntil(job);
  else await job;

  return json({ ok: true, received: ours.length });
}

/**
 * GET /api/hubspot — що налаштовано (лише true/false, без значень).
 * GET /api/hubspot?check=1 — додатково перевіряє, що HubSpot приймає токен.
 */
export async function hubspotHealth(request, env) {
  const out = {
    ok: true,
    fn: "hubspot",
    secret_set: Boolean(env.HUBSPOT_APP_SECRET),
    hubspot_set: Boolean(env.HUBSPOT_TOKEN),
    tiktok_set: Boolean(crmTokenOf(env)),
    crm_token: env.TIKTOK_CRM_TOKEN ? "TIKTOK_CRM_TOKEN" : env.TIKTOK_EVENTS_TOKEN ? "TIKTOK_EVENTS_TOKEN" : null,
    crm_event_set: crmSetOf(env)
  };
  if (new URL(request.url).searchParams.get("check") === "1" && env.HUBSPOT_TOKEN) {
    try {
      const r = await hubspot(env, "?limit=1&properties=sales_lead_status,tiktok_sync_status", "GET");
      out.hubspot = { ok: r.ok, status: r.status };
    } catch {
      out.hubspot = { ok: false, status: "fetch_failed" };
    }
  }
  return json(out);
}

/** Спільний роутер для /api/hubspot. */
export function handleHubspot(request, env, ctx) {
  if (request.method === "GET") return hubspotHealth(request, env);
  if (request.method === "POST") return hubspotWebhook(request, env, ctx);
  return new Response(JSON.stringify({ ok: false, error: "method_not_allowed" }), {
    status: 405,
    headers: { "content-type": "application/json; charset=utf-8", allow: "GET, POST" }
  });
}
