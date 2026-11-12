/**
 * Жетон «(ВИШ)»: только за группы ВИШ, без наследования по тёзкам, со снятием
 * в учебные недели и заморозкой на зачёты, сессию и каникулы.
 */
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/index.js";
import { Repo, type WebinarRow } from "../src/db/repo.js";
import { TeacherService, hasVishToken, teacherMapKey, vishTokenRevocable, webinarTeacherVish } from "../src/portal/teachers.js";
import { WebinarService } from "../src/portal/webinars.js";
import { hitLabel } from "../src/people/search.js";
import type { PortalClient } from "../src/portal/client.js";
import type { ScheduleService } from "../src/schedule/service.js";
import { todayMsk } from "../src/time.js";

const today = todayMsk();

function webinar(teacher: string, groups: string[]): WebinarRow {
  return { date: today, slot: 3, start: 700, end: 780, subject: "Математика", type: "лк", teacher, position: null, degree: null, subgroup: null, title: null, groups, scheduled: true };
}

/** Расписание с нужной неделей семестра: null — семестр не идёт или не откалиброван. */
function schedule(week: number | null): ScheduleService {
  return { semesterFor: () => 1, weekInfo: () => ({ week, parity: null, semester: 1 }) } as unknown as ScheduleService;
}

/** Портал, где у каждого преподавателя своя страница со списком групп. */
function portal(pages: Record<number, { name: string; groups: string[] }>): PortalClient {
  return {
    authenticated: true,
    getTeacherPage: async (id: number) => {
      const p = pages[id]!;
      return { days: p.groups.length ? [{ blocks: [{ lessons: [{ subject: "Математика", groups: p.groups }] }] }] : [], info: { name: p.name } };
    },
  } as unknown as PortalClient;
}

function seed(repo: Repo, people: Array<[number, string]>): void {
  for (const [id, name] of people) repo.seedTeacherMap(teacherMapKey(id, name), id, name);
}

describe("жетон «(ВИШ)»: когда его можно снимать", () => {
  it("только в учебные недели семестра (3–14)", () => {
    expect(vishTokenRevocable(schedule(2))).toBe(false);
    expect(vishTokenRevocable(schedule(3))).toBe(true);
    expect(vishTokenRevocable(schedule(14))).toBe(true);
    // Зачётные недели, сессия, каникулы, семестр не откалиброван — жетоны заморожены.
    expect(vishTokenRevocable(schedule(15))).toBe(false);
    expect(vishTokenRevocable(schedule(null))).toBe(false);
  });
});

describe("жетон «(ВИШ)» со страницы вебинаров", () => {
  it("только тем, у кого в вебинарах есть группа ВИШ", () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.replaceWebinars(today, [webinar("Петров К. А.", ["ИВТ-13-26"]), webinar("Иванова К. Ю.", ["ВИШ-12-24"])]);
    const svc = new WebinarService({} as PortalClient, repo, 32, () => true);
    svc.syncTeacherMap();
    expect(webinarTeacherVish(repo, "Петров К. А.", ["ИВТ-13-26"])).toBe(false);
    expect(webinarTeacherVish(repo, "Иванова К. Ю.", ["ВИШ-12-24"])).toBe(true);
    expect(hasVishToken(repo, null, "Иванова К. Ю.")).toBe(true);
    // Подпись в поиске: без жетона остаётся только «дистант».
    expect(hitLabel({ role: "teacher", name: "Петров К. А.", vish: false, webinarOnly: true })).toBe("👨‍🏫 Петров К. А. (дистант)");
    expect(hitLabel({ role: "teacher", name: "Иванова К. Ю.", vish: true, webinarOnly: true })).toBe("👨‍🏫 Иванова К. Ю. (ВИШ, дистант)");
  });

  it("вебинары с ВИШ кончились: в семестре жетон снимается, в сессию остаётся", () => {
    for (const [revocable, expected] of [[true, false], [false, true]] as const) {
      const repo = new Repo(openDatabase(":memory:"));
      repo.replaceWebinars(today, [webinar("Иванова К. Ю.", ["ВИШ-12-24"]), webinar("Сидоров П. П.", ["ВИШ-11-24"])]);
      const svc = new WebinarService({} as PortalClient, repo, 32, () => revocable);
      svc.syncTeacherMap();
      // Иванова теперь ведёт только у других, Сидоров пропал со страницы совсем.
      repo.replaceWebinars(today, [webinar("Иванова К. Ю.", ["ИВТ-13-26"])]);
      const again = new WebinarService({} as PortalClient, repo, 32, () => revocable);
      again.syncTeacherMap();
      expect(hasVishToken(repo, null, "Иванова К. Ю.")).toBe(expected);
      expect(hasVishToken(repo, null, "Сидоров П. П.")).toBe(expected);
    }
  });
});

