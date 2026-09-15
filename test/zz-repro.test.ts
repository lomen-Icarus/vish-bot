import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { Notifier } from "../src/notify/dispatcher.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import type { WallClock } from "../src/time.js";

const group: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [8524], portalNames: ["ВИШ-12-23"] };
function lesson(date: string, slot: number, start: number, subject: string, extra: Partial<Occurrence> = {}): Occurrence {
  return { groupKey: group.key, period: 1, date, slot, start, end: start + 80, subject, type: "лк", room: "Т-310", teacher: null, subgroup: null, isDistance: false, status: "scheduled", sources: ["ВИШ-12-23"], ...extra };
}
const svc = { group: (k: string) => (k === group.key ? group : null), groups: () => [group], lessonsOn: () => [], materialize: () => [], weekInfo: () => ({ week: 3, parity: "odd", semester: 1 }), semesterFor: () => 1, weekOneMonday: () => "2026-09-01", lastPollRun: () => null } as unknown as ScheduleService;
const clock = (date: string, hh: number, mm: number): WallClock => ({ date, minutes: hh * 60 + mm, weekday: 1, ms: 0 });

describe("repro", () => {
  it("40 events", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(1, "q", "Q");
    repo.updateUser(1, { groupKey: group.key, notifyChanges: true, quietFrom: "22:00", quietTo: "08:00" });
    const sent: string[] = [];
    const api = { sendMessage: async (_c: number, t: string) => { sent.push(t); return {} as never; }, sendPhoto: async () => ({}) as never } as never;
    const n = new Notifier(api, repo, svc, null);
    expect(await n.flushQuietBacklog(clock("2026-09-15", 9, 0))).toBe(0); // watermark
    const evs = [];
    for (let i = 0; i < 40; i++) {
      const d = `2026-12-${String(1 + Math.floor(i / 8)).padStart(2, "0")}`;
      evs.push({ groupKey: group.key, date: d, period: 1 as const, kind: "removed", payload: { before: lesson(d, (i % 8) + 1, 8 * 60 + 20 + i * 5, `S${i}`) } });
    }
    repo.insertChangeEvents(evs as never);
    expect(await n.dispatchChangeEvents(clock("2026-09-15", 23, 0))).toBe(0);
    let total = 0;
    for (let day = 16; day <= 30; day++) {
      total += await n.flushQuietBacklog(clock(`2026-09-${day}`, 9, 0));
    }
    const all = sent.join("\n");
    const missing = [];
    for (let i = 0; i < 40; i++) if (!new RegExp(`S${i}\\b`).test(all)) missing.push(`S${i}`);
    console.log("messages:", sent.length, "missing:", missing.join(","));

    expect(missing).toEqual([]);
  });
});
