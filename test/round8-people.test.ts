import { describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { WebinarService } from "../src/portal/webinars.js";
import type { PortalClient } from "../src/portal/client.js";
import { StudentDirectory } from "../src/students/directory.js";
import { peopleHandlers } from "../src/bot/people.js";
import { teacherHandlers } from "../src/bot/handlers/teachers.js";
import { poiskHandlers } from "../src/bot/handlers/poisk.js";
import { miscHandlers } from "../src/bot/handlers/misc.js";
import { soleExactPerson } from "../src/bot/handlers/ask.js";
import { BTN } from "../src/bot/keyboards.js";
import { webinarNameKey } from "../src/people/ref.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import { todayMsk } from "../src/time.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
const today = todayMsk();
const group: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [1], portalNames: ["ВИШ-12-23"] };

const lesson: Occurrence = { groupKey: group.key, period: 1, date: today, slot: 1, start: 0, end: 23 * 60 + 59, subject: "Физика", type: "лк", room: "Г-101", teacher: null, subgroup: null, isDistance: false, status: "scheduled", sources: [] };

function makeDeps(): Deps {
  const repo = new Repo(openDatabase(":memory:"));
  repo.touchUser(7, "u", "U");
  // Преподаватель дистанта: известен по странице вебинаров, пара идёт весь день.
  repo.replaceWebinars(today, [{ date: today, slot: 1, start: 0, end: 23 * 60 + 59, subject: "Программирование", type: "лб", teacher: "Петрова Анна Сергеевна", position: "доцент", degree: "к.т.н.", subgroup: null, title: "Циклы", groups: ["ВИШ-12-23"], scheduled: true }]);
  const dir = mkdtempSync(path.join(tmpdir(), "people-"));
  const file = path.join(dir, "students.csv");
  writeFileSync(file, "ФИО;Группа\nБеляев Иван Петрович;ВИШ-12-23\nПетров Олег Игоревич;ВИШ-12-23\n", "utf8");
  const service = {
    group: (k: string) => (k === group.key ? group : null),
    groups: () => [group],
    intakes: () => [23],
    stream: () => [group],
    lessonsOn: () => [lesson],
    materialize: () => [lesson],
    weekInfo: () => ({ week: 3, parity: "odd" as const, semester: 1 as const }),
    academicYear: 2026,
  } as unknown as ScheduleService;
  return {
    config: { ADMIN_IDS: [], MEDIA_CHAT_IDS: [], POISK: true, POISK_DAILY_LIMIT: 30, AI_DAILY_LIMIT_PER_USER: 10, AI_DAILY_LIMIT_GLOBAL: 300 } as unknown as Deps["config"],
    repo,
    service,
    renderer: null,
    ask: null,
    teachers: null,
    webinars: new WebinarService({} as PortalClient, repo, 32),
    students: new StudentDirectory(file),
    known: null,
    news: null,
    http: null,
    inline: true,
    botUsername: "vish_bot",
    pending: new Map(),
    startedAt: new Date(),
  };
}

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

async function run(update: Update, deps: Deps): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = deps;
  ctx.user = deps.repo.touchUser(7, "u", "U");
  ctx.isAdmin = false;
  const composer = new Composer<BotContext>();
  composer.use(miscHandlers, peopleHandlers, teacherHandlers, poiskHandlers);
  await composer.middleware()(ctx, async () => undefined);
  return calls;
}

const text = (t: string): Update => ({
  update_id: 1,
  message: { message_id: 10, date: 0, chat: { id: 7, type: "private", first_name: "U" }, from: { id: 7, is_bot: false, first_name: "U" }, text: t, ...(t.startsWith("/") ? { entities: [{ type: "bot_command" as const, offset: 0, length: t.split(" ")[0]!.length }] } : {}) },
});
const press = (data: string): Update => ({
  update_id: 2,
  callback_query: { id: "1", from: { id: 7, is_bot: false, first_name: "U" }, chat_instance: "1", data, message: { message_id: 11, date: 0, chat: { id: 7, type: "private", first_name: "U" }, text: "старое" } as never },
});

const card = (calls: Call[]): Call => calls.find((c) => (c.method === "sendMessage" || c.method === "editMessageText") && /👨‍🏫|🎓/.test(String(c.payload.text)))!;
const buttons = (c: Call): string[][] => ((c.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }).inline_keyboard ?? []).map((row) => row.map((b) => b.callback_data ?? ""));
const shape = (c: Call): string[][] => buttons(c).map((row) => row.map((d) => d.split(":")[0]!));

