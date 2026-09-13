import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { Notifier } from "../src/notify/dispatcher.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import type { WallClock } from "../src/time.js";

const group: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [8524], portalNames: ["ВИШ-12-23"] };

function lesson(date: string, slot: number, start: number, subject: string, subgroup: number | null = null): Occurrence {
  return { groupKey: group.key, period: 1, date, slot, start, end: start + 80, subject, type: "лк", room: "Т-310", teacher: null, subgroup, isDistance: false, status: "scheduled", sources: ["ВИШ-12-23"] };
}

function makeService(byDate: Record<string, Occurrence[]>): ScheduleService {
  return {
    group: (key: string) => (key === group.key ? group : null),
    groups: () => [group],
    lessonsOn: (_g: LogicalGroup, date: string) => byDate[date] ?? [],
    materialize: (_g: LogicalGroup, from: string, to: string) => Object.entries(byDate).flatMap(([d, l]) => (d >= from && d <= to ? l : [])),
    weekInfo: () => ({ week: 3, parity: "odd" as const, semester: 1 as const }),
  } as unknown as ScheduleService;
}

function makeApi() {
  const sent: Array<{ chatId: number; text: string }> = [];
  const api = {
    sendMessage: async (chatId: number, text: string) => {
      sent.push({ chatId, text });
      return {} as never;
    },
    sendPhoto: async () => ({}) as never,
  };
  return { api: api as never, sent };
}

const clock = (date: string, hh: number, mm: number): WallClock => ({ date, minutes: hh * 60 + mm, weekday: 1, ms: 0 });

describe("reminders", () => {
  it("sends the first-lesson reminder once, inside the window, respecting quiet hours", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(1, "u", "U");
    repo.updateUser(1, { groupKey: group.key, remindFirstMin: 120 });
    const service = makeService({ "2026-09-14": [lesson("2026-09-14", 3, 11 * 60 + 40, "Машиностроительное оборудование"), lesson("2026-09-14", 4, 13 * 60 + 30, "Технология")] });
    const { api, sent } = makeApi();
    const n = new Notifier(api, repo, service, null);

    expect(await n.tickReminders(clock("2026-09-14", 9, 0))).toBe(0); // too early (11:40 - 2h = 9:40)
    expect(await n.tickReminders(clock("2026-09-14", 9, 41))).toBe(1);
    expect(sent[0]!.text).toMatch(/Через 1 час 59 мин первая пара/);
    expect(sent[0]!.text).toMatch(/Машиностроительное/);
    expect(await n.tickReminders(clock("2026-09-14", 9, 42))).toBe(0); // already sent today
    expect(await n.tickReminders(clock("2026-09-14", 12, 0))).toBe(0); // lesson started

    repo.updateUser(1, { quietFrom: "22:00", quietTo: "10:00" });
    const repo2 = new Repo(openDatabase(":memory:"));
    repo2.touchUser(2, "q", "Q");
    repo2.updateUser(2, { groupKey: group.key, remindFirstMin: 120, quietFrom: "22:00", quietTo: "10:00" });
    const n2 = new Notifier(api, repo2, service, null);
    expect(await n2.tickReminders(clock("2026-09-14", 9, 45))).toBe(0); // quiet hours
    expect(await n2.tickReminders(clock("2026-09-14", 10, 5))).toBe(1); // quiet hours over, still before the lesson
  });

  it("sends per-lesson reminders filtered by subgroup and evening digests", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(1, "u", "U");
    repo.updateUser(1, { groupKey: group.key, subgroup: 2, remindEachMin: 15, eveningAt: "20:00" });
    const service = makeService({
      "2026-09-14": [lesson("2026-09-14", 1, 8 * 60 + 20, "Информатика", 1), lesson("2026-09-14", 1, 8 * 60 + 20, "Физика", 2)],
      "2026-09-15": [lesson("2026-09-15", 2, 9 * 60 + 50, "Патентоведение")],
    });
    const { api, sent } = makeApi();
    const n = new Notifier(api, repo, service, null);
    expect(await n.tickReminders(clock("2026-09-14", 8, 10))).toBe(1);
    expect(sent[0]!.text).toMatch(/Физика/);
    expect(sent[0]!.text).not.toMatch(/Информатика/);
    expect(await n.tickReminders(clock("2026-09-14", 8, 12))).toBe(0);
    expect(await n.tickReminders(clock("2026-09-14", 20, 3))).toBe(1);
    expect(sent[1]!.text).toMatch(/Завтра/);
    expect(sent[1]!.text).toMatch(/Патентоведение/);
    expect(await n.tickReminders(clock("2026-09-14", 20, 10))).toBe(0);
  });

  it("dispatches change events to subscribers of the group only", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(1, "a", "A");
    repo.updateUser(1, { groupKey: group.key, notifyChanges: true });
    repo.touchUser(2, "b", "B");
    repo.updateUser(2, { groupKey: "other", notifyChanges: true });
    repo.touchUser(3, "c", "C");
    repo.updateUser(3, { groupKey: group.key, notifyChanges: false });
    repo.touchUser(4, "d", "D");
    repo.updateUser(4, { groupKey: "other" });
    repo.toggleWatchGroup(4, group.key);
    const before = lesson("2026-09-16", 4, 13 * 60 + 30, "Промышленный менеджмент");
    const after = { ...before, room: "Т-204" };
    repo.insertChangeEvents([{ groupKey: group.key, date: "2026-09-16", period: 1, kind: "changed", payload: { before, after, fields: ["room"] } }]);
    const { api, sent } = makeApi();
    const n = new Notifier(api, repo, makeService({}), null);
    expect(await n.dispatchChangeEvents()).toBe(2);
    expect(sent.map((s) => s.chatId).sort()).toEqual([1, 4]);
    expect(sent[0]!.text).toMatch(/Т-310 → Т-204/);
    expect(await n.dispatchChangeEvents()).toBe(0);
  });
});
