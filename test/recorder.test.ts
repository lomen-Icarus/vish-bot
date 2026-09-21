import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { looksLikeLoginPage, parseWebinarRows } from "../recorder/src/portal.js";
import { keyOf, mskNow, wanted } from "../recorder/src/plan.js";

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
