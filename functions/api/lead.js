/**
 * Cloudflare Pages Function для /api/lead.
 *
 * Зараз проєкт задеплоєний як Worker (див. wrangler.jsonc + worker.js), тож
 * цей файл не використовується. Лишається на випадок переїзду на Pages —
 * логіка спільна, у lib/lead.js, щоб не розходилась.
 */

import { health, submit } from "../../lib/lead.js";

export const onRequestGet = ({ request, env }) => health(request, env);
export const onRequestPost = ({ request, env }) => submit(request, env);
