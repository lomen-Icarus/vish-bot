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
import { findGroup, logicalKeyFor, type LogicalGroup } from "../schedule/groups.js";
import { sameGroup } from "../portal/webinars.js";
import { firstNameOf } from "../students/known.js";
import type { ChatTool } from "../chat/service.js";
import { matchSubjects, matchSubjectsLoose, sameSubject, subjectKey, type IntroRequest, type SlidesRequest } from "../chat/social.js";
import { nameWords, samePersonWords } from "../text/match.js";
import { addDays, fmtDDMM, todayMsk, weekdayShort, type LocalDate } from "../time.js";
import { esc } from "../schedule/format.js";
import { logger } from "../logger.js";

// ---------- кто это ----------

/**
 * Имя для обращения: по нику из файла старост, иначе из знакомства в чате.
 * Анонимность («🕶» в настройках) выключает узнавание целиком.
 */
export function knownFirstName(deps: Deps, from: { id: number; username?: string | undefined }, user: User, opts: { intros?: boolean } = {}): string | null {
  if (user.anon) return null;
  const username = from.username ?? user.username;
  const known = deps.known?.byUsername(username);
  if (known) return known.firstName;
  // Знакомство из чата написал кто-то другой, и оно могло быть шуткой: по
  // умолчанию — только в группах, где его и записали; в личке — нет.
  if (opts.intros === false) return null;
  const intro = deps.repo.introByUserId(from.id) ?? (username ? deps.repo.introByUsername(username) : null);
  return intro ? firstNameOf(intro.name) : null;
}

