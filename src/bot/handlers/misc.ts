import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { clearPending, setPending, takePending } from "../context.js";
import { BTN, groupLabel, isMenuText, mainKeyboard } from "../keyboards.js";
import { featuresText, helpText, needGroup } from "../views.js";
import { showGroupPicker } from "./schedule.js";
import { webinarKey } from "./teachers.js";
import { esc } from "../../schedule/format.js";
import { dayView } from "../views.js";
import { findGroup } from "../../schedule/groups.js";
import { lessonTypeLabel, type Occurrence } from "../../schedule/model.js";
import { addDays, fmtDDMM, fmtHHMM, parseRuDate, todayMsk, weekdayName } from "../../time.js";
import { logger } from "../../logger.js";

export const miscHandlers = new Composer<BotContext>();

miscHandlers.command("start", async (ctx) => {
  const kb = mainKeyboard();
  const group = needGroup(ctx);
  if (!group) {
    await ctx.reply(
      "Привет! Я бот расписания Высшей инженерной школы ЧувГУ.\n\nПокажу пары на любой день, пришлю изменения в расписании и напомню о парах. Сначала выбери группу.",
      { reply_markup: kb },
    );
    await showGroupPicker(ctx);
    return;
  }
  await ctx.reply(`С возвращением! Твоя группа: <b>${esc(group.title)}</b>.`, { parse_mode: "HTML", reply_markup: kb });
});

miscHandlers.command("help", (ctx) => ctx.reply(helpText(ctx.deps), { parse_mode: "HTML" }));
miscHandlers.command("features", (ctx) => ctx.reply(featuresText(ctx.deps), { parse_mode: "HTML" }));
miscHandlers.hears(BTN.features, (ctx) => ctx.reply(featuresText(ctx.deps), { parse_mode: "HTML" }));

// ---- suggest news to media team ----
function newsRecipients(ctx: BotContext): number[] {
  const media = ctx.deps.config.MEDIA_CHAT_IDS;
  return media.length ? media : ctx.deps.config.ADMIN_IDS;
}

async function startSuggest(ctx: BotContext): Promise<void> {
  if (newsRecipients(ctx).length === 0) {
    await ctx.reply("Приём новостей пока не настроен. Напиши напрямую медиа-ВИШ.");
    return;
  }
  setPending(ctx.deps, ctx.user.id, { kind: "suggest" }, 10 * 60_000);
  await ctx.reply("Пришли новость, достижение или объявление одним сообщением: текст, фото или документ. Я передам его медиа-ВИШ. Отмена: /cancel");
}
miscHandlers.command("suggest", startSuggest);
// Existing chats still show the old keyboard until Telegram replaces it, and it
// had this button; keep it working.
miscHandlers.hears(BTN.suggest, startSuggest);
miscHandlers.command("cancel", async (ctx) => {
  clearPending(ctx.deps, ctx.user.id);
  await ctx.reply("Отменено.");
});

miscHandlers.on("message", async (ctx, next) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (!pending || pending.kind !== "suggest") return next();
  if (ctx.msg.text?.startsWith("/")) return next();
  // A menu button means the user left the flow: drop it and let the button work.
  if (isMenuText(ctx.msg.text)) {
    clearPending(ctx.deps, ctx.user.id);
    return next();
  }
  clearPending(ctx.deps, ctx.user.id);
  const group = needGroup(ctx);
  const from = ctx.from;
  const header = `📨 <b>Предложение от</b> ${from?.username ? `@${esc(from.username)}` : esc(from?.first_name ?? "аноним")}${group ? ` (${esc(group.title)})` : ""} · id <code>${from?.id}</code>`;
  let delivered = 0;
  for (const chatId of newsRecipients(ctx)) {
    try {
      await ctx.api.sendMessage(chatId, header, { parse_mode: "HTML" });
      await ctx.api.forwardMessage(chatId, ctx.chat.id, ctx.msg.message_id);
      delivered++;
    } catch (err) {
      logger.warn({ err, chatId }, "failed to deliver suggestion");
    }
  }
  await ctx.reply(delivered ? "Передал медиа-ВИШ, спасибо! 🙌" : "Не получилось доставить, попробуй позже.");
});

