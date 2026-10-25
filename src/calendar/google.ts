/**
 * Google: вход (OAuth 2.0 для веб-сервера) и Calendar API v3 — ровно то, что
 * нужно для прямой записи пар. Право одно — calendar.app.created: создать
 * свой календарь и менять события только в нём; чужие календари человека бот
 * не видит. fetch подставляется (тесты гоняют поддельный Google).
 *
 * Ошибки сводятся к видам из errors.ts (revoked, gone, retry, fatal).
 */
import { CalError, type CalErrorKind } from "./errors.js";

export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/calendar/v3";

/** Ошибки Google — общий вид ошибок календарей (errors.ts); старое имя оставлено для читаемости. */
export { CalError as GoogleError };
export type GoogleErrorKind = CalErrorKind;

export type Fetch = typeof fetch;

export interface GoogleEvent {
  summary: string;
  location?: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  reminders: { useDefault: boolean; overrides?: Array<{ method: "popup"; minutes: number }> };
  /** Повторная постановка удалённого события: вернуть его из «отменённых». */
  status?: "confirmed";
}

/** Причина из ответа Google без текста запроса (в нём бывают названия пар). */
async function reasonOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string | { status?: string; errors?: Array<{ reason?: string }> } } | null;
  if (!body?.error) return `http_${res.status}`;
  if (typeof body.error === "string") return body.error;
  return body.error.errors?.[0]?.reason ?? body.error.status ?? `http_${res.status}`;
}

function kindOf(status: number, reason: string): CalErrorKind {
  if (reason === "invalid_grant" || reason === "unauthorized_client") return "revoked";
  if (status === 404 || status === 410) return "gone";
  if (status === 429 || status >= 500 || /rateLimit|backendError/i.test(reason)) return "retry";
  // 401 — протух access token: следующий проход возьмёт свежий; отзыв доступа видно по invalid_grant.
  if (status === 401) return "retry";
  // 403 без «лимита» — чаще всего доступ к календарю потерян (прав больше нет).
  if (status === 403) return /forbidden|insufficient|accessNotConfigured/i.test(reason) ? "revoked" : "retry";
  return "fatal";
}

async function fail(res: Response): Promise<never> {
  const reason = (await reasonOf(res)).slice(0, 80);
  throw new CalError(kindOf(res.status, reason), res.status, reason);
}

export class GoogleCalendarClient {
  constructor(
    private readonly cfg: { clientId: string; clientSecret: string; redirectUri: string },
    private readonly http: Fetch = fetch,
  ) {}

  /** Куда отправить человека: вход в Google и согласие на одно право. prompt=consent — чтобы refresh token пришёл и при повторном входе. */
  authUrl(state: string): string {
    const q = new URLSearchParams({ client_id: this.cfg.clientId, redirect_uri: this.cfg.redirectUri, response_type: "code", scope: GOOGLE_SCOPE, access_type: "offline", prompt: "consent", state });
    return `${AUTH_URL}?${q.toString()}`;
  }

  private async token(form: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
    const res = await this.call(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...form }).toString() });
    if (!res.ok) return fail(res);
    return (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
  }

  /** Код из возврата → токены. Без refresh token или без нужного права — fatal: записывать будет нечем. */
  async exchange(code: string): Promise<{ accessToken: string; refreshToken: string }> {
    const t = await this.token({ code, grant_type: "authorization_code", redirect_uri: this.cfg.redirectUri });
    if (!t.refresh_token) throw new CalError("fatal", 200, "no_refresh_token");
    if (t.scope && !t.scope.split(" ").includes(GOOGLE_SCOPE)) throw new CalError("fatal", 200, "scope_not_granted");
    return { accessToken: t.access_token, refreshToken: t.refresh_token };
  }

  /** Свежий access token по refresh token (живёт около часа). */
  async refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: number }> {
    const t = await this.token({ refresh_token: refreshToken, grant_type: "refresh_token" });
    return { accessToken: t.access_token, expiresAt: Date.now() + Math.max(60, (t.expires_in ?? 3600) - 120) * 1000 };
  }

  /** Отозвать доступ (при «Отключить»). Ошибку глотаем: человек всё равно отключён у нас. */
  async revoke(token: string): Promise<void> {
    await this.call(REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }).toString() })
      .then((r) => r.body?.cancel())
      .catch(() => undefined);
  }

  private async api(access: string, method: string, path: string, body?: unknown): Promise<Response> {
    return this.call(`${API}${path}`, { method, headers: { Authorization: `Bearer ${access}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.http(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new CalError("retry", 0, "network");
    }
  }

  async createCalendar(access: string, summary: string): Promise<string> {
    const res = await this.api(access, "POST", "/calendars", { summary, timeZone: "Europe/Moscow", description: "Расписание ВИШ ЧувГУ — обновляет Telegram-бот" });
    if (!res.ok) return fail(res);
    return ((await res.json()) as { id: string }).id;
  }

  /** Жив ли календарь (повторное подключение берёт прежний, а не плодит второй). */
  async calendarExists(access: string, calendarId: string): Promise<boolean> {
    const res = await this.api(access, "GET", `/calendars/${encodeURIComponent(calendarId)}`);
    if (res.ok) {
      await res.body?.cancel();
      return true;
    }
    const err = await fail(res).catch((e: CalError) => e);
    if (err.kind === "gone" || err.kind === "revoked") return false;
    throw err;
  }

  async renameCalendar(access: string, calendarId: string, summary: string): Promise<void> {
    const res = await this.api(access, "PATCH", `/calendars/${encodeURIComponent(calendarId)}`, { summary });
    if (!res.ok) return fail(res);
    await res.body?.cancel();
  }

  /**
   * Поставить событие с нашим id. Уже есть (409: ставили раньше или его
   * удаляли, и Google помнит id) — перезаписать его целиком, вернув из
   * отменённых. Повтор после сбоя поэтому не плодит дублей.
   */
  async putEvent(access: string, calendarId: string, eventId: string, event: GoogleEvent): Promise<void> {
    const cal = encodeURIComponent(calendarId);
    const ins = await this.api(access, "POST", `/calendars/${cal}/events`, { id: eventId, ...event });
    if (ins.ok) return void (await ins.body?.cancel());
    if (ins.status !== 409) return fail(ins);
    await ins.body?.cancel();
    const upd = await this.api(access, "PUT", `/calendars/${cal}/events/${eventId}`, { ...event, status: "confirmed" });
    if (!upd.ok) return fail(upd);
    await upd.body?.cancel();
  }

  /** Убрать событие; его уже нет (404/410) — тоже успех. */
  async deleteEvent(access: string, calendarId: string, eventId: string): Promise<void> {
    const res = await this.api(access, "DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`);
    if (res.ok || res.status === 404 || res.status === 410) return void (await res.body?.cancel());
    // 404 на сам календарь неотличим от 404 на событие — календарь проверит следующая постановка.
    return fail(res);
  }
}
