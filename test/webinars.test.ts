import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseWebinars } from "chuvsu-js/parsers";
import { isLoginPage } from "../src/portal/pageMeta.js";
import { openDatabase } from "../src/db/index.js";
import { Repo, type WebinarRow } from "../src/db/repo.js";
import { WebinarService, webinarToRow } from "../src/portal/webinars.js";
import type { PortalClient } from "../src/portal/client.js";
import type { Occurrence } from "../src/schedule/model.js";
import { addDays, todayMsk } from "../src/time.js";

const today = todayMsk();

function row(over: Partial<WebinarRow> = {}): WebinarRow {
  return {
    date: today,
    slot: 3,
    start: 11 * 60 + 40,
    end: 13 * 60,
    subject: "Безопасность жизнедеятельности",
    type: "лк",
    teacher: "Иванова К. Ю.",
    position: "доц.",
    degree: "к.х.н.",
    subgroup: null,
    title: "2 Классификация чрезвычайных ситуаций",
    groups: ["ВИШ-11-24", "ВИШ-12-24", "ВИШ-13-24"],
    ...over,
  };
}

function lesson(over: Partial<Occurrence> = {}): Occurrence {
  return {
    groupKey: "виш-12-24",
    period: 1,
    date: today,
    slot: 3,
    start: 11 * 60 + 40,
    end: 13 * 60,
    subject: "Безопасность жизнедеятельности",
    type: "лк",
    room: null,
    teacher: null,
    subgroup: null,
    isDistance: true,
    status: "scheduled",
    sources: ["ВИШ-12-24"],
    ...over,
  };
}

function service(rows: WebinarRow[]): { svc: WebinarService; repo: Repo } {
  const repo = new Repo(openDatabase(":memory:"));
  const byDate = new Map<string, WebinarRow[]>();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  for (const [date, list] of byDate) repo.replaceWebinars(date, list);
  const portal = { getWebinars: async () => [] } as unknown as PortalClient;
  return { svc: new WebinarService(portal, repo, 32), repo };
}

describe("webinar rows", () => {
  it("maps a parsed webinar into a storable row", () => {
    const mapped = webinarToRow(
      {
        id: "",
        idType: 1,
        scheduled: true,
        scheduledDate: "2026-09-15",
        slotNumber: 3,
        time: { start: { hours: 11, minutes: 40 }, end: { hours: 13, minutes: 0 } },
        subject: " Безопасность жизнедеятельности ",
        type: "лк",
        teacher: { name: " Иванова К. Ю. ", position: "доц.", degree: "к.х.н." },
        groups: ["ВИШ-11-24", " ВИШ-12-24 "],
        title: " 2 Классификация ЧС ",
        raw: "",
      } as never,
      "2026-09-14",
    );
    expect(mapped).toMatchObject({ date: "2026-09-15", slot: 3, start: 700, end: 780, teacher: "Иванова К. Ю.", position: "доц.", degree: "к.х.н.", title: "2 Классификация ЧС" });
    expect(mapped.groups).toEqual(["ВИШ-11-24", "ВИШ-12-24"]);
  });

  it("replaces a day instead of duplicating it", () => {
    const { repo } = service([row(), row({ subject: "Другое", slot: 4 })]);
    expect(repo.webinarsBetween(today, today)).toHaveLength(2);
    repo.replaceWebinars(today, [row({ title: "Новая тема" })]);
    const stored = repo.webinarsBetween(today, today);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.title).toBe("Новая тема");
    expect(stored[0]!.groups).toEqual(["ВИШ-11-24", "ВИШ-12-24", "ВИШ-13-24"]);
  });
});

describe("webinar matching", () => {
  it("fills teacher and topic into online lessons of the right group only", () => {
    const { svc } = service([row()]);
    const lessons = [lesson(), lesson({ slot: 4, start: 13 * 60 + 30, subject: "Физика", isDistance: false, room: "Т-310" })];
    const enriched = svc.enrich(lessons, ["ВИШ-12-24"]);
    expect(enriched[0]!.teacher).toBe("Иванова К. Ю.");
    expect(enriched[0]!.topic).toBe("2 Классификация чрезвычайных ситуаций");
    expect(enriched[1]!.teacher).toBeNull();
    expect(enriched[1]!.topic).toBeUndefined();
    // A group that does not attend this webinar gets nothing.
    expect(svc.enrich(lessons, ["ВИШ-15-26"])[0]!.teacher).toBeNull();
  });

  it("treats the иот variant of a group as the same group", () => {
    const { svc } = service([row({ groups: ["ВИШ-12-23иот (ИОТ)"] })]);
    expect(svc.enrich([lesson()], ["ВИШ-12-23"])[0]!.teacher).toBe("Иванова К. Ю.");
  });

  it("does not match a different slot or subject", () => {
    const { svc } = service([row()]);
    expect(svc.enrich([lesson({ slot: 5 })], ["ВИШ-12-24"])[0]!.teacher).toBeNull();
    expect(svc.enrich([lesson({ subject: "Математика" })], ["ВИШ-12-24"])[0]!.teacher).toBeNull();
    expect(svc.forLesson(lesson({ slot: 3 }), ["ВИШ-12-24"])?.teacher).toBe("Иванова К. Ю.");
  });
});

describe("teachers from webinars", () => {
  it("aggregates subjects and groups per teacher and searches fuzzily", () => {
    const { svc } = service([
      row(),
      row({ date: addDays(today, 1), slot: 6, subject: "Правоведение", teacher: "Кожина Т. Н.", position: "доц.", degree: "к.и.н.", groups: ["ВИШ-11-25"], title: "Лекция 3" }),
      row({ date: addDays(today, 2), subject: "Безопасность жизнедеятельности", groups: ["ВИШ-14-24"], title: "3 Оповещение" }),
    ]);
    const all = svc.teachers();
    expect(all).toHaveLength(2);
    const ivanova = all.find((t) => t.name.startsWith("Иванова"))!;
    expect(ivanova.subjects).toEqual(["Безопасность жизнедеятельности"]);
    expect(ivanova.groups).toContain("ВИШ-14-24");
    expect(ivanova.position).toBe("доц.");
    expect(svc.search("иванова")[0]!.name).toBe("Иванова К. Ю.");
    expect(svc.search("Кожина Т.")[0]!.name).toBe("Кожина Т. Н.");
    expect(svc.search("Троишестова")).toEqual([]);
    expect(svc.upcoming(ivanova).map((l) => l.date)).toEqual([today, addDays(today, 2)]);
  });
});

describe("portal webinar page", () => {
  const fx = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");

  it("is not mistaken for the login page (its join dialog has the same inputs)", () => {
    const page = fx("webinar-fac32.html");
    expect(page).toContain('name="wname"'); // the join dialog
    expect(isLoginPage(page)).toBe(false);
    expect(isLoginPage(fx("portal-login.html"))).toBe(true);
  });

  it("yields teacher, groups and topic for an online lesson of ВИШ", () => {
    const list = parseWebinars(fx("webinar-fac32.html"));
    expect(list.length).toBeGreaterThan(0);
    const mapped = list.map((w) => webinarToRow(w, "2026-09-15"));
    const bzd = mapped.find((r) => r.subject.startsWith("Безопасность"))!;
    expect(bzd.teacher).toBe("Иванова К. Ю.");
    expect(bzd.position).toBe("доц.");
    expect(bzd.slot).toBe(3);
    expect(bzd.start).toBe(11 * 60 + 40);
    expect(bzd.groups).toContain("ВИШ-14-24");
    expect(bzd.title).toContain("Классификация");
  });
});
