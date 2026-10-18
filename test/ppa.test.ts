/**
 * Пересдачи (ППА): разбор страницы портала, хранение, отметки долгов.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseGroupSchedule } from "chuvsu-js/parsers";
import { isPpaPage, parsePpaPage } from "../src/portal/ppa.js";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("страница ППА портала", () => {
  it("разбирает дату, время, аудиторию, предмет, форму и попытку — и совпадает с общим разборщиком портала", () => {
    const html = fixture("group-8824-ppa.html");
    expect(isPpaPage(html)).toBe(true);
    const items = parsePpaPage(html);
    expect(items).toHaveLength(13);
    expect(items[0]).toEqual({ date: "2026-10-01", start: 16 * 60 + 40, end: 18 * 60, room: "К-304", subject: "Элективные дисциплины (модули) по физической культуре и спорту", kind: "зач", attempt: 1, isDistance: false });
    expect(items.at(-1)).toMatchObject({ date: "2026-10-22", start: 15 * 60, subject: "Философия", kind: "Экз", room: "Г-303" });
    // Базы данных — дважды: курсовой проект и экзамен в разные дни.
    expect(items.filter((i) => i.subject === "Базы данных").map((i) => i.kind)).toEqual(["КП", "Экз"]);
    const theirs = parseGroupSchedule(html).flatMap((d) => d.blocks.flatMap((b) => b.lessons.map((l) => `${d.date}|${b.time.start.hours * 60 + b.time.start.minutes}|${l.subject}`)));
    expect(items.map((i) => `${i.date}|${i.start}|${i.subject}`)).toEqual(theirs);
  });

  it("пустая страница ППА — пусто; страница без отметки периода 11 — не ППА", () => {
    const empty = fixture("group-10145-ppa.html");
    expect(isPpaPage(empty)).toBe(true);
    expect(parsePpaPage(empty)).toEqual([]);
    expect(isPpaPage(fixture("group-8526-p1.html"))).toBe(false);
    expect(isPpaPage(fixture("portal-login.html"))).toBe(false);
  });

  it("две пересдачи в один день; «2 ППА»; дистанционная — как в обычной таблице портала", () => {
    const html = `<script>$("#pertype-"+"11").attr('checked','checked');</script><table id="groupstt"><tbody>
      <tr><td id="trd20270210" class="trfd trdata">10 Февраль 2027<br>Среда</td><td id="td20270210g1" class="trdata"><div id="tdd20270210g1" class="tdd"><table width="100%"><tr><td >В-317 <span style="color: blue;">Физика</span> (Экз) - <span class="red">2 ППА</span><br>08:20 - 09:40</td></tr><tr><td >Дистанционно <span style="color: blue;">Химия</span> (зач) - <span class="red">1 ППА</span><br>09:50 - 11:10 <span style="color: blue;"> (ДОТ)</span></td></tr></table></div></td></tr>
    </tbody></table>`;
    expect(parsePpaPage(html).map((i) => [i.subject, i.attempt, i.kind, i.room, i.isDistance, i.start])).toEqual([
      ["Физика", 2, "Экз", "В-317", false, 8 * 60 + 20],
      ["Химия", 1, "зач", "Дистанционно", true, 9 * 60 + 50],
    ]);
  });
});

describe("хранение и долги", () => {
  it("страница, отметки, должники по предмету; /soon стирает отметки", () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "student_u", "S");
    expect(repo.ppaPage(8824)).toBeNull();
    repo.savePpaPage(8824, "h1", parsePpaPage(fixture("group-8824-ppa.html")));
    expect(repo.ppaPage(8824)!.items).toHaveLength(13);
    repo.setPpaDebt(7, "виш-14-24", "k1", true);
    repo.setPpaDebt(7, "виш-14-24", "k1", true);
    repo.setPpaDebt(7, "виш-14-24", "k2", true);
    expect(repo.ppaDebts(7, "виш-14-24").sort()).toEqual(["k1", "k2"]);
    expect(repo.ppaDebtors("виш-14-24", "k1")).toEqual([7]);
    repo.setPpaDebt(7, "виш-14-24", "k2", false);
    expect(repo.ppaDebts(7, "виш-14-24")).toEqual(["k1"]);
    repo.markPpaAsked(7, "виш-14-24", "2026-осень");
    expect(repo.ppaAskedWave(7, "виш-14-24")).toBe("2026-осень");
    repo.forgetUser(7);
    expect(repo.ppaDebts(7, "виш-14-24")).toEqual([]);
    expect(repo.ppaAskedWave(7, "виш-14-24")).toBeNull();
  });
});

import { ScheduleService } from "../src/schedule/service.js";
import { diffPpa } from "../src/schedule/ppa.js";
import { subjectKey } from "../src/schedule/subjects.js";
import { dispatchPpaEvents, tickPpaAsk, type PpaSender } from "../src/notify/ppa.js";
import type { PpaItem } from "../src/portal/ppa.js";
import type { User } from "../src/db/repo.js";

const item = (over: Partial<PpaItem> = {}): PpaItem => ({ date: "2026-10-22", start: 900, end: 980, room: "Г-303", subject: "Философия", kind: "Экз", attempt: 1, isDistance: false, ...over });

/** Сервис с одной группой ВИШ-14-24 (две страницы: основная и «иот»), портал отдаёт pages[id]. */
function setup(pages: Record<number, PpaItem[] | Error>) {
  const repo = new Repo(openDatabase(":memory:"));
  repo.upsertPortalGroups([
    { id: 8824, name: "ВИШ-14-24", groupKey: "виш-14-24" },
    { id: 10679, name: "ВИШ-14-24иот", groupKey: "виш-14-24" },
  ]);
  const portal = {
    getPpaPage: async (id: number) => {
      const p = pages[id];
      if (p instanceof Error) throw p;
      return { items: p ?? [], htmlHash: JSON.stringify(p ?? []) };
    },
  };
  const svc = new ScheduleService(repo, portal as never, { facultyId: 32, hiddenPrefixes: [] });
  return { repo, svc, pages };
}

