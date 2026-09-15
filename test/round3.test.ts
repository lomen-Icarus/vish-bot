import { describe, expect, it, afterAll } from "vitest";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { Notifier } from "../src/notify/dispatcher.js";
import { teacherMatchScore } from "../src/portal/teachers.js";
import { changesCalendar, groupCalendar } from "../src/schedule/calendar.js";
import { clampHtml } from "../src/schedule/format.js";
import { createHttpServer } from "../src/http/server.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import type { ChangeEvent } from "../src/schedule/diff.js";
import type { WallClock } from "../src/time.js";
import type { Server } from "node:http";

const group: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [8524], portalNames: ["ВИШ-12-23"] };

function lesson(date: string, slot: number, start: number, subject: string, extra: Partial<Occurrence> = {}): Occurrence {
  return { groupKey: group.key, period: 1, date, slot, start, end: start + 80, subject, type: "лк", room: "Т-310", teacher: null, subgroup: null, isDistance: false, status: "scheduled", sources: ["ВИШ-12-23"], ...extra };
}

function makeService(byDate: Record<string, Occurrence[]>): ScheduleService {
  return {
    group: (key: string) => (key === group.key ? group : null),
    groups: () => [group],
    lessonsOn: (_g: LogicalGroup, date: string) => byDate[date] ?? [],
    materialize: (_g: LogicalGroup, from: string, to: string) => Object.entries(byDate).flatMap(([d, l]) => (d >= from && d <= to ? l : [])),
    weekInfo: () => ({ week: 3, parity: "odd" as const, semester: 1 as const }),
    semesterFor: () => 1 as const,
    weekOneMonday: () => "2026-09-01",
    lastPollRun: () => null,
  } as unknown as ScheduleService;
}

function makeApi() {
  const sent: Array<{ chatId: number; text: string; markup?: unknown }> = [];
  const api = {
    sendMessage: async (chatId: number, text: string, opts?: { reply_markup?: unknown }) => {
      sent.push({ chatId, text, markup: opts?.reply_markup });
      return {} as never;
    },
    sendPhoto: async () => ({}) as never,
  };
  return { api: api as never, sent };
}

const clock = (date: string, hh: number, mm: number): WallClock => ({ date, minutes: hh * 60 + mm, weekday: 1, ms: 0 });
const buttons = (markup: unknown): string[] => ((markup as { inline_keyboard?: Array<Array<{ text: string }>> })?.inline_keyboard ?? []).flat().map((b) => b.text);

describe("teacher search scoring", () => {
  it("matches surname, name-first order, initials and prefixes; rejects unrelated words", () => {
    expect(teacherMatchScore("Троишестова Д.А.", "троишестова")).toBeGreaterThan(0);
    expect(teacherMatchScore("Троишестова Д.А.", "Дарья Троишестова")).toBeGreaterThan(0);
    expect(teacherMatchScore("Троишестова Дарья Александровна", "троишестова дарья")).toBeGreaterThan(0);
    expect(teacherMatchScore("Троишестова Д.А.", "Троиш")).toBeGreaterThan(0);
    expect(teacherMatchScore("Троишестова Д.А.", "Троишестова Д.")).toBeGreaterThan(0);
    expect(teacherMatchScore("Иванов И.И.", "Дарья Троишестова")).toBe(0);
    expect(teacherMatchScore("Иванов И.И.", "Петров")).toBe(0);
    // An initial must never carry a match on its own: "Т." is not "Троишестова".
    expect(teacherMatchScore("Кожина Т. Н.", "Троишестова")).toBe(0);
    expect(teacherMatchScore("Иванова К. Ю.", "к ю")).toBe(0);
    expect(teacherMatchScore("Троишестова Дарья Александровна", "дарья")).toBeGreaterThan(0);
    // Exact surname beats a prefix hit on another entry.
    expect(teacherMatchScore("Иванов И.И.", "иванов")).toBeGreaterThan(teacherMatchScore("Иванова А.А.", "иванов"));
  });
});

