import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { PortalClient, type GroupPage } from "../src/portal/client.js";
import { EMPTY_PAGE_CONFIRMATIONS, ScheduleService } from "../src/schedule/service.js";
import { addDays, todayMsk } from "../src/time.js";

describe("пустая, но настоящая страница портала", () => {
  it("придерживается, пока не повторится EMPTY_PAGE_CONFIRMATIONS опросов подряд; исправная сбрасывает счёт", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const html = readFileSync("test/fixtures/group-8524-p1.html", "utf8");
    const client = new PortalClient({});
    Object.assign(client.http, {
      clearCookies: () => undefined,
      post: async (url: string) => ({ status: 302, body: "", url }),
      postFollow: async (url: string) => ({ status: 200, body: html, url }),
      getFollow: async (url: string) => ({ status: 200, body: html, url }),
    });
    const real = await client.getGroupPage(8524, 1);
    const empty: GroupPage = { ...real, days: [], htmlHash: "empty", contentHash: "empty" };
    let page = real;
    const portal = {
      authenticated: false,
      getFacultyGroups: async () => [{ id: 8524, name: "ВИШ-12-23" }],
      getGroupPage: async (_id: number, period: number) => {
        if (period !== 1) throw new Error("only period 1 in this test");
        return page;
      },
    };
    const svc = new ScheduleService(repo, portal as never, { facultyId: 32, hiddenPrefixes: [] });
    const today = todayMsk();
    const count = () => repo.occurrences("виш-12-23", today, addDays(today, 14)).filter((o) => o.status === "scheduled").length;
    await svc.poll();
    const before = count();
    expect(before).toBeGreaterThan(0);

    page = empty;
    for (let i = 1; i < EMPTY_PAGE_CONFIRMATIONS; i++) {
      const r = await svc.poll({ force: true });
      expect(r).toMatchObject({ pagesHeld: 1, emptyAccepted: [], events: [] });
      expect(count()).toBe(before);
    }
    // Исправная страница между пустыми — счёт сначала.
    page = real;
    expect((await svc.poll({ force: true })).pagesHeld).toBe(0);
    page = empty;
    expect((await svc.poll({ force: true })).pagesHeld).toBe(1);
    expect(count()).toBe(before);

    for (let i = 2; i < EMPTY_PAGE_CONFIRMATIONS; i++) await svc.poll({ force: true });
    const accepted = await svc.poll({ force: true });
    expect(accepted.pagesHeld).toBe(0);
    expect(accepted.emptyAccepted).toEqual(["виш-12-23"]);
    expect(accepted.events.length).toBeGreaterThan(0);
    expect(count()).toBe(0);

    // Пустую уже приняли — дальше она обычная, без новых предупреждений.
    expect((await svc.poll({ force: true })).emptyAccepted).toEqual([]);
    // Расписание вернулось — принимается сразу.
    page = real;
    const back = await svc.poll({ force: true });
    expect(back.pagesHeld).toBe(0);
    expect(count()).toBe(before);
  });
});
