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

  it("волна есть, а впереди пересдач нет — не спрашиваем и не отмечаем; появились — спросим", async () => {
    const { repo, svc, pages } = setup({ 8824: [], 10679: [] });
    await svc.pollPpa("2026-10-18");
    pages[8824] = [item({ date: "2026-10-01" })];
    await svc.pollPpa("2026-10-18");
    repo.touchUser(7, "a_u", "A");
    repo.updateUser(7, { groupKey: "виш-14-24" });
    const s = sender();
    expect(await tickPpaAsk(s, repo, svc, NOON)).toBe(0);
    expect(repo.ppaAskedWave(7, "виш-14-24")).toBeNull();
    // Появилась пересдача впереди (вопрос смотрит на настоящее «сегодня» — берём дальнюю дату;
    // волну держим той же, как если бы 2 ППА добавили в текущую).
    pages[8824] = [item({ date: "2026-10-01" }), item({ date: "2099-10-05", attempt: 2 })];
    repo.setMeta("ppa:seen:виш-14-24", "2099-осень");
    repo.setMeta("ppa:ask:виш-14-24", "2099-осень");
    await svc.pollPpa("2026-10-18");
    expect(await tickPpaAsk(s, repo, svc, NOON)).toBe(1);
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

import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { ppaHandlers } from "../src/bot/handlers/ppa.js";
import { hubHandlers } from "../src/bot/handlers/hub.js";
import { BTN, MORE_BTN } from "../src/bot/keyboards.js";
import type { BotContext } from "../src/bot/context.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
type Call = { method: string; payload: Record<string, unknown> };
let uid = 5000;
const msg = (text: string): Update => ({ update_id: uid, message: { message_id: uid++, date: 0, chat: { id: 7, type: "private", first_name: "U" }, from: { id: 7, is_bot: false, first_name: "U" }, text, ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}) } });
const tap = (data: string): Update => ({ update_id: uid++, callback_query: { id: "1", from: { id: 7, is_bot: false, first_name: "U" }, chat_instance: "1", data, message: { message_id: 3, date: 0, chat: { id: 7, type: "private", first_name: "U" }, text: "x" } as never } });

async function run(deps: Deps, update: Update, chain: Composer<BotContext>[] = [ppaHandlers]): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_p, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 9, date: 0, chat: { id: 7, type: "private" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  Object.assign(ctx, { deps, user: deps.repo.getUser(7)!, isAdmin: false });
  const all = new Composer<BotContext>();
  for (const c of chain) all.use(c);
  await all.middleware()(ctx, async () => undefined);
  return calls;
}

describe("экран «📋 ППА»", () => {
  async function ready(items: PpaItem[]) {
    const env = setup({ 8824: items, 10679: [] });
    await env.svc.pollPpa("2026-10-18");
    env.repo.touchUser(7, "a_u", "A");
    env.repo.updateUser(7, { groupKey: "виш-14-24" });
    const deps = { repo: env.repo, service: env.svc, webinars: null, config: { ADMIN_IDS: [], SLIDES_TOKEN: "" } } as unknown as Deps;
    return { ...env, deps };
  }
  const far = [item({ date: "2099-10-22" }), item({ subject: "Химия", kind: "зач", date: "2099-10-20", start: 500 })];
  const markup = (c: Call | undefined): string => JSON.stringify(c?.payload.reply_markup ?? null);

  it("/ppa — пересдачи впереди и кнопки предметов; отметка → ✅ и в расписании; «Готово» — итог", async () => {
    const { deps, repo } = await ready(far);
    const shown = (await run(deps, msg("/ppa"))).find((c) => c.method === "sendMessage")!;
    expect(String(shown.payload.text)).toContain("Пересдачи (ППА) · ВИШ-14-24");
    expect(String(shown.payload.text)).toContain("Химия");
    expect(markup(shown)).toContain(`ppa:t:${subjectKey("Философия")}`);
    expect(markup(shown)).toContain("ppa:none");
    const toggled = await run(deps, tap(`ppa:t:${subjectKey("Философия")}`));
    expect(repo.ppaDebts(7, "виш-14-24")).toEqual([subjectKey("Философия")]);
    const edit = toggled.find((c) => c.method === "editMessageText")!;
    expect(markup(edit)).toContain("✅ Философия");
    expect(markup(edit)).toContain("ppa:done");
    const done = (await run(deps, tap("ppa:done"))).find((c) => c.method === "editMessageText")!;
    expect(String(done.payload.text)).toContain("1 пересдача");
    expect(String(done.payload.text)).toContain("Философия");
  });

  it("«Долгов нет» снимает отметки; чужой ключ предмета — отказ", async () => {
    const { deps, repo } = await ready(far);
    repo.setPpaDebt(7, "виш-14-24", subjectKey("Химия"), true);
    await run(deps, tap("ppa:none"));
    expect(repo.ppaDebts(7, "виш-14-24")).toEqual([]);
    const bad = await run(deps, tap("ppa:t:nope"));
    expect(JSON.stringify(bad.find((c) => c.method === "answerCallbackQuery")!.payload)).toContain("уже нет");
    expect(repo.ppaDebts(7, "виш-14-24")).toEqual([]);
  });

  it("«🗂 Ещё»: кнопка ППА есть, пока пересдачи впереди", async () => {
    const withPpa = await ready(far);
    expect(markup((await run(withPpa.deps, msg(BTN.more), [hubHandlers])).find((c) => c.method === "sendMessage"))).toContain("more:ppa");
    const past = await ready([item({ date: "2026-10-01" })]);
    expect(markup((await run(past.deps, msg(BTN.more), [hubHandlers])).find((c) => c.method === "sendMessage"))).not.toContain("more:ppa");
    expect(MORE_BTN.ppa).toBe("📋 Пересдачи (ППА)");
  });
});

