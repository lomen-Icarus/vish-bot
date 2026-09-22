import type { LocalDate } from "../time.js";
import { samePerson } from "../text/match.js";
import { contentHash, positionKey, type Occurrence } from "./model.js";

export type ChangeKind = "added" | "removed" | "changed" | "moved";

export interface ChangeEvent {
  kind: ChangeKind;
  groupKey: string;
  date: LocalDate;
  period: Occurrence["period"];
  before?: Occurrence;
  after?: Occurrence;
  /** For "changed": which fields differ. */
  fields?: string[];
}

function changedFields(a: Occurrence, b: Occurrence): string[] {
  const f: string[] = [];
  if (a.room !== b.room) f.push("room");
  // Преподаватель ПОЯВИЛСЯ или ПРОПАЛ — это не замена, а смена источника.
  // Фамилии портал отдаёт только авторизованным: как только учётка входит,
  // они появляются у всех пар разом, а если учётка отвалится — так же разом
  // исчезнут. Рассылать по такому поводу «изменение в расписании» каждому
  // подписчику — спам на пустом месте. Настоящую замену (один человек на
  // другого) по-прежнему показываем; разное написание одного и того же
  // человека заменой не считается.
  if (a.teacher && b.teacher && !samePerson(a.teacher, b.teacher)) f.push("teacher");
  if (a.start !== b.start || a.end !== b.end) f.push("time");
  if (a.isDistance !== b.isDistance) f.push("distance");
  if (a.status !== b.status) f.push("status");
  if ((a.movedTo?.date ?? "") !== (b.movedTo?.date ?? "") || (a.movedTo?.slot ?? "") !== (b.movedTo?.slot ?? "")) f.push("movedTo");
  return f;
}

function sameLesson(a: Occurrence, b: Occurrence): boolean {
  return a.subject === b.subject && a.type === b.type && (a.subgroup ?? null) === (b.subgroup ?? null);
}

/**
 * Compare two materialisations of the same group over the same window.
 * Emits one event per meaningful difference and folds "removed here + added
 * there" for the same lesson into a single "moved" event.
 */
export function diffOccurrences(prev: Occurrence[], next: Occurrence[], opts: { from: LocalDate; to: LocalDate }): ChangeEvent[] {
  const inWindow = (o: Occurrence) => o.date >= opts.from && o.date <= opts.to;
  const prevMap = new Map(prev.filter(inWindow).map((o) => [positionKey(o), o]));
  const nextMap = new Map(next.filter(inWindow).map((o) => [positionKey(o), o]));

  const events: ChangeEvent[] = [];
  const removed: Occurrence[] = [];
  const added: Occurrence[] = [];

  for (const [key, before] of prevMap) {
    const after = nextMap.get(key);
    if (!after) {
      removed.push(before);
      continue;
    }
    if (contentHash(before) !== contentHash(after)) {
      const fields = changedFields(before, after);
      if (fields.length) events.push({ kind: "changed", groupKey: after.groupKey, date: after.date, period: after.period, before, after, fields });
    }
  }
  for (const [key, after] of nextMap) if (!prevMap.has(key)) added.push(after);

  // Fold moves: a lesson that disappeared from one place and appeared in another.
  const usedAdded = new Set<Occurrence>();
  for (const before of removed) {
    const candidates = added.filter((a) => !usedAdded.has(a) && sameLesson(before, a) && a.status === "scheduled");
    // Prefer an explicit portal transfer pointing back at this origin.
    const explicit = candidates.find((a) => a.movedFrom && a.movedFrom.date === before.date && a.movedFrom.slot === before.slot);
    const match = explicit ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (match && before.status === "scheduled") {
      usedAdded.add(match);
      events.push({ kind: "moved", groupKey: match.groupKey, date: match.date, period: match.period, before, after: match });
    } else if (before.status === "scheduled") {
      events.push({ kind: "removed", groupKey: before.groupKey, date: before.date, period: before.period, before });
    }
    // A vacated ("moved") placeholder disappearing is not news by itself.
  }
  for (const after of added) {
    if (usedAdded.has(after)) continue;
    if (after.status === "moved") continue; // vacated placeholder appearing without its counterpart: covered by "changed"/"moved"
    events.push({ kind: "added", groupKey: after.groupKey, date: after.date, period: after.period, after });
  }

  // A scheduled lesson turning into a vacated placeholder is a move when the target is visible.
  return events
    .map((e) => {
      if (e.kind === "changed" && e.before && e.after && e.after.status === "moved" && e.before.status === "scheduled" && e.after.movedTo) {
        const target = next.find((o) => o.date === e.after!.movedTo!.date && o.subject === e.after!.subject && o.movedFrom?.date === e.before!.date);
        if (target) {
          // Skip: the corresponding "added" event for the target already became a "moved" event above,
          // unless it did not (target outside window), in which case report the move here.
          const alreadyMoved = events.some((x) => x.kind === "moved" && x.after === target);
          if (alreadyMoved) return null;
          return { ...e, kind: "moved" as const, after: target, date: target.date };
        }
      }
      return e;
    })
    .filter((e): e is ChangeEvent => e !== null)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.after?.slot ?? a.before?.slot ?? 0) - (b.after?.slot ?? b.before?.slot ?? 0));
}
