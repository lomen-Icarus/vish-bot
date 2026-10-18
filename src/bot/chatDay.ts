/**
 * Расписание дня в групповом чате — той же картинкой, что в личке у бота.
 * Модель пересказывала пары своими словами и теряла детали; теперь она зовёт
 * show_day, бот сам прикладывает к её ответу постер дня (без отрисовщика —
 * текст дня), а её ответ становится короткой подписью.
 */
import { InputFile } from "grammy";
import type { BotContext } from "./context.js";
import type { ChatTool } from "../chat/service.js";
import { groupLessons } from "./views.js";
import { captionFits, clampHtml, esc, formatDay } from "../schedule/format.js";
import { findGroup, type LogicalGroup } from "../schedule/groups.js";
import { fmtDDMM, fmtHHMM, isLocalDate, todayMsk, wallClock, weekdayShort, type LocalDate } from "../time.js";
import { logger } from "../logger.js";

export interface DayToolState {
  days?: Array<{ group: LogicalGroup; date: LocalDate }>;
}

/** Больше двух картинок за ответ — уже простыня в чате. */
const MAX_DAYS = 2;

export function dayTool(ctx: BotContext, speakerGroup: LogicalGroup | null, state: DayToolState): ChatTool {
  return {
    name: "show_day",
    description:
      "Показать в чате расписание группы на день картинкой — точно как в личке у бота. Вызывай, когда просят расписание группы на конкретный день («расписание на завтра», «что у 14-24 в среду», «пары 21 октября»). Бот сам приложит картинку к твоему ответу; ты ответь одной короткой фразой-подписью и не пересказывай пары.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Дата YYYY-MM-DD (этого учебного года)" },
        group: { type: "string", description: "Группа, если назвали: «14-24»; иначе группа спросившего" },
      },
      required: ["date"],
    },
    parse: (input: unknown) => {
      const raw = (input ?? {}) as { date?: unknown; group?: unknown };
      const date = String(raw.date ?? "").trim();
      if (!isLocalDate(date)) throw new Error("date: YYYY-MM-DD");
      const group = typeof raw.group === "string" && raw.group.trim() ? raw.group.trim().slice(0, 30) : null;
      return { date, group };
    },
    run: async ({ date, group }: { date: LocalDate; group: string | null }) => {
      const today = todayMsk();
      if (Math.abs(Date.parse(date) - Date.parse(today)) / 86_400_000 > 200) return `Дата ${date} — не этот учебный год: сегодня ${today}. Возьми ${today.slice(0, 4)} и вызови снова.`;
      const g = group ? (findGroup(ctx.deps.service.groups(), group)[0] ?? null) : speakerGroup;
      if (!g) return group ? `Группа «${group}» не найдена. Назови её, например 14-24.` : "Группа спросившего неизвестна — спроси, какая группа, например 14-24.";
      const days = (state.days ??= []);
      if (days.length >= MAX_DAYS) return "Больше двух дней за раз не показываю — ответь, что остальное можно спросить следом.";
      if (!days.some((d) => d.group.key === g.key && d.date === date)) days.push({ group: g, date });
      // Факты для подписи — чтобы она не расходилась с картинкой.
      const lessons = ctx.deps.service.lessonsOn(g, date).filter((o) => o.status !== "moved" && o.start != null);
      const facts = lessons.length
        ? `${new Set(lessons.map((o) => `${o.start}|${o.subject}`)).size} пар(ы), ${fmtHHMM(Math.min(...lessons.map((o) => o.start!)))}–${fmtHHMM(Math.max(...lessons.map((o) => o.end ?? o.start!)))}`
        : "пар нет";
      return `Картинку «${g.title}, ${weekdayShort(date)} ${fmtDDMM(date)}» бот приложит к твоему ответу сам. Факты: ${facts}. Ответь одной короткой фразой-подписью (например, когда начало и конец), пары не перечисляй.`;
    },
  };
}

/**
 * Отправить дни из show_day ответом на сообщение. caption — ответ модели:
 * подпись к первой картинке, если влезает. Возвращает, ушла ли подпись
 * (тогда отдельный текст ответа уже не нужен).
 */
export async function sendDays(ctx: BotContext, state: DayToolState, caption: string | null, replyTo: number): Promise<boolean> {
  const deps = ctx.deps;
  const today = todayMsk();
  let captionUsed = false;
  for (const { group, date } of state.days ?? []) {
    const cap = !captionUsed && caption && captionFits(esc(caption)) ? esc(caption) : undefined;
    const reply = { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } };
    try {
      const lessons = groupLessons(deps, group, date, date);
      const weekInfo = deps.service.weekInfo(date);
      if (deps.renderer) {
        const png = await deps.renderer.renderDay({ group, date, lessons, weekInfo, today, now: wallClock() });
        await ctx.replyWithPhoto(new InputFile(png, `${group.title}-${date}.png`), { ...(cap ? { caption: cap, parse_mode: "HTML" as const } : {}), ...reply });
      } else {
        const text = formatDay(group, date, lessons, weekInfo, today, { now: wallClock() });
        await ctx.reply(clampHtml(cap ? `${cap}\n\n${text}` : text), { parse_mode: "HTML", ...reply });
      }
      if (cap) captionUsed = true;
    } catch (err) {
      logger.warn({ err: (err as Error).name, chat: ctx.chat?.id }, "group chat: day view not sent");
    }
  }
  return captionUsed;
}
