import { afterAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { createHttpServer } from "../src/http/server.js";
import { quorumSnapshot } from "../src/http/quorum.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";

const g = (prefix: string, n: number, intake: number, profile = ""): LogicalGroup => {
  const title = `${prefix}-${n}-${intake}${profile ? ` (${profile})` : ""}`;
  return { key: title.toLowerCase(), title, prefix, number: n, intake, course: 27 - intake, portalIds: [n], portalNames: [title] };
};
const GROUPS = [g("ВИШ", 11, 26), g("ВИШ", 12, 26), g("ВИШ", 11, 23, "РЗиАЭС"), g("ОЗВИШ", 11, 25)];

function seed(): Repo {
  const repo = new Repo(openDatabase(":memory:"));
  let id = 100;
  const add = (groupKey: string | null, patch: { blocked?: boolean; teacherMode?: boolean } = {}) => {
    const uid = id++;
    repo.touchUser(uid, null, null);
    repo.updateUser(uid, { groupKey, ...patch });
  };
  add("виш-11-26");
  add("виш-11-26");
  add("виш-11-26", { blocked: true }); // заблокировал бота — не в счёт
  add("виш-11-26", { teacherMode: true }); // преподаватель — не студент
  add("виш-11-23 (рзиаэс)");
  add("озвиш-11-25"); // заочная — на странице нет
  add(null); // группу не выбрал
  return repo;
}

describe("«Кворум»: студенты в боте по группам", () => {
  it("считает только студентов: без заблокировавших и без режима преподавателя", () => {
    const counts = seed().studentsPerGroup();
    expect(counts.get("виш-11-26")).toBe(2);
    expect(counts.get("виш-11-23 (рзиаэс)")).toBe(1);
    expect(counts.has("виш-12-26")).toBe(false);
  });

  it("снимок — только дневные группы ВИШ, без людей — с нулём, без имён и id", () => {
    const snap = quorumSnapshot(GROUPS, seed().studentsPerGroup(), new Date("2026-10-20T10:00:00Z"));
    expect(snap).toEqual({
      updatedAt: "2026-10-20T10:00:00.000Z",
      groups: [
        { title: "ВИШ-11-26", course: 1, users: 2 },
        { title: "ВИШ-12-26", course: 1, users: 0 },
        { title: "ВИШ-11-23 (РЗиАЭС)", course: 4, users: 1 },
      ],
    });
  });

  let server: Server | null = null;
  afterAll(() => server?.close());

  it("GET /quorum.json — открыто, JSON, кешируется на 30 секунд; HEAD без тела", async () => {
    const repo = seed();
    const service = { groups: () => GROUPS, group: (k: string) => GROUPS.find((x) => x.key === k) ?? null } as unknown as ScheduleService;
    server = createHttpServer({ repo, service, port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/quorum.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { groups: Array<{ title: string; users: number }> };
    expect(body.groups.find((x) => x.title === "ВИШ-11-26")?.users).toBe(2);
    expect(Object.keys(body.groups[0]!).sort()).toEqual(["course", "title", "users"]);

    // Новый человек появится не раньше, чем через 30 секунд кеша.
    repo.touchUser(999, null, null);
    repo.updateUser(999, { groupKey: "виш-12-26" });
    const again = (await (await fetch(`http://127.0.0.1:${port}/quorum.json`)).json()) as { groups: Array<{ title: string; users: number }> };
    expect(again.groups.find((x) => x.title === "ВИШ-12-26")?.users).toBe(0);

    const head = await fetch(`http://127.0.0.1:${port}/quorum.json`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});
