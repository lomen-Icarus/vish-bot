/**
 * «Социальность» в групповых чатах — то, что бот делает сам, без модели:
 *
 *  - узнаёт людей: имя по нику из файла старост (KNOWN_DB) или из знакомства
 *    в чате — модель может обратиться по имени; анонимность это выключает;
 *  - знакомства «@ник это Фамилия Имя 12-23» → «Приятно познакомиться, запишу»;
 *  - подписки темы чата на слайды вебинаров: «@бот сюда слайды по физике» →
 *    вопрос с точным названием предмета и ближайшим вебинаром → «Да».
 */
import { randomBytes } from "node:crypto";
import { InlineKeyboard } from "grammy";
import type { Message } from "grammy/types";
import type { BotContext, Deps } from "./context.js";
import type { User } from "../db/repo.js";
import { findGroup, type LogicalGroup } from "../schedule/groups.js";
import { sameGroup } from "../portal/webinars.js";
import { firstNameOf } from "../students/known.js";
import { matchSubjects, subjectKey, type IntroRequest, type SlidesRequest } from "../chat/social.js";
import { nameWords, samePersonWords } from "../text/match.js";
import { addDays, fmtDDMM, todayMsk, weekdayShort, type LocalDate } from "../time.js";
import { esc } from "../schedule/format.js";
import { logger } from "../logger.js";

// ---------- кто это ----------

/**
 * Имя для обращения: по нику из файла старост, иначе из знакомства в чате.
 * Анонимность («🕶» в настройках) выключает узнавание целиком.
 */
export function knownFirstName(deps: Deps, from: { id: number; username?: string | undefined }, user: User): string | null {
  if (user.anon) return null;
  const username = from.username ?? user.username;
  const known = deps.known?.byUsername(username);
  if (known) return known.firstName;
  const intro = deps.repo.introByUserId(from.id) ?? (username ? deps.repo.introByUsername(username) : null);
  return intro ? firstNameOf(intro.name) : null;
}

/** Группа человека из знакомства в чате — если в боте он её не выбирал. */
export function introGroup(deps: Deps, from: { id: number; username?: string | undefined }, user: User): LogicalGroup | null {
  if (user.anon) return null;
  const intro = deps.repo.introByUserId(from.id) ?? (from.username ? deps.repo.introByUsername(from.username) : null);
  if (!intro?.groupTitle) return null;
  return findGroup(deps.service.groups(), intro.groupTitle)[0] ?? null;
}

// ---------- знакомства ----------

export const INTRO_HINT = "Запишу, если скажешь и группу: «@ник это Фамилия Имя 12-23» 🙂";

/**
 * Что ответить на знакомство и записать ли его. null — это не знакомство
 * (например, без группы и не боту): пусть сообщение идёт дальше.
 */
export function handleIntro(deps: Deps, intro: IntroRequest, by: { id: number }, chatId: number, addressed: boolean): string | null {
  if (!intro.groupQuery) return addressed ? INTRO_HINT : null;
  const groups = findGroup(deps.service.groups(), intro.groupQuery);
  if (!groups.length) return addressed || intro.self ? `Не знаю группу «${intro.groupQuery}» 🤔 Напиши как 12-23.` : null;
  const group = groups[0]!;
  const target = intro.userId != null ? deps.repo.getUser(intro.userId) : intro.username ? deps.repo.userByUsername(intro.username) : null;
  if (target?.anon) return "Приятно познакомиться 🙂 Но записывать не буду: у человека включена анонимность.";
  // Файл старост главнее: этого человека бот уже знает.
  if (intro.username && deps.known?.byUsername(intro.username)) return "А я уже знаю этого человека 🙂";
  const existing = (intro.userId != null ? deps.repo.introByUserId(intro.userId) : null) ?? (intro.username ? deps.repo.introByUsername(intro.username) : null);
  const want = nameWords(intro.name);
  if (existing && !intro.self) {
    return samePersonWords(want, nameWords(existing.name)) ? "Да я уже знаю 🙂" : "Этот ник у меня уже записан за кем-то другим 🤔 Если это ошибка — пусть человек сам представится: «@бот я — Фамилия Имя 12-23».";
  }
  // Сам человек может поправить себя, но не присвоить чужое имя.
  const takenInFile = deps.known?.nameTakenByOther(intro.name, intro.username) ?? false;
  const takenInChats = deps.repo
    .intros(2000)
    .some((i) => i.id !== existing?.id && !(intro.username && i.username === intro.username) && !(intro.userId != null && i.userId === intro.userId) && samePersonWords(want, nameWords(i.name)));
  if (takenInFile || takenInChats) return "А этого человека я уже знаю под другим ником 🤔";
  deps.repo.saveIntro({ username: intro.username, userId: intro.userId, name: intro.name, groupTitle: group.title, chatId, introducedBy: by.id });
  logger.info({ chat: chatId, self: intro.self }, "group chat: intro saved");
  return "Приятно познакомиться, запишу 🙂";
}

