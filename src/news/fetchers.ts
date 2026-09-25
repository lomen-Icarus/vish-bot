/**
 * Source fetchers for the news scanner. Each returns recent posts in a common
 * shape; no authentication except the optional VK service token.
 */
import { createHash } from "node:crypto";
import { fetch as undiciFetch, EnvHttpProxyAgent, type Dispatcher } from "undici";
import { logger } from "../logger.js";

export interface FetchedPost {
  externalId: string;
  url: string | null;
  /** ISO timestamp. */
  publishedAt: string;
  text: string;
  photoUrl: string | null;
}

export type SourceKind = "tg" | "vk" | "web";

let dispatcher: Dispatcher | undefined;
function agent(): Dispatcher | undefined {
  if (!process.env.HTTPS_PROXY) return undefined;
  dispatcher ??= new EnvHttpProxyAgent();
  return dispatcher;
}

/**
 * Адрес для сообщения об ошибке: без строки запроса. В запросе VK лежит
 * сервисный токен, а текст ошибки уходит в news_sources.last_error, в логи и
 * админу в ответ на /news_scan.
 */
function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? "";
  }
}

async function getText(url: string, timeoutMs = 30_000): Promise<string> {
  const res = await undiciFetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; vish-bot/0.1; +telegram)", "Accept-Language": "ru,en;q=0.5" },
    signal: AbortSignal.timeout(timeoutMs),
    dispatcher: agent(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${safeUrl(url)}`);
  return res.text();
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", mdash: "—", ndash: "–", hellip: "…", copy: "©" };
  // Кривая сущность вида &#9999999999; роняла String.fromCodePoint, а вместе с
  // ним — разбор всего источника за день. Непонятное оставляем как было.
  const codePoint = (n: number, raw: string): string => (Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw);
  return s
    .replace(/&#(\d+);/g, (m, n: string) => codePoint(Number(n), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, n: string) => codePoint(parseInt(n, 16), m))
    .replace(/&([a-z]+);/gi, (m, n: string) => named[n.toLowerCase()] ?? m);
}

/** Parse a source reference typed by an admin into a kind + canonical ref. */
export function parseSourceRef(input: string): { kind: SourceKind; ref: string; title: string } | null {
  const s = input.trim();
  let m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?@?([A-Za-z0-9_]{4,})\/?/i.exec(s) ?? /^@([A-Za-z0-9_]{4,})$/.exec(s);
  if (m) return { kind: "tg", ref: m[1]!, title: `t.me/${m[1]}` };
  m = /^(?:https?:\/\/)?(?:m\.)?vk\.com\/([A-Za-z0-9_.]+)\/?/i.exec(s);
  if (m && !/^(wall|feed|im|id\d+$)/i.test(m[1]!)) return { kind: "vk", ref: m[1]!, title: `vk.com/${m[1]}` };
  if (/^https?:\/\//i.test(s)) return { kind: "web", ref: s.replace(/\/+$/, ""), title: s.replace(/^https?:\/\//, "").replace(/\/+$/, "") };
  return null;
}

// ---------- Telegram public channel preview (t.me/s/<channel>) ----------
export async function fetchTelegram(username: string): Promise<FetchedPost[]> {
  const html = await getText(`https://t.me/s/${username}`);
  const posts: FetchedPost[] = [];
  const blocks = html.split(/<div class="tgme_widget_message_wrap/).slice(1);
  // Страница отдалась, но сообщений на ней нет вовсе: у канала закрыт
  // публичный предпросмотр. Молча вернуть пусто — значит вечно показывать
  // «✅ просканирован» по источнику, который никогда ничего не принесёт.
  if (!blocks.length) throw new Error(`У @${username} нет публичного превью (t.me/s/${username} пуст)`);
  for (const block of blocks) {
    const post = /data-post="([^"]+)"/.exec(block)?.[1];
    const time = /<time[^>]*datetime="([^"]+)"/.exec(block)?.[1];
    if (!post || !time) continue;
    const textHtml = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?:<div class="tgme_widget_message_(?:footer|reply|link_preview|photo|video|document|poll|sticker|voice|grouped)|<\/div>)/.exec(block)?.[1] ?? "";
    const text = htmlToText(textHtml);
    const photo = /tgme_widget_message_photo_wrap[^>]*style="[^"]*background-image:url\('([^']+)'\)/.exec(block)?.[1] ?? null;
    if (!text && !photo) continue;
    posts.push({ externalId: post, url: `https://t.me/${post}`, publishedAt: new Date(time).toISOString(), text, photoUrl: photo });
  }
  return posts;
}

// ---------- VK wall via API (service token) ----------
interface VkPhotoSize {
  url: string;
  width: number;
}
interface VkPost {
  id: number;
  owner_id: number;
  date: number;
  text: string;
  is_pinned?: number;
  attachments?: Array<{ type: string; photo?: { sizes: VkPhotoSize[] } }>;
  copy_history?: Array<{ text?: string; attachments?: Array<{ type: string; photo?: { sizes: VkPhotoSize[] } }> }>;
}

export async function fetchVk(domain: string, token: string): Promise<FetchedPost[]> {
  const url = `https://api.vk.com/method/wall.get?domain=${encodeURIComponent(domain)}&count=30&v=5.199&access_token=${encodeURIComponent(token)}`;
  const body = JSON.parse(await getText(url)) as { response?: { items: VkPost[] }; error?: { error_msg: string } };
  if (body.error) throw new Error(`VK: ${body.error.error_msg}`);
  const items = body.response?.items ?? [];
  return items.map((p) => {
    const repost = p.copy_history?.[0];
    const text = [p.text, repost?.text].filter((t) => t && t.trim()).join("\n\n");
    const photos = [...(p.attachments ?? []), ...(repost?.attachments ?? [])].filter((a) => a.type === "photo" && a.photo?.sizes?.length);
    const best = photos[0]?.photo?.sizes.reduce((a, b) => (b.width > a.width ? b : a));
    return {
      externalId: `${p.owner_id}_${p.id}`,
      url: `https://vk.com/wall${p.owner_id}_${p.id}`,
      publishedAt: new Date(p.date * 1000).toISOString(),
      text: text.trim(),
      photoUrl: best?.url ?? null,
    };
  });
}