describe("жетон «(ВИШ)» у человека из справочника", () => {
  it("за группу ВИШ на собственной странице; чужие группы жетона не дают", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    seed(repo, [[1, "Петров К. А."], [2, "Смирнова А. А."]]);
    const t = new TeacherService(portal({ 1: { name: "Петров Кирилл Алексеевич", groups: ["ИВТ-13-26"] }, 2: { name: "Смирнова Анна Андреевна", groups: ["ВИШ-12-24", "ИВТ-13-26"] } }), repo, schedule(11), 32);
    await t.refreshMapFor(1);
    await t.refreshMapFor(2);
    expect(t.isVish(1)).toBe(false);
    expect(t.isVish(2)).toBe(true);
    expect(repo.teacherMapById(2)!.groups).toEqual(["ВИШ-12-24"]);
    expect(repo.teacherMapById(2)!.vishSeenAt).toBeTruthy();
  });

  it("жетон с вебинаров не наследуют тёзки: ни полные, ни по инициалам", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.replaceWebinars(today, [webinar("Петров К. А.", ["ВИШ-12-24"])]);
    new WebinarService({} as PortalClient, repo, 32).syncTeacherMap();
    // Два полных тёзки и ещё один с теми же инициалами: кто из них ведёт вебинар, неизвестно.
    seed(repo, [[1, "Петров Кирилл Алексеевич"], [2, "Петров Кирилл Алексеевич"], [3, "Петров Константин Андреевич"]]);
    const pages = { 1: { name: "Петров Кирилл Алексеевич", groups: [] }, 2: { name: "Петров Кирилл Алексеевич", groups: ["ИВТ-13-26"] }, 3: { name: "Петров Константин Андреевич", groups: [] } };
    const t = new TeacherService(portal(pages), repo, schedule(11), 32);
    for (const id of [1, 2, 3]) await t.refreshMapFor(id);
    expect([1, 2, 3].map((id) => t.isVish(id))).toEqual([false, false, false]);
    // И до обхода, пока строки по id нет, жетон по имени не показывается.
    expect(hasVishToken(repo, 99, "Петров Кирилл Алексеевич")).toBe(false);
  });

  it("имя в справочнике однозначно — жетон с вебинаров переходит", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.replaceWebinars(today, [webinar("Иванова К. Ю.", ["ВИШ-12-24"])]);
    new WebinarService({} as PortalClient, repo, 32).syncTeacherMap();
    seed(repo, [[5, "Иванова Ксения Юрьевна"], [6, "Иванова Клара Борисовна"]]);
    const t = new TeacherService(portal({ 5: { name: "Иванова Ксения Юрьевна", groups: [] }, 6: { name: "Иванова Клара Борисовна", groups: [] } }), repo, schedule(11), 32);
    await t.refreshMapFor(5);
    await t.refreshMapFor(6);
    expect(t.isVish(5)).toBe(true);
    expect(t.isVish(6)).toBe(false);
  });

  it("старый жетон без пар ВИШ: в семестре снимается, в сессию и каникулы держится", async () => {
    for (const [week, expected] of [[11, false], [16, true], [null, true]] as const) {
      const repo = new Repo(openDatabase(":memory:"));
      repo.markTeacherVish(teacherMapKey(1, "Петров Кирилл Алексеевич"), 1, "Петров Кирилл Алексеевич", ["ВИШ-12-24"]);
      const t = new TeacherService(portal({ 1: { name: "Петров Кирилл Алексеевич", groups: [] } }), repo, schedule(week), 32);
      await t.refreshMapFor(1);
      expect(t.isVish(1)).toBe(expected);
      // Замороженный жетон помнит свои группы: карточка не пустеет на сессию.
      expect(repo.teacherMapById(1)!.groups).toEqual(expected ? ["ВИШ-12-24"] : []);
    }
  });

  it("миграция ставит уже помеченных в начало очереди обхода", () => {
    const repo = new Repo(openDatabase(":memory:"));
    seed(repo, [[1, "Петров К. А."]]);
    expect(repo.teacherMapStale(10)).toEqual([1]);
    expect(repo.teacherMapById(1)!.vishSeenAt).toBeNull();
  });
});
