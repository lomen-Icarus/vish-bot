import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { clearPending, setPending, takePending } from "../context.js";
import { BTN, groupCb, groupLabel, groupPicker, isMenuText, LEGACY_BTN, menuFor } from "../keyboards.js";
import { autoTeacherStart, nameAndPatronymic } from "../teacherMode.js";
import { featuresSections, featuresText, needGroup } from "../views.js";
import { askAi } from "./ask.js";
import { aiLimits } from "../../ai/limits.js";
import { candidatesKeyboard, showPerson } from "../people.js";
import { ershovNamesakes, isErshovQuery, sendErshovCard } from "../easter.js";
import { clearHit, hitLabel, hitShort, searchPeople, tiedWith, type PersonHit } from "../../people/search.js";
import { refKey } from "../../people/ref.js";
import { clampHtml, esc } from "../../schedule/format.js";
import { buildInlineResults, buildPeopleResults, parseInlineQuery } from "../inline.js";
import { findGroup } from "../../schedule/groups.js";
import { lessonTypeLabel, type Occurrence } from "../../schedule/model.js";
import { addDays, fmtDDMM, fmtHHMM, parseRuDate, todayMsk, weekdayName } from "../../time.js";
import { logger } from "../../logger.js";

export const miscHandlers = new Composer<BotContext>();

/**
 * Имя человека, если бот его узнаёт: по телеграм-нику из файла старост.
 * «Усиленная анонимность» в настройках выключает узнавание целиком.
 */
function knownName(ctx: BotContext): string | null {
  if (ctx.user.anon) return null;
  return ctx.deps.known?.byUsername(ctx.from?.username ?? ctx.user.username)?.firstName ?? null;
}

/**
 * Единственная кнопка под приветствием — «Спросить?»: расписание и так в
 * нижнем меню, а про «спросить своими словами» никто не догадывается. Это тот
 * же ИИ-поиск, что и «🔍 ИИ поисковик», с теми же дневными лимитами из админки.
 */
function askButton(ctx: BotContext): InlineKeyboard | null {
  return ctx.deps.ask ? new InlineKeyboard().text("💬 Спросить?", "ask:open") : null;
}

/**
 * Гайд по inline-режиму: он же открывается кнопкой «❔ Как писать запрос»
 * над списком подсказок (Telegram присылает в личку «/start inline»).
 */
export function inlineGuide(ctx: BotContext): string {
  const bot = ctx.deps.botUsername ?? "бот";
  const poisk = ctx.deps.config.POISK && !!ctx.deps.students;
  return [
    "<b>💬 Расписание в любом чате</b>",
    "",
    `Напиши в любом чате <code>@${bot}</code>, пробел — и дальше запрос. Появится список: выбираешь нужное, и сообщение отправляешь <b>ты сам</b>. Бота в чат добавлять не надо.`,
    "",
    "<b>📅 Группы</b>",
    `• <code>@${bot} 12-23</code> — день группы (можно «виш 12 23»)`,
    `• <code>@${bot} 12-23 завтра</code> — другой день`,
    `• <code>@${bot} неделя</code> — своя неделя, <code>неделя след</code> — следующая`,
    `• <code>@${bot} поток 24</code> — весь поток, <code>общие</code> — общие пары`,
    "",
    "<b>👤 Люди</b>",
    `• <code>@${bot} Петров</code> — просто фамилия: кто это, где сейчас по расписанию и его день${poisk ? " — хоть преподаватель, хоть студент" : ""}`,
    `• <code>@${bot} Петров завтра</code> · <code>@${bot} неделя Петров</code>`,
    `• уточнить, кого ищешь: <code>@${bot} препод Петров</code>${poisk ? `, <code>@${bot} студент Беляев</code>` : ""}`,
    "",
    "<b>🗓 Даты</b>",
    "• словом: <code>сегодня</code>, <code>завтра</code>, <code>вчера</code>, <code>послезавтра</code>, <code>позавчера</code>",
    "• каждое «после» — плюс день: <code>послепослезавтра</code> = +3 дня",
    "• числом: <code>25.09</code>, <code>25.09.2026</code>",
    "",
    "<i>Слова можно в любом порядке: «неделя 12-23» и «12-23 неделя» — одно и то же.</i>",
  ].join("\n");
}

