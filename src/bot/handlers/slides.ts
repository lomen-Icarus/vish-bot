/**
 * Слайды записанных вебинаров по просьбе — в личке. Раньше готовый PDF можно
 * было получить только рассылкой (настройка «📎 Слайды записанных пар», и
 * только новые записи) или в групповом чате («@бот скинь слайды по физике»).
 * Теперь:
 *   • под расписанием дня у записанной пары — кнопка «📎 Слайды: …»;
 *   • в личке «слайды история», «скинь слайды по экономике за 09.10»,
 *     просто «слайды» — список последних записей своей группы.
 * Записи не личные: как и в групповом чате, любую можно получить по номеру.
 */
import { Composer, InlineKeyboard } from "grammy";
import type { BotContext, Deps } from "../context.js";
import { takePending } from "../context.js";
import type { SlideDeckRow } from "../../db/repo.js";
import { BTN, panelRef } from "../keyboards.js";
import { logicalKeyFor, type LogicalGroup } from "../../schedule/groups.js";
import { matchSubjectsLoose, sameSubject } from "../../chat/social.js";
import { addDays, fmtDDMM, parseDayWord, parseRuDate, todayMsk, type LocalDate } from "../../time.js";
import { deckPartLabel, newestFirst } from "../../notify/deckName.js";
import { sendDeck } from "../deck.js";

export const slidesHandlers = new Composer<BotContext>();

/** Сколько кнопок «📎 Слайды» максимум под одним днём. */
const MAX_DAY_BUTTONS = 3;

const ofGroup = (deck: SlideDeckRow, groupKey: string): boolean => deck.groups.some((g) => logicalKeyFor(g) === groupKey);

/** Записи этого дня у этой группы — для кнопок под расписанием. */
export function deckRows(decks: SlideDeckRow[], group: LogicalGroup, date: LocalDate): SlideDeckRow[] {
  return decks.filter((d) => d.date === date && ofGroup(d, group.key)).slice(0, MAX_DAY_BUTTONS);
}

/** Дописать под расписание дня кнопки «📎 Слайды: предмет» — только если что-то записано. */
export function addDeckButtons(kb: InlineKeyboard, deps: Deps, group: LogicalGroup, date: LocalDate): InlineKeyboard {
  for (const d of deckRows(deps.repo.slideDecksOn(date), group, date)) kb.row().text(`📎 Слайды: ${d.subject.slice(0, 32)}${deckPartLabel(d.title)}`, `sld:${d.id}`);
  return kb;
}

export interface SlidesQuery {
  subject: string;
  /** Точная дата («вчера», «09.10.2026»). */
  date: LocalDate | null;
  /** День и месяц без года («09.10»): месяц null — «9 число». */
  day: number | null;
  month: number | null;
}

const FILLER = new Set(["по", "за", "с", "со", "от", "на", "лекции", "лекция", "лекций", "лекцию", "пары", "пару", "пара", "вебинар", "вебинара", "число", "числа", "плз", "пж", "пожалуйста", "мне", "мои", "все", "последние", "последнюю"]);

/**
 * «по экономике за 9.10», «история, вчера», «физика 9 число» → предмет и дата.
 * Слова-даты и даты — теми же разборщиками, что в расписании (time.ts):
 * «позавчера», «31.02» (такого дня нет) понимаются одинаково везде.
 */
