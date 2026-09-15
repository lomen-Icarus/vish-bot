import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseGroupButtons, parseGroupSchedule } from "chuvsu-js/parsers";
import { buildLogicalGroups, findGroup, logicalKeyFor, parseGroupName } from "../src/schedule/groups.js";
import { mergeVariants } from "../src/schedule/merge.js";
import { expandDays } from "../src/schedule/expand.js";
import { diffOccurrences } from "../src/schedule/diff.js";
import { parseBanner, parseWeekMarker } from "../src/portal/pageMeta.js";
import { formatChanges, formatDay } from "../src/schedule/format.js";
import { addDays, mondayOf, parseRuDate, weekdayOf } from "../src/time.js";

const fx = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");

describe("group naming", () => {
  it("parses portal names", () => {
    expect(parseGroupName("ВИШ-12-23иот (11.03.04)")).toEqual({ prefix: "ВИШ", number: 12, intake: 23, individualTrack: true, qualifier: null });
    expect(parseGroupName("ВИШ-11-23 (ЭиЭА)")).toEqual({ prefix: "ВИШ", number: 11, intake: 23, individualTrack: false, qualifier: "ЭиЭА" });
    expect(parseGroupName("ВИШ-11-23(РЗиАЭС)")?.qualifier).toBe("РЗиАЭС");
    expect(parseGroupName("ОЗВИШ-13-26")?.prefix).toBe("ОЗВИШ");
  });

  it("merges individual-track variants but keeps qualified groups apart", () => {
    expect(logicalKeyFor("ВИШ-12-23иот (11.03.04)")).toBe(logicalKeyFor("ВИШ-12-23"));
    expect(logicalKeyFor("ВИШ-13-23иот")).toBe(logicalKeyFor("ВИШ-13-23"));
    expect(logicalKeyFor("ВИШ-11-23 (ЭиЭА)")).not.toBe(logicalKeyFor("ВИШ-11-23(РЗиАЭС)"));
  });

  it("builds 23 logical groups from the live faculty page", () => {
    const portal = parseGroupButtons(fx("fac32.html"));
    expect(portal.length).toBe(26);
    const groups = buildLogicalGroups(portal, 2026);
    expect(groups.length).toBe(23);
    const g1223 = groups.find((g) => g.title === "ВИШ-12-23")!;
    expect([...g1223.portalIds].sort((a, b) => a - b)).toEqual([8524, 10521, 10528]);
    expect(g1223.course).toBe(4);
    expect(groups.find((g) => g.title === "ВИШ-11-26")!.course).toBe(1);
    expect(groups[0]!.title).toBe("ВИШ-11-26");
    expect(findGroup(groups, "12-23").map((g) => g.title)).toEqual(["ВИШ-12-23"]);
    expect(findGroup(groups, "виш 11 23").length).toBe(2);
  });
});

describe("page meta", () => {
  it("reads the week marker and banner", () => {
    const html = fx("group-8524-p1.html");
    expect(parseWeekMarker(html)).toEqual({ week: 2, parity: "even", semester: 1 });
    expect(parseBanner(html)).toMatch(/смешанном формате/);
  });
});

describe("merge + expand", () => {
  const anchor = "2026-08-31"; // week 1 contains 1 September 2026
  it("unions identical variants without duplicates", () => {
    const days = mergeVariants([
      { name: "ВИШ-12-23", days: parseGroupSchedule(fx("group-8524-p1.html")) },
      { name: "ВИШ-12-23иот (11.03.04)", days: parseGroupSchedule(fx("group-10528-p1.html")) },
    ]);
    const lessons = days.flatMap((d) => d.blocks.flatMap((b) => b.lessons));
    expect(lessons.length).toBe(36);
    expect(lessons.every((l) => l.sources.length === 2)).toBe(true);
  });

  it("keeps source hints for lessons present in one variant only", () => {
    const days = mergeVariants([
      { name: "ВИШ-13-23", days: parseGroupSchedule(fx("group-8526-p1.html")) },
      { name: "ВИШ-13-23иот", days: parseGroupSchedule(fx("group-10517-p1.html")) },
    ]);
    const lessons = days.flatMap((d) => d.blocks.flatMap((b) => b.lessons));
    expect(lessons.length).toBe(39);
    expect(lessons.filter((l) => l.sources.length === 1).length).toBe(7);
  });

  it("expands week ranges and parity into dates", () => {
    const days = mergeVariants([{ name: "ВИШ-12-23", days: parseGroupSchedule(fx("group-8524-p1.html")) }]);
    const occ = expandDays(days, { groupKey: "виш-12-23", period: 1, weekOneMonday: anchor, from: "2026-09-14", to: "2026-09-20" });
    const monday = occ.filter((o) => o.date === "2026-09-14");
    // Week 3 is odd: "Машиностроительное оборудование (лк) (2 - 16 нед.)" with * (odd) is present.
    expect(monday.some((o) => o.subject === "Машиностроительное оборудование" && o.slot === 3)).toBe(true);
    // "Цифровые оптические сенсоры" 2-2 even is not on week 3.
    expect(monday.some((o) => o.subject === "Цифровые оптические сенсоры" && o.slot === 3)).toBe(false);
    expect(occ.filter((o) => o.date === "2026-09-19").length).toBe(0); // Saturday is a self-study day
    expect(occ.every((o) => o.start != null && o.end != null)).toBe(true);
  });

  it("applies transfers: vacates the origin and places the lesson at the target", () => {
    const days = mergeVariants([{ name: "ВИШ-13-26", days: parseGroupSchedule(fx("group-10147-p1.html")) }]);
    const occ = expandDays(days, { groupKey: "виш-13-26", period: 1, weekOneMonday: anchor, from: "2026-09-07", to: "2026-10-04" });
    const target = occ.find((o) => o.date === "2026-09-30" && o.subject === "Основы российской государственности" && o.status === "scheduled");
    expect(target?.movedFrom).toEqual({ date: "2026-09-09", slot: 3 });
    expect(target?.slot).toBe(5);
    const origin = occ.find((o) => o.date === "2026-09-09" && o.subject === "Основы российской государственности");
    expect(origin?.status).toBe("moved");
    expect(origin?.movedTo).toEqual({ date: "2026-09-30", slot: 5 });
    const sat = occ.filter((o) => o.date === "2026-09-12" && o.subject === "Информатика");
    expect(sat.map((o) => o.subgroup).sort()).toEqual([1, 2]);
  });

  it("expands session rows by their own dates", () => {
    const days = mergeVariants([{ name: "ВИШ-11-26", days: parseGroupSchedule(fx("group-10145-p2.html")) }]);
    const occ = expandDays(days, { groupKey: "виш-11-26", period: 2, weekOneMonday: anchor, from: "2026-12-20", to: "2027-01-31" });
    expect(occ.length).toBe(12);
    expect(occ.find((o) => o.type === "экз" && o.subject === "Физика")?.date).toBe("2027-01-15");
    expect(occ[0]!.start).toBe(8 * 60 + 20);
  });
});