miscHandlers.command("start", async (ctx) => {
  const group = needGroup(ctx);
  // Кнопка над inline-списком открывает личку с «/start inline» — значит,
  // человек спрашивает именно про inline, и отвечать надо про него.
  if ((ctx.match ?? "").trim() === "inline") {
    await ctx.reply(inlineGuide(ctx), { parse_mode: "HTML", reply_markup: menuFor(ctx.user), link_preview_options: { is_disabled: true } });
    await ctx.reply("Можно попробовать прямо сейчас — кнопка откроет выбор чата:", {
      reply_markup: new InlineKeyboard().switchInline("💬 Попробовать в чате", "неделя"),
    });
    return;
  }
  const ask = askButton(ctx);
  const askLine = ctx.deps.ask ? "\n\nМожно просто спросить словами — «когда матан», «где Беляев», «как включить напоминания»." : "";
  // Преподаватель из реестра: режим включается сам, без выбора группы.
  if (await autoTeacherStart(ctx)) return;
  // Режим преподавателя: своя «группа» — он сам, обращение по имени-отчеству.
  if (ctx.user.teacherMode) {
    const name = ctx.user.teacherName ? nameAndPatronymic(ctx.user.teacherName) : null;
    await ctx.reply(`${name ? `Здравствуйте, ${esc(name)}! Рад вас видеть 👋` : "Здравствуйте! Рад вас видеть 👋"} «📅 Сегодня» и «🗓 Неделя» — ваши пары, «👥 Студенты» — расписание любой группы.${askLine}`, { parse_mode: "HTML", reply_markup: ask ?? menuFor(ctx.user) });
    return;
  }
  // Бот может узнать человека по телеграм-нику из файла старост. ФИО у людей
  // нигде не спрашивают — регистрации в боте нет. Группу из файла не берём:
  // он годичной давности, группа могла смениться, а имя — нет.
  const hello = knownName(ctx);
  if (!group) {
    // Одно сообщение: приветствие, выбор группы и «Спросить?». Нижнее меню
    // придёт вместе с подтверждением выбранной группы.
    const groups = ctx.deps.service.groups();
    const kb = groups.length ? groupPicker(groups, { selected: null }) : new InlineKeyboard();
    if (ask) kb.row().text("💬 Спросить?", "ask:open");
    await ctx.reply(
      `${hello ? `Привет, ${esc(hello)}! ` : "Привет! "}Я бот расписания Высшей инженерной школы ЧувГУ.\n\nПокажу пары на любой день, пришлю изменения в расписании и напомню о парах. ${groups.length ? "Сначала выбери свою группу:" : "Список групп ещё загружается с портала — напиши /start через минуту."}`,
      { parse_mode: "HTML", reply_markup: kb },
    );
    return;
  }
  // Одно сообщение с одной кнопкой. Нижнее меню у вернувшегося уже есть.
  await ctx.reply(`${hello ? `Привет, ${esc(hello)}!` : "С возвращением!"} Твоя группа: <b>${esc(group.title)}</b>.${askLine}`, { parse_mode: "HTML", reply_markup: ask ?? menuFor(ctx.user) });
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
miscHandlers.hears([BTN.search, LEGACY_BTN.search], startSearch);
miscHandlers.callbackQuery("ask:open", async (ctx) => {
  await ctx.answerCallbackQuery();
  await startSearch(ctx);
});
miscHandlers.callbackQuery("feat:open", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showFeatures(ctx);
});
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
  /** Найденные люди (преподаватели и студенты). */
  people: PersonHit[];
  /** Кроме людей ничего не нашлось: ни групп, ни предметов. */
  onlyPeople: boolean;
}

/** Слова, после которых запрос — вопрос, а не имя. */
const QUESTION_WORDS = /^(кто|что|где|когда|как|какой|какая|какие|каким|почему|зачем|сколько|ведет|ведёт|ведут|пары|пара|пар|расписание|завтра|сегодня|неделя|у|в|во|на|по|с|и|или|не|есть|будет|включить|выключить|найти|показать)$/iu;

