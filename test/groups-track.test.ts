import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { buildLogicalGroups, logicalKeyFor, parseGroupName } from "../src/schedule/groups.js";
import { groupPicker } from "../src/bot/keyboards.js";
import { sameGroup } from "../src/portal/webinars.js";
import { PortalClient } from "../src/portal/client.js";
import { ScheduleService } from "../src/schedule/service.js";
import { addDays, todayMsk } from "../src/time.js";

describe("второй трек группы: «ВИШ-13-24иот (09.03.01)-2»", () => {
  it("это та же ВИШ-13-24; хвост «-2» у обычной группы — другая группа", () => {
    expect(parseGroupName("ВИШ-13-24иот (09.03.01)-2")).toEqual({ prefix: "ВИШ", number: 13, intake: 24, individualTrack: true, qualifier: null });
    expect(logicalKeyFor("ВИШ-13-24иот (09.03.01)-2")).toBe("виш-13-24");
    expect(logicalKeyFor("ВИШ-11-23 (ЭиЭА)-2")).not.toBe(logicalKeyFor("ВИШ-11-23 (ЭиЭА)"));
    expect(parseGroupName("ВИШ-11-23 (ЭиЭА)")?.qualifier).toBe("ЭиЭА");
    expect(sameGroup("ВИШ-13-24иот (09.03.01)-2", "ВИШ-13-24")).toBe(true);
    expect(sameGroup("ВИШ-13-24иот (09.03.01)-2", "ВИШ-14-24")).toBe(false);
  });

  it("список групп как на портале сейчас: без «(0 курс)», трек «-2» внутри ВИШ-13-24", () => {
    const portal = [
      { id: 8823, name: "ВИШ-13-24" },
      { id: 10547, name: "ВИШ-13-24иот (09.03.01)" },
      { id: 10551, name: "ВИШ-13-24иот (09.03.01)-2" },
      { id: 8524, name: "ВИШ-12-23" },
    ];
    const groups = buildLogicalGroups(portal, 2026);
    expect(groups.map((g) => g.title)).toEqual(["ВИШ-13-24", "ВИШ-12-23"]);
    expect(groups[0]!.portalIds).toEqual([8823, 10547, 10551]);
    const labels = groupPicker(groups).inline_keyboard.flat().map((b) => b.text);
    expect(labels).toEqual(["— 3 курс —", "13-24", "— 4 курс —", "12-23"]);
  });

  it("название совсем незнакомого вида — отдельная группа под своим именем, но в своём курсе", () => {
    const [g] = buildLogicalGroups([{ id: 1, name: "ВИШ-13-24 поток Б/2" }], 2026);
    expect(g).toMatchObject({ title: "ВИШ-13-24 поток Б/2", prefix: "ВИШ", number: 13, intake: 24, course: 3 });
    const [x] = buildLogicalGroups([{ id: 2, name: "Сборная группа" }], 2026);
    expect(x!.course).toBe(0);
    expect(groupPicker([x!]).inline_keyboard[0]![0]!.text).toBe("— Другие группы —");
  });

  it("сменился ключ группы — выбор людей переезжает; новый трек в группе — её ключ в ответе", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const oldKey = "виш-13-24иот (09.03.01)-2";
    expect(repo.upsertPortalGroups([{ id: 8823, name: "ВИШ-13-24", groupKey: "виш-13-24" }, { id: 10551, name: "ВИШ-13-24иот (09.03.01)-2", groupKey: oldKey }]).sort()).toEqual([oldKey, "виш-13-24"].sort());
    repo.touchUser(5, "s", "S");
    repo.updateUser(5, { groupKey: oldKey });
    repo.touchUser(6, "t", "T");
    repo.updateUser(6, { groupKey: "виш-12-23" });
    // Повтор без изменений — состав прежний.
    expect(repo.upsertPortalGroups([{ id: 8823, name: "ВИШ-13-24", groupKey: "виш-13-24" }, { id: 10551, name: "ВИШ-13-24иот (09.03.01)-2", groupKey: oldKey }])).toEqual([]);
    // Правило разбора поправили: та же страница — теперь ВИШ-13-24.
    const changed = repo.upsertPortalGroups([{ id: 8823, name: "ВИШ-13-24", groupKey: "виш-13-24" }, { id: 10551, name: "ВИШ-13-24иот (09.03.01)-2", groupKey: "виш-13-24" }]);
    expect(changed.sort()).toEqual([oldKey, "виш-13-24"].sort());
    expect(repo.getUser(5)!.groupKey).toBe("виш-13-24");
    expect(repo.getUser(6)!.groupKey).toBe("виш-12-23");
  });

  it("на портале появился новый трек группы — его пары не рассылаются как «изменения»", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    // Страница «трека» — с другими парами, чем у основной группы: без пересборки
    // молча сравнение объявило бы их все новыми.
    const pages: Record<string, string> = { "8524": readFileSync("test/fixtures/group-8524-p1.html", "utf8"), "10528": readFileSync("test/fixtures/group-8526-p1.html", "utf8") };
    const pageFor = (url: string) => pages[/\/gr\/(\d+)/.exec(url)?.[1] ?? "8524"] ?? pages["8524"]!;
    const client = new PortalClient({});
    Object.assign(client.http, {
      clearCookies: () => undefined,
      post: async (url: string) => ({ status: 302, body: "", url }),
      postFollow: async (url: string) => ({ status: 200, body: pageFor(url), url }),
      getFollow: async (url: string) => ({ status: 200, body: pageFor(url), url }),
    });
    let faculty = [{ id: 8524, name: "ВИШ-12-23" }];
    const portal = { authenticated: false, getFacultyGroups: async () => faculty, getGroupPage: (id: number, period: 1 | 2 | 3 | 4) => client.getGroupPage(id, period) };
    const svc = new ScheduleService(repo, portal as never, { facultyId: 32, hiddenPrefixes: [] });
    await svc.poll();
    const today = todayMsk();
    const before = repo.occurrences("виш-12-23", today, addDays(today, 14)).length;
    expect(before).toBeGreaterThan(0);

    faculty = [...faculty, { id: 10528, name: "ВИШ-12-23иот (11.03.04)" }];
    const joined = await svc.poll();
    expect(joined.events).toEqual([]);
    // Пары трека вошли в расписание группы, и следующее сравнение их не объявит.
    expect(repo.occurrences("виш-12-23", today, addDays(today, 14)).length).toBeGreaterThan(before);
    expect((await svc.poll({ force: true })).events).toEqual([]);
  });
});