// ---------- Web page (Tilda feeds recognised; anything else -> page text) ----------
interface TildaPost {
  uid: string;
  title?: string;
  descr?: string;
  text?: string;
  date?: string;
  /** Когда пост реально выложили; «date» редактор ставит руками. */
  published?: string;
  url?: string;
  image?: string;
}

/**
 * Tilda gives "2026-09-09 15:00" in the site's timezone (Moscow for us).
 * Полей с датой два: «date» — та, что редактор поставил в карточке (её часто
 * ставят задним числом), «published» — когда пост реально появился. Свежесть
 * считается по второй, иначе задним числом опубликованная новость сразу
 * считается протухшей и не доходит вообще никогда.
 */
export function tildaDate(raw: string | undefined): string {
  if (!raw) return new Date().toISOString();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::\d{2})?)?$/.exec(raw.trim());
  if (m) return new Date(`${m[1]}T${m[2] ?? "12:00"}:00+03:00`).toISOString();
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

/**
 * Ленты Tilda на странице: их бывает несколько (на сайте ВИШ — «Новости» и
 * «Анонсы»). Берём пары recid+feeduid как они записаны рядом в настройках
 * блока: если выдёргивать их по отдельности, можно склеить recid одной ленты
 * с feeduid другой, а вторая лента потеряется целиком.
 */
export function tildaFeeds(html: string): Array<{ recid: string; feeduid: string }> {
  const out: Array<{ recid: string; feeduid: string }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/recid:\s*'([0-9]+)'\s*,\s*feeduid:\s*'([0-9]+)'/g)) {
    const key = `${m[1]}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ recid: m[1]!, feeduid: m[2]! });
  }
  if (out.length) return out;
  // Запасной вариант для старой вёрстки, где атрибуты лежат порознь.
  const feeduid = /feeduid[=:]\s*'?([0-9]+)'?/.exec(html)?.[1];
  const recid = /(?:data-feed-)?recid[=:]"?'?([0-9]+)'?/.exec(html)?.[1];
  return feeduid && recid ? [{ recid, feeduid }] : [];
}

async function fetchTildaFeed(pageUrl: string, html: string): Promise<FetchedPost[] | null> {
  const feeds = tildaFeeds(html);
  if (!feeds.length) return null;
  const origin = new URL(pageUrl).origin;
  const out: FetchedPost[] = [];
  const seen = new Set<string>();
  for (const feed of feeds.slice(0, 4)) {
    const api = `https://feeds.tildacdn.com/api/getfeed/?feeduid=${feed.feeduid}&recid=${feed.recid}&c=${Date.now()}&size=20&slice=1&getparts=true&sort%5Bdate%5D=desc&filters%5Bdate%5D=all`;
    const data = JSON.parse(await getText(api)) as { posts?: TildaPost[] };
    for (const p of data.posts ?? []) {
      const id = `tilda:${p.uid}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const link = p.url ? (p.url.startsWith("http") ? p.url : `${origin}${p.url.startsWith("/") ? "" : "/"}${p.url}`) : pageUrl;
      const body = [htmlToText(p.descr ?? ""), htmlToText(p.text ?? "")].filter((x) => x.trim()).join("\n\n");
      const title = p.title?.trim() ?? "";
      const text = title && !body.startsWith(title) ? `${title}\n\n${body}` : body || title;
      out.push({ externalId: id, url: link, publishedAt: tildaDate(p.published ?? p.date), text, photoUrl: p.image ?? null });
    }
  }
  return out;
}

export async function fetchWeb(pageUrl: string): Promise<FetchedPost[]> {
  const html = await getText(pageUrl);
  const hasFeed = tildaFeeds(html).length > 0;
  const tilda = await fetchTildaFeed(pageUrl, html).catch((err) => {
    logger.warn({ err: String(err), pageUrl }, "tilda feed failed");
    return null;
  });
  if (tilda) return tilda;
  // Лента на странице есть, но не отдалась. Свалиться на «вся страница —
  // одна новость» тут нельзя: подписчики получат кусок меню и шапки сайта,
  // а источник будет отмечен как успешно просканированный.
  if (hasFeed) throw new Error(`Лента Tilda на ${safeUrl(pageUrl)} не ответила`);
  // Generic fallback: the whole page as one "post" dated now; the classifier decides.
  const text = htmlToText(html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, ""));
  // Ключ — по содержимому, а не по дате: неизменившаяся страница не должна
  // каждый день становиться «новым постом» и снова уходить подписчикам.
  const body = text.slice(0, 6000);
  return [{ externalId: `page:${createHash("sha1").update(body).digest("hex").slice(0, 16)}`, url: pageUrl, publishedAt: new Date().toISOString(), text: body, photoUrl: null }];
}

export async function fetchSource(kind: SourceKind, ref: string, opts: { vkToken?: string }): Promise<FetchedPost[]> {
  if (kind === "tg") return fetchTelegram(ref);
  if (kind === "vk") {
    if (!opts.vkToken) throw new Error("VK_SERVICE_TOKEN не задан");
    return fetchVk(ref, opts.vkToken);
  }
  return fetchWeb(ref);
}
