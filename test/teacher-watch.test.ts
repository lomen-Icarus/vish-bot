import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { Notifier } from "../src/notify/dispatcher.js";
import { todayMsk } from "../src/time.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { TeacherService } from "../src/portal/teachers.js";

const today = todayMsk();
const service = { group: () => null, weekInfo: () => ({ week: 3, parity: "odd" as const, semester: 1 as const }) } as unknown as ScheduleService;

function setup(n: number, eveningAt?: string) {
  const repo = new Repo(openDatabase(":memory:"));
  const calls: string[] = [];
  const teachers = {
    lessons: async (t: { id: number }, from: string) => {
      calls.push(`${t.id}|${from}`);
      return { lessons: [{ date: from, start: 8 * 60, end: 9 * 60 + 30, status: "scheduled", subject: "X", type: "лк", period: 1, groupKey: "t", slot: 1, room: null, teacher: null, subgroup: null, isDistance: false, sources: [] }], fullName: "Кто-то" };
    },
  } as unknown as TeacherService;
  for (let i = 1; i <= n; i++) {
    repo.touchUser(i, "u" + i, "U");
    if (eveningAt) repo.updateUser(i, { eveningAt });
    repo.toggleWatchTeacher(i, 100 + i, "Препод " + i);
  }
  const api = { sendMessage: async () => ({ message_id: 1 }) } as never;
  return { repo, calls, n: new Notifier(api, repo, service, null, [], null, teachers) };
}

const at = (minutes: number) => ({ date: today, minutes, weekday: 1, ms: Date.now() });

describe("tickTeacherWatches: холостая работа ночью", () => {
  it("в 00:00 на портал не ходит вовсе", async () => {
    const t = setup(40);
    await t.n.tickTeacherWatches(at(0));
    expect(t.calls.length).toBe(0);
  });

  it("в 06:00 берёт только бюджет тика, остальных — следующими тиками", async () => {
    const t = setup(40);
    await t.n.tickTeacherWatches(at(6 * 60));
    expect(t.calls.length).toBe(5);
    await t.n.tickTeacherWatches(at(6 * 60 + 1));
    expect(t.calls.length).toBe(10);
  });

  it("узкое вечернее окно не откладывается бюджетом", async () => {
    const t = setup(40, "20:00");
    const sent = await t.n.tickTeacherWatches(at(20 * 60));
    // по два похода на каждого: сегодня (для утреннего окна) + завтра
    expect(t.calls.length).toBe(80);
    expect(sent).toBe(40);
  });
});