describe("distance reminders and notification buttons", () => {
  it("pings before an online lesson with the webinar link, once", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(1, "u", "U");
    repo.updateUser(1, { groupKey: group.key, remindDistanceMin: 5 });
    const service = makeService({ "2026-09-14": [lesson("2026-09-14", 1, 8 * 60 + 20, "Информатика", { isDistance: true, room: null }), lesson("2026-09-14", 2, 9 * 60 + 50, "Физика")] });
    const { api, sent } = makeApi();
    const n = new Notifier(api, repo, service, null);
    expect(await n.tickReminders(clock("2026-09-14", 8, 10))).toBe(0);
    expect(await n.tickReminders(clock("2026-09-14", 8, 16))).toBe(1);
    expect(sent[0]!.text).toMatch(/дистант/);
    expect(sent[0]!.text).toContain("https://tt.chuvsu.ru/webinar");
    expect(buttons(sent[0]!.markup)).toContain("💻 Открыть вебинар");
    expect(await n.tickReminders(clock("2026-09-14", 8, 17))).toBe(0);
    expect(await n.tickReminders(clock("2026-09-14", 9, 46))).toBe(0); // Физика is offline
  });

  it("adds a calendar button for the own group and an unwatch button for watched groups", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(1, "a", "A");
    repo.updateUser(1, { groupKey: group.key, notifyChanges: true });
    repo.touchUser(4, "d", "D");
    repo.updateUser(4, { groupKey: "other" });
    repo.toggleWatchGroup(4, group.key);
    const before = lesson("2026-09-16", 4, 13 * 60 + 30, "Промышленный менеджмент");
    repo.insertChangeEvents([{ groupKey: group.key, date: "2026-09-16", period: 1, kind: "changed", payload: { before, after: { ...before, room: "Т-204" }, fields: ["room"] } }]);
    const { api, sent } = makeApi();
    const n = new Notifier(api, repo, makeService({}), null);
    expect(await n.dispatchChangeEvents()).toBe(2);
    const own = sent.find((s) => s.chatId === 1)!;
    const watcher = sent.find((s) => s.chatId === 4)!;
    expect(buttons(own.markup)).toEqual(["📆 Обновить в календаре"]);
    expect(buttons(watcher.markup)).toEqual(["👁 Не следить за группой"]);
    expect(repo.clearWatchGroups(4)).toBe(1);
    expect(repo.watchGroups(4)).toEqual([]);
  });
});

describe("quiet hours", () => {
  it("delivers changes after the quiet window instead of dropping them", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(1, "q", "Q");
    repo.updateUser(1, { groupKey: group.key, notifyChanges: true, quietFrom: "22:00", quietTo: "08:00" });
    const before = lesson("2026-09-16", 4, 13 * 60 + 30, "Промышленный менеджмент");
    repo.insertChangeEvents([{ groupKey: group.key, date: "2026-09-16", period: 1, kind: "changed", payload: { before, after: { ...before, room: "Т-204" }, fields: ["room"] } }]);
    const { api, sent } = makeApi();
    const n = new Notifier(api, repo, makeService({}), null);
    // First call only records the watermark, so nothing older is ever re-sent.
    expect(await n.flushQuietBacklog(clock("2026-09-15", 9, 0))).toBe(0);
    repo.insertChangeEvents([{ groupKey: group.key, date: "2026-09-17", period: 1, kind: "removed", payload: { before: lesson("2026-09-17", 2, 9 * 60 + 50, "Физика") } }]);

    // 23:00 is inside the quiet window: the push is skipped but not lost.
    const atNight = new Notifier(api, repo, makeService({}), null);
    expect(await atNight.dispatchChangeEvents(clock("2026-09-15", 23, 0))).toBe(0);
    expect(sent).toHaveLength(0);

    // Morning: the backlog arrives once, and only once.
    expect(await n.flushQuietBacklog(clock("2026-09-16", 9, 0))).toBe(1);
    expect(sent[0]!.text).toMatch(/тихие часы/);
    expect(sent[0]!.text).toMatch(/Физика/);
    expect(await n.flushQuietBacklog(clock("2026-09-16", 9, 1))).toBe(0);
  });

  it("does not resend what was already delivered normally", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(1, "a", "A");
    repo.updateUser(1, { groupKey: group.key, notifyChanges: true });
    const { api, sent } = makeApi();
    const n = new Notifier(api, repo, makeService({}), null);
    expect(await n.flushQuietBacklog(clock("2026-09-15", 9, 0))).toBe(0); // watermark
    const before = lesson("2026-09-16", 4, 13 * 60 + 30, "Промышленный менеджмент");
    repo.insertChangeEvents([{ groupKey: group.key, date: "2026-09-16", period: 1, kind: "changed", payload: { before, after: { ...before, room: "Т-204" }, fields: ["room"] } }]);
    expect(await n.dispatchChangeEvents()).toBe(1);
    expect(await n.flushQuietBacklog(clock("2026-09-15", 9, 5))).toBe(0);
    expect(sent).toHaveLength(1);
  });
});

