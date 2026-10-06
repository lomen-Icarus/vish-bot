/**
 * Картинки дней с изменениями — общие для рассылки (Notifier) и кнопки
 * «🔔 Изменения»: один и тот же способ нарисовать и один и тот же кеш, чтобы
 * два пути не разошлись.
 *
 * У подписчиков одной группы картинка различается только темой, подгруппой и
 * видом преподавателя, поэтому одинаковые постеры рисуются один раз: в
 * рассылке — на время одного прохода, у кнопки — несколько минут (её жмут
 * подряд, а постер — это секунда работы рендера).
 */
import type { Renderer } from "../render/image.js";
import type { ScheduleService } from "../schedule/service.js";
import type { LogicalGroup } from "../schedule/groups.js";
import { positionKey, type Occurrence } from "../schedule/model.js";
import { filterSubgroup, type TeacherView } from "../schedule/format.js";
import type { WallClock, LocalDate } from "../time.js";
import { logger } from "../logger.js";
import type { ChangeDay } from "./changes.js";

/** Пары дня для картинки: своей группы — только своей подгруппы, чужой — все. */
export function dayLessonsFor(service: Pick<ScheduleService, "lessonsOn">, group: LogicalGroup, subgroup: number | null | undefined): (date: LocalDate) => Occurrence[] {
  return (date) => filterSubgroup(service.lessonsOn(group, date), subgroup);
}

export class ChangePosters {
  private readonly cache = new Map<string, { at: number; png: Promise<Buffer | undefined> }>();

  constructor(
    private readonly ttlMs = Number.POSITIVE_INFINITY,
    private readonly max = 500,
  ) {}

  clear(): void {
    this.cache.clear();
  }

  /** Постер дня с пометками; не нарисовался — undefined (и запись в лог). */
  render(renderer: Renderer, service: Pick<ScheduleService, "weekInfo">, args: { group: LogicalGroup; day: ChangeDay; now: WallClock; theme?: string | null; teacherView?: TeacherView }): Promise<Buffer | undefined> {
    const { group, day, now } = args;
    const key = JSON.stringify([group.key, day.date, args.theme ?? "", args.teacherView ?? "", day.banner.text, now.date === day.date ? now.minutes : 0, day.lessons.map((o) => [positionKey(o), o.room, o.start, o.end, o.status, o.mark?.kind ?? "", o.mark?.note ?? ""])]);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.png;
    const png = renderer
      .renderDay({ group, date: day.date, lessons: day.lessons, weekInfo: service.weekInfo(day.date), today: now.date, now, theme: args.theme ?? undefined, teacherView: args.teacherView, banner: day.banner })
      .catch((err: unknown) => {
        logger.warn({ err: String(err).slice(0, 200) }, "changes image render failed");
        return undefined;
      });
    this.cache.delete(key);
    this.cache.set(key, { at: Date.now(), png });
    // Самые старые — вон: Map помнит порядок вставки.
    while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
    return png;
  }
}
