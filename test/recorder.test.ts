import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { looksLikeLoginPage, parseWebinarRows } from "../recorder/src/portal.js";
import { deckBaseName, keyOf, mskNow, planRecording, wanted, type RecordState } from "../recorder/src/plan.js";
import { envNumber } from "../recorder/src/config.js";
import type { WebinarRow } from "../recorder/src/portal.js";

const html = readFileSync(path.resolve("test/fixtures/webinar-fac32.html"), "utf8");
const login = readFileSync(path.resolve("test/fixtures/portal-login.html"), "utf8");

describe("записывалка вебинаров: разбор страницы", () => {
  it("берёт пару целиком: предмет, преподаватель, группы и время", () => {
    const rows = parseWebinarRows(html);
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    // Предмет должен быть предметом, а не всей ячейкой с ФИО и группами.
    expect(row.subject).toBe("Безопасность жизнедеятельности");
    expect(row.teacher).toContain("Иванова");
    expect(row.groups).toContain("ВИШ-11-24");
    expect(row.startMinutes).toBe(11 * 60 + 40);
    expect(row.endMinutes).toBe(13 * 60);
    expect(row.scheduled).toBe(true);
  });

  it("не записывает встречи вне расписания и пары без групп", () => {
    const row = parseWebinarRows(html)[0]!;
    expect(wanted(row, { subjects: [], groups: [] })).toBe(true);
    expect(wanted({ ...row, scheduled: false }, { subjects: [], groups: [] })).toBe(false);
    expect(wanted({ ...row, groups: [] }, { subjects: [], groups: [] })).toBe(false);
    // Фильтры по предмету и группе работают по части названия.
    expect(wanted(row, { subjects: ["безопасность"], groups: [] })).toBe(true);
    expect(wanted(row, { subjects: ["физика"], groups: [] })).toBe(false);
    expect(wanted(row, { subjects: [], groups: ["11-24"] })).toBe(true);
    expect(wanted(row, { subjects: [], groups: ["99-99"] })).toBe(false);
  });

  it("узнаёт форму входа, чтобы перелогиниться, а не считать, что пар нет", () => {
    expect(looksLikeLoginPage(login)).toBe(true);
    expect(looksLikeLoginPage(html)).toBe(false);
  });

  it("ключ пары различает разные пары и не зависит от регистра", () => {
    const row = parseWebinarRows(html)[0]!;
    expect(keyOf("2026-09-21", row)).toBe(keyOf("2026-09-21", { ...row, subject: row.subject.toUpperCase() }));
    expect(keyOf("2026-09-21", row)).not.toBe(keyOf("2026-09-21", { ...row, startMinutes: 600 }));
  });

  it("московское время считается от UTC, а не от часов машины", () => {
    const at = new Date("2026-09-21T21:30:00Z");
    expect(mskNow(at)).toEqual({ date: "2026-09-22", minutes: 30 });
  });
});

describe("записывалка вебинаров: планировщик", () => {
  const base = parseWebinarRows(html)[0]!;
  const row = (subject: string, start: number, end: number, extra: Partial<WebinarRow> = {}): WebinarRow => ({ ...base, subject, startMinutes: start, endMinutes: end, joinId: "j1", ...extra });
  const cfg = { subjects: [], groups: [], leadMinutes: 7, maxParallel: 2 };
  const fresh = (): RecordState => ({ done: new Set(), active: new Set(), retryAt: new Map() });
  const at = (minutes: number) => ({ date: "2026-09-21", minutes });

  it("пара в работе от «за leadMinutes до начала» до её конца, не дольше", () => {
    const r = row("Физика", 600, 690);
    expect(planRecording([r], at(590), cfg, fresh(), 0).start).toEqual([]);
    expect(planRecording([r], at(593), cfg, fresh(), 0).start).toEqual([r]);
    expect(planRecording([r], at(689), cfg, fresh(), 0).start).toEqual([r]);
    expect(planRecording([r], at(690), cfg, fresh(), 0).start).toEqual([]);
  });

  it("неудачная попытка повторяется, пока пара идёт, а не теряется после трёх осечек", () => {
    const r = row("Физика", 600, 690);
    const state = fresh();
    state.retryAt.set(keyOf("2026-09-21", r), 5_000);
    const early = planRecording([r], at(620), cfg, state, 4_999);
    expect(early.start).toEqual([]);
    expect(early.waiting).toEqual([r]);
    expect(planRecording([r], at(620), cfg, state, 5_000).start).toEqual([r]);
  });

  it("записанные и записываемые пары второй раз не берутся; без «Подключиться» — ждём", () => {
    const a = row("Физика", 600, 690);
    const b = row("Химия", 600, 690);
    const c = row("История", 600, 690, { joinId: "" });
    const state = fresh();
    state.done.add(keyOf("2026-09-21", a));
    state.active.add(keyOf("2026-09-21", b));
    const plan = planRecording([a, b, c], at(610), cfg, state, 0);
    expect(plan.start).toEqual([]);
    expect(plan.waiting).toEqual([c]);
  });

  it("параллельные пары пишутся одновременно, лишние ждут свободного места", () => {
    const rows = [row("Физика", 610, 700), row("Химия", 600, 690), row("История", 605, 695)];
    const plan = planRecording(rows, at(612), cfg, fresh(), 0);
    // Раньше начавшиеся — первыми.
    expect(plan.start.map((r) => r.subject)).toEqual(["Химия", "История"]);
    expect(plan.skipped.map((r) => r.subject)).toEqual(["Физика"]);
    const busy = fresh();
    busy.active.add("другая пара");
    expect(planRecording(rows, at(612), cfg, busy, 0).start.map((r) => r.subject)).toEqual(["Химия"]);
  });

  it("имя пачки: дата, время начала и предмет — две пары одного предмета в день не затирают друг друга", () => {
    expect(deckBaseName("2026-09-21", 9 * 60 + 5, "Физика")).toBe("2026-09-21-0905-Физика");
    expect(deckBaseName("2026-09-21", 13 * 60, "Физика")).not.toBe(deckBaseName("2026-09-21", 9 * 60 + 5, "Физика"));
    expect(deckBaseName("2026-09-21", null, "Мат/анализ: часть 1")).toBe("2026-09-21-xxxx-Матанализ-часть-1");
    expect(deckBaseName("2026-09-21", 600, "///")).toBe("2026-09-21-1000-вебинар");
  });

  it("пустое значение в .env — это «не задано», а не ноль", () => {
    expect(envNumber(undefined, 5)).toBe(5);
    expect(envNumber("", 5)).toBe(5);
    expect(envNumber("  ", 5)).toBe(5);
    expect(envNumber("abc", 5)).toBe(5);
    expect(envNumber("0", 5)).toBe(0);
    expect(envNumber("12", 5)).toBe(12);
  });
});