// ---------- слайды в чат ----------

interface SlideCandidate {
  subject: string;
  group: LogicalGroup | null;
  next: LocalDate | null;
}

interface PendingSub {
  chatId: number;
  threadId: number | null;
  requester: number;
  candidates: SlideCandidate[];
  expiresAt: number;
}

const pendingSubs = new Map<string, PendingSub>();
const PENDING_TTL_MS = 15 * 60_000;

/** Для тестов. */
export function resetSlideSubState(): void {
  pendingSubs.clear();
}

/** Тема форума, в которой написали; в обычном чате — null (ответ идёт в сам чат). */
export function topicOf(msg: Message): number | null {
  return msg.is_topic_message && msg.message_thread_id ? msg.message_thread_id : null;
}

function inGroup(groupNames: string[], group: LogicalGroup): boolean {
  return groupNames.some((g) => sameGroup(g, group.title) || group.portalNames.some((p) => sameGroup(g, p)));
}

/**
 * Предметы онлайн-пар, похожие на запрос, с ближайшим вебинаром. Сначала —
 * у группы (названной в просьбе или своей у человека), не нашлось — у всех.
 */
export function slideCandidates(deps: Deps, query: string, group: LogicalGroup | null, today: LocalDate = todayMsk()): SlideCandidate[] {
  const rows = deps.repo.webinarsBetween(addDays(today, -60), addDays(today, 30)).filter((r) => r.scheduled && r.subject);
  const scheduleFor = (g: LogicalGroup) => deps.service.materialize(g, today, addDays(today, 56)).filter((o) => o.isDistance && o.status !== "moved");
  const attempt = (g: LogicalGroup | null): SlideCandidate[] => {
    const mine = g ? rows.filter((r) => inGroup(r.groups, g)) : rows;
    const lessons = g ? scheduleFor(g) : [];
    const subjects = [...mine.map((r) => r.subject), ...lessons.map((o) => o.subject)];
    return matchSubjects(query, subjects).map((subject) => {
      const key = subjectKey(subject);
      const dates = [...mine.filter((r) => subjectKey(r.subject) === key).map((r) => r.date), ...lessons.filter((o) => subjectKey(o.subject) === key).map((o) => o.date)].filter((d) => d >= today).sort();
      return { subject, group: g, next: dates[0] ?? null };
    });
  };
  const own = group ? attempt(group) : [];
  return own.length ? own : attempt(null);
}

function describe(c: SlideCandidate): string {
  return `«${c.subject}»${c.group ? ` (${c.group.title})` : ""} — ${c.next ? `ближайший вебинар ${weekdayShort(c.next)} ${fmtDDMM(c.next)}` : "ближайшего вебинара пока не видно"}`;
}