function sender(quiet = false): PpaSender & { sent: Array<{ to: number; text: string; kind: string }> } {
  const sent: Array<{ to: number; text: string; kind: string }> = [];
  return {
    sent,
    async send(user: User, html: string, opts: { kind: string }) {
      sent.push({ to: user.id, text: html, kind: opts.kind });
      return true;
    },
    inQuietHours: () => quiet,
  };
}

const NOON = { date: "2026-10-18", minutes: 12 * 60 } as never;

describe("опрос ППА", () => {
  it("первый опрос — тихо; потом перенос даёт событие; сбой страницы — не «отменили»", async () => {
    const { repo, svc, pages } = setup({ 8824: [item()], 10679: [] });
    expect(await svc.pollPpa("2026-10-18")).toMatchObject({ events: [], newWaves: [], fetched: 2, failed: 0 });
    expect(svc.ppaItems(svc.group("виш-14-24")!)).toHaveLength(1);
    pages[8824] = [item({ date: "2026-10-23", start: 810 })];
    const r = await svc.pollPpa("2026-10-18");
    expect(r.events).toEqual([expect.objectContaining({ change: "changed", subjectKey: subjectKey("Философия"), before: expect.objectContaining({ date: "2026-10-22" }), after: expect.objectContaining({ date: "2026-10-23" }) })]);
    pages[8824] = new Error("портал лёг");
    expect((await svc.pollPpa("2026-10-18")).events).toEqual([]);
    expect(svc.ppaItems(svc.group("виш-14-24")!)[0]!.date).toBe("2026-10-23");
    expect(repo.getMeta("ppa:ask:виш-14-24")).toBeNull();
  });

  it("новая волна (пусто → пересдачи): метка «спросить», старые отметки группы сброшены", async () => {
    const { repo, svc, pages } = setup({ 8824: [], 10679: [] });
    await svc.pollPpa("2027-01-20");
    repo.touchUser(7, "student_u", "S");
    repo.setPpaDebt(7, "виш-14-24", "old", true);
    pages[8824] = [item({ date: "2027-02-10" })];
    const r = await svc.pollPpa("2027-01-20");
    expect(r.newWaves).toEqual(["виш-14-24"]);
    expect(r.events).toEqual([]);
    expect(repo.getMeta("ppa:ask:виш-14-24")).toBe("2027-весна");
    expect(repo.ppaDebts(7, "виш-14-24")).toEqual([]);
  });

  it("diff: новая попытка, пропавшая будущая; прошедшие не шумят", () => {
    const past = item({ date: "2026-10-01", subject: "Химия" });
    const ev = diffPpa("g", [item(), past], [item(), item({ attempt: 2, date: "2026-11-05" })], "2026-10-18");
    expect(ev.map((e) => e.change)).toEqual(["added"]);
    expect(diffPpa("g", [item()], [], "2026-10-18").map((e) => e.change)).toEqual(["removed"]);
  });

  it("отмеченный предмет — как пара расписания; чужой — нет", async () => {
    const { svc } = setup({ 8824: [item(), item({ subject: "Химия", date: "2026-10-20", start: 500 })], 10679: [] });
    await svc.pollPpa("2026-10-18");
    const g = svc.group("виш-14-24")!;
    const lessons = svc.ppaLessons(g, [subjectKey("Философия")], "2026-10-18", "2026-10-31");
    expect(lessons).toEqual([expect.objectContaining({ date: "2026-10-22", subject: "Философия", type: "экз", ppa: 1, slot: null, start: 900, status: "scheduled" })]);
  });
});

