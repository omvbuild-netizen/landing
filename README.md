# Котедж у Княжичах — лендінг

Живий сайт: **https://chasdodomu.com**

Cloudflare **Worker зі статикою** (не Pages), збирається з цього репозиторію
автоматично на кожен `git push` у `main`.

```
index.html        сам сайт — один файл, без збірок і залежностей
img/              фото у WebP, по 2–3 розміри на кожне
worker.js         точка входу: маршрути /api/lead і /api/hubspot, решта → статика
lib/lead.js       логіка заявки → Telegram, HubSpot, TikTok Events API
lib/status.js     вебхук HubSpot: зміна «Статусу ліда» → TikTok
wrangler.jsonc    конфіг Worker'а
.assetsignore     що НЕ віддавати як статику (.git, вихідники)
functions/        те саме для Pages — не використовується, лежить про запас
```

> **Чому не Pages.** У Pages тека `functions/` перетворюється на маршрути
> автоматично. У Worker'а такої магії немає — маршрут задається в `worker.js`.
> Проєкт створений як Worker, тому `/api/lead` спершу віддавав 404 і форма
> мовчки не працювала. Не переносьте `functions/` назад без `worker.js`.

## Заявки в Telegram

Заявка йде на `/api/lead` → `worker.js` → `lib/lead.js` → ваш бот.
Чат уже прописаний: група **«Княжичі ліди»** (`-5484943327`).

**Залишилось задати лише одну змінну.**

Cloudflare → Workers & Pages → **landing** → Settings → Variables and Secrets → Add:

| Ім'я | Значення | Тип |
|---|---|---|
| `BOT_TOKEN` | токен з @BotFather | **Secret** |

Після збереження натисніть **Deploy** — без нового деплою змінна не підхопиться.

Щоб надсилати заявки в інший чат, додайте змінну `CHAT_ID` — вона має
пріоритет над значенням у коді.

### Перевірка без тестових заявок

Відкрийте в браузері:

- `https://chasdodomu.com/api/lead` → `{"ok":true,"fn":"lead","token_set":true,…}`
  `token_set: false` означає, що `BOT_TOKEN` не заданий.
- `https://chasdodomu.com/api/lead?check=1` → додатково покаже, чи бачить бот
  групу: `"telegram":{"ok":true,"title":"Княжичі ліди","type":"group"}`.

Токен ці відповіді не розкривають.

### Токен у код не вписувати

Репозиторій публічний, `index.html` відкритий кожному відвідувачу. Токен живе
тільки у змінних оточення Cloudflare. Якщо токен колись світився у листуванні
чи в комітах — відкликайте його через `/revoke` у @BotFather і задайте новий.

### Формат повідомлення

```
🏡 Новий лід — Княжичі

+380 95 835 90 87
Ольга
✅ Так, планую купити протягом 3 місяців
```

Телефон приходить посиланням — можна дзвонити прямо з Telegram.

Останній рядок — відповідь на питання у формі «Розглядаєте купівлю будинку на
Лівому березі Київщини, який знаходиться за 10 хв від Києва?» (ті самі варіанти,
що й в Instant Form у TikTok). Відповідь «Ні, шукаю в іншому місці» позначена ⚠️:
така заявка теж приходить менеджеру, але сайт не рахує її конверсією для
TikTok / Meta / Google, щоб реклама не вчилася на нецільовій аудиторії.
Список варіантів — у `INTENTS` у `lib/lead.js`; значення радіокнопок у формах
`index.html` мають збігатися з його ключами.

### Якщо заявка не доходить

Cloudflare → Workers & Pages → landing → **Logs** (увімкнено в `wrangler.jsonc`):

- `not_configured` — не задано `BOT_TOKEN` або не перезапущено деплой
- `telegram_failed` — токен відкликано, бота видалили з групи або змінився
  `chat_id` (група, яку зробили супергрупою, отримує новий id). Текст помилки
  від Telegram іде в полі `description`
- `telegram_unreachable` — Telegram не відповів
- `bad_input` — не пройшла валідація імені чи телефону
- `404` на `/api/lead` — зламався маршрут: перевірте, що `wrangler.jsonc`
  і `worker.js` лежать у корені репозиторію

## Телефон

У тому ж блоці:

```js
const CONTACT_PHONE = "+38 093 156 79 55";
const CONTACT_TEL   = "+380931567955";
```

Змініть обидва рядки — номер оновиться і в шапці, і в підвалі, і в нижній панелі на мобільному.

## TikTok Pixel і Events API

Піксель **«Час Додому сайт»** (`DATMVURC77U98OIJUO3G`, рекламний кабінет «Час додому»)
уже стоїть у `<head>`. Події сайт надсилає сам:

| Подія | Коли |
|---|---|
| `ViewContent` | людина почала заповнювати форму або відкрила вікно заявки (раз за візит) |
| `Contact` | натиснула номер телефону |
| `FindLocation` | натиснула «Прокласти маршрут у Google Maps» |
| `SubmitForm` | успішна заявка з відповіддю «Так…» |
| `CompleteRegistration` | «гаряча» заявка: «Так, планую купити протягом 3 місяців» |

Заявка з «Ні, шукаю в іншому місці» конверсією не рахується — ні в пікселі, ні з сервера.

`ttclid` і `utm_*` з посилання реклами сайт запам'ятовує на 7 днів і передає із
заявкою: у Telegram (рядок «з реклами TikTok: …»), у HubSpot і в TikTok.

Ті самі `SubmitForm` / `CompleteRegistration` сервер дублює в **TikTok Events API**
з тим самим `event_id` — TikTok склеює їх в одну подію, а сервер добирає ті,
що заблокував браузер. Для цього потрібна змінна:

