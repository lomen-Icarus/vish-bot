/**
 * Отправка PDF боту. Прокси перед ботом (nginx хостинга) режет тело запроса
 * больше 1 МБ, поэтому большой PDF уходит кусками по 900 КиБ: каждый кусок —
 * POST <адрес>/part, потом POST <адрес>/complete с контрольной суммой, и бот
 * собирает файл. Маленький PDF — одним запросом, как раньше.
 * Отдельный модуль (без pdf-lib), чтобы его можно было проверить тестом.
 */
import { createHash, randomBytes } from "node:crypto";
import { fetch as undiciFetch } from "undici";
import { log } from "./log.js";

/** 900 КиБ: с заголовками запроса гарантированно меньше 1 МиБ. */
export const PART_BYTES = 900 * 1024;

export interface UploadOptions {
  url: string;
  token: string;
  pdf: Buffer;
  /** Готовый заголовок X-Slides-Meta (base64 JSON). */
  meta: string;
  /** Для тестов: размер куска и пауза между повторами. */
  partBytes?: number;
  retryDelayMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function post(url: string, headers: Record<string, string>, body: Buffer | undefined): Promise<{ status: number; text: string }> {
  const res = await undiciFetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(120_000) });
  return { status: res.status, text: (await res.text()).slice(0, 200) };
}

/** Кусок с повторами: сеть моргнула — не повод начинать всю отправку заново. */
async function postWithRetry(url: string, headers: Record<string, string>, body: Buffer | undefined, delayMs: number): Promise<{ status: number; text: string }> {
  let last: { status: number; text: string } = { status: 0, text: "" };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      last = await post(url, headers, body);
      // 4xx (кроме 408/429) — ответ бота по существу, повтор не поможет.
      if (last.status < 500 && last.status !== 408 && last.status !== 429) return last;
    } catch (err) {
      last = { status: 0, text: String(err).slice(0, 200) };
    }
    if (attempt < 2) await sleep(delayMs * (attempt + 1));
  }
  return last;
}

/** Отдать PDF боту. true — бот принял. */
export async function uploadDeck(opts: UploadOptions): Promise<boolean> {
  const partBytes = opts.partBytes ?? PART_BYTES;
  const delay = opts.retryDelayMs ?? 2000;
  const base = opts.url.replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${opts.token}` };
  if (opts.pdf.length <= partBytes) {
    const r = await postWithRetry(base, { ...auth, "Content-Type": "application/pdf", "X-Slides-Meta": opts.meta }, opts.pdf, delay);
    if (r.status >= 200 && r.status < 300) return true;
    log.warn({ status: r.status, body: r.text }, "бот не принял слайды");
    return false;
  }
  const id = randomBytes(16).toString("hex");
  const count = Math.ceil(opts.pdf.length / partBytes);
  for (let i = 0; i < count; i++) {
    const chunk = opts.pdf.subarray(i * partBytes, (i + 1) * partBytes);
    const r = await postWithRetry(`${base}/part`, { ...auth, "Content-Type": "application/octet-stream", "X-Upload-Id": id, "X-Part-Index": String(i) }, chunk, delay);
    if (r.status < 200 || r.status >= 300) {
      log.warn({ status: r.status, body: r.text, part: i, parts: count }, "кусок слайдов не принят");
      return false;
    }
  }
  const sha = createHash("sha256").update(opts.pdf).digest("hex");
  const done = await postWithRetry(`${base}/complete`, { ...auth, "X-Upload-Id": id, "X-Part-Count": String(count), "X-Sha256": sha, "X-Slides-Meta": opts.meta }, undefined, delay);
  if (done.status >= 200 && done.status < 300) return true;
  log.warn({ status: done.status, body: done.text, parts: count }, "бот не собрал слайды из кусков");
  return false;
}
