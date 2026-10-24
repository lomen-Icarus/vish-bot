/**
 * Календари групп от админа: ссылки-подписки на расписание группы, ни к кому
 * не привязанные. Например, организатору мероприятий — по ссылке на каждую
 * группу, чтобы видеть, когда у кого пары.
 *
 * Ссылка живёт сама по себе: в ней расписание группы с сессией (все
 * подгруппы, без напоминаний; с «+ппа» — и все пересдачи группы), и ничто,
 * что кто-либо нажимает в боте, её не меняет. Перестаёт работать, только
 * если админ её отзовёт.
 *
 *   /calfeeds                       — для кого выпущены ссылки
 *   /calfeeds Петров                — ссылки Петрова (прислать ещё раз)
 *   /calfeed_new Петров             — по ссылке на каждую группу
 *   /calfeed_new Петров +ппа        — то же, с пересдачами (ППА) групп; «-ппа» — убрать их
 *   /calfeed_new Петров: 12-23 14-24 — только на эти группы
 *   /calfeed_del Петров | 17        — отозвать все ссылки Петрова | одну (с подтверждением)
 */
import { randomBytes } from "node:crypto";
import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { calFeedLabelKey, type CalFeed } from "../../db/repo.js";
import { findGroup, type LogicalGroup } from "../../schedule/groups.js";
import { esc, plural } from "../../schedule/format.js";
import { calendarPath } from "../../http/server.js";
import { publicBase } from "../../http/publicUrl.js";
import { logger } from "../../logger.js";

export const calFeedHandlers = new Composer<BotContext>();
const adminOnly = calFeedHandlers.filter((ctx) => ctx.isAdmin);

/** Длиннее подпись «для кого» не нужна: это пометка для админа. */
const LABEL_MAX = 60;
/** Сообщение Telegram — до 4096 символов; длинное шлём частями. */
const CHUNK = 3500;
/** Сколько ненайденных и неоднозначных групп перечислять: дальше — «…и ещё N». */
const LIST_MAX = 10;

const NOT_READY = "Подписки сейчас не работают: нет публичного адреса (PUBLIC_URL) или HTTP-сервер бота не запущен.";

/** Адрес бота для ссылок; null — подписки не работают (нет адреса или сервер не слушает). */
function feedBase(ctx: BotContext): string | null {
  const base = publicBase(ctx.deps);
  return base && ctx.deps.http?.listening === true ? base : null;
}

/** «+ппа» / «-ппа» где угодно в команде: включить или выключить пересдачи группы. */
const PPA_FLAG = /(?:^|\s)([+-])\s?(?:ппа|ppa)(?=[\s,;:]|$)/giu;

export interface FeedRequest {
  label: string;
  groups: LogicalGroup[];
  unknown: string[];
  /** Запрос подошёл к нескольким группам («23»): какие — чтобы админ уточнил. */
  ambiguous: Array<{ query: string; titles: string[] }>;
  /** true/false — включить/выключить пересдачи; undefined — не трогать. */
  ppa: boolean | undefined;
}

