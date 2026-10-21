/**
 * Тонкий клиент Bot API мессенджера МАКС (https://dev.max.ru/docs-api): только
 * то, что нужно мосту (src/max/bridge.ts). Своя реализация, а не
 * @maxhub/max-bot-api: API отдаёт сертификат НУЦ Минцифры, и доверять ему
 * нужно точечно — своим undici-агентом, как порталу (src/portal/http.ts), — а
 * не всему процессу через NODE_EXTRA_CA_CERTS.
 */
import { rootCertificates } from "node:tls";
import { Agent, FormData, ProxyAgent, type Dispatcher, fetch as undiciFetch } from "undici";
import { RUSSIAN_TRUSTED_ROOT_CA } from "./certs.js";
import { sleep } from "../time.js";

export const MAX_API_ROOT = "https://platform-api2.max.ru";

/** Кнопки под сообщением (InlineKeyboard у МАКС). */
export type MaxButton =
  | { type: "callback"; text: string; payload: string }
  | { type: "link"; text: string; url: string }
  | { type: "message"; text: string }
  | { type: "clipboard"; text: string; payload: string };

/** Вложение исходящего сообщения: картинка и файл — по токену загрузки или ссылке. */
export type MaxAttachment =
  | { type: "image"; payload: { token?: string; url?: string; photos?: Record<string, { token: string }> } }
  | { type: "file"; payload: { token: string } }
  | { type: "inline_keyboard"; payload: { buttons: MaxButton[][] } };

export interface MaxNewMessage {
  text?: string | null;
  attachments?: MaxAttachment[] | null;
  notify?: boolean;
  format?: "html" | "markdown" | null;
}

export interface MaxUser {
  user_id: number;
  first_name?: string;
  last_name?: string | null;
  name?: string;
  username?: string | null;
  is_bot?: boolean;
}

/** Вложение входящего сообщения (что нужно мосту; остальные поля игнорируем). */
export interface MaxIncomingAttachment {
  type: string;
  payload?: { url?: string; token?: string; photo_id?: number; buttons?: unknown } | null;
  filename?: string;
}

export interface MaxMessage {
  sender?: MaxUser | null;
  recipient: { chat_id: number | null; chat_type: string; user_id: number | null };
  timestamp: number;
  body: { mid: string; seq?: number; text: string | null; attachments?: MaxIncomingAttachment[] | null };
}

export type MaxUpdate =
  | { update_type: "message_created"; timestamp: number; message: MaxMessage }
  | { update_type: "message_callback"; timestamp: number; callback: { callback_id: string; payload?: string; user: MaxUser; timestamp: number }; message?: MaxMessage | null }
  | { update_type: "bot_started"; timestamp: number; chat_id: number; user: MaxUser; payload?: string | null }
  | { update_type: "bot_stopped"; timestamp: number; chat_id: number; user: MaxUser }
  | { update_type: string; timestamp: number; [key: string]: unknown };

export interface MaxBotInfo {
  user_id: number;
  first_name?: string;
  name?: string;
  username?: string | null;
}