describe("announcements board", () => {
  it("stores, lists active only, deletes early", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const id = repo.addAnnouncement("Завтра дистант", 5, 24);
    const old = repo.addAnnouncement("Старое", 5, -1); // already expired
    expect(repo.activeAnnouncements().map((a) => a.id)).toEqual([id]);
    expect(repo.deleteAnnouncement(id)).toBe(true);
    expect(repo.deleteAnnouncement(old)).toBe(true);
    expect(repo.activeAnnouncements()).toEqual([]);
  });

  it("keeps only future change events in the active list", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const l = lesson("2026-09-10", 1, 8 * 60 + 20, "Прошлое");
    repo.insertChangeEvents([
      { groupKey: group.key, date: "2026-09-10", period: 1, kind: "added", payload: { after: l } },
      { groupKey: group.key, date: "2026-09-20", period: 1, kind: "added", payload: { after: { ...l, date: "2026-09-20" } } },
    ]);
    expect(repo.activeEvents(group.key, "2026-09-15").map((e) => e.date)).toEqual(["2026-09-20"]);
  });
});

describe("long messages", () => {
  it("never cuts HTML mid-tag and closes what it opened", () => {
    const block = (i: number) => `<b>Пара ${i}</b>\n<i>ауд. Т-${i}</i> · <code>11:40</code>\n`;
    const long = Array.from({ length: 300 }, (_, i) => block(i)).join("");
    const out = clampHtml(long, 1000);
    expect(out.length).toBeLessThanOrEqual(1100);
    expect(out.lastIndexOf("<")).toBeLessThan(out.lastIndexOf(">"));
    const opens = [...out.matchAll(/<(b|i|code)>/g)].length;
    const closes = [...out.matchAll(/<\/(b|i|code)>/g)].length;
    expect(opens).toBe(closes);
    expect(clampHtml("<b>коротко</b>", 1000)).toBe("<b>коротко</b>");
    // A cut inside a tag is repaired rather than shipped.
    expect(clampHtml("<b>привет</b> и <i>пока</i>", 12)).not.toContain("<i");
  });
});