import { AskService } from "../src/ai/ask.js";
import { isPpaQuery } from "../src/bot/handlers/ppa.js";
import { freeTextSearch } from "../src/bot/handlers/misc.js";

describe("бот понимает вопросы про пересдачи", () => {
  it("«передсача», «ппа», «долги», «хвосты» — про пересдачи; «передачи данных» — нет", () => {
    for (const s of ["передсача рапсисание", "дай расписание передсачи долгов", "ППА", "когда пересдача по философии", "хвосты по матану"]) expect(isPpaQuery(s)).toBe(true);
    for (const s of ["Модели и методы передачи данных", "передача", "14-24", "ппап"]) expect(isPpaQuery(s)).toBe(false);
  });

  type Tool = { name: string; run: (i: unknown) => Promise<unknown>; parse: (i: unknown) => unknown };
  async function askTools() {
    const env = setup({ 8824: [item({ date: "2099-10-22" }), item({ subject: "Химия", kind: "зач", date: "2099-10-20", start: 500 }), item({ subject: "История", date: "2026-10-01" })], 10679: [] });
    await env.svc.pollPpa("2026-10-18");
    const ask = new AskService("sk-test", env.svc, { model: "m" });
    const g = env.svc.group("виш-14-24")!;
    const priv = (ask as unknown as { tools: (...a: unknown[]) => Tool[] }).tools(g, null, "", { teachers: [], webinarTeachers: [], groupKeys: [], students: [] }, 7, "private", new Set([subjectKey("Философия")]));
    const chat = ask.groupTools({ group: g, subgroup: null, userId: 7 }) as unknown as Tool[];
    return { priv, chat };
  }
  const call = async (tools: Tool[], input: object = {}) => {
    const t = tools.find((x) => x.name === "get_ppa")!;
    return String(await t.run(t.parse(input)));
  };

  it("ИИ в личке: get_ppa — пересдачи группы впереди и свой отмеченный долг", async () => {
    const { priv } = await askTools();
    const out = await call(priv);
    expect(out).toContain("Пересдачи (ППА) ВИШ-14-24 впереди");
    expect(out).toContain("Химия (зачёт) | 1 ППА | ауд. Г-303");
    expect(out).toMatch(/Философия \(экзамен\).*отмечен твой долг/);
    expect(out).not.toMatch(/Химия.*отмечен твой долг/);
    expect(out).toContain("Уже прошли в этой волне: 1");
    expect(out).toContain("/ppa");
  });

  it("болталка в чате: get_ppa есть, но чужих отметок не выдаёт", async () => {
    const { chat } = await askTools();
    const out = await call(chat);
    expect(out).toContain("Философия");
    expect(out).not.toContain("отмечен");
  });

  it("текст «передсача рапсисание» без режима ИИ — сразу экран ППА своей группы", async () => {
    const env = setup({ 8824: [item({ date: "2099-10-22" })], 10679: [] });
    await env.svc.pollPpa("2026-10-18");
    env.repo.touchUser(7, "a_u", "A");
    env.repo.updateUser(7, { groupKey: "виш-14-24" });
    const deps = { repo: env.repo, service: env.svc, webinars: null, ask: null, config: { POISK: false } } as unknown as Deps;
    const calls: Call[] = [];
    const api = new Api("123:FAKE");
    api.config.use(async (_p, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: { message_id: 9, date: 0, chat: { id: 7, type: "private" } } as never };
    });
    const ctx = new Context(msg("передсача рапсисание"), api, ME) as BotContext;
    Object.assign(ctx, { deps, user: env.repo.getUser(7)!, isAdmin: false });
    await freeTextSearch(ctx, "передсача рапсисание");
    expect(String(calls.find((c) => c.method === "sendMessage")!.payload.text)).toContain("Пересдачи (ППА) · ВИШ-14-24");
  });
});