/** Ответ на просьбу про слайды: текст и, если нужно подтверждение, кнопки. */
export function handleSlidesRequest(ctx: BotContext, req: SlidesRequest, speakerGroup: LogicalGroup | null): { text: string; kb?: InlineKeyboard } {
  const deps = ctx.deps;
  const msg = ctx.msg!;
  const chatId = ctx.chat!.id;
  const threadId = topicOf(msg);
  const where = threadId ? "в эту тему" : "в этот чат";
  const subs = deps.repo.slideSubs(chatId, threadId);
  if (req.kind === "list") {
    if (!subs.length) return { text: `Сюда пока никакие слайды не приходят. Подписать: «@${ctx.me.username} сюда слайды по физике».` };
    return { text: `Сюда приходят слайды: ${subs.map((s) => `«${s.subject}»${s.groupTitle ? ` (${s.groupTitle})` : ""}`).join(", ")}.` };
  }
  if (req.kind === "unsubscribe") {
    if (!subs.length) return { text: "Сюда и так никакие слайды не приходят 🙂" };
    const hit = req.subject ? matchSubjects(req.subject, subs.map((s) => s.subject)) : subs.map((s) => s.subject);
    if (!hit.length) return { text: `Слайдов «${req.subject}» сюда и не было. Приходят: ${subs.map((s) => `«${s.subject}»`).join(", ")}.` };
    for (const subject of new Set(hit)) deps.repo.removeSlideSubs(chatId, threadId, subjectKey(subject));
    return { text: `Ок, слайды ${[...new Set(hit)].map((s) => `«${s}»`).join(", ")} сюда больше не присылаю.` };
  }
  if (!req.subject) return { text: `По какому предмету? Напиши: «@${ctx.me.username} сюда слайды по физике».` };
  let group = speakerGroup;
  if (req.group) {
    const found = findGroup(deps.service.groups(), req.group);
    if (!found.length) return { text: `Не знаю группу «${req.group}» 🤔 Напиши как 12-23.` };
    group = found[0]!;
  }
  const candidates = slideCandidates(deps, req.subject, group);
  if (!candidates.length) return { text: `Не нашёл онлайн-пар по «${req.subject}» 🤔 Напиши название ближе к расписанию.` };
  // Короткий id: callback_data у Telegram — не больше 64 байт.
  const id = randomBytes(4).toString("hex");
  for (const [k, v] of pendingSubs) if (v.expiresAt < Date.now()) pendingSubs.delete(k);
  pendingSubs.set(id, { chatId, threadId, requester: ctx.from!.id, candidates, expiresAt: Date.now() + PENDING_TTL_MS });
  const kb = new InlineKeyboard();
  if (candidates.length === 1) {
    kb.text("✅ Да", `css:${id}:0`).text("❌ Нет", `css:${id}:n`);
    return { text: `Ты хочешь получать слайды ${describe(candidates[0]!)} ${where}?`, kb };
  }
  candidates.forEach((c, i) => kb.text(c.subject.slice(0, 40), `css:${id}:${i}`).row());
  kb.text("❌ Ничего из этого", `css:${id}:n`);
  return { text: `Нашёл несколько похожих. Какие слайды ты хочешь получать ${where}?\n${candidates.map((c) => `• ${describe(c)}`).join("\n")}`, kb };
}

/** Кнопка под вопросом «Ты хочешь получать слайды …?». */
export async function confirmSlideSub(ctx: BotContext, id: string, choice: string): Promise<void> {
  const pending = pendingSubs.get(id);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingSubs.delete(id);
    await ctx.answerCallbackQuery({ text: "Вопрос устарел — попроси ещё раз 🙂" });
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    return;
  }
  const from = ctx.from;
  if (!from) return;
  if (from.id !== pending.requester && !ctx.isAdmin) {
    await ctx.answerCallbackQuery({ text: "Это спрашивали не тебя 🙂" });
    return;
  }
  pendingSubs.delete(id);
  const where = pending.threadId ? "в эту тему" : "сюда";
  if (choice === "n") {
    await ctx.answerCallbackQuery({ text: "Ок" });
    await ctx.editMessageText("Ок, не буду.").catch(() => undefined);
    return;
  }
  const c = pending.candidates[Number(choice)];
  if (!c) {
    await ctx.answerCallbackQuery();
    return;
  }
  ctx.deps.repo.addSlideSub({ chatId: pending.chatId, threadId: pending.threadId, subject: c.subject, subjectNorm: subjectKey(c.subject), groupKey: c.group?.key ?? null, groupTitle: c.group?.title ?? null, createdBy: from.id });
  logger.info({ chat: pending.chatId, thread: pending.threadId }, "group chat: slides subscription added");
  await ctx.answerCallbackQuery({ text: "Готово" });
  const note = ctx.deps.config.SLIDES_TOKEN ? "" : "\n\n<i>Запись вебинаров пока не подключена — начну, как только подключат.</i>";
  await ctx.editMessageText(`Готово 📎 Слайды «${esc(c.subject)}»${c.group ? ` (${esc(c.group.title)})` : ""} буду присылать ${where}, как только запишу вебинар.${note}`, { parse_mode: "HTML" }).catch(() => undefined);
}
