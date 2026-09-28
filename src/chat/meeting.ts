/**
 * «Стоит ли провести собрание 12-23 в пятницу в 15:00?» — сверка времени с
 * расписанием группы. Правила — от владельца бота:
 *
 *  - время попадает на пару → «нене, у них такая-то пара, и вообще они
 *    заняты парами с … до …»;
 *  - до пар: меньше 30 минут до начала → «ой сори, у них пары скоро,
 *    вариант 50/50», иначе → «о кайф, как раз за N до пар»;
 *  - после пар: не позже 15 минут после последней → «о, как раз после пар,
 *    норм вариант», позже → «поздновато… может пораньше?»;
 *  - между парами (окно) — по тому же правилу 30 минут до следующей пары;
 *  - пар нет вовсе → свободны.
 *
 * Здесь только расчёт: словами вердикт передаёт модель (инструмент
 * meeting_slot в src/ai/ask.ts).
 */
import { fmtHHMM } from "../time.js";
import { lessonTypeLabel, type Occurrence } from "../schedule/model.js";

export type MeetingKind = "free-day" | "busy" | "soon" | "before" | "after" | "late" | "window";

export interface MeetingVerdict {
  kind: MeetingKind;
  /** Что известно: пары дня, окна — для модели. */
  facts: string;
  /** В каком духе ответить (формулировки владельца бота). */
  hint: string;
}

/** Меньше этого до начала пар — «пары скоро, 50/50». */
export const SOON_BEFORE_MIN = 30;
/** Больше этого после последней пары — «поздновато». */
export const LATE_AFTER_MIN = 15;

/** 40 → «40 мин», 80 → «1 ч 20 мин», 120 → «2 ч». */
export function fmtDuration(min: number): string {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} ч ${rest} мин` : `${h} ч`;
}

function lessonLine(o: Occurrence): string {
  return `${fmtHHMM(o.start!)}–${fmtHHMM(o.end!)} ${o.subject} (${lessonTypeLabel(o.type)})${o.subgroup ? `, у ${o.subgroup} подгр.` : ""}${o.isDistance ? ", онлайн" : o.room ? `, ауд. ${o.room}` : ""}`;
}

/**
 * Вердикт по парам одного дня и времени начала встречи (минуты от полуночи).
 * Перенесённые «пустые» места (status moved) и пары без времени не считаются.
 */
export function meetingVerdict(lessons: Occurrence[], at: number): MeetingVerdict {
  const list = lessons.filter((o) => o.status !== "moved" && o.start != null && o.end != null).sort((a, b) => a.start! - b.start! || a.end! - b.end!);
  if (!list.length) return { kind: "free-day", facts: "Пар в этот день нет.", hint: "у них в этот день пар нет — свободны, норм вариант" };
  const dayStart = list[0]!.start!;
  const dayEnd = Math.max(...list.map((o) => o.end!));
  // Окна между парами: где пар нет ни у одной подгруппы.
  const gaps: Array<{ from: number; to: number }> = [];
  let busyUntil = list[0]!.end!;
  for (const o of list.slice(1)) {
    if (o.start! > busyUntil) gaps.push({ from: busyUntil, to: o.start! });
    busyUntil = Math.max(busyUntil, o.end!);
  }
  const span = `с ${fmtHHMM(dayStart)} до ${fmtHHMM(dayEnd)}`;
  const facts = [`Пары в этот день (${span}):`, ...list.map((o) => `  ${lessonLine(o)}`), gaps.length ? `Окна: ${gaps.map((g) => `${fmtHHMM(g.from)}–${fmtHHMM(g.to)}`).join(", ")}.` : "Окон между парами нет."].join("\n");

  const current = list.find((o) => o.start! <= at && at < o.end!);
  if (current) {
    return { kind: "busy", facts, hint: `нене, у них в это время ${current.subject} (${fmtHHMM(current.start!)}–${fmtHHMM(current.end!)}${current.subgroup ? `, у ${current.subgroup} подгр.` : ""}), и вообще они заняты парами ${span}` };
  }
  if (at < dayStart) {
    const gap = dayStart - at;
    if (gap < SOON_BEFORE_MIN) return { kind: "soon", facts, hint: `ой сори, у них пары скоро — через ${fmtDuration(gap)}, в ${fmtHHMM(dayStart)}, вариант фифти-фифти` };
    return { kind: "before", facts, hint: `о кайф, как раз за ${fmtDuration(gap)} до пар (пары ${span})` };
  }
  if (at >= dayEnd) {
    const after = at - dayEnd;
    if (after <= LATE_AFTER_MIN) return { kind: "after", facts, hint: `о, как раз после пар (кончаются в ${fmtHHMM(dayEnd)}), норм вариант` };
    return { kind: "late", facts, hint: `поздновато... пары кончаются в ${fmtHHMM(dayEnd)}, может пораньше?` };
  }
  // Между парами: до следующей пары меньше 30 минут — тоже «скоро».
  const next = list.find((o) => o.start! > at)!;
  const gap = next.start! - at;
  const window = gaps.find((g) => g.from <= at && at < g.to);
  if (gap < SOON_BEFORE_MIN) return { kind: "soon", facts, hint: `ой сори, у них скоро следующая пара — ${next.subject} в ${fmtHHMM(next.start!)}, через ${fmtDuration(gap)}, вариант фифти-фифти` };
  return { kind: "window", facts, hint: `норм, у них как раз окно${window ? ` с ${fmtHHMM(window.from)} до ${fmtHHMM(window.to)}` : ""} — до следующей пары ${fmtDuration(gap)}` };
}
