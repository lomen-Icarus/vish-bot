import { describe, expect, it } from "vitest";
import { PortalClient, parseTeacherList } from "../src/portal/client.js";
import { TeacherService } from "../src/portal/teachers.js";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { HttpResponse } from "../src/portal/http.js";

const MAIN = `<html><body><button class="facbut" onClick="$('#hfac').val(32)">ВИШ</button></body></html>`;
const TECHBUT = `<button class="techbut" onClick="$('#htech').val(101);" value="Иванова Ирина Ивановна">Иванова И. И.</button>
<button class="techbut" onClick="$('#htech').val(102);" value="Петров  Пётр Петрович">Петров П. П.</button>`;

/** Портал-заглушка: адрес (и тело формы) → страница. Учётный вход — 302, если accountOk. */
function fakeClient(pages: Record<string, string>, opts: { accountOk?: boolean } = {}) {
  const client = new PortalClient({ credentials: { login: "u", password: "p" } });
  const calls: string[] = [];
  const res = (url: string, body: string): HttpResponse => ({ status: 200, body, url });
  Object.assign(client.http, {
    clearCookies: () => undefined,
    post: async (url: string, form: Record<string, string>) => {
      calls.push(`POST ${url.replace("https://tt.chuvsu.ru", "")} ${form.wname ? "account" : "guest"}`);
      const ok = form.wname ? (opts.accountOk ?? true) : true;
      return { status: ok ? 302 : 200, body: "", url };
    },
    getFollow: async (url: string) => {
      const path = url.replace("https://tt.chuvsu.ru", "");
      calls.push(`GET ${path}`);
      return res(url, pages[`GET ${path}`] ?? MAIN);
    },
    postFollow: async (url: string, form: Record<string, string>) => {
      const path = url.replace("https://tt.chuvsu.ru", "");
      calls.push(`POST ${path} hfac=${form.hfac ?? ""}`);
      return res(url, pages[`POST ${path} hfac=${form.hfac ?? ""}`] ?? MAIN);
    },
  });
  return { client, calls };
}

describe("справочник преподавателей: /index/techfac", () => {
  it("кнопки .techbut, name=\"tech…\" и ссылки на расписание преподавателя", () => {
    const html = `${TECHBUT}
      <button name="tech103" value="Сидорова Анна Сергеевна">С. А. С.</button>
      <a href="/index/techtt/tech/104">Кузнецов&nbsp;Кирилл <b>Андреевич</b></a>
      <a href="/index/techtt/tech/101">дубль Ивановой</a>`;
    expect(parseTeacherList(html)).toEqual([
      { id: 101, name: "Иванова Ирина Ивановна" },
      { id: 102, name: "Петров Пётр Петрович" },
      { id: 103, name: "Сидорова Анна Сергеевна" },
      { id: 104, name: "Кузнецов Кирилл Андреевич" },
    ]);
    expect(parseTeacherList(MAIN)).toEqual([]);
  });

  it("берёт список с /index/techfac и дальше не ходит", async () => {
    const { client, calls } = fakeClient({ "GET /index/techfac": TECHBUT });
    const list = await client.getAllTeachers(32);
    expect(list.map((t) => t.id)).toEqual([101, 102]);
    expect(client.directorySource).toBe("/index/techfac");
    expect(calls.filter((c) => c.includes("/index/tech"))).toEqual(["GET /index/techfac"]);
  });

  it("страница просит факультет — пробует её с факультетом бота", async () => {
    const { client } = fakeClient({ "POST /index/techfac hfac=32": TECHBUT });
    expect((await client.getAllTeachers(32)).length).toBe(2);
    expect(client.directorySource).toBe("/index/techfac (факультет 32)");
  });

  it("старый /index/tech остаётся запасным; пусто везде — понятная причина", async () => {
    const old = fakeClient({ "GET /index/tech": TECHBUT });
    expect((await old.client.getAllTeachers(32)).length).toBe(2);
    expect(old.client.directorySource).toBe("/index/tech");
    const none = fakeClient({});
    expect(await none.client.getAllTeachers(32)).toEqual([]);
    expect(none.client.directoryNote).toContain("/index/techfac: преподавателей нет (на странице выбор факультета)");
    expect(none.client.directoryNote).toContain("/index/tech: преподавателей нет");
  });
});

describe("проверка входа не путает «не вошла» и «пустой справочник»", () => {
  const service = {} as ScheduleService;

  it("учётка вошла, справочник есть", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const { client } = fakeClient({ "GET /index/techfac": TECHBUT });
    const t = new TeacherService(client, repo, service, 32);
    expect(await t.checkLogin()).toEqual({ ok: true });
    expect(t.loginOk()).toBe(true);
    expect(JSON.parse(repo.getMeta("teachers:list")!)).toHaveLength(2);
  });

  it("учётку не пустили — так и написано, а не «справочник пуст»", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const { client } = fakeClient({ "GET /index/techfac": TECHBUT }, { accountOk: false });
    const t = new TeacherService(client, repo, service, 32);
    const r = await t.checkLogin();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^учётка не вошла \(.*Account login failed: HTTP 200\) — бот ходит гостем$/);
    expect(t.loginOk()).toBe(false);
  });

  it("вошла, но справочник пуст — вход засчитан, причина — в странице", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const { client } = fakeClient({});
    const t = new TeacherService(client, repo, service, 32);
    const r = await t.checkLogin();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^справочник преподавателей пуст: \/index\/techfac/);
    expect(t.loginOk()).toBe(true);
  });
});
