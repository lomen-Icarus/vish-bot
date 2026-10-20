/**
 * Календари групп от админа: ссылки-подписки на расписание группы, ни к кому
 * не привязанные. Например, организатору мероприятий — по ссылке на каждую
 * группу, чтобы видеть, когда у кого пары.
 *
 * Ссылка живёт сама по себе: в ней только расписание группы (все подгруппы,
 * без напоминаний и без чьих-то пересдач), и ничто, что кто-либо нажимает в
 * боте, её не меняет. Перестаёт работать, только если админ её отзовёт.
 *
 *   /calfeeds                       — для кого выпущены ссылки
 *   /calfeeds Петров                — ссылки Петрова (прислать ещё раз)
 *   /calfeed_new Петров             — по ссылке на каждую группу
 *   /calfeed_new Петров: 12-23 14-24 — только на эти группы
 *   /calfeed_del Петров | 17        — отозвать все ссылки Петрова | одну (с подтверждением)
 */
import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import type { CalFeed } from "../../db/repo.js";
import { findGroup, type LogicalGroup } from "../../schedule/groups.js";
import { esc, plural } from "../../schedule/format.js";
import { calendarPath } from "../../http/server.js";
import { publicBase } from "../../http/publicUrl.js";
import { logger } from "../../logger.js";

export const calFeedHandlers = new Composer<BotContext>();
const adminOnly = calFeedHandlers.filter((ctx) => ctx.isAdmin);

/** Длиннее подпись «для кого» не нужна: это пометка для админа. */
const LABEL_MAX = 60;
/** Сообщение Telegram — до 4096 символов; ссылки шлём частями. */
const CHUNK = 3500;

/** Адрес бота для ссылок; null — подписки не работают (нет адреса или сервер не слушает). */
function feedBase(ctx: BotContext): string | null {
  const base = publicBase(ctx.deps);
  return base && ctx.deps.http?.listening === true ? base : null;
}

/** «Петров: 12-23, 14-24» → подпись и группы; без двоеточия — все группы. */
export function parseFeedRequest(raw: string, groups: LogicalGroup[]): { label: string; groups: LogicalGroup[]; unknown: string[] } | null {
  const colon = raw.indexOf(":");
  const label = (colon >= 0 ? raw.slice(0, colon) : raw).replace(/\s+/g, " ").trim();
  if (!label || label.length > LABEL_MAX) return null;
  if (colon < 0) return { label, groups: [...groups], unknown: [] };
  const picked: LogicalGroup[] = [];
  const unknown: string[] = [];
  for (const q of raw.slice(colon + 1).split(/[\s,;]+/).filter(Boolean)) {
    const g = findGroup(groups, q)[0];
    if (!g) unknown.push(q);
    else if (!picked.some((p) => p.key === g.key)) picked.push(g);
  }
  return { label, groups: picked, unknown };
}

function feedLine(ctx: BotContext, base: string, f: CalFeed): string {
  const title = ctx.deps.service.group(f.groupKey)?.title ?? f.groupKey;
  return `<b>${esc(title)}</b> · #${f.id}\n<code>${esc(`${base}${calendarPath(f.token)}`)}</code>`;
}

const HOW_TO = [
  "<b>Как добавить:</b>",
  "• Google Календарь: calendar.google.com → слева «Другие календари» → «+» → «По URL» → вставить ссылку. Повторить для каждой группы.",
  "• iPhone: Настройки → Приложения → Календарь → Учётные записи → Добавить → Другое → «Подписной календарь».",
  "Календари обновляются сами (телефон проверяет раз в несколько часов). Ссылки не зависят ни от чьих действий в боте.",
].join("\n");

