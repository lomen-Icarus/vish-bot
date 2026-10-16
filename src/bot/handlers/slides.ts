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
import type { SlideDeckRow } from "../../db/repo.js";
import { BTN, panelRef } from "../keyboards.js";
import { logicalKeyFor, type LogicalGroup } from "../../schedule/groups.js";
import { matchSubjectsLoose, sameSubject } from "../../chat/social.js";
import { addDays, fmtDDMM, todayMsk, type LocalDate } from "../../time.js";
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
  for (const d of deckRows(deps.repo.slideDecksOn(date), group, date)) kb.row().text(`📎 Слайды: ${d.subject.slice(0, 32)}`, `sld:${d.id}`);
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

/** «по экономике за 9.10», «история вчера», «физика 9 число» → предмет и дата. */
export function parseSlidesQuery(rest: string, today: LocalDate = todayMsk()): SlidesQuery {
  let text = ` ${rest.toLowerCase().replace(/ё/g, "е")} `;
  let date: LocalDate | null = null;
  let day: number | null = null;
  let month: number | null = null;
  const rel: Record<string, number> = { сегодня: 0, вчера: -1, позавчера: -2 };
  for (const [word, shift] of Object.entries(rel)) {
    if (text.includes(` ${word} `)) {
      date = addDays(today, shift);
      text = text.replace(` ${word} `, " ");
    }
  }
  const full = /\s(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\s/.exec(text);
  if (full) {
    day = Number(full[1]);
    month = Number(full[2]);
    if (full[3]) {
      const y = full[3].length === 2 ? 2000 + Number(full[3]) : Number(full[3]);
      date = `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
    text = text.replace(full[0], " ");
  } else {
    const num = /\s(\d{1,2})(?:-?е|-?го)?\s+числ[ао]?\s/.exec(text) ?? /\s(\d{1,2})\s/.exec(text);
    if (num) {
      day = Number(num[1]);
      text = text.replace(num[0], " ");
    }
  }
  const subject = text
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .join(" ");
  return { subject, date, day, month };
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
  for (const d of decks) kb.text(`${fmtDDMM(d.date)} · ${d.subject.slice(0, 40)}`, `sld:${d.id}`).row();
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

/** Новые раньше — по дате пары, а не по порядку записи: недоставленная пачка бывает добавлена позже. */
const newestFirst = (decks: SlideDeckRow[]): SlideDeckRow[] => [...decks].sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

slidesHandlers.chatType("private").hears(/^\s*(?:скинь|скиньте|пришли|пришлите|дай|дайте|отправь|хочу)?\s*слайд(?:ы|ов|ик\w*)?(?:\s+(.*))?$/isu, async (ctx) => {
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