describe("diff", () => {
  const base = () => {
    const days = mergeVariants([{ name: "ВИШ-12-23", days: parseGroupSchedule(fx("group-8524-p1.html")) }]);
    return expandDays(days, { groupKey: "g", period: 1, weekOneMonday: "2026-08-31", from: "2026-09-14", to: "2026-09-27" });
  };
  const win = { from: "2026-09-14", to: "2026-09-27" };

  it("is silent when nothing changed", () => {
    expect(diffOccurrences(base(), base(), win)).toEqual([]);
  });

  it("detects room changes", () => {
    const next = base();
    const target = next.find((o) => o.date === "2026-09-14" && o.slot === 3)!;
    target.room = "Т-999";
    const ev = diffOccurrences(base(), next, win);
    expect(ev.length).toBe(1);
    expect(ev[0]!.kind).toBe("changed");
    expect(ev[0]!.fields).toEqual(["room"]);
    expect(formatChanges({ key: "g", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [1], portalNames: ["ВИШ-12-23"] }, ev)).toMatch(/Т-310 → Т-999/);
  });

  it("folds removed + added into a move", () => {
    const next = base();
    const idx = next.findIndex((o) => o.date === "2026-09-14" && o.slot === 4);
    const moved = { ...next[idx]!, date: "2026-09-16", slot: 6, start: 16 * 60 + 40, end: 18 * 60 };
    next.splice(idx, 1);
    next.push(moved);
    const ev = diffOccurrences(base(), next, win);
    expect(ev.map((e) => e.kind)).toEqual(["moved"]);
    expect(ev[0]!.before!.date).toBe("2026-09-14");
    expect(ev[0]!.after!.date).toBe("2026-09-16");
  });

  it("reports removals and additions", () => {
    const next = base();
    const removed = next.splice(0, 1)[0]!;
    next.push({ ...removed, date: "2026-09-25", subject: "Новая дисциплина", slot: 7, start: 18 * 60 + 10, end: 19 * 60 + 30 });
    const ev = diffOccurrences(base(), next, win);
    expect(ev.map((e) => e.kind).sort()).toEqual(["added", "removed"]);
  });
});

describe("time helpers", () => {
  it("handles dates", () => {
    expect(weekdayOf("2026-09-14")).toBe(1);
    expect(mondayOf("2026-09-13")).toBe("2026-09-07");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(parseRuDate("14.09", "2026-09-13")).toBe("2026-09-14");
    expect(parseRuDate("15.01", "2026-09-13")).toBe("2027-01-15");
    expect(parseRuDate("1.9.2026", "2026-09-13")).toBe("2026-09-01");
  });
});

describe("format", () => {
  it("renders a day", () => {
    const days = mergeVariants([{ name: "ВИШ-12-23", days: parseGroupSchedule(fx("group-8524-p1.html")) }]);
    const occ = expandDays(days, { groupKey: "g", period: 1, weekOneMonday: "2026-08-31", from: "2026-09-14", to: "2026-09-14" });
    const text = formatDay({ key: "g", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [1], portalNames: ["ВИШ-12-23"] }, "2026-09-14", occ, { week: 3, parity: "odd", semester: 1 }, "2026-09-13");
    expect(text).toContain("Завтра · Понедельник, 14 сентября");
    expect(text).toContain("НЕЧЁТНАЯ</b> · 3-я неделя");
    expect(text).toContain("3 пары");
  });
});