// ---- search: groups, subjects, teachers ----
async function startSearch(ctx: BotContext): Promise<void> {
  setPending(ctx.deps, ctx.user.id, { kind: "search" }, 3 * 60_000);
  await ctx.reply(
    "Что ищем? Напиши группу (<code>14-24</code>), предмет (<code>матан</code>, <code>физика</code>) или преподавателя (<code>Иванова</code>). Отмена: /cancel",
    { parse_mode: "HTML" },
  );
}
miscHandlers.hears(BTN.search, startSearch);
miscHandlers.command("search", async (ctx) => {
  const q = (ctx.match ?? "").trim();
  if (!q) return startSearch(ctx);
  await runSearch(ctx, q);
});

function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
}

function subjectHits(list: Occurrence[], query: string): Map<string, Occurrence[]> {
  const q = normalize(query);
  const stems = q
    .split(" ")
    .filter((w) => w.length >= 3)
    .map((w) => w.slice(0, Math.max(3, Math.min(w.length - 1, 5))));
  const out = new Map<string, Occurrence[]>();
  for (const o of list) {
    if (o.status !== "scheduled") continue;
    const subj = normalize(o.subject);
    const hit = subj.includes(q) || (stems.length > 0 && stems.every((st) => subj.split(" ").some((w) => w.startsWith(st))));
    if (hit) out.set(o.subject, [...(out.get(o.subject) ?? []), o]);
  }
  return out;
}

async function runSearch(ctx: BotContext, query: string): Promise<void> {
  const deps = ctx.deps;
  const today = todayMsk();
  const parts: string[] = [];
  const kb = new InlineKeyboard();
  let buttons = 0;

  // 1. Groups.
  const groups = /\d/.test(query) ? findGroup(deps.service.groups(), query) : [];
  if (groups.length) {
    parts.push(`<b>Группы</b>: ${groups.map((g) => esc(g.title)).join(", ")}`);
    for (const g of groups.slice(0, 6)) {
      kb.text(`📅 ${groupLabel(g)}`, `pdn:${g.key}:${today}`);
      if (++buttons % 3 === 0) kb.row();
    }
    if (buttons % 3) kb.row();
  }

  // 2. Subjects in the own group (8 weeks), then across all groups if nothing at home.
  const own = needGroup(ctx);
  if (!/^\d+[-–]\d+$/.test(query.trim())) {
    const scan = (list: Occurrence[], title: string) => {
      const hits = subjectHits(list, query);
      if (!hits.size) return false;
      const lines = [...hits.entries()].slice(0, 5).map(([subject, occ]) => {
        const next = occ.slice(0, 3).map((o) => `${weekdayName(o.date)} ${fmtDDMM(o.date)}${o.start != null ? ` ${fmtHHMM(o.start)}` : ""}${o.room ? ` · ${esc(o.room)}` : ""}${o.isDistance ? " · 💻" : ""}`);
        const teacher = occ.find((o) => o.teacher)?.teacher;
        return `• <b>${esc(subject)}</b> (${lessonTypeLabel(occ[0]!.type)})${teacher ? ` — ${esc(teacher)}` : ""}\n   ${next.join("\n   ")}`;
      });
      parts.push(`<b>${title}</b>\n${lines.join("\n")}`);
      return true;
    };
    let found = false;
    if (own) found = scan(deps.service.materialize(own, today, addDays(today, 56)), `Предметы ${esc(own.title)}`);
    if (!found) {
      const all = new Map<string, Set<string>>();
      for (const g of deps.service.groups()) {
        for (const subject of subjectHits(deps.service.materialize(g, today, addDays(today, 56)), query).keys()) all.set(subject, new Set([...(all.get(subject) ?? []), g.title]));
      }
      if (all.size) parts.push(`<b>Предметы в других группах</b>\n${[...all.entries()].slice(0, 6).map(([s, gs]) => `• <b>${esc(s)}</b> — ${[...gs].map((t) => esc(t.replace(/^ВИШ-/, ""))).join(", ")}`).join("\n")}`);
    }
  }

  // 3. Teachers: the portal directory when the bot has an account, plus teachers of online lessons.
  if (/\p{L}{3,}/u.test(query)) {
    const names: string[] = [];
    try {
      for (const t of deps.teachers ? await deps.teachers.search(query, 5) : []) {
        names.push(t.name);
        kb.text(`👨‍🏫 ${t.name}`, `t:${t.id}`);
        if (++buttons % 2 === 0) kb.row();
      }
    } catch (err) {
      logger.warn({ err: String(err) }, "search: teachers failed");
    }
    for (const t of deps.webinars?.search(query, 4) ?? []) {
      if (names.some((n) => n.toLowerCase().startsWith(t.name.toLowerCase().slice(0, 12)))) continue;
      names.push(`${t.name} (дистант)`);
      kb.text(`👨‍🏫 ${t.name}`, webinarKey(t.name));
      if (++buttons % 2 === 0) kb.row();
    }
    if (names.length) parts.push(`<b>Преподаватели</b>: ${names.map(esc).join("; ")}`);
    if (buttons % 2) kb.row();
  }

  if (!parts.length) {
    await ctx.reply(`По «${esc(query)}» ничего не нашёл. Попробуй короче: номер группы, часть названия предмета или фамилию.`, { parse_mode: "HTML" });
    return;
  }
  await ctx.reply(`🔍 <b>Поиск: ${esc(query)}</b>\n\n${parts.join("\n\n")}`, { parse_mode: "HTML", reply_markup: buttons ? kb : undefined });
}

