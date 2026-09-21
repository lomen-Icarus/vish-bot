import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { clearPending, setPending, takePending } from "../context.js";
import { BTN, groupLabel, isMenuText, mainKeyboard } from "../keyboards.js";
import { featuresSections, featuresText, needGroup } from "../views.js";
import { showGroupPicker } from "./schedule.js";
import { askAi } from "./ask.js";
import { aiLimits } from "../../ai/limits.js";
import { teacherVishTag, webinarKey } from "./teachers.js";
import { clampHtml, esc } from "../../schedule/format.js";
import { buildInlineResults, INLINE_HINT, parseInlineQuery } from "../inline.js";
import { findGroup } from "../../schedule/groups.js";
import { lessonTypeLabel, type Occurrence } from "../../schedule/model.js";
import { addDays, fmtDDMM, fmtHHMM, parseRuDate, todayMsk, weekdayName } from "../../time.js";
import { logger } from "../../logger.js";

export const miscHandlers = new Composer<BotContext>();

miscHandlers.command("start", async (ctx) => {
  const kb = mainKeyboard();
  const group = needGroup(ctx);
  // Кнопка над inline-списком открывает личку с «/start inline» — значит,
  // человек спрашивает именно про inline, и отвечать надо про него.
  if ((ctx.match ?? "").trim() === "inline") {
    const bot = ctx.deps.botUsername ?? "бот";
    await ctx.reply(
      [
        "<b>💬 Как писать в любом чате</b>",
        "",
        `Набери <code>@${bot}</code> и дальше что нужно:`,
        `• <code>@${bot} 12-23 завтра</code> — день группы`,
        `• <code>@${bot} неделя</code> — своя неделя`,
        `• <code>@${bot} поток 24</code> — весь поток`,
        `• <code>@${bot} общие</code> — общие пары`,
        `• <code>@${bot} послепослезавтра</code> — любая дата словом или числом (<code>25.09</code>)`,
        "",
        "Бот добавлять в чат не нужно: сообщение отправляешь ты сам.",
      ].join("\n"),
      { parse_mode: "HTML", reply_markup: kb },
    );
    return;
  }
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

/** Карта функций приходит двумя сообщениями: одним она не влезает в лимит Telegram. */
async function showFeatures(ctx: BotContext): Promise<void> {
  for (const part of featuresSections(ctx.deps, { admin: ctx.isAdmin })) {
    await ctx.reply(clampHtml(part), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }
}
miscHandlers.command("help", showFeatures);
miscHandlers.command("features", showFeatures);
miscHandlers.hears(BTN.features, showFeatures);

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
// ---- forget me: wipe everything the bot stored about this person ----
async function askWipe(ctx: BotContext): Promise<void> {
  await ctx.reply(
    "Удалить всё, что бот о тебе знает?\n\nСотрутся группа и подгруппа, все настройки уведомлений, слежение за другими группами, ссылка на календарь и история напоминаний. После этого <code>/start</code> начнётся с нуля, как у нового человека.\n\nОстанется только служебный учёт: сколько вопросов к ИИ ты задал сегодня и журнал поиска людей, если ты им пользовался. Он нужен, чтобы через бота нельзя было выкачать базу, и чистится сам.",
    { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🧹 Да, забудь меня", "wipe:yes").row().text("Отмена", "wipe:no") },
  );
}
miscHandlers.command("soon", askWipe);
miscHandlers.command("reset", askWipe);
miscHandlers.command("forget", askWipe);

miscHandlers.callbackQuery(/^wipe:(yes|no)$/, async (ctx) => {
  if (ctx.match[1] === "no") {
    await ctx.answerCallbackQuery({ text: "Ничего не трогал" });
    try {
      await ctx.editMessageText("Отменено, всё на месте.");
    } catch {
      /* ignore */
    }
    return;
  }
  clearPending(ctx.deps, ctx.user.id);
  ctx.deps.repo.forgetUser(ctx.user.id);
  await ctx.answerCallbackQuery({ text: "Готово" });
  try {
    await ctx.editMessageText("Готово, я тебя забыл. Напиши /start, чтобы начать заново.");
  } catch {
    /* ignore */
  }
  await ctx.reply("Клавиатура убрана.", { reply_markup: { remove_keyboard: true } });
});

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
  const smart = !!ctx.deps.ask;
  await ctx.reply(
    smart
      ? "Спрашивай что угодно про расписание, преподавателей и сам бот. Например:\n• <code>когда матан на этой неделе</code>\n• <code>что у 14-24 в пятницу</code>\n• <code>кто ведёт БЖД</code>\n• <code>как включить напоминания</code>\n\nОтмена: /cancel"
      : "Что ищем? Напиши группу (<code>14-24</code>), предмет (<code>матан</code>) или преподавателя (<code>Иванова</code>). Отмена: /cancel",
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

interface LocalHits {
  parts: string[];
  kb: InlineKeyboard;
  buttons: number;
}

async function localSearch(ctx: BotContext, query: string): Promise<LocalHits> {
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
    // Scanning every group is only worth it for a short, subject-like query.
    if (!found && query.trim().split(/\s+/).length <= 3) {
      const all = new Map<string, Set<string>>();
      for (const g of deps.service.groups()) {
        for (const subject of subjectHits(deps.service.materialize(g, today, addDays(today, 56)), query).keys()) all.set(subject, new Set([...(all.get(subject) ?? []), g.title]));
      }
      if (all.size) parts.push(`<b>Предметы в других группах</b>\n${[...all.entries()].slice(0, 6).map(([s, gs]) => `• <b>${esc(s)}</b> — ${[...gs].map((t) => esc(t.replace(/^ВИШ-/, ""))).join(", ")}`).join("\n")}`);
    }
  }

  // 3. Teachers: the portal directory when the bot has an account, plus teachers of online lessons.
  // Only for name-shaped input: a whole question would send every word of it to
  // the portal search one by one.
  const nameWords = query.trim().split(/\s+/).filter((w) => /\p{L}{3,}/u.test(w));
  if (nameWords.length > 0 && nameWords.length <= 3) {
    const names: string[] = [];
    try {
      for (const t of deps.teachers ? await deps.teachers.search(query, 5) : []) {
        names.push(t.name);
        kb.text(`👨‍🏫 ${t.name}${teacherVishTag(deps.repo, t.id, t.name)}`, `t:${t.id}`);
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

  // 4. Студенты — когда включён глобальный поиск. Тот же лимит и тот же журнал,
  // что и у «Где студент»: через поиск базу выкачать не проще.
  const students = deps.students;
  if (students && nameWords.length > 0 && nameWords.length <= 3) {
    const limit = deps.config.POISK_DAILY_LIMIT;
    const day = todayMsk();
    const allowed = limit <= 0 || ctx.isAdmin || deps.repo.poiskUsage(ctx.user.id, day) < limit;
    if (allowed) {
      const hits = students.search(query, 4);
      // Журнал ведём и на промахах — иначе базу можно перебирать бесплатно.
      // ИИ по тому же запросу ищет людей сам, поэтому запись ставим здесь
      // только когда ИИ не будет вызван: иначе с человека спишется два поиска.
      if (!deps.ask) deps.repo.logPoisk(ctx.user.id, day, `поиск: ${query}`, hits[0]?.student.id ?? null);
      if (hits.length) {
        const guess = hits.every((h) => h.fuzzy);
        parts.push(`<b>Студенты ВИШ</b>${guess ? " (похожие по написанию)" : ""}: ${hits.map((h) => `${esc(h.student.name)} — ${esc(h.student.groupTitle)}`).join("; ")}`);
        for (const h of hits) {
          kb.text(`🕵️ ${h.student.name}`.slice(0, 40), `pop:${h.student.id}`);
          if (++buttons % 2 === 0) kb.row();
        }
        if (buttons % 2) kb.row();
      }
    }
  }

  return { parts, kb, buttons };
}

/**
 * The search button: the model answers, and whatever the local index found
 * (groups, teachers) rides along as buttons. Without a model, or when the
 * daily budget is gone, the local result is the answer.
 */
async function runSearch(ctx: BotContext, query: string): Promise<void> {
  const deps = ctx.deps;
  const hits = await localSearch(ctx, query);
  if (deps.ask) {
    const outcome = await askAi(ctx, query, { extraButtons: hits.buttons ? hits.kb : undefined });
    if (outcome === "answered") return;
    if (!hits.parts.length && (outcome === "limit-user" || outcome === "limit-global")) {
      await ctx.reply(
        outcome === "limit-user"
          ? `На сегодня твой лимит вопросов к ИИ исчерпан (${aiLimits(deps.repo, deps.config, todayMsk()).perUser} в день). Кнопки и расписание работают без лимита.`
          : "Сегодня бот уже много отвечал, общий дневной бюджет вопросов закончился. Кнопки и расписание работают без лимита.",
      );
      return;
    }
  }
  if (!hits.parts.length) {
    const noAccount = !deps.teachers ? " Преподавателей бот пока знает только по дистанционным парам: полный справочник портал отдаёт лишь авторизованным." : "";
    await ctx.reply(`По «${esc(query)}» ничего не нашёл. Попробуй короче: номер группы, часть названия предмета или фамилию.${noAccount}`, { parse_mode: "HTML" });
    return;
  }
  // grammY на row() кладёт пустой массив: при нечётном числе кнопок последний
  // ряд остаётся пустым, а Telegram такую клавиатуру не принимает.
  const kb = new InlineKeyboard(hits.kb.inline_keyboard.filter((row) => row.length).map((row) => [...row]));
  await ctx.reply(`🔍 <b>Поиск: ${esc(query)}</b>\n\n${hits.parts.join("\n\n")}`, { parse_mode: "HTML", reply_markup: hits.buttons ? kb : undefined });
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
  await runSearch(ctx, ctx.msg.text.trim().slice(0, 500));
});

// ---- inline mode: @bot 12-23 завтра ----
// Разбор запроса и сборка вариантов живут в src/bot/inline.ts.
miscHandlers.on("inline_query", async (ctx) => {
  const req = parseInlineQuery(ctx.deps, ctx.inlineQuery.query, ctx.user ?? null);
  const results = buildInlineResults(ctx.deps, req, ctx.user ?? null);
  await ctx.answerInlineQuery(results, {
    cache_time: 60,
    is_personal: true,
    button: { text: "❔ Как писать запрос", start_parameter: "inline" },
  });
});