describe("calendar feeds", () => {
  it("keeps the newest version when a lesson changed twice", () => {
    const base = lesson("2026-09-16", 4, 13 * 60 + 30, "Промышленный менеджмент");
    const first: ChangeEvent = { kind: "changed", groupKey: group.key, date: "2026-09-16", period: 1, before: base, after: { ...base, room: "Т-204" }, fields: ["room"] };
    const second: ChangeEvent = { kind: "changed", groupKey: group.key, date: "2026-09-16", period: 1, before: { ...base, room: "Т-204" }, after: { ...base, room: "Т-300" }, fields: ["room"] };
    const { ics, live } = changesCalendar(group, [first, second], { subgroup: null, alarmMinutes: null, now: new Date("2026-09-15T10:00:00Z") });
    const flat = ics.replace(/\r\n[ \t]/g, "");
    expect(live).toBe(1);
    expect(flat.split("BEGIN:VEVENT").length - 1).toBe(1);
    expect(flat).toContain("LOCATION:ауд. Т-300\\, ЧувГУ");
    expect(flat).not.toContain("Т-204");
  });

  it("marks a lesson cancelled when the last event removed it", () => {
    const base = lesson("2026-09-16", 4, 13 * 60 + 30, "Промышленный менеджмент");
    const changed: ChangeEvent = { kind: "changed", groupKey: group.key, date: "2026-09-16", period: 1, before: base, after: { ...base, room: "Т-204" }, fields: ["room"] };
    const removed: ChangeEvent = { kind: "removed", groupKey: group.key, date: "2026-09-16", period: 1, before: { ...base, room: "Т-204" } };
    const { ics, live, cancelled } = changesCalendar(group, [changed, removed], { subgroup: null, alarmMinutes: null });
    expect(live).toBe(0);
    expect(cancelled).toBe(1);
    expect(ics.replace(/\r\n[ \t]/g, "")).toContain("STATUS:CANCELLED");
  });

  it("builds a changes-only file with live and cancelled events", () => {
    const before = lesson("2026-09-16", 4, 13 * 60 + 30, "Промышленный менеджмент");
    const moved: ChangeEvent = { kind: "moved", groupKey: group.key, date: "2026-09-16", period: 1, before, after: { ...before, date: "2026-09-18", movedFrom: { date: "2026-09-16", slot: 4 } } };
    const removed: ChangeEvent = { kind: "removed", groupKey: group.key, date: "2026-09-17", period: 1, before: lesson("2026-09-17", 2, 9 * 60 + 50, "Физика") };
    const changed: ChangeEvent = { kind: "changed", groupKey: group.key, date: "2026-09-19", period: 1, before: lesson("2026-09-19", 1, 8 * 60 + 20, "Химия"), after: lesson("2026-09-19", 1, 8 * 60 + 20, "Химия", { room: "Т-100" }), fields: ["room"] };
    const { ics, live, cancelled } = changesCalendar(group, [moved, removed, changed], { subgroup: null, alarmMinutes: 15, now: new Date("2026-09-15T10:00:00Z") });
    expect(live).toBe(2);
    expect(cancelled).toBe(2);
    const flat = ics.replace(/\r\n[ \t]/g, "");
    expect(flat.split("BEGIN:VEVENT").length - 1).toBe(4);
    expect(flat).toContain("SUMMARY:Отменено: Физика (лекция)");
    expect(flat).toContain("LOCATION:ауд. Т-100\\, ЧувГУ");
    expect(flat).toContain("DTSTART:20260918T103000Z");
  });

  let server: Server | null = null;
  afterAll(() => server?.close());

  it("serves a personal feed by token over http", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    repo.updateUser(7, { groupKey: group.key, calAlarmMin: 30 });
    const token = repo.ensureCalToken(7);
    expect(repo.ensureCalToken(7)).toBe(token);
    expect(repo.userByCalToken(token)?.id).toBe(7);
    const service = makeService({ "2026-09-16": [lesson("2026-09-16", 4, 13 * 60 + 30, "Промышленный менеджмент")] });
    const direct = groupCalendar(service, group, { subgroup: null, alarmMinutes: 30, today: "2026-09-15" });
    expect(direct.count).toBe(1);
    server = createHttpServer({ repo, service, port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const ok = await fetch(`http://127.0.0.1:${port}/cal/${token}.ics`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/calendar");
    const body = await ok.text();
    expect(body).toContain("X-WR-CALNAME:ВИШ-12-23");
    expect(body).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
    expect(body).toContain("TRIGGER:-PT30M");
    expect((await fetch(`http://127.0.0.1:${port}/cal/nope-nope-nope.ics`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/cal/${token}.ics`, { method: "POST" })).status).toBe(405);
  });
});
