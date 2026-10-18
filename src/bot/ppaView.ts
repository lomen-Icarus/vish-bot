/**
 * Экран «📋 ППА»: пересдачи группы и отметки своих долгов. Один и тот же вид —
 * в /ppa, в «🗂 Ещё» и в вопросе «Есть долги?», который бот задаёт раз за волну.
 */
import { InlineKeyboard } from "grammy";
import type { PpaItem } from "../portal/ppa.js";
import { esc } from "../schedule/format.js";
import type { LogicalGroup } from "../schedule/groups.js";
import { lessonTypeLabel } from "../schedule/model.js";
import { subjectKey } from "../schedule/subjects.js";
import { fmtDDMM, fmtHHMM, weekdayShort } from "../time.js";

/** «вт 20.10 08:20–11:10 · Философия · экзамен · 1 ППА · Г-303». */
export function ppaItemText(i: PpaItem): string {
  const time = i.start != null ? ` ${fmtHHMM(i.start)}${i.end != null ? `–${fmtHHMM(i.end)}` : ""}` : "";
  return [`<b>${weekdayShort(i.date)} ${fmtDDMM(i.date)}</b>${time}`, esc(i.subject), lessonTypeLabel(i.kind), i.attempt ? `${i.attempt} ППА` : "", i.room ? esc(i.room) : ""].filter(Boolean).join(" · ");
}

/** Предметы пересдач (по одному на ключ), в порядке первой пересдачи. */
function subjectsOf(items: PpaItem[]): Array<{ key: string; subject: string }> {
  const seen = new Map<string, string>();
  for (const i of items) if (!seen.has(subjectKey(i.subject))) seen.set(subjectKey(i.subject), i.subject);
  return [...seen].map(([key, subject]) => ({ key, subject }));
}

const short = (s: string, n = 30): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Текст и кнопки. ask — первый вопрос волны: объясняем, зачем отмечать.
 * Кнопка предмета переключает отметку; внизу — «Долгов нет» или «Готово».
 */
export function ppaScreen(group: LogicalGroup, upcoming: PpaItem[], debts: ReadonlySet<string>, opts: { ask?: boolean } = {}): { text: string; kb: InlineKeyboard } {
  const kb = new InlineKeyboard();
  if (!upcoming.length) {
    return { text: `📋 <b>Пересдачи (ППА) · ${esc(group.title)}</b>\n\nВпереди пересдач у группы нет — портал их пока не показывает. Как появятся, спрошу про долги сам.`, kb };
  }
  const first = upcoming[0]!.date;
  const last = upcoming.at(-1)!.date;
  const head = opts.ask
    ? `📋 <b>У ${esc(group.title)} вышло расписание пересдач (ППА)</b>: ${upcoming.length}, ${first === last ? fmtDDMM(first) : `с ${fmtDDMM(first)} по ${fmtDDMM(last)}`}.\n\nЕсть долги? Отметь предметы — их пересдачи встанут в твоё расписание, напоминания и календарь. Кто ничего не отметит, лишнего не увидит. Отметки видишь только ты.`
    : `📋 <b>Пересдачи (ППА) · ${esc(group.title)}</b>\n\nОтмеченные ✅ стоят в твоём расписании, напоминаниях и календаре. Отметки видишь только ты.`;
  const lines = upcoming.map((i) => `${debts.has(subjectKey(i.subject)) ? "✅" : "▫️"} ${ppaItemText(i)}`);
  // По два предмета в ряд: у группы за волну бывает с десяток предметов.
  const subjects = subjectsOf(upcoming);
  subjects.forEach((s, n) => {
    kb.text(`${debts.has(s.key) ? "✅" : "▫️"} ${short(s.subject, 22)}`, `ppa:t:${s.key}`);
    if (n % 2 === 1) kb.row();
  });
  if (subjects.length % 2 === 1) kb.row();
  const mine = subjects.filter((s) => debts.has(s.key)).length;
  kb.text(mine ? "👌 Готово" : "🙅 Долгов нет", mine ? "ppa:done" : "ppa:none");
  return { text: `${head}\n\n${lines.join("\n")}`, kb };
}
