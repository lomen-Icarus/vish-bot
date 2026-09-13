import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseGroupButtons } from "chuvsu-js/parsers";
import { buildLogicalGroups, type LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import { commonLessons, formatCommonLessons, formatStreamDay, mergeStream, shortGroupLabel } from "../src/schedule/stream.js";
import { topicsForText } from "../src/bot/handlers/news.js";

const fx = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");

const g = (title: string, intake: number): LogicalGroup => ({ key: title.toLowerCase(), title, prefix: "ВИШ", number: Number(title.split("-")[1]), intake, course: 4, portalIds: [1], portalNames: [title] });
const lesson = (groupKey: string, date: string, slot: number, subject: string, room: string, extra: Partial<Occurrence> = {}): Occurrence => ({
  groupKey,
  period: 1,
  date,
  slot,
  start: 8 * 60 + 20 + (slot - 1) * 90,
  end: 9 * 60 + 40 + (slot - 1) * 90,
  subject,
  type: "лк",
  room,
  teacher: null,
  subgroup: null,
  isDistance: false,
  status: "scheduled",
  sources: [],
  ...extra,
});

describe("hidden groups", () => {
  it("part-time ОЗВИШ groups can be filtered out, leaving 4 courses × 5 groups", () => {
    const groups = buildLogicalGroups(parseGroupButtons(fx("fac32.html")), 2026).filter((x) => x.prefix !== "ОЗВИШ");
    expect(groups.length).toBe(20);
    for (const course of [1, 2, 3, 4]) expect(groups.filter((x) => x.course === course).length).toBe(5);
    expect(shortGroupLabel(groups.find((x) => x.title.includes("ЭиЭА"))!)).toBe("11-23 ЭиЭА");
  });
});

describe("stream merge", () => {
  const a = g("ВИШ-12-23", 23);
  const b = g("ВИШ-13-23", 23);
  const c = g("ВИШ-14-23", 23);
  const byGroup = new Map<string, Occurrence[]>([
    [a.key, [lesson(a.key, "2026-09-14", 1, "Физика", "Г-301"), lesson(a.key, "2026-09-14", 2, "Матанализ", "Т-101")]],
    [b.key, [lesson(b.key, "2026-09-14", 1, "Физика", "Г-301"), lesson(b.key, "2026-09-14", 2, "Химия", "Т-102")]],
    [c.key, [lesson(c.key, "2026-09-14", 1, "Физика", "Г-301")]],
  ]);

  it("collapses identical lessons across groups into one row", () => {
    const rows = mergeStream([a, b, c], byGroup);
    expect(rows.length).toBe(3);
    const physics = rows.find((r) => r.subject === "Физика")!;
    expect(physics.groups).toEqual(["12-23", "13-23", "14-23"]);
    expect(rows.find((r) => r.subject === "Матанализ")!.groups).toEqual(["12-23"]);
  });

  it("finds common lessons of the own group and renders both views", () => {
    const rows = mergeStream([a, b, c], byGroup);
    expect(commonLessons(rows, a.key).map((r) => r.subject)).toEqual(["Физика"]);
    expect(commonLessons(rows, null).length).toBe(1);
    const day = formatStreamDay(23, "2026-09-14", rows, { week: 3, parity: "odd", semester: 1 }, "2026-09-14", a.key);
    expect(day).toContain("Поток 2023");
    expect(day).toContain("<b>12-23</b>, 13-23, 14-23");
    expect(day).toContain("★");
    const common = formatCommonLessons(23, "2026-09-14", rows, a);
    expect(common).toContain("вместе с: 13-23, 14-23");
  });
});

describe("news routing", () => {
  it("maps hashtags to topics", () => {
    expect(topicsForText("Открыт набор на #хакатон и #стипендия")).toEqual(["contests"]);
    expect(topicsForText("#Срочно завтра дистант")).toEqual(["announcements"]);
    expect(topicsForText("Тайный #Санта стартует #событие")).toEqual(["events"]);
    expect(topicsForText("#всем важное")).toBe("all");
    expect(topicsForText("просто текст")).toEqual([]);
  });
});