| Ім'я | Звідки | Тип |
|---|---|---|
| `TIKTOK_EVENTS_TOKEN` | TikTok Events Manager → піксель «Час Додому сайт» → Settings → Events API → Generate Access Token | **Secret** |

Для Meta / Google код теж готовий (`fbq("track", "Lead")`, `gtag("event", "generate_lead")`) —
спрацює, щойно їхні пікселі з'являться в `<head>`.

## HubSpot

Кожна заявка з сайту створює контакт у HubSpot (або оновлює наявний із тим самим
телефоном). Заповнюються поля: ім'я, телефон, «Купівля на Лівому березі»,
«Джерело ліда» = Сайт, «TikTok click ID», «Сторінка заявки», «UTM campaign»,
«UTM content». Новим контактам ставиться «Статус ліда» = Новий. У поле
**«TikTok: передано»** сайт пише, чи прийняв TikTok заявку (✓ або текст помилки).

Потрібна змінна:

| Ім'я | Звідки | Тип |
|---|---|---|
| `HUBSPOT_TOKEN` | HubSpot → Development → Legacy apps → Create legacy app → Private → Scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write` → Create → вкладка Auth → Show token | **Secret** |

Після зміни змінних натисніть **Deploy**. Перевірка: `https://chasdodomu.com/api/lead`
показує `hubspot_set` і `tiktok_events_set` (лише true/false, без значень).
У логах Worker'а помилки видно як `hubspot_failed` і `tiktok_failed`.

### Статус ліда → TikTok (без Zapier)

Менеджер змінює **«Статус ліда»** в HubSpot — HubSpot одразу викликає
`https://chasdodomu.com/api/hubspot`, а сайт передає статус у TikTok:

| Статус у HubSpot | Що отримує TikTok |
|---|---|
| Кваліфікований | CRM-подія `qualified` |
| Перегляд призначено | CRM-подія `viewing_booked`; для заявок із сайту ще й `Schedule` у піксель |
| Угода | CRM-подія `deal`; для заявок із сайту ще й `Purchase` на $100 000 у піксель |
| Нецільовий | CRM-подія `unqualified` |
| Новий | нічого — про саму заявку TikTok уже знає |

CRM-події йдуть у CRM Event Set **«Час Додому HubSpot»** (`7690863133832822804`).
Заявки з Instant Form TikTok зіставляє за «TikTok lead ID», заявки з сайту — за
«TikTok click ID» і телефоном (у TikTok іде лише SHA-256 хеш номера). У TikTok
Events Manager → «Час Додому HubSpot» кожен статус один раз прив'язується до етапу
воронки. Результат видно в контакті, у полі «TikTok: передано», наприклад
`Кваліфікований → TikTok ✓ · 05.10 12:10`.

Налаштування (один раз):

1. HubSpot → Development → Legacy apps → застосунок, з якого `HUBSPOT_TOKEN` →
   вкладка **Auth** → Client secret → Show → скопіювати.
2. Cloudflare → landing → Settings → Variables and Secrets → `HUBSPOT_APP_SECRET`
   (Secret) = client secret → **Deploy**.
3. У тому ж застосунку HubSpot → вкладка **Webhooks** → Target URL
   `https://chasdodomu.com/api/hubspot` → Create subscription: Contacts →
   Property changed → «Статус ліда» → Subscribe. Підписка має бути **Active**;
   збережіть зміни застосунку (Commit changes).

| Ім'я | Звідки | Тип |
|---|---|---|
| `HUBSPOT_APP_SECRET` | крок 1 вище. Без нього сайт відхиляє вебхук | **Secret** |
| `TIKTOK_CRM_TOKEN` | лише якщо в «TikTok: передано» помилка доступу до CRM Event Set: TikTok Events Manager → «Час Додому HubSpot» → Settings → Generate Access Token. Без нього використовується `TIKTOK_EVENTS_TOKEN` | **Secret** |

Перевірка: `https://chasdodomu.com/api/hubspot?check=1` → `"secret_set":true` і
`"hubspot":{"ok":true,…}`. Сайт приймає лише запити з підписом HubSpot. У логах
Worker'а: `status_sent`, `status_failed`, `status_bad_signature`.

## Фото та логотип

Усі фото лежать у `img/` у трьох розмірах (400 / 600 / максимальний) у форматі WebP.
Щоб замінити фото — покладіть новий файл із тим самим ім'ям.

Логотип: `img/logo.png` (темний, для шапки) і `img/logo-light.png` (білий, для підвалу).
Обидва з прозорим фоном.

## Карта

У секції «Локація» вбудована карта Google через `<iframe>` і дві кнопки з вашим
посиланням `https://maps.app.goo.gl/EVB56Fxj2VoXRmxt7`.

Щоб карта показувала точну мітку замість центру села, відкрийте Google Maps,
знайдіть будинок, натисніть «Поділитися» → «Вбудувати карту» → «Копіювати HTML»
і замініть `src` в тегу `<iframe>` у секції `#lokatsiya`.

## Що ще варто зробити

- Задати `HUBSPOT_APP_SECRET` і вебхук у HubSpot (див. «Статус ліда → TikTok»)
- Прив'язати статуси до етапів воронки в TikTok Events Manager → «Час Додому HubSpot»
  (з'являться там після першої зміни статусу)
- Звірити текст «Політики конфіденційності» з юристом: він згадує піксель TikTok
  і HubSpot, але це короткий варіант
- Вставити піксель Meta перед `</head>`, якщо запускатимете рекламу в Meta