/** «Петров: 12-23, 14-24 +ппа» → подпись, группы и пересдачи; без двоеточия — все группы. */
export function parseFeedRequest(input: string, groups: LogicalGroup[]): FeedRequest | null {
  let ppa: boolean | undefined;
  const raw = input.replace(PPA_FLAG, (_m, sign: string) => {
    ppa = sign === "+";
    return " ";
  });
  const colon = raw.indexOf(":");
  const label = (colon >= 0 ? raw.slice(0, colon) : raw).replace(/\s+/g, " ").trim();
  // Подпись из одних цифр /calfeed_del принял бы за номер ссылки.
  if (!label || label.length > LABEL_MAX || /^#?\d+$/.test(label)) return null;
  if (colon < 0) return { label, groups: [...groups], unknown: [], ambiguous: [], ppa };
  const picked: LogicalGroup[] = [];
  const unknown: string[] = [];
  const ambiguous: FeedRequest["ambiguous"] = [];
  const add = (g: LogicalGroup) => {
    if (!picked.some((p) => p.key === g.key)) picked.push(g);
  };
  for (const q of raw.slice(colon + 1).split(/[\s,;]+/).filter(Boolean)) {
    const found = findGroup(groups, q);
    if (!found.length) unknown.push(q.slice(0, 30));
    // «11-23» (номер и год) у двух профилей — это обе группы; «23» или «ВИШ» — неясно какие.
    else if (found.length === 1 || (q.match(/\d{1,2}/g) ?? []).length >= 2) found.forEach(add);
    else ambiguous.push({ query: q.slice(0, 30), titles: found.map((g) => g.title) });
  }
  return { label, groups: picked, unknown, ambiguous, ppa };
}

/** «, с ППА» — у всех ссылок; «, с ППА у 2 из 5» — у части. */
function withPpa(feeds: CalFeed[]): string {
  const n = feeds.filter((f) => f.ppa).length;
  return !n ? "" : n === feeds.length ? ", с ППА" : `, с ППА у ${n} из ${feeds.length}`;
}

function listed(items: string[]): string {
  return items.length > LIST_MAX ? `${items.slice(0, LIST_MAX).join(", ")} …и ещё ${items.length - LIST_MAX}` : items.join(", ");
}

function feedLine(ctx: BotContext, base: string, f: CalFeed): string {
  const title = ctx.deps.service.group(f.groupKey)?.title ?? f.groupKey;
  return `<b>${esc(title)}</b> · #${f.id}\n<code>${esc(`${base}${calendarPath(f.token)}`)}</code>`;
}

const HOW_TO = [
  "<b>Как добавить:</b>",
  "• Google Календарь: calendar.google.com (с компьютера) → слева «Другие календари» → «+» → «По URL» → вставить ссылку. Повторить для каждой группы. На Android потом в приложении: ☰ → Настройки → календарь группы → включить «Синхронизация», иначе на телефоне его не видно.",
  "• Яндекс Календарь: слева «Подписки» → «Добавить» → вставить ссылку. Именно подписка, не импорт: импорт не обновляется.",
  "• iPhone: Настройки → Приложения → Календарь → Учётные записи → Добавить → Другое → «Подписной календарь».",
  "Календари обновляются сами: iPhone — раз в несколько часов, Google и Яндекс — реже, иногда через сутки-двое. Ссылки не зависят ни от чьих действий в боте.",
].join("\n");

/** Блоки текста — сообщениями не длиннее CHUNK; блок длиннее CHUNK режется. */
export function chunkBlocks(blocks: string[], sep: string): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const raw of blocks) {
    const block = raw.length > CHUNK ? `${raw.slice(0, CHUNK - 1)}…` : raw;
    if (cur && cur.length + sep.length + block.length > CHUNK) {
      parts.push(cur);
      cur = "";
    }
    cur += `${cur ? sep : ""}${block}`;
  }
  if (cur) parts.push(cur);
  return parts;
}

