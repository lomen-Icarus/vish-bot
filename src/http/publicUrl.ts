/**
 * Публичный адрес бота с резервом: PUBLIC_URL — основной, PUBLIC_URL_FALLBACK —
 * запасной (тоже HTTPS). По ним телефоны забирают подписку на календарь.
 * Домен основного может лечь (у регистратора ломалось делегирование DNS), и
 * тогда бот раздавал бы мёртвые ссылки. Поэтому раз в несколько минут бот
 * проверяет основной адрес: есть ли имя в публичном DNS и отвечает ли /health
 * (сам у себя). Всё в порядке — ссылки
 * идут через основной; нет — пробует запасной; не отвечает никто — остаётся
 * основной (как настроено). Ссылка, уже выданная через запасной, работает и
 * дальше: запасной адрес постоянный.
 */
import { logger } from "../logger.js";

export const PUBLIC_URL_CHECK_MS = 5 * 60_000;

export type Prober = (url: string) => Promise<boolean>;

/** Публичные DNS-over-HTTPS: так имя видят телефоны пользователей, а не кеш хостинга. */
const DOH = ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"];

/**
 * Резолвится ли имя в публичном DNS. true/false — ответ DNS; null — до DNS
 * не достучались (тогда судим только по /health). Нужно потому, что DNS
 * хостинга бота помнил записи лёгшего домена: со своего сервера бот видел
 * основной адрес живым и раздавал ссылки, которые у людей не открывались.
 */
export async function publicDnsOk(host: string, fetcher: typeof fetch = fetch): Promise<boolean | null> {
  for (const url of DOH) {
    try {
      const res = await fetcher(`${url}?name=${encodeURIComponent(host)}&type=A`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) continue;
      const data = (await res.json()) as { Status?: number; Answer?: unknown[] };
      return data.Status === 0 && Array.isArray(data.Answer) && data.Answer.length > 0;
    } catch {
      /* следующий резолвер */
    }
  }
  return null;
}

/** Адрес жив: имя есть в публичном DNS (или DNS недоступен) и GET /health отвечает 2xx за 10 с. */
export const probeHealth: Prober = async (base) => {
  try {
    if ((await publicDnsOk(new URL(base).hostname)) === false) return false;
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) });
    await res.text().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
};

export class PublicUrl {
  private active: "primary" | "fallback" = "primary";

  constructor(
    private readonly primary: string | undefined,
    private readonly fallback: string | undefined,
    private readonly probe: Prober = probeHealth,
  ) {}

  /** Адрес для новых ссылок. undefined — публичный адрес не настроен вовсе. */
  current(): string | undefined {
    if (this.active === "fallback" && this.fallback) return this.fallback;
    return this.primary ?? this.fallback;
  }

  /** Какой адрес сейчас в ходу — для /health и логов. */
  which(): "primary" | "fallback" {
    return this.active === "fallback" && this.fallback ? "fallback" : "primary";
  }

  /** Проверить основной; лёг — перейти на запасной, если тот отвечает. */
  async refresh(): Promise<void> {
    if (!this.primary || !this.fallback) return;
    const was = this.active;
    if (await this.probe(this.primary)) this.active = "primary";
    else if (await this.probe(this.fallback)) this.active = "fallback";
    else this.active = "primary";
    if (was !== this.active) logger.warn({ use: this.active }, this.active === "fallback" ? "основной PUBLIC_URL не отвечает — ссылки идут через запасной" : "основной PUBLIC_URL снова отвечает");
  }
}

/** Адрес для ссылок: живой из пары основной/запасной, иначе как в конфиге. */
export function publicBase(deps: { publicUrl?: PublicUrl; config: { PUBLIC_URL?: string; PUBLIC_URL_FALLBACK?: string } }): string | undefined {
  return deps.publicUrl?.current() ?? deps.config.PUBLIC_URL ?? deps.config.PUBLIC_URL_FALLBACK;
}

/**
 * Первый HTTPS-адрес среди доступных: нужен Mini App (Telegram открывает его
 * только по HTTPS), когда основной адрес — http, а HTTPS только запасной.
 */
export function httpsBase(deps: { publicUrl?: PublicUrl; config: { PUBLIC_URL?: string; PUBLIC_URL_FALLBACK?: string } }): string | undefined {
  return [deps.publicUrl?.current(), deps.config.PUBLIC_URL, deps.config.PUBLIC_URL_FALLBACK].find((u) => u?.startsWith("https://"));
}