miscHandlers.on("message:text", async (ctx, next) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (!pending || pending.kind !== "search") return next();
  if (ctx.msg.text.startsWith("/")) return next();
  if (isMenuText(ctx.msg.text)) {
    clearPending(ctx.deps, ctx.user.id);
    return next();
  }
  clearPending(ctx.deps, ctx.user.id);
  await ctx.replyWithChatAction("typing");
  await runSearch(ctx, ctx.msg.text.trim().slice(0, 60));
});

// ---- inline mode: @bot 12-23 завтра ----
miscHandlers.on("inline_query", async (ctx) => {
  const deps = ctx.deps;
  const q = ctx.inlineQuery.query.trim();
  const groups = deps.service.groups();
  const words = q.split(/\s+/).filter(Boolean);
  let date = todayMsk();
  const dateWord = words.find((w) => /^(сегодня|завтра|\d{1,2}[./]\d{1,2}([./]\d{2,4})?)$/iu.test(w));
  if (dateWord) {
    if (/завтра/iu.test(dateWord)) date = addDays(date, 1);
    else if (!/сегодня/iu.test(dateWord)) date = parseRuDate(dateWord) ?? date;
  }
  const groupQuery = words.filter((w) => w !== dateWord).join(" ");
  let candidates = groupQuery ? findGroup(groups, groupQuery) : [];
  if (!candidates.length && !groupQuery && ctx.user.groupKey) {
    const own = deps.service.group(ctx.user.groupKey);
    if (own) candidates = [own];
  }
  if (!candidates.length && !groupQuery) candidates = groups.slice(0, 10);
  const results = candidates.slice(0, 10).map((g) => {
    const { text } = dayView(deps, g, date, null);
    return {
      type: "article" as const,
      id: `${g.key}:${date}`.slice(0, 64),
      title: `${g.title} — ${date === todayMsk() ? "сегодня" : date}`,
      description: text.replace(/<[^>]+>/g, "").split("\n").slice(2, 6).join(" · ").slice(0, 100),
      input_message_content: { message_text: text.slice(0, 4000), parse_mode: "HTML" as const },
    };
  });
  await ctx.answerInlineQuery(results, { cache_time: 60, is_personal: true });
});