async function sendBlocks(ctx: BotContext, blocks: string[], sep: string): Promise<void> {
  for (const p of chunkBlocks(blocks, sep)) await ctx.reply(p, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
}

/** Ссылки — частями, чтобы не упереться в предел длины сообщения. */
async function sendFeeds(ctx: BotContext, base: string, head: string, feeds: CalFeed[]): Promise<void> {
  await sendBlocks(ctx, [head, ...feeds.map((f) => feedLine(ctx, base, f)), HOW_TO], "\n\n");
}

/** Аргумент команды: пробелы схлопнуты, как в подписи при выпуске. */
const arg = (ctx: BotContext): string => String(ctx.match ?? "").replace(/\s+/g, " ").trim();

adminOnly.command("calfeeds", async (ctx) => {
  const base = feedBase(ctx);
  const label = arg(ctx);
  if (label) {
    const feeds = ctx.deps.repo.calFeeds(label);
    if (!feeds.length) return void (await ctx.reply(`Для «${label}» ссылок нет. Выпустить: /calfeed_new ${label}`));
    if (!base) return void (await ctx.reply(NOT_READY));
    return sendFeeds(ctx, base, `📆 <b>Календари групп для «${esc(feeds[0]!.label)}»</b> (${feeds.length}${withPpa(feeds)})`, feeds);
  }
  // Один получатель — одна строка, как бы ни писали его подпись.
  const byLabel = new Map<string, CalFeed[]>();
  for (const f of ctx.deps.repo.calFeeds()) {
    const k = calFeedLabelKey(f.label);
    byLabel.set(k, [...(byLabel.get(k) ?? []), f]);
  }
  await sendBlocks(
    ctx,
    [
      "📆 <b>Календари групп</b> — ссылки-подписки без привязки к человеку",
      "",
      ...(byLabel.size ? [...byLabel.values()].map((fs) => `• ${esc(fs[0]!.label)} — ${fs.length} ${plural(fs.length, "группа", "группы", "групп")}${withPpa(fs)} · <code>/calfeeds ${esc(fs[0]!.label)}</code>`) : ["Пока ни одной."]),
      "",
      "<code>/calfeed_new Петров</code> — по ссылке на каждую группу",
      "<code>/calfeed_new Петров +ппа</code> — то же, с пересдачами (ППА) групп; <code>-ппа</code> — убрать их",
      "<code>/calfeed_new Петров: 12-23 14-24</code> — только на эти группы",
      "<code>/calfeeds Петров</code> — прислать ссылки ещё раз (те же самые)",
      "<code>/calfeed_del Петров</code> или <code>/calfeed_del 17</code> — отозвать все или одну",
      "",
      "<i>В календаре — расписание группы с сессией, все подгруппы, без напоминаний; с «+ппа» — и все пересдачи группы. Повторный выпуск для того же человека ссылок не меняет; пересдачи меняет только явная пометка «+ппа» или «-ппа», а новая группа берёт то же, что у остальных его ссылок.</i>",
    ],
    "\n",
  );
});

adminOnly.command("calfeed_new", async (ctx) => {
  const base = feedBase(ctx);
  if (!base) return void (await ctx.reply(NOT_READY));
  const req = parseFeedRequest(String(ctx.match ?? ""), ctx.deps.service.groups());
  if (!req) return void (await ctx.reply(`Так: <code>/calfeed_new Петров</code> (все группы), <code>/calfeed_new Петров +ппа</code> (с пересдачами) или <code>/calfeed_new Петров: 12-23 14-24</code>. Подпись — для кого, до ${LABEL_MAX} символов и не из одних цифр.`, { parse_mode: "HTML" }));
  const notes: string[] = [];
  if (req.unknown.length) notes.push(`Не нашёл группы: ${esc(listed(req.unknown))}.`);
  if (req.ambiguous.length) notes.push(`Неясно, какие группы — уточни номер и год (12-23): ${esc(listed(req.ambiguous.map((a) => `${a.query} → ${a.titles.slice(0, 4).join(", ")}${a.titles.length > 4 ? "…" : ""}`)))}.`);
  if (!req.groups.length) return void (await ctx.reply(`Ни одной ссылки не выпустил. ${notes.join("\n") || "Пиши группы как 12-23."}`, { parse_mode: "HTML" }));
  const feeds = req.groups.map((g) => ctx.deps.repo.ensureCalFeed(g.key, req.label, ctx.from!.id, req.ppa));
  logger.info({ feeds: feeds.length }, "calendar group feeds issued");
  const ppaCount = feeds.filter((f) => f.ppa).length;
  const what = !ppaCount ? "расписание с сессией, без пересдач и напоминаний" : ppaCount === feeds.length ? "расписание с сессией и пересдачами (ППА), без напоминаний" : "расписание с сессией, без напоминаний; пересдачи — только там, где они включены";
  const head = `📆 <b>Календари групп для «${esc(feeds[0]!.label)}»</b> (${feeds.length}${withPpa(feeds)})${notes.length ? `\n${notes.join("\n")}` : ""}\n\nВ календарях — ${what}. Перешли это сообщение — ссылки работают у любого, кому их дать.`;
  await sendFeeds(ctx, base, head, feeds);
});

/** Вопрос «отозвать все?» помнит ровно те ссылки, что были в нём названы. */
const revokeKey = (id: string): string => `calfeed:revoke:${id}`;

adminOnly.command("calfeed_del", async (ctx) => {
  const what = arg(ctx);
  if (!what) return void (await ctx.reply("Так: <code>/calfeed_del Петров</code> — все ссылки, или <code>/calfeed_del 17</code> — одну (номер из /calfeeds Петров).", { parse_mode: "HTML" }));
  const repo = ctx.deps.repo;
  if (/^#?\d+$/.test(what)) {
    const id = Number(what.replace(/^#/, ""));
    const f = repo.calFeeds().find((x) => x.id === id);
    if (!f) return void (await ctx.reply(`Действующей ссылки #${id} нет.`));
    const title = ctx.deps.service.group(f.groupKey)?.title ?? f.groupKey;
    const kb = new InlineKeyboard().text("🗑 Да, отозвать", `cfd:one:${f.id}`).text("Нет", "cfd:no");
    return void (await ctx.reply(`Отозвать ссылку #${f.id} (${esc(title)}, для «${esc(f.label)}»)? Календарь по ней перестанет обновляться.`, { parse_mode: "HTML", reply_markup: kb }));
  }
  const feeds = repo.calFeeds(what);
  if (!feeds.length) return void (await ctx.reply(`Для «${what}» действующих ссылок нет. Список: /calfeeds`));
  const id = randomBytes(4).toString("hex");
  repo.setMeta(revokeKey(id), JSON.stringify(feeds.map((f) => f.id)));
  const kb = new InlineKeyboard().text(`🗑 Да, отозвать все (${feeds.length})`, `cfd:set:${id}`).text("Нет", `cfd:no:${id}`);
  await ctx.reply(`Отозвать все ссылки для «${esc(feeds[0]!.label)}» — ${feeds.length} ${plural(feeds.length, "группа", "группы", "групп")}? Календари по ним перестанут обновляться.`, { parse_mode: "HTML", reply_markup: kb });
});

adminOnly.callbackQuery(/^cfd:(?:one:(\d+)|set:([0-9a-f]{8})|all:\d+|no(?::([0-9a-f]{8}))?)$/, async (ctx) => {
  const repo = ctx.deps.repo;
  const [, oneId, setId, noId] = ctx.match;
  const data = ctx.callbackQuery.data;
  if (data.startsWith("cfd:no")) {
    if (noId) repo.setMeta(revokeKey(noId), "");
    await ctx.answerCallbackQuery({ text: "Ок" });
    return void (await ctx.editMessageText("Ок, ссылки остаются.").catch(() => undefined));
  }
  let ids: number[] = [];
  if (oneId) ids = [Number(oneId)];
  else if (setId) {
    try {
      ids = JSON.parse(repo.getMeta(revokeKey(setId)) || "[]") as number[];
    } catch {
      ids = [];
    }
    repo.setMeta(revokeKey(setId), "");
  }
  // Кнопки «все» первого выпуска (cfd:all:<id>) и вопросы, на которые уже ответили, — устарели.
  if (!ids.length) {
    await ctx.answerCallbackQuery({ text: "Вопрос устарел — повтори /calfeed_del", show_alert: true });
    return void (await ctx.editMessageReplyMarkup().catch(() => undefined));
  }
  const live = repo.calFeeds().filter((f) => ids.includes(f.id));
  const n = repo.revokeCalFeeds(live.map((f) => f.id));
  logger.info({ feeds: n }, "calendar group feeds revoked");
  if (!n) {
    await ctx.answerCallbackQuery({ text: "Уже отозвано" });
    return void (await ctx.editMessageReplyMarkup().catch(() => undefined));
  }
  const label = live[0]!.label;
  await ctx.answerCallbackQuery({ text: `Отозвано: ${n}` });
  await ctx.editMessageText(`Отозвал ${n} ${plural(n, "ссылку", "ссылки", "ссылок")} для «${esc(label)}». Выпустить новые: /calfeed_new ${esc(label)}`, { parse_mode: "HTML" }).catch(() => undefined);
});