describe("одна карточка для преподавателя и студента", () => {
  it("у преподавателя тоже есть «где сейчас», как у студента", async () => {
    const deps = makeDeps();
    await run(text(BTN.teachers), deps);
    const teacher = card(await run(text("Петрова"), deps));
    expect(String(teacher.payload.text)).toContain("👨‍🏫 <b>Петрова Анна Сергеевна</b> (ВИШ)");
    expect(String(teacher.payload.text)).toContain("Преподаватель ВИШ");
    expect(String(teacher.payload.text)).toMatch(/📍 Сейчас \(\d\d:\d\d\) по расписанию: <b>Программирование<\/b>/);

    await run(text("/poisk"), deps);
    const student = card(await run(text("Беляев"), deps));
    expect(String(student.payload.text)).toContain("🎓 <b>Беляев Иван Петрович</b>");
    expect(String(student.payload.text)).toContain("Студент ВИШ · ВИШ-12-23");
    expect(String(student.payload.text)).toMatch(/📍 Сейчас \(\d\d:\d\d\) по расписанию: <b>Физика<\/b>/);
  });

  it("кнопки под карточкой устроены одинаково", async () => {
    const deps = makeDeps();
    await run(text(BTN.teachers), deps);
    const teacher = card(await run(text("Петрова"), deps));
    await run(text("/poisk"), deps);
    const student = card(await run(text("Беляев"), deps));
    // Стрелки по дням, затем «Неделя» и «Найти другого» — у обоих одни и те же.
    expect(shape(teacher).slice(0, 2)).toEqual([["pp", "pp"], ["ppw", "ppf"]]);
    expect(shape(student).slice(0, 2)).toEqual([["pp", "pp"], ["ppw", "ppf"]]);
    // Третья строка своя: у студента — вся его группа.
    expect(shape(student)[2]).toEqual(["pdn"]);
  });

  it("через ИИ-кнопку, старую кнопку и «Где студент» — одна и та же карточка", async () => {
    const deps = makeDeps();
    await run(text("/poisk"), deps);
    const viaButton = String(card(await run(text("Беляев"), deps)).payload.text);
    const sid = buttons(card(await run(text("/poisk"), deps).then(() => run(text("Беляев"), deps))))[0]![0]!.split(":")[1]!;
    const viaAi = String(card(await run(press(`ppo:${sid}`), deps)).payload.text);
    const viaOld = String(card(await run(press(`pop:${sid.slice(1)}`), deps)).payload.text);
    const strip = (s: string): string => s.replace(/\(\d\d:\d\d\)/, "");
    expect(strip(viaAi)).toBe(strip(viaButton));
    expect(strip(viaOld)).toBe(strip(viaButton));
    const teacherOld = String(card(await run(press(`wtc:${webinarNameKey("Петрова Анна Сергеевна")}`), deps)).payload.text);
    expect(teacherOld).toContain("👨‍🏫 <b>Петрова Анна Сергеевна</b>");
  });

  it("«🔍 Поиск» с одной фамилией сразу открывает карточку, без ИИ", async () => {
    const deps = makeDeps();
    const calls = await run(text("/search Беляев"), deps);
    expect(String(card(calls).payload.text)).toContain("🎓 <b>Беляев Иван Петрович</b>");
  });

  it("фамилия, под которую подходят и студент, и преподаватель, — выбор кнопками", async () => {
    const deps = makeDeps();
    const calls = await run(text("/search Петров"), deps);
    const all = JSON.stringify(calls);
    // «Петров» точно совпадает со студентом Петровым и с началом «Петровой»: спрашиваем.
    expect(all).toContain("ppo:s");
    expect(all).toContain("👨‍🏫");
    expect(all).toContain("🎓");
  });
});

describe("ИИ присылает карточку, только если человек один и найден точно", () => {
  it("один точный — карточка; похожие или несколько — нет", () => {
    expect(soleExactPerson({ teachers: [], webinarTeachers: [{ name: "Петрова Анна Сергеевна", exact: true }], groupKeys: [], students: [] })).toEqual({ kind: "webinar", key: webinarNameKey("Петрова Анна Сергеевна") });
    expect(soleExactPerson({ teachers: [], webinarTeachers: [], groupKeys: [], students: [{ id: "a", name: "A", groupTitle: "g", exact: false }] })).toBeNull();
    expect(soleExactPerson({ teachers: [{ id: 1, name: "Иванов И.И.", exact: true }], webinarTeachers: [], groupKeys: [], students: [{ id: "a", name: "A", groupTitle: "g", exact: true }] })).toBeNull();
    // Один и тот же человек из справочника и со страницы вебинаров — один.
    expect(soleExactPerson({ teachers: [{ id: 5, name: "Петрова А. С.", exact: true }], webinarTeachers: [{ name: "Петрова Анна Сергеевна", exact: true }], groupKeys: [], students: [] })).toEqual({ kind: "teacher", id: 5 });
  });
});

describe("inline: просто фамилия", () => {
  const user = { id: 7, groupKey: group.key, subgroup: null, teacherView: "bold" } as never;

  it("«Беляев завтра» — человек, а не ненайденная группа", async () => {
    const { parseInlineQuery } = await import("../src/bot/inline.js");
    const deps = makeDeps();
    const req = parseInlineQuery(deps, "Беляев завтра", user);
    expect(req.person).toEqual({ kind: "any", query: "Беляев" });
    expect(req.unknownGroup).toBe(false);
    expect(req.mode).toBe("day");
    // Цифры по-прежнему означают группу.
    expect(parseInlineQuery(deps, "99-99 завтра", user).unknownGroup).toBe(true);
  });

  it("показывает студента и преподавателя одной и той же карточкой", async () => {
    const { parseInlineQuery, buildPeopleResults } = await import("../src/bot/inline.js");
    const deps = makeDeps();
    const student = await buildPeopleResults(deps, parseInlineQuery(deps, "Беляев", user), user);
    const teacher = await buildPeopleResults(deps, parseInlineQuery(deps, "Петрова", user), user);
    const body = (r: { input_message_content: unknown }[]): string => (r[0]!.input_message_content as { message_text: string }).message_text;
    expect(body(student)).toContain("🎓 <b>Беляев Иван Петрович</b>");
    expect(body(student)).toContain("📍");
    expect(body(teacher)).toContain("👨‍🏫 <b>Петрова Анна Сергеевна</b> (ВИШ)");
    expect(body(teacher)).toContain("📍");
    // Студент в inline тоже записан в журнал «сыска».
    expect(deps.repo.poiskUsage(7, today)).toBe(1);
  });

  it("по трём буквам студентов не показывает", async () => {
    const { parseInlineQuery, buildPeopleResults } = await import("../src/bot/inline.js");
    const deps = makeDeps();
    const res = await buildPeopleResults(deps, parseInlineQuery(deps, "Бел", user), user);
    expect(JSON.stringify(res)).not.toContain("Беляев Иван");
    expect(deps.repo.poiskUsage(7, today)).toBe(0);
  });
});