export function parseSlidesQuery(rest: string, today: LocalDate = todayMsk()): SlidesQuery {
  // Знаки препинания — пробелы («история, вчера»); точка между цифрами — часть даты.
  const words = rest
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/(?<!\d)\.|\.(?!\d)|[^\p{L}\p{N}./-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  let date: LocalDate | null = null;
  let day: number | null = null;
  let month: number | null = null;
  const subject: string[] = [];
  for (const w of words) {
    const found: boolean = date != null || day != null;
    const shift = found ? null : parseDayWord(w);
    if (shift != null) {
      date = addDays(today, shift);
      continue;
    }
    const dm: RegExpExecArray | null = found ? null : /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/.exec(w);
    if (dm) {
      day = Number(dm[1]);
      month = Number(dm[2]);
      if (dm[3]) date = parseRuDate(w, today);
      continue;
    }
    const num: RegExpExecArray | null = found ? null : /^(\d{1,2})(?:-?е|-?го)?$/.exec(w);
    if (num && Number(num[1]) >= 1 && Number(num[1]) <= 31) {
      day = Number(num[1]);
      continue;
    }
    // «вчера 2 пара» — номер пары, а не предмет.
    if (found && /^\d{1,2}(?:-?я|-?ая)?$/.test(w)) continue;
    if (!FILLER.has(w)) subject.push(w);
  }
  return { subject: subject.join(" "), date, day, month };
}

const onDate = (d: SlideDeckRow, q: SlidesQuery): boolean => {
  if (q.date) return d.date === q.date;
  if (q.day == null) return true;
  const [, m, dd] = d.date.split("-").map(Number);
  return dd === q.day && (q.month == null || m === q.month);
};

/** Подходящие записи: своей группы первыми, внутри — новые раньше. */
export function findDecks(decks: SlideDeckRow[], q: SlidesQuery, groupKey: string | null): SlideDeckRow[] {
  let hits = decks.filter((d) => onDate(d, q));
  if (q.subject) {
    const subject = matchSubjectsLoose(q.subject, [...new Set(hits.map((d) => d.subject))], 1)[0];
    hits = subject ? hits.filter((d) => sameSubject(d.subject, subject)) : [];
  }
  if (!groupKey) return hits;
  return [...hits.filter((d) => ofGroup(d, groupKey)), ...hits.filter((d) => !ofGroup(d, groupKey))];
}

function listKeyboard(decks: SlideDeckRow[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const d of decks) kb.text(`${fmtDDMM(d.date)} · ${d.subject.slice(0, 40)}${deckPartLabel(d.title)}`, `sld:${d.id}`).row();
  return kb;
}

function autoHint(ctx: BotContext): string {
  return `Чтобы новые слайды приходили сами — включи «📎 Слайды записанных пар» в ${panelRef(ctx.user, BTN.more, BTN.settings, "/settings")}.`;
}

/** Последние записи: своей группы, а если группы нет — любые. */
function recentFor(ctx: BotContext, all: SlideDeckRow[]): SlideDeckRow[] {
  const key = ctx.user.groupKey;
  return (key ? all.filter((d) => ofGroup(d, key)) : all).slice(0, 8);
}

slidesHandlers.chatType("private").hears(/^\s*(?:скинь|скиньте|пришли|пришлите|дай|дайте|отправь|хочу)?\s*слайд(?:ы|ов|ик\p{L}*)?(?:\s+(.*))?$/isu, async (ctx, next) => {
  // Бот ждёт ввод (фамилию, обращение, вопрос ИИ) — «слайды по физике» и есть этот ввод.
  if (takePending(ctx.deps, ctx.user.id)) return next();
  const all = newestFirst(ctx.deps.repo.recentSlideDecks(300));
  if (!all.length) return void (await ctx.reply("Записанных вебинаров у меня пока нет."));
  const q = parseSlidesQuery(ctx.match[1] ?? "");
  if (!q.subject && q.date == null && q.day == null) {
    const recent = recentFor(ctx, all);
    if (!recent.length) return void (await ctx.reply(`У твоей группы записанных пар пока нет. Напиши, по какому предмету: «слайды экономика». ${autoHint(ctx)}`));
    await ctx.reply("Какие слайды прислать? Последние записи твоей группы:", { reply_markup: listKeyboard(recent) });
    return;
  }
  const hits = findDecks(all, q, ctx.user.groupKey);
  if (!hits.length) {
    const what = [q.subject && `«${q.subject}»`, q.date ? `за ${fmtDDMM(q.date)}` : q.day != null ? `за ${q.day}${q.month ? `.${String(q.month).padStart(2, "0")}` : " число"}` : ""].filter(Boolean).join(" ");
    await ctx.reply(`Слайдов ${what} у меня нет: записываются не все онлайн-пары. Просто «слайды» — список последних записей. ${autoHint(ctx)}`);
    return;
  }
  await sendDeck(ctx, hits[0]!);
  const others = hits.slice(1, 6);
  if (others.length) await ctx.reply("Ещё есть записи:", { reply_markup: listKeyboard(others) });
});

slidesHandlers.callbackQuery(/^sld:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const deck = ctx.deps.repo.slideDeck(Number(ctx.match[1]));
  if (!deck) return void (await ctx.reply("Этой записи уже нет: старые слайды бот удаляет через 120 дней."));
  await sendDeck(ctx, deck);
});
