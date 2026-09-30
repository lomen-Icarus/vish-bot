/**
 * Ровно та часть портала, которая нужна записи вебинаров: страница
 * «Вебинары» за день и запрос ссылки на комнату.
 *
 * Как это устроено у ЧГУ (проверено по разметке страницы):
 *   • строка вебинара получает ссылку `jointo(idw, idwt)` только когда к нему
 *     уже можно подключиться, то есть незадолго до начала и во время пары;
 *   • «Подключиться» шлёт POST /webinar/getjoin {idw, idwt, name, pass, auto}
 *     и получает JSON {mes:"SUCCESS", url:"https://…"} — это адрес комнаты
 *     BigBlueButton с одноразовым токеном.
 */
import { Agent, fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { PORTAL_CA_CERTS } from "./certs.js";
import { parseWebinars } from "chuvsu-js/parsers";
import type { WebinarProfile } from "./config.js";
import { profilesFor } from "./plan.js";

export const PORTAL_BASE = "https://tt.chuvsu.ru";

export interface WebinarRow {
  /** «Вебинар по расписанию» — только такие записываем. */
  scheduled: boolean;
  /** idw для getjoin; пустая строка — подключиться ещё нельзя. */
  joinId: string;
  /** idwt для getjoin. */
  joinType: string;
  startMinutes: number | null;
  endMinutes: number | null;
  subject: string;
  teacher: string;
  groups: string[];
  title: string;
  raw: string;
}

const MIN_GAP_MS = 900;

export class Portal {
  private readonly cookies = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastAt = 0;
  private readonly dispatcher: Dispatcher;

  constructor(private readonly opts: { proxyUrl?: string; timeoutMs?: number } = {}) {
    // Цепочку портала проверяем по закреплённым сертификатам, как бот.
    const tls = { ca: PORTAL_CA_CERTS };
    this.dispatcher = opts.proxyUrl ? new ProxyAgent({ uri: opts.proxyUrl, requestTls: tls, connectTimeout: 15_000 }) : new Agent({ connect: { ...tls, timeout: 15_000 } });
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private store(headers: Headers): void {
    const raw = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const c of raw) {
      const m = /^([^=]+)=([^;]*)/.exec(c);
      if (m) this.cookies.set(m[1]!.trim(), m[2]!);
    }
  }

  /** Все запросы идут по очереди с паузой: портал не любит частых обращений. */
  private request(url: string, init: { method: string; body?: string; headers?: Record<string, string>; keepCookies?: boolean }): Promise<{ status: number; body: string; location?: string }> {
    const run = async (): Promise<{ status: number; body: string; location?: string }> => {
      const wait = this.lastAt + MIN_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastAt = Date.now();
      const res = await undiciFetch(url, {
        method: init.method,
        headers: {
          ...(init.headers ?? {}),
          Cookie: this.cookieHeader(),
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) vish-bot-recorder",
          "Accept-Language": "ru,en;q=0.5",
        },
        body: init.body,
        redirect: "manual",
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
      if (init.keepCookies !== false) this.store(res.headers as unknown as Headers);
      return { status: res.status, body: await res.text(), location: res.headers.get("location") ?? undefined };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Гостевой вход: портал отдаёт сессионную куку, без неё страница вебинаров пуста. */
  async loginAsGuest(): Promise<void> {
    this.cookies.clear();
    const res = await this.request(`${PORTAL_BASE}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ guest: "Войти гостем" }).toString(),
    });
    if (!this.cookies.size) throw new Error(`портал не дал сессию гостю (HTTP ${res.status})`);
  }

  /**
   * Страница вебинаров за день. Гостевая сессия живёт не вечно: если портал
   * отдал форму входа, заходим гостем заново и повторяем запрос один раз.
   */
  async webinarPage(date: string, facultyId: number): Promise<string> {
    const html = await this.fetchWebinarPage(date, facultyId);
    if (!looksLikeLoginPage(html)) return html;
    await this.loginAsGuest();
    return this.fetchWebinarPage(date, facultyId);
  }

  private async fetchWebinarPage(date: string, facultyId: number): Promise<string> {
    // Портал ждёт дату как ГГГГ-ММ-ДД: это значения в его списке дат
    // (<select name="seldate">), так же её шлют бот и chuvsu-js.
    const res = await this.request(`${PORTAL_BASE}/webinar`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ seldate: date, selfac: String(facultyId), pertt: "1" }).toString(),
    });
    if (res.status >= 300 && res.status < 400 && res.location) {
      const follow = await this.request(new URL(res.location, PORTAL_BASE).toString(), { method: "GET" });
      return follow.body;
    }
    return res.body;
  }

  /**
   * Просит у портала ссылку на комнату. Возвращает либо адрес, либо текст
   * ошибки портала — его полезно показать админу как есть.
   */
  async getJoinUrl(row: { joinId: string; joinType: string }, auth: { name: string; pass: string; mode: string }): Promise<{ url?: string; error?: string }> {
    const res = await this.request(`${PORTAL_BASE}/webinar/getjoin`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
      body: new URLSearchParams({ idw: row.joinId, idwt: row.joinType, name: auth.name, pass: auth.pass, auto: auth.mode }).toString(),
      // Куки ответа getjoin не сохраняем: попытка одной учётки не должна
      // менять сессию, с которой пойдёт следующая. Ссылка на комнату от куки
      // не зависит, а протухшую гостевую сессию webinarPage обновит сама.
      keepCookies: false,
    });
    try {
      const data = JSON.parse(res.body) as { mes?: string; url?: string };
      if (data.mes === "SUCCESS" && data.url && /^https?:\/\//.test(data.url)) return { url: data.url };
      return { error: (data.mes ?? res.body).toString().replace(/<[^>]+>/g, "").slice(0, 300) };
    } catch {
      return { error: `портал ответил не JSON (${res.status}): ${res.body.slice(0, 200).replace(/\s+/g, " ")}` };
    }
  }
}

/** Итог попытки войти в комнату: ссылка и каким профилем, либо ошибки по каждому профилю. */
export interface JoinResult {
  url?: string;
  profile?: string;
  errors: string[];
}

/**
 * Ссылка на комнату: профили по очереди (сначала заведённые для групп пары,
 * потом общие). Ошибка сети у одного профиля не мешает попробовать следующий.
 * В ошибках — только номер профиля, без логина.
 */
export async function joinWithProfiles(portal: Pick<Portal, "getJoinUrl">, row: Pick<WebinarRow, "joinId" | "joinType" | "groups">, profiles: WebinarProfile[]): Promise<JoinResult> {
  const order = profilesFor(row, profiles);
  if (!order.length) return { errors: [`ни один профиль не заведён для групп ${row.groups.join(", ")}`] };
  const errors: string[] = [];
  for (const p of order) {
    try {
      const join = await portal.getJoinUrl(row, { name: p.login, pass: p.password, mode: p.authMode });
      if (join.url) return { url: join.url, profile: p.name, errors };
      errors.push(`профиль ${p.name}: ${join.error ?? "нет ссылки"}`);
    } catch (err) {
      errors.push(`профиль ${p.name}: ${String(err).slice(0, 200)}`);
    }
  }
  return { errors };
}

/**
 * Разбор строк вебинаров берём из chuvsu-js — той же библиотеки, которой
 * пользуется бот. Своя регулярка спотыкалась о вложенные таблицы и о кавычки
 * в `jointo('90412',1)`, а этот парсер живёт вместе с порталом.
 */
export function parseWebinarRows(html: string): WebinarRow[] {
  const minutes = (t: { hours: number; minutes: number } | undefined): number | null => (t ? t.hours * 60 + t.minutes : null);
  return parseWebinars(html).map((w) => ({
    joinId: w.id ?? "",
    joinType: String(w.idType ?? 1),
    startMinutes: minutes(w.time?.start),
    endMinutes: minutes(w.time?.end),
    subject: w.subject?.trim() ?? "",
    teacher: w.teacher?.name?.trim() ?? "",
    groups: (w.groups ?? []).map((g) => g.trim()).filter(Boolean),
    title: w.title?.trim() ?? "",
    // Вне расписания бывают закрытые встречи — их записывать нельзя.
    scheduled: w.scheduled !== false,
    raw: w.raw ?? "",
  }));
}

/**
 * Портал отдал форму входа вместо страницы: сессия протухла.
 * Та же проверка, что и у бота: поля `wname` есть и на странице вебинаров —
 * внутри диалога подключения, поэтому одного их наличия мало.
 */
export function looksLikeLoginPage(html: string): boolean {
  if (!html.includes('name="wname"')) return false;
  return !html.includes('id="joindialog"');
}
