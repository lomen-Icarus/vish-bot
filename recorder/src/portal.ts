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
import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici";

export const PORTAL_BASE = "https://tt.chuvsu.ru";

export interface WebinarRow {
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
  private readonly dispatcher: Dispatcher | undefined;

  constructor(private readonly opts: { proxyUrl?: string; timeoutMs?: number } = {}) {
    this.dispatcher = opts.proxyUrl ? new ProxyAgent({ uri: opts.proxyUrl, connectTimeout: 15_000 }) : undefined;
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
  private request(url: string, init: { method: string; body?: string; headers?: Record<string, string> }): Promise<{ status: number; body: string; location?: string }> {
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
      this.store(res.headers as unknown as Headers);
      return { status: res.status, body: await res.text(), location: res.headers.get("location") ?? undefined };
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Гостевой вход: портал отдаёт сессионную куку, без неё страница вебинаров пуста. */
  async loginAsGuest(): Promise<void> {
    await this.request(`${PORTAL_BASE}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ guest: "Войти гостем" }).toString(),
    });
  }

  /** Страница вебинаров за день (HTML). */
  async webinarPage(date: string, facultyId: number): Promise<string> {
    const [y, m, d] = date.split("-");
    const res = await this.request(`${PORTAL_BASE}/webinar`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ seldate: `${d}.${m}.${y}`, selfac: String(facultyId), pertt: "1" }).toString(),
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

const textOf = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const toMinutes = (hhmm: string | undefined): number | null => {
  if (!hhmm) return null;
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(hhmm.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Разбор строк таблицы вебинаров. Нас интересует не столько содержимое
 * (его знает бот), сколько `jointo(...)`: он и есть пропуск в комнату.
 */
export function parseWebinarRows(html: string): WebinarRow[] {
  const rows: WebinarRow[] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const inner = tr[1]!;
    const join = /jointo(?:sub)?\((\d+)\s*,\s*(\d+)\)/.exec(inner);
    const cells = [...inner.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => textOf(c[1]!));
    if (cells.length < 2) continue;
    const raw = cells.join(" | ");
    const time = /(\d{1,2}[:.]\d{2})\s*[–—-]\s*(\d{1,2}[:.]\d{2})/.exec(raw);
    const groups = [...raw.matchAll(/(ОЗ)?ВИШ[\s-]*\d{1,2}[\s-]*\d{2}(?:иот)?(?:\s*\([^)]*\))?/gu)].map((m) => m[0].replace(/\s+/g, " ").trim());
    // Преподаватель — «Фамилия И. О.»; берём первое такое вхождение строки.
    const teacher = /([А-ЯЁ][а-яё-]+\s+[А-ЯЁ]\.\s*[А-ЯЁ]\.)/u.exec(raw)?.[1] ?? "";
    rows.push({
      joinId: join?.[1] ?? "",
      joinType: join?.[2] ?? "1",
      startMinutes: toMinutes(time?.[1]),
      endMinutes: toMinutes(time?.[2]),
      subject: cells[1] ?? "",
      teacher,
      groups: [...new Set(groups)],
      title: cells[2] ?? "",
      raw,
    });
  }
  return rows;
}
