/**
 * Яндекс: вход (OAuth, oauth.yandex.ru) и запись пар по CalDAV
 * (caldav.yandex.ru, заголовок «Authorization: OAuth <токен>»). Права
 * задаются в самом приложении на oauth.yandex.ru (Календарь: чтение и
 * запись); в отличие от Google, Яндекс даёт доступ ко всем календарям
 * аккаунта — бот всё равно пишет только в свой.
 *
 * Создать отдельный календарь Яндекс по CalDAV может не дать (MKCALENDAR →
 * 501/405/403): тогда бот ищет календарь с нужным названием, созданный
 * человеком, а не найдя — просит его создать (need_calendar).
 *
 * Ошибки — общие для календарей (errors.ts). fetch подставляется (тесты).
 */
import { randomBytes } from "node:crypto";
import { CalError, type CalErrorKind } from "./errors.js";
import type { Fetch } from "./google.js";

const AUTH_URL = "https://oauth.yandex.ru/authorize";
const TOKEN_URL = "https://oauth.yandex.ru/token";
const REVOKE_URL = "https://oauth.yandex.ru/revoke_token";
export const YANDEX_DAV = "https://caldav.yandex.ru";

function kindOf(status: number, reason: string): CalErrorKind {
  if (reason === "invalid_grant" || reason === "unauthorized_client" || reason === "invalid_client") return "revoked";
  if (status === 401 || status === 403) return "revoked";
  if (status === 404 || status === 410) return "gone";
  if (status === 429 || status >= 500 || status === 0) return "retry";
  return "fatal";
}

async function fail(res: Response): Promise<never> {
  const body = (await res.text().catch(() => "")).slice(0, 2000);
  let reason = `http_${res.status}`;
  try {
    const j = JSON.parse(body) as { error?: string };
    if (typeof j.error === "string") reason = j.error;
  } catch {
    /* не JSON — CalDAV отвечает XML или пусто */
  }
  throw new CalError(kindOf(res.status, reason), res.status, reason.slice(0, 80));
}

/** Все <href> из ответа PROPFIND внутри нужного свойства (префиксы пространств имён у Яндекса и других серверов разные). */
function hrefIn(xml: string, prop: string): string | null {
  const m = new RegExp(`<(?:[\\w-]+:)?${prop}\\b[^>]*>\\s*<(?:[\\w-]+:)?href[^>]*>([^<]+)<`, "i").exec(xml);
  return m ? decodeXml(m[1]!.trim()) : null;
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
}

const escXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface DavCalendar {
  href: string;
  name: string;
}

/** Календари из ответа PROPFIND Depth: 1 по домашней папке. */
export function parseCalendars(xml: string): DavCalendar[] {
  const out: DavCalendar[] = [];
  for (const block of xml.split(/<(?:[\w-]+:)?response\b/i).slice(1)) {
    const href = /<(?:[\w-]+:)?href[^>]*>([^<]+)</i.exec(block)?.[1];
    if (!href || !/<(?:[\w-]+:)?calendar\b[^>]*\/>/i.test(block)) continue;
    const name = /<(?:[\w-]+:)?displayname[^>]*>([^<]*)</i.exec(block)?.[1] ?? "";
    out.push({ href: decodeXml(href.trim()), name: decodeXml(name.trim()) });
  }
  return out;
}

export class YandexCalendarClient {
  constructor(
    private readonly cfg: { clientId: string; clientSecret: string; redirectUri: string },
    private readonly http: Fetch = fetch,
  ) {}

  /** Вход в Яндекс; force_confirm — чтобы человек видел, какой аккаунт подключает. */
  authUrl(state: string): string {
    const q = new URLSearchParams({ response_type: "code", client_id: this.cfg.clientId, redirect_uri: this.cfg.redirectUri, state, force_confirm: "yes" });
    return `${AUTH_URL}?${q.toString()}`;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.http(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new CalError("retry", 0, "network");
    }
  }

