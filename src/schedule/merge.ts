import type { ParsedScheduleDay, ParsedLesson } from "chuvsu-js/parsers";

export interface SourcedDay extends Omit<ParsedScheduleDay, "blocks"> {
  blocks: Array<{ slotNumber?: number; time?: ParsedScheduleDay["blocks"][number]["time"]; lessons: SourcedLesson[] }>;
}

export interface SourcedLesson extends ParsedLesson {
  /** Portal group names in which this exact lesson row was observed. */
  sources: string[];
}

function lessonIdentity(l: ParsedLesson): string {
  return JSON.stringify([
    l.subject,
    l.type,
    l.room ?? null,
    l.teacher?.name ?? null,
    l.subgroup ?? null,
    l.weeks ?? null,
    l.weekParity ?? null,
    l.isDistance ?? false,
    l.substitutions ?? null,
    l.transfer ?? null,
  ]);
}

/**
 * Union of several portal projections of one logical group. Identical rows
 * collapse into one; rows present only in some variants keep the list of
 * variants that carry them so the UI can hint "только ВИШ-13-23".
 */
export function mergeVariants(variants: Array<{ name: string; days: ParsedScheduleDay[] }>): SourcedDay[] {
  const dayMap = new Map<string, SourcedDay>();
  const dayOrder: string[] = [];
  for (const v of variants) {
    for (const day of v.days) {
      const dayKey = day.date ?? day.weekday;
      let target = dayMap.get(dayKey);
      if (!target) {
        target = { weekday: day.weekday, date: day.date, isSelfStudyDay: day.isSelfStudyDay, blocks: [] };
        dayMap.set(dayKey, target);
        dayOrder.push(dayKey);
      } else if (day.isSelfStudyDay === false || day.isSelfStudyDay === undefined) {
        // A self-study day in one variant and lessons in another: lessons win.
        if (day.blocks.some((b) => b.lessons.length > 0)) target.isSelfStudyDay = false;
      }
      for (const block of day.blocks) {
        const blockKey = block.slotNumber ?? (block.time ? `${block.time.start.hours}:${block.time.start.minutes}` : "?");
        let tb = target.blocks.find((b) => (b.slotNumber ?? (b.time ? `${b.time.start.hours}:${b.time.start.minutes}` : "?")) === blockKey);
        if (!tb) {
          tb = { slotNumber: block.slotNumber, time: block.time, lessons: [] };
          target.blocks.push(tb);
        }
        for (const lesson of block.lessons) {
          const id = lessonIdentity(lesson);
          const existing = tb.lessons.find((x) => lessonIdentity(x) === id);
          if (existing) {
            if (!existing.sources.includes(v.name)) existing.sources.push(v.name);
          } else {
            tb.lessons.push({ ...lesson, sources: [v.name] });
          }
        }
      }
    }
  }
  const days = dayOrder.map((k) => dayMap.get(k)!);
  for (const d of days) d.blocks.sort((a, b) => (a.slotNumber ?? 99) - (b.slotNumber ?? 99) || startMinutes(a.time) - startMinutes(b.time));
  return days;
}

function startMinutes(t: { start: { hours: number; minutes: number } } | undefined): number {
  return t ? t.start.hours * 60 + t.start.minutes : 0;
}