/** Ошибка API: HTTP-код и код МАКС («attachment.not.ready», «chat.denied», …). */
export class MaxApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${status} ${code}: ${message}`);
    this.name = "MaxApiError";
  }
}

/** Сколько раз переотправлять, пока МАКС «переваривает» загруженный файл, и первая пауза. */
const NOT_READY_RETRIES = 4;
const NOT_READY_BASE_MS = 1000;
/** 30 запросов в секунду на весь API (dev.max.ru): держимся с запасом. */
const MIN_GAP_MS = 40;

export interface MaxApiOptions {
  token: string;
  proxyUrl?: string;
  apiRoot?: string;
  /** Для тестов: подменить сеть. */
  fetch?: typeof undiciFetch;
}

export class MaxApi {
  private readonly dispatcher: Dispatcher;
  private readonly root: string;
  private readonly doFetch: typeof undiciFetch;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(private readonly opts: MaxApiOptions) {
    // Минцифры — в дополнение к обычным корням: адрес загрузки файлов может
    // оказаться на другом хосте с обычным сертификатом.
    const tls = { ca: [...rootCertificates, RUSSIAN_TRUSTED_ROOT_CA] };
    this.dispatcher = opts.proxyUrl ? new ProxyAgent({ uri: opts.proxyUrl, requestTls: tls, connectTimeout: 15_000 }) : new Agent({ connect: { ...tls, timeout: 15_000 } });
    this.root = opts.apiRoot ?? MAX_API_ROOT;
    this.doFetch = opts.fetch ?? undiciFetch;
  }

  /** Очередь с паузой между запросами: лимит МАКС общий на бота. Long polling идёт мимо неё. */
  private paced<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequestAt + MIN_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      return fn();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async call<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, opts: { query?: Record<string, string | number | boolean | undefined | null>; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const url = new URL(path, this.root);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v != null && v !== "") url.searchParams.set(k, String(v));
    const res = await this.doFetch(url, {
      method,
      dispatcher: this.dispatcher,
      // Токен — только в заголовке: в адресе его больше не принимают, да и в логи он бы попал.
      headers: { Authorization: this.opts.token, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal ?? AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const d = (data ?? {}) as { code?: string; message?: string };
      throw new MaxApiError(res.status, d.code ?? "http", (d.message ?? text).slice(0, 300));
    }
    // POST /answers и часть других методов отвечают 200 с success=false.
    const d = data as { success?: boolean; message?: string } | null;
    if (d && d.success === false) throw new MaxApiError(res.status, "not.success", (d.message ?? "").slice(0, 300));
    return data as T;
  }

  me(): Promise<MaxBotInfo> {
    return this.paced(() => this.call<MaxBotInfo>("GET", "/me"));
  }

  /** Long polling: ждёт до `timeout` секунд. marker — с какого события читать (null — только новые). */
  updates(opts: { marker: number | null; timeout?: number; types?: string[]; signal?: AbortSignal }): Promise<{ updates: MaxUpdate[]; marker: number | null }> {
    const timeout = opts.timeout ?? 30;
    return this.call("GET", "/updates", {
      query: { marker: opts.marker, timeout, limit: 100, types: opts.types?.join(",") },
      signal: opts.signal ?? AbortSignal.timeout((timeout + 15) * 1000),
    });
  }

  /** Пока файл обрабатывается, МАКС отвечает attachment.not.ready — ждём и пробуем снова. */
  private async withNotReadyRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.paced(fn);
      } catch (err) {
        if (!(err instanceof MaxApiError) || err.code !== "attachment.not.ready" || attempt >= NOT_READY_RETRIES) throw err;
        await sleep(NOT_READY_BASE_MS * 2 ** attempt);
      }
    }
  }

  async sendMessage(userId: number, body: MaxNewMessage, opts: { disableLinkPreview?: boolean } = {}): Promise<MaxMessage> {
    const res = await this.withNotReadyRetry(() => this.call<{ message: MaxMessage }>("POST", "/messages", { query: { user_id: userId, disable_link_preview: opts.disableLinkPreview || undefined }, body }));
    return res.message;
  }

  async editMessage(mid: string, body: MaxNewMessage): Promise<void> {
    await this.withNotReadyRetry(() => this.call("PUT", "/messages", { query: { message_id: mid }, body }));
  }

  async deleteMessage(mid: string): Promise<void> {
    await this.paced(() => this.call("DELETE", "/messages", { query: { message_id: mid } }));
  }

  /** Ответ на нажатие кнопки: всплывающее уведомление. */
  async answerCallback(callbackId: string, notification: string): Promise<void> {
    await this.paced(() => this.call("POST", "/answers", { query: { callback_id: callbackId }, body: { notification } }));
  }

  /** Команды в меню «/» у поля ввода. */
  async setCommands(commands: Array<{ name: string; description: string }>): Promise<void> {
    await this.paced(() => this.call("PATCH", "/me/commands", { body: { commands } }));
  }

  /**
   * Загрузка картинки или файла: адрес загрузки у API, сам файл — туда одним
   * multipart-запросом (поле data). Возвращает payload для вложения.
   */
  async upload(type: "image" | "file", bytes: Uint8Array, fileName: string): Promise<MaxAttachment> {
    const slot = await this.paced(() => this.call<{ url: string; token?: string }>("POST", "/uploads", { query: { type } }));
    const form = new FormData();
    form.append("data", new Blob([bytes]), fileName);
    const res = await this.doFetch(slot.url, { method: "POST", dispatcher: this.dispatcher, headers: { Authorization: this.opts.token }, body: form, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    if (!res.ok) throw new MaxApiError(res.status, "upload", text.slice(0, 300));
    let data: { token?: string; photos?: Record<string, { token: string }> } = {};
    try {
      data = text ? (JSON.parse(text) as typeof data) : {};
    } catch {
      data = {};
    }
    if (type === "image") {
      if (data.photos) return { type: "image", payload: { photos: data.photos } };
      const token = data.token ?? slot.token;
      if (!token) throw new MaxApiError(res.status, "upload", "no token in upload response");
      return { type: "image", payload: { token } };
    }
    const token = data.token ?? slot.token;
    if (!token) throw new MaxApiError(res.status, "upload", "no token in upload response");
    return { type: "file", payload: { token } };
  }
}