/** «@бот это не я» — стереть знакомства про этого человека. Сколько стёрто. */
export function forgetIntro(deps: Deps, from: { id: number; username?: string | undefined }): number {
  let n = 0;
  for (const intro of [deps.repo.introByUserId(from.id), from.username ? deps.repo.introByUsername(from.username) : null]) {
    if (intro && deps.repo.deleteIntro(intro.id)) n++;
  }
  return n;
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
  // Человека могли упомянуть ником или без ника (text_mention): если он писал
  // боту, знаем и то и другое — иначе одно знакомство расползлось бы на два.
  const target = intro.userId != null ? deps.repo.getUser(intro.userId) : intro.username ? deps.repo.userByUsername(intro.username) : null;
  const username = intro.username ?? target?.username?.toLowerCase() ?? null;
  const userId = intro.userId ?? target?.id ?? null;
  if (target?.anon) return "Приятно познакомиться 🙂 Но записывать не буду: у человека включена анонимность.";
  // Файл старост главнее: этого человека бот уже знает.
  if (username && deps.known?.byUsername(username)) return "А я уже знаю этого человека 🙂";
  const existing = (userId != null ? deps.repo.introByUserId(userId) : null) ?? (username ? deps.repo.introByUsername(username) : null);
  const want = nameWords(intro.name);
  if (existing && !intro.self) {
    return samePersonWords(want, nameWords(existing.name)) ? "Да я уже знаю 🙂" : "Этот ник у меня уже записан за кем-то другим 🤔 Если это ошибка — пусть человек сам представится: «@бот я — Фамилия Имя 12-23».";
  }
  // Сам человек может поправить себя, но не присвоить чужое имя.
  const takenInFile = deps.known?.nameTakenByOther(intro.name, username) ?? false;
  const takenInChats = deps.repo
    .intros(2000)
    .some((i) => i.id !== existing?.id && !(username && i.username === username) && !(userId != null && i.userId === userId) && samePersonWords(want, nameWords(i.name)));
  if (takenInFile || takenInChats) return "А этого человека я уже знаю под другим ником 🤔";
  deps.repo.saveIntro({ username, userId, name: intro.name, groupTitle: group.title, chatId, introducedBy: by.id });
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
export function slideCandidates(deps: Deps, query: string, group: LogicalGroup | null, strict = false, today: LocalDate = todayMsk()): SlideCandidate[] {
  const rows = deps.repo.webinarsBetween(addDays(today, -60), addDays(today, 30)).filter((r) => r.scheduled && r.subject);
  const scheduleFor = (g: LogicalGroup) => deps.service.materialize(g, today, addDays(today, 56)).filter((o) => o.isDistance && o.status !== "moved");
  const attempt = (g: LogicalGroup | null, q: string): SlideCandidate[] => {
    const mine = g ? rows.filter((r) => inGroup(r.groups, g)) : rows;
    const lessons = g ? scheduleFor(g) : [];
    const subjects = [...mine.map((r) => r.subject), ...lessons.map((o) => o.subject)];
    return matchSubjectsLoose(q, subjects).map((subject) => {
      const key = subjectKey(subject);
      const dates = [...mine.filter((r) => subjectKey(r.subject) === key).map((r) => r.date), ...lessons.filter((o) => subjectKey(o.subject) === key).map((o) => o.date)].filter((d) => d >= today).sort();
      return { subject, group: g, next: dates[0] ?? null };
    });
  };
  const own = group ? attempt(group, query) : [];
  // Группу назвали прямо — чужие группы не предлагаем: иначе «для 12-23»
  // превратилось бы в подписку на все группы.
  return own.length || strict ? own : attempt(null, query);
}

function describe(c: SlideCandidate): string {
  return `«${c.subject}»${c.group ? ` (${c.group.title})` : ""} — ${c.next ? `ближайший вебинар ${weekdayShort(c.next)} ${fmtDDMM(c.next)}` : "ближайшего вебинара пока не видно"}`;
}

/** Готовый PDF, который бот приложит к ответу. */
export interface DeckToSend {
  id: number;
  subject: string;
  date: string;
  file: string;
  fileId: string | null;
  slides: number;
}

export interface SlidesReply {
  text: string;
  /** Кнопки подтверждения подписки. */
  kb?: InlineKeyboard;
  /** PDF, который отправить следом за текстом. */
  deck?: DeckToSend;
}

/** Ответ на просьбу про слайды: текст, кнопки подтверждения или готовый PDF. */
export function handleSlidesRequest(ctx: BotContext, req: SlidesRequest, speakerGroup: LogicalGroup | null): SlidesReply {
  const deps = ctx.deps;
  const msg = ctx.msg!;
  const chatId = ctx.chat!.id;
  const threadId = topicOf(msg);
  const where = threadId ? "в эту тему" : "в этот чат";
  const subs = deps.repo.slideSubs(chatId, threadId);
  if (req.kind === "send") {
    if (!req.subject) return { text: `Слайды по какому предмету? Напиши: «@${ctx.me.username} скинь слайды по физике».` };
    let group = speakerGroup;
    if (req.group) {
      const found = findGroup(deps.service.groups(), req.group);
      if (!found.length) return { text: `Не знаю группу «${req.group}» 🤔 Напиши как 12-23.` };
      group = found[0]!;
    }
    // Свежие записи по предмету: сначала своей группы, иначе любой.
    // «по физике с прошлой пары», «по бжд плз»: предмет подбираем так же терпимо, как для подписки.
    const all = deps.repo.recentSlideDecks(200);
    const hit = matchSubjectsLoose(req.subject, [...new Set(all.map((d) => d.subject))], 1)[0];
    const decks = hit ? all.filter((d) => sameSubject(d.subject, hit)) : [];
    const deck = (group && decks.find((d) => d.groups.some((g) => logicalKeyFor(g) === group.key))) ?? (req.group ? undefined : decks[0]);
    if (deck) return { text: `Держи: слайды «${deck.subject}» за ${fmtDDMM(deck.date)}${deck.groups.length ? ` (${deck.groups.join(", ")})` : ""} 👇`, deck: { id: deck.id, subject: deck.subject, date: deck.date, file: deck.file, fileId: deck.fileId, slides: deck.slides } };
    // Записи ещё нет — предложить подписку: слайды появятся, как только бот запишет вебинар.
    const sub = handleSlidesRequest(ctx, { kind: "subscribe", subject: req.subject, group: req.group }, speakerGroup);
    return sub.kb ? { ...sub, text: `Таких слайдов у меня пока нет — появятся, как запишу ближайший вебинар. ${sub.text}` } : sub;
  }
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
  const candidates = slideCandidates(deps, req.subject, group, !!req.group);
  if (!candidates.length) return { text: `Не нашёл онлайн-пар по «${req.subject}»${req.group && group ? ` у ${group.title}` : ""} 🤔 Напиши название ближе к расписанию.` };
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

/** Что инструмент chat_slides оставил боту приложить к ответу модели. */
export interface SlidesToolState {
  kb?: InlineKeyboard;
  deck?: DeckToSend;
}

/**
 * Инструмент для модели: слайды вебинаров в этот чат — подписка, готовый
 * PDF, отписка, список. Модель зовёт его на любую просьбу про слайды, как бы
 * её ни сформулировали; текст ответа бот приложит с кнопками или файлом.
 */
export function slidesTool(ctx: BotContext, speakerGroup: LogicalGroup | null, state: SlidesToolState): ChatTool {
  return {
    name: "chat_slides",
    description:
      "Слайды онлайн-пар (вебинаров) в этот чат или тему. Бот сам записывает вебинары ВИШ и присылает PDF со слайдами. Действия: subscribe — присылать сюда слайды по предмету каждый раз (с подтверждением кнопками); send — прислать готовый PDF последней записи по предмету (нет записи — предложит подписку); unsubscribe — больше не присылать; list — что сюда приходит. Вызывай на любую просьбу про слайды, лекции в PDF, «пришли/скинь/присылай слайды», «хочу слайды», «есть ли слайды».",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["subscribe", "send", "unsubscribe", "list"], description: "Что сделать" },
        subject: { type: "string", description: "Предмет, как его назвали: «физика», «БЖД», «матан»" },
        group: { type: "string", description: "Группа, если её назвали: «12-23»" },
      },
      required: ["action"],
    },
    parse: (input: unknown) => {
      const raw = (input ?? {}) as { action?: unknown; subject?: unknown; group?: unknown };
      const action = String(raw.action ?? "");
      if (!["subscribe", "send", "unsubscribe", "list"].includes(action)) throw new Error("action: subscribe | send | unsubscribe | list");
      const subject = typeof raw.subject === "string" && raw.subject.trim() ? raw.subject.trim().slice(0, 80) : null;
      const group = typeof raw.group === "string" && raw.group.trim() ? raw.group.trim().slice(0, 30) : null;
      return { action: action as "subscribe" | "send" | "unsubscribe" | "list", subject, group };
    },
    run: async ({ action, subject, group }: { action: "subscribe" | "send" | "unsubscribe" | "list"; subject: string | null; group: string | null }) => {
      const req: SlidesRequest = action === "list" ? { kind: "list" } : action === "unsubscribe" ? { kind: "unsubscribe", subject } : { kind: action, subject, group };
      const r = handleSlidesRequest(ctx, req, speakerGroup);
      state.kb = r.kb;
      state.deck = r.deck;
      const attach = r.kb ? " Кнопки «Да/Нет» бот приложит к твоему ответу сам." : r.deck ? " PDF бот пришлёт следом за твоим ответом сам." : "";
      return `Ответь ровно этим текстом, ничего не добавляя: «${r.text}».${attach}`;
    },
  };
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