/** Ссылки — частями, чтобы не упереться в предел длины сообщения. */
async function sendFeeds(ctx: BotContext, base: string, head: string, feeds: CalFeed[]): Promise<void> {
  const parts: string[] = [];
  let cur = head;
  for (const line of feeds.map((f) => feedLine(ctx, base, f))) {
    if (cur.length + line.length + 2 > CHUNK) {
      parts.push(cur);
      cur = "";
    }
    cur += `${cur ? "\n\n" : ""}${line}`;
  }
  if (cur.length + HOW_TO.length + 2 > CHUNK) {
    parts.push(cur);
    cur = HOW_TO;
  } else cur += `\n\n${HOW_TO}`;
  parts.push(cur);
  for (const p of parts) await ctx.reply(p, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
}

adminOnly.command("calfeeds", async (ctx) => {
  const base = feedBase(ctx);
  const label = (ctx.match ?? "").trim();
  if (label) {
    const feeds = ctx.deps.repo.calFeeds(label);
    if (!feeds.length) return void (await ctx.reply(`Для «${label}» ссылок нет. Выпустить: /calfeed_new ${label}`));
    if (!base) return void (await ctx.reply("Подписки сейчас не работают: нет публичного адреса (PUBLIC_URL) или HTTP-сервер бота не запущен."));
    return sendFeeds(ctx, base, `📆 <b>Календари групп для «${esc(feeds[0]!.label)}»</b> (${feeds.length})`, feeds);
  }
  const all = ctx.deps.repo.calFeeds();
  const byLabel = new Map<string, CalFeed[]>();
  for (const f of all) byLabel.set(f.label, [...(byLabel.get(f.label) ?? []), f]);
  await ctx.reply(
    [
      "📆 <b>Календари групп</b> — ссылки-подписки без привязки к человеку",
      "",
      ...(byLabel.size ? [...byLabel].map(([l, fs]) => `• ${esc(l)} — ${fs.length} ${plural(fs.length, "группа", "группы", "групп")} · <code>/calfeeds ${esc(l)}</code>`) : ["Пока ни одной."]),
      "",
      "<code>/calfeed_new Петров</code> — по ссылке на каждую группу",
      "<code>/calfeed_new Петров: 12-23 14-24</code> — только на эти группы",
      "<code>/calfeeds Петров</code> — прислать ссылки ещё раз (те же самые)",
      "<code>/calfeed_del Петров</code> или <code>/calfeed_del 17</code> — отозвать все или одну",
      "",
      "<i>В календаре — расписание группы со всеми подгруппами, без напоминаний и без личных пересдач. Повторный выпуск для того же человека ссылок не меняет.</i>",
    ].join("\n"),
    { parse_mode: "HTML" },
  );
});

adminOnly.command("calfeed_new", async (ctx) => {
  const base = feedBase(ctx);
  if (!base) return void (await ctx.reply("Подписки сейчас не работают: нет публичного адреса (PUBLIC_URL) или HTTP-сервер бота не запущен."));
  const req = parseFeedRequest(ctx.match ?? "", ctx.deps.service.groups());
  if (!req) return void (await ctx.reply(`Так: <code>/calfeed_new Петров</code> (все группы) или <code>/calfeed_new Петров: 12-23 14-24</code>. Подпись — для кого, до ${LABEL_MAX} символов.`, { parse_mode: "HTML" }));
  if (!req.groups.length) return void (await ctx.reply(`Не нашёл ни одной группы${req.unknown.length ? `: ${req.unknown.join(", ")}` : ""}. Пиши как 12-23.`));
  const feeds = req.groups.map((g) => ctx.deps.repo.ensureCalFeed(g.key, req.label, ctx.from!.id));
  logger.info({ feeds: feeds.length }, "calendar group feeds issued");
  const note = req.unknown.length ? `\nНе нашёл группы: ${esc(req.unknown.join(", "))}.` : "";
  await sendFeeds(ctx, base, `📆 <b>Календари групп для «${esc(req.label)}»</b> (${feeds.length})${note}\n\nПерешли это сообщение — ссылки работают у любого, кому их дать.`, feeds);
});

adminOnly.command("calfeed_del", async (ctx) => {
  const arg = (ctx.match ?? "").trim().replace(/^#/, "");
  if (!arg) return void (await ctx.reply("Так: <code>/calfeed_del Петров</code> — все ссылки, или <code>/calfeed_del 17</code> — одну (номер из /calfeeds Петров).", { parse_mode: "HTML" }));
  const repo = ctx.deps.repo;
  if (/^\d+$/.test(arg)) {
    const f = repo.calFeeds().find((x) => x.id === Number(arg));
    if (!f) return void (await ctx.reply(`Действующей ссылки #${arg} нет.`));
    const title = ctx.deps.service.group(f.groupKey)?.title ?? f.groupKey;
    const kb = new InlineKeyboard().text("🗑 Да, отозвать", `cfd:one:${f.id}`).text("Нет", "cfd:no");
    return void (await ctx.reply(`Отозвать ссылку #${f.id} (${esc(title)}, для «${esc(f.label)}»)? Календарь по ней перестанет обновляться.`, { parse_mode: "HTML", reply_markup: kb }));
  }
  const feeds = repo.calFeeds(arg);
  if (!feeds.length) return void (await ctx.reply(`Для «${arg}» действующих ссылок нет. Список: /calfeeds`));
  const kb = new InlineKeyboard().text(`🗑 Да, отозвать все (${feeds.length})`, `cfd:all:${feeds[0]!.id}`).text("Нет", "cfd:no");
  await ctx.reply(`Отозвать все ссылки для «${esc(feeds[0]!.label)}» — ${feeds.length} ${plural(feeds.length, "группа", "группы", "групп")}? Календари по ним перестанут обновляться.`, { parse_mode: "HTML", reply_markup: kb });
});

adminOnly.callbackQuery(/^cfd:(?:(one|all):(\d+)|no)$/, async (ctx) => {
  const kind = ctx.match[1];
  if (!kind) {
    await ctx.answerCallbackQuery({ text: "Ок" });
    return void (await ctx.editMessageText("Ок, ссылки остаются.").catch(() => undefined));
  }
  const repo = ctx.deps.repo;
  const f = repo.calFeeds().find((x) => x.id === Number(ctx.match[2]));
  if (!f) {
    await ctx.answerCallbackQuery({ text: "Уже отозвано" });
    return void (await ctx.editMessageReplyMarkup().catch(() => undefined));
  }
  const ids = kind === "one" ? [f.id] : repo.calFeeds(f.label).map((x) => x.id);
  const n = repo.revokeCalFeeds(ids);
  logger.info({ feeds: n }, "calendar group feeds revoked");
  await ctx.answerCallbackQuery({ text: `Отозвано: ${n}` });
  await ctx.editMessageText(`Отозвал ${n} ${plural(n, "ссылку", "ссылки", "ссылок")} для «${esc(f.label)}». Выпустить новые: /calfeed_new ${esc(f.label)}`, { parse_mode: "HTML" }).catch(() => undefined);
});
