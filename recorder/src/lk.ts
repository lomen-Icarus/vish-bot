/**
 * Проверка учётки студента через личный кабинет lk.chuvsu.ru — без вебинара.
 * Логин и пароль те же, что у режима «обучающийся» на странице вебинара.
 *
 * Ответы кабинета (проверено вживую):
 *   • верный логин — 302 на /student/…;
 *   • неверный — 200 со страницей входа и словом «Неверн…»;
 *   • всё остальное (5xx, обрыв, таймаут) — кабинет недоступен, это не
 *     «пароль не подошёл»: иначе сбой портала объявил бы мёртвыми все аккаунты.
 *
 * Открываем только страницу расписания (/student/tt.php) — ради номера группы.
 * Страницу с личными данными (ФИО, телефон, дата рождения) не трогаем.
 */
import { Agent, fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";
import { PORTAL_CA_CERTS } from "./certs.js";

export const LK_BASE = "https://lk.chuvsu.ru";

export type LoginVerdict = "ok" | "bad" | "down";

export interface LoginCheck {
  verdict: LoginVerdict;
  /** Номер группы в расписании tt.chuvsu.ru — только при verdict = ok. */
  groupId?: number | null;
}

const dispatchers = new Map<string, Dispatcher>();
function dispatcherFor(proxyUrl?: string): Dispatcher {
  const key = proxyUrl ?? "";
  let d = dispatchers.get(key);
  if (!d) {
    const tls = { ca: PORTAL_CA_CERTS };
    d = proxyUrl ? new ProxyAgent({ uri: proxyUrl, requestTls: tls, connectTimeout: 15_000 }) : new Agent({ connect: { ...tls, timeout: 15_000 } });
    dispatchers.set(key, d);
  }
  return d;
}

/** Разбор ответа на вход — отдельно, чтобы проверить его без сети. */
export function loginVerdict(status: number, location: string | null, body: string): LoginVerdict {
  if (status >= 300 && status < 400 && location?.includes("student")) return "ok";
  if (status === 200 && /неверн/i.test(body)) return "bad";
  return "down";
}

export function groupIdFromTtPage(html: string): number | null {
  const m = /tt\.chuvsu\.ru\/index\/grouptt\/gr\/(\d+)/.exec(html);
  return m ? Number(m[1]) : null;
}

/** Открывается ли страница входа кабинета — «контрольная» проверка, жив ли сам портал. */
export async function lkAlive(opts: { proxyUrl?: string } = {}): Promise<boolean> {
  try {
    const res = await undiciFetch(`${LK_BASE}/info/login.php`, { dispatcher: dispatcherFor(opts.proxyUrl), signal: AbortSignal.timeout(20_000) });
    await res.text();
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function checkStudentLogin(login: string, password: string, opts: { proxyUrl?: string } = {}): Promise<LoginCheck> {
  const dispatcher = dispatcherFor(opts.proxyUrl);
  let cookie = "";
  try {
    const res = await undiciFetch(`${LK_BASE}/info/login.php`, {
      method: "POST",
      dispatcher,
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) vish-bot-recorder" },
      body: new URLSearchParams({ email: login, password, role: "1", enter: "" }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text();
    const verdict = loginVerdict(res.status, res.headers.get("location"), body);
    if (verdict !== "ok") return { verdict };
    cookie = ((res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [])
      .map((c) => /^([^=]+=[^;]*)/.exec(c)?.[1])
      .filter(Boolean)
      .join("; ");
  } catch {
    return { verdict: "down" };
  }
  try {
    const tt = await undiciFetch(`${LK_BASE}/student/tt.php`, { dispatcher, headers: { Cookie: cookie }, signal: AbortSignal.timeout(20_000) });
    return { verdict: "ok", groupId: groupIdFromTtPage(await tt.text()) };
  } catch {
    // Вход прошёл — это главное; группу не узнали.
    return { verdict: "ok", groupId: null };
  }
}
