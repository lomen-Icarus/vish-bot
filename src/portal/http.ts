import { Agent, ProxyAgent, type Dispatcher, fetch as undiciFetch } from "undici";
import { PORTAL_CA_CERTS } from "./certs.js";
import { sleep } from "../time.js";
import { logger } from "../logger.js";

export interface PortalHttpOptions {
  /** Skip TLS verification (development behind an intercepting proxy only). */
  insecureTls?: boolean;
  /** Honour HTTPS_PROXY (development sandboxes). */
  proxyUrl?: string;
  /** Minimum gap between two requests, to be polite to the portal. */
  minGapMs?: number;
  timeoutMs?: number;
  userAgent?: string;
}

export interface HttpResponse {
  status: number;
  body: string;
  location?: string;
  url: string;
}

export class PortalHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PortalHttpError";
  }
}

/**
 * Small cookie-aware HTTP client: sequential, rate-limited, with retries.
 * Redirects are not followed automatically so the caller can observe 302s
 * (the portal signals login success with a redirect).
 */
export class PortalHttp {
  private readonly cookies = new Map<string, string>();
  private readonly dispatcher: Dispatcher;
  private readonly minGapMs: number;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private lastRequestAt = 0;
  private queue: Promise<unknown> = Promise.resolve();
  requestCount = 0;

  constructor(opts: PortalHttpOptions = {}) {
    const tls = opts.insecureTls ? { rejectUnauthorized: false } : { ca: PORTAL_CA_CERTS };
    this.dispatcher = opts.proxyUrl
      ? new ProxyAgent({ uri: opts.proxyUrl, requestTls: tls, connectTimeout: 15_000 })
      : new Agent({ connect: { ...tls, timeout: 15_000 } });
    this.minGapMs = opts.minGapMs ?? 900;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.userAgent = opts.userAgent ?? "vish-bot/0.1 (+telegram schedule bot; contact via bot admin)";
    if (opts.insecureTls) logger.warn("portal TLS verification is DISABLED (PORTAL_TLS_INSECURE)");
  }

  clearCookies(): void {
    this.cookies.clear();
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private storeCookies(headers: Headers): void {
    const raw = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const c of raw) {
      const m = /^([^=]+)=([^;]*)/.exec(c);
      if (m) this.cookies.set(m[1]!.trim(), m[2]!);
    }
  }

  get(url: string): Promise<HttpResponse> {
    return this.request(url, { method: "GET" });
  }

  post(url: string, form: Record<string, string>): Promise<HttpResponse> {
    return this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
  }

  /** GET that follows same-origin redirects (max 5). */
  async getFollow(url: string): Promise<HttpResponse> {
    let current = url;
    for (let i = 0; i < 5; i++) {
      const res = await this.get(current);
      if (res.status >= 300 && res.status < 400 && res.location) {
        current = new URL(res.location, current).toString();
        continue;
      }
      return res;
    }
    throw new PortalHttpError(`Too many redirects for ${url}`);
  }

  /** POST that follows a redirect with GET (portal pattern: POST form -> 302 -> page). */
  async postFollow(url: string, form: Record<string, string>): Promise<HttpResponse> {
    const res = await this.post(url, form);
    if (res.status >= 300 && res.status < 400 && res.location) {
      return this.getFollow(new URL(res.location, url).toString());
    }
    return res;
  }

  private request(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<HttpResponse> {
    const run = async (): Promise<HttpResponse> => {
      const wait = this.lastRequestAt + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        this.lastRequestAt = Date.now();
        this.requestCount++;
        try {
          const res = await undiciFetch(url, {
            method: init.method,
            headers: {
              ...(init.headers ?? {}),
              Cookie: this.cookieHeader(),
              "User-Agent": this.userAgent,
              "Accept-Language": "ru,en;q=0.5",
            },
            body: init.body,
            redirect: "manual",
            dispatcher: this.dispatcher,
            signal: AbortSignal.timeout(this.timeoutMs),
          });
          this.storeCookies(res.headers);
          const body = await res.text();
          if (res.status >= 500 || res.status === 403 || res.status === 429) {
            throw new PortalHttpError(`HTTP ${res.status} from ${url}`, res.status);
          }
          return { status: res.status, body, location: res.headers.get("location") ?? undefined, url };
        } catch (err) {
          lastError = err;
          const status = err instanceof PortalHttpError ? err.status : undefined;
          logger.warn({ err: String(err), url, attempt }, "portal request failed");
          // 403/429 look like burst limiting on the portal: back off for longer.
          if (attempt < 3) await sleep(status === 403 || status === 429 ? 20_000 * attempt : 1000 * attempt * attempt);
        }
      }
      throw lastError instanceof Error ? lastError : new PortalHttpError(String(lastError));
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