/** Похож ли запрос на имя человека: 1–3 слова из одних букв (дефис можно), без слов-вопросов. */
function looksLikeName(query: string): boolean {
  const words = query.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 3 && words.every((w) => /^[\p{L}-]+$/u.test(w) && !QUESTION_WORDS.test(w));
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
      kb.text(`📅 ${groupLabel(g)}`, groupCb("pdn", g.key, today));
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
        return `• <b>${esc(subject)}</b> (${esc(lessonTypeLabel(occ[0]!.type))})${teacher ? ` — ${esc(teacher)}` : ""}\n   ${next.join("\n   ")}`;
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

  // 3. Люди: преподаватели и студенты — тем же поиском, что и кнопки
  // «👨‍🏫 Преподаватели» и «Где студент», с теми же подписями и карточкой.
  // Только для запроса, похожего на имя: целый вопрос разослал бы каждое своё
  // слово в поиск портала по очереди.
  const nameWords = query.trim().split(/\s+/).filter((w) => /\p{L}{3,}/u.test(w));
  let people: PersonHit[] = [];
  if (nameWords.length > 0 && nameWords.length <= 3) {
    try {
      // Журнал «сыска» ведётся и на промахах; если по тому же запросу сработает
      // ещё и инструмент ИИ, repo.logPoisk склеит это в одну запись. Поэтому
      // студентов ищем, только когда запрос похож на имя: «матан», «кто ведёт
      // БЖД» или «что у 14-24» не должны тратить лимит поиска людей и попадать
      // в журнал как поиск человека. Преподаватели ищутся всегда.
      const scope = looksLikeName(query) && !parts.length ? "all" : "teacher";
      people = (await searchPeople(deps, query, { scope, viewerId: ctx.user.id, isAdmin: ctx.isAdmin, source: "поиск", limit: 6 })).hits;
    } catch (err) {
      logger.warn({ err: String(err) }, "search: people failed");
    }
    if (people.length) {
      const guess = people.every((h) => h.fuzzy);
      parts.push(`<b>Люди</b>${guess ? " (похожие по написанию)" : ""}: ${people.map((h) => esc(hitShort(h))).join("; ")}`);
      if (buttons % 3) kb.row();
      for (const h of people) kb.text(hitLabel(h), `ppo:${refKey(h.ref)}`).row();
      buttons += people.length;
    }
  }

  return { parts, kb, buttons, people, onlyPeople: people.length > 0 && parts.length === 1 };
}

/**
 * The search button: the model answers, and whatever the local index found
 * (groups, teachers) rides along as buttons. Without a model, or when the
 * daily budget is gone, the local result is the answer.
 */
async function runSearch(ctx: BotContext, query: string): Promise<void> {
  const deps = ctx.deps;
  if (isErshovQuery(query)) {
    // Пасхалка. Настоящих однофамильцев не прячем — кнопками следом, но без ИИ.
    await sendErshovCard(ctx);
    const namesakes = await ershovNamesakes(deps, query, { id: ctx.user.id, isAdmin: ctx.isAdmin });
    if (namesakes.length) await ctx.reply("А это однофамильцы в расписании:", { reply_markup: candidatesKeyboard(namesakes, "teacher") });
    return;
  }
  const hits = await localSearch(ctx, query);
  // Нашёлся ровно один человек и больше ничего — сразу его карточка, та же, что
  // из кнопок «Преподаватели» и «Где студент»: кто это, где сейчас, день.
  const person = hits.onlyPeople ? clearHit(hits.people) : null;
  if (person) {
    await showPerson(ctx, person.ref, todayMsk(), { others: tiedWith(hits.people, person), self: person });
    return;
  }
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
  const results = req.person
    ? await buildPeopleResults(ctx.deps, req, ctx.user ?? null, { isAdmin: ctx.isAdmin })
    : buildInlineResults(ctx.deps, req, ctx.user ?? null);
  await ctx.answerInlineQuery(results, {
    cache_time: 60,
    is_personal: true,
    button: { text: "❔ Как писать запрос", start_parameter: "inline" },
  });
});