  private async token(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
    const res = await this.call(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...form }).toString() });
    if (!res.ok) return fail(res);
    return (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
  }

  async exchange(code: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }> {
    const t = await this.token({ grant_type: "authorization_code", code });
    // Без refresh token продлевать нечем — тогда храним сам токен (у Яндекса он живёт долго, до года).
    return { accessToken: t.access_token, refreshToken: t.refresh_token ?? `access:${t.access_token}`, expiresAt: Date.now() + Math.max(60, (t.expires_in ?? 3600) - 120) * 1000 };
  }

  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: number }> {
    if (refreshToken.startsWith("access:")) return { accessToken: refreshToken.slice(7), expiresAt: Date.now() + 3600_000 };
    const t = await this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
    return { accessToken: t.access_token, expiresAt: Date.now() + Math.max(60, (t.expires_in ?? 3600) - 120) * 1000 };
  }

  /** Отозвать токен (при «Отключить»); ошибки глотаем — у нас человек отключён в любом случае. */
  async revoke(refreshToken: string): Promise<void> {
    const access = await this.refresh(refreshToken).then((t) => t.accessToken).catch(() => null);
    if (!access) return;
    await this.call(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ access_token: access, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }).toString() })
      .then((r) => r.body?.cancel())
      .catch(() => undefined);
  }

  private async dav(access: string, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<Response> {
    const url = /^https?:\/\//.test(path) ? path : `${YANDEX_DAV}${path}`;
    return this.call(url, { method, headers: { Authorization: `OAuth ${access}`, ...(body ? { "Content-Type": "application/xml; charset=utf-8" } : {}), ...headers }, body });
  }

  /** Домашняя папка календарей: current-user-principal → calendar-home-set. */
  async home(access: string): Promise<string> {
    const ask = (prop: string) => `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><${prop}/></d:prop></d:propfind>`;
    const r1 = await this.dav(access, "PROPFIND", "/", ask("d:current-user-principal"), { Depth: "0" });
    if (r1.status !== 207) return fail(r1);
    const principal = hrefIn(await r1.text(), "current-user-principal");
    if (!principal) throw new CalError("fatal", 207, "no_principal");
    const r2 = await this.dav(access, "PROPFIND", principal, ask("c:calendar-home-set"), { Depth: "0" });
    if (r2.status !== 207) return fail(r2);
    const home = hrefIn(await r2.text(), "calendar-home-set");
    if (!home) throw new CalError("fatal", 207, "no_calendar_home");
    return home.endsWith("/") ? home : `${home}/`;
  }

  async calendars(access: string, home: string): Promise<DavCalendar[]> {
    const body = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>';
    const res = await this.dav(access, "PROPFIND", home, body, { Depth: "1" });
    if (res.status !== 207) return fail(res);
    return parseCalendars(await res.text());
  }

  /** Создать календарь; Яндекс может не уметь (501/405/403) — тогда need_calendar решает вызывающий. */
  async createCalendar(access: string, home: string, name: string): Promise<string> {
    const href = `${home}vish-${randomBytes(6).toString("hex")}/`;
    const body = `<?xml version="1.0" encoding="utf-8"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>${escXml(name)}</d:displayname></d:prop></d:set></c:mkcalendar>`;
    const res = await this.dav(access, "MKCALENDAR", href, body);
    if (res.ok) {
      await res.body?.cancel();
      return href;
    }
    if (res.status === 501 || res.status === 405 || res.status === 403 || res.status === 400) {
      await res.body?.cancel();
      throw new CalError("fatal", res.status, "mkcalendar_unsupported");
    }
    return fail(res);
  }

  async calendarExists(access: string, href: string): Promise<boolean> {
    const res = await this.dav(access, "PROPFIND", href, '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>', { Depth: "0" });
    if (res.status === 207) {
      await res.body?.cancel();
      return true;
    }
    const err = await fail(res).catch((e: CalError) => e);
    if (err.kind === "gone") return false;
    throw err;
  }

  /** Переименовать (сменилась группа). Не дал Яндекс — не беда: пары важнее названия. */
  async renameCalendar(access: string, href: string, name: string): Promise<void> {
    const body = `<?xml version="1.0" encoding="utf-8"?><d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><d:displayname>${escXml(name)}</d:displayname></d:prop></d:set></d:propertyupdate>`;
    const res = await this.dav(access, "PROPPATCH", href, body).catch(() => null);
    await res?.body?.cancel();
  }

  /** Поставить или перезаписать событие (PUT по своему имени файла — повтор не плодит дублей). */
  async putEvent(access: string, href: string, eventId: string, ics: string): Promise<void> {
    const res = await this.call(`${YANDEX_DAV}${href}${eventId}.ics`, { method: "PUT", headers: { Authorization: `OAuth ${access}`, "Content-Type": "text/calendar; charset=utf-8" }, body: ics });
    if (!res.ok) return fail(res);
    await res.body?.cancel();
  }

  async deleteEvent(access: string, href: string, eventId: string): Promise<void> {
    const res = await this.dav(access, "DELETE", `${href}${eventId}.ics`);
    if (res.ok || res.status === 404 || res.status === 410) return void (await res.body?.cancel());
    return fail(res);
  }
}