describe("рассылка ППА", () => {
  it("весть о переносе — только отметившим этот предмет", async () => {
    const { repo } = setup({});
    repo.touchUser(7, "a_u", "A");
    repo.touchUser(8, "b_u", "B");
    repo.updateUser(7, { groupKey: "виш-14-24" });
    repo.updateUser(8, { groupKey: "виш-14-24" });
    repo.setPpaDebt(7, "виш-14-24", subjectKey("Философия"), true);
    const s = sender();
    const n = await dispatchPpaEvents(s, repo, diffPpa("виш-14-24", [item()], [item({ date: "2026-10-23" })], "2026-10-18"), NOON);
    expect(n).toBe(1);
    expect(s.sent.map((x) => x.to)).toEqual([7]);
    expect(s.sent[0]!.text).toContain("перенесена");
    expect(s.sent[0]!.text).toContain("23.10");
  });

  it("вопрос «Есть долги?» — раз за волну, днём, только тем, у кого уведомления включены", async () => {
    const { repo, svc, pages } = setup({ 8824: [], 10679: [] });
    await svc.pollPpa("2026-10-18");
    // Дата далеко впереди: вопрос смотрит на пересдачи от сегодняшнего дня.
    pages[8824] = [item({ date: "2099-10-22" })];
    await svc.pollPpa("2026-10-18");
    repo.touchUser(7, "a_u", "A");
    repo.touchUser(8, "b_u", "B");
    repo.updateUser(7, { groupKey: "виш-14-24" });
    repo.updateUser(8, { groupKey: "виш-14-24", notifyChanges: false, notifySession: false });
    const s = sender();
    expect(await tickPpaAsk(s, repo, svc, { date: "2026-10-18", minutes: 9 * 60 } as never)).toBe(0);
    expect(await tickPpaAsk(s, repo, svc, NOON)).toBe(1);
    expect(s.sent[0]).toMatchObject({ to: 7, kind: "ppa-ask" });
    expect(s.sent[0]!.text).toContain("Есть долги?");
    expect(await tickPpaAsk(s, repo, svc, NOON)).toBe(0);
  });
});

import { dayView, myPpa } from "../src/bot/views.js";
import { groupCalendar } from "../src/schedule/calendar.js";
import { Notifier } from "../src/notify/dispatcher.js";
import type { Deps } from "../src/bot/context.js";

describe("отмеченные пересдачи — в своём расписании", () => {
  async function ready() {
    const env = setup({ 8824: [item(), item({ subject: "Химия", date: "2026-10-22", start: 500, end: 580, kind: "зач" })], 10679: [] });
    await env.svc.pollPpa("2026-10-18");
    env.repo.touchUser(7, "a_u", "A");
    env.repo.updateUser(7, { groupKey: "виш-14-24" });
    env.repo.setPpaDebt(7, "виш-14-24", subjectKey("Философия"), true);
    const deps = { repo: env.repo, service: env.svc, webinars: null } as unknown as Deps;
    return { ...env, deps, g: env.svc.group("виш-14-24")! };
  }

  it("день: своя отмеченная — с пометкой «ППА»; чужой предмет и чужая группа — нет", async () => {
    const { deps, repo, g } = await ready();
    const me = repo.getUser(7)!;
    const { text } = dayView(deps, g, "2026-10-22", null, "bold", myPpa(deps, me, g, "2026-10-22", "2026-10-22"));
    expect(text).toContain("Философия");
    expect(text).toContain("экзамен · 1 ППА");
    expect(text).not.toContain("Химия");
    expect(myPpa(deps, { id: 7, groupKey: "виш-12-23" }, g, "2026-10-22", "2026-10-22")).toEqual([]);
    expect(myPpa(deps, { id: 8, groupKey: "виш-14-24" }, g, "2026-10-22", "2026-10-22")).toEqual([]);
  });

  it("календарь и напоминания берут отмеченную пересдачу", async () => {
    const { repo, svc, g } = await ready();
    const cal = groupCalendar(svc, g, { subgroup: null, alarmMinutes: null, today: "2026-10-18", ppaDebts: repo.ppaDebts(7, g.key) });
    expect(cal.ics).toContain("Философия (экзамен · 1 ППА)");
    expect(cal.ics).not.toContain("Химия");
    expect(groupCalendar(svc, g, { subgroup: null, alarmMinutes: null, today: "2026-10-18" }).ics).not.toContain("Философия");
    const notifier = new Notifier({} as never, repo, svc, null);
    const day = await (notifier as unknown as { ownDay: (u: unknown, d: string, c: Map<string, unknown>) => Promise<{ lessons: Array<{ subject: string }> }> }).ownDay(repo.getUser(7)!, "2026-10-22", new Map());
    expect(day.lessons.map((o) => o.subject)).toEqual(["Философия"]);
  });
});
