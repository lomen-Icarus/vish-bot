/**
 * Пересдачи (ППА) — отдельный период портала (htype=11): таблица по датам,
 * в каждой строке «аудитория, предмет (форма) — N ППА, время». Общий разборщик
 * портала (parseGroupSchedule) читает эту страницу, но теряет номер попытки и
 * не знает период 11, поэтому здесь свой маленький разбор.
 */
import type { LocalDate } from "../time.js";

export interface PpaItem {
  date: LocalDate;
  /** Минуты от полуночи. */
  start: number | null;
  end: number | null;
  room: string | null;
  subject: string;
  /** Форма как на портале: зач, Экз, ЗачО, КП, КР. */
  kind: string;
  /** «1 ППА» → 1, «2 ППА» → 2; не разобрали — null. */
  attempt: number | null;
  isDistance: boolean;
}

/** Страница правда про ППА: портал отмечает выбранный период в скрипте. */
export function isPpaPage(html: string): boolean {
  return /#pertype-"\s*\+\s*"11"/.test(html);
}

const decode = (s: string): string =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const minutes = (h: string, m: string): number => Number(h) * 60 + Number(m);

/** Все пересдачи со страницы ППА группы, по дате и времени. */
export function parsePpaPage(html: string): PpaItem[] {
  const out: PpaItem[] = [];
  // Ячейка дня: id="td20261015g8824", внутри — таблица, строка на пересдачу.
  const cellRe = /<td id="td(\d{4})(\d{2})(\d{2})g\d+"[^>]*>([\s\S]*?)<\/div>\s*<\/td>/g;
  for (const cell of html.matchAll(cellRe)) {
    const date = `${cell[1]}-${cell[2]}-${cell[3]}` as LocalDate;
    for (const row of cell[4]!.matchAll(/<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)) {
      const raw = row[1]!;
      const subjectHtml = /<span style="color:\s*blue;?">([\s\S]*?)<\/span>/.exec(raw);
      if (!subjectHtml) continue;
      const subject = decode(subjectHtml[1]!);
      if (!subject) continue;
      const before = decode(raw.slice(0, subjectHtml.index));
      const after = raw.slice(subjectHtml.index + subjectHtml[0].length);
      const kind = /^\s*\(([^()]*)\)/.exec(decode(after))?.[1]?.trim() ?? "";
      const attempt = /(\d+)\s*ППА/.exec(decode(after))?.[1];
      const time = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/.exec(after);
      const isDistance = /ДОТ/.test(before) || /ДОТ/.test(decode(after));
      const room = before.replace(/\(?ДОТ\)?/g, "").trim() || null;
      out.push({
        date,
        start: time ? minutes(time[1]!, time[2]!) : null,
        end: time ? minutes(time[3]!, time[4]!) : null,
        room,
        subject,
        kind,
        attempt: attempt ? Number(attempt) : null,
        isDistance,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? 0) - (b.start ?? 0));
}
