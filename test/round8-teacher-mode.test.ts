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
import { KnownPeople } from "../src/students/known.js";
import { teacherModeHandlers } from "../src/bot/teacherMode.js";
import { peopleHandlers } from "../src/bot/people.js";
import { scheduleHandlers } from "../src/bot/handlers/schedule.js";
import { calendarHandlers } from "../src/bot/handlers/calendar.js";
import { settingsHandlers } from "../src/bot/handlers/settings.js";
import { BTN } from "../src/bot/keyboards.js";
import { Notifier } from "../src/notify/dispatcher.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import { todayMsk, wallClock } from "../src/time.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
const today = todayMsk();
const group: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [1], portalNames: ["ВИШ-12-23"] };

function makeDeps(): Deps {
  const repo = new Repo(openDatabase(":memory:"));
  repo.replaceWebinars(today, [{ date: today, slot: 5, start: 15 * 60, end: 16 * 60 + 20, subject: "Программирование", type: "лб", teacher: "Петрова Анна Сергеевна", position: "доцент", degree: "к.т.н.", subgroup: null, title: "Циклы", groups: ["ВИШ-12-23"], scheduled: true }]);
  const dir = mkdtempSync(path.join(tmpdir(), "tmode-"));
  const reg = path.join(dir, "teachers.csv");
  writeFileSync(reg, "ФИО;Телеграм\nПетрова Анна Сергеевна;petrova_as\n", "utf8");
  const service = {
    group: (k: string) => (k === group.key ? group : null),
    groups: () => [group],
    intakes: () => [23],
    lessonsOn: () => [],
    materialize: () => [],
    weekInfo: () => ({ week: 3, parity: "odd" as const, semester: 1 as const }),
    semesterFor: () => 1 as const,
    weekOneMonday: () => "2026-09-01",
    academicYear: 2026,
  } as unknown as ScheduleService;
  return {
    config: { ADMIN_IDS: [99], MEDIA_CHAT_IDS: [], POISK: false, POISK_DAILY_LIMIT: 30, PUBLIC_URL: undefined } as unknown as Deps["config"],
    repo,
    service,
    renderer: null,
    ask: null,
    teachers: null,
    webinars: new WebinarService({} as PortalClient, repo, 32),
    students: null,
    known: null,
    teacherRegistry: new KnownPeople(reg),
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

async function run(update: Update, deps: Deps, opts: { userId?: number; username?: string; admin?: boolean } = {}): Promise<Call[]> {
  const userId = opts.userId ?? 7;
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: userId, type: "private" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = deps;
  ctx.user = deps.repo.touchUser(userId, opts.username ?? "u", "U");
  ctx.isAdmin = opts.admin ?? false;
  const composer = new Composer<BotContext>();
  composer.use(teacherModeHandlers, peopleHandlers, calendarHandlers, settingsHandlers, scheduleHandlers);
  await composer.middleware()(ctx, async () => undefined);
  return calls;
}

const text = (t: string, userId = 7): Update => ({
  update_id: 1,
  message: { message_id: 10, date: 0, chat: { id: userId, type: "private", first_name: "U" }, from: { id: userId, is_bot: false, first_name: "U" }, text: t, ...(t.startsWith("/") ? { entities: [{ type: "bot_command" as const, offset: 0, length: t.split(" ")[0]!.length }] } : {}) },
});
const press = (data: string, userId = 7): Update => ({
  update_id: 2,
  callback_query: { id: "1", from: { id: userId, is_bot: false, first_name: "U" }, chat_instance: "1", data, message: { message_id: 11, date: 0, chat: { id: userId, type: "private", first_name: "U" }, text: "старое" } as never },
});
const all = (calls: Call[]): string => calls.map((c) => String(c.payload.text ?? c.payload.caption ?? "")).join("\n");

describe("режим преподавателя", () => {
  it("не из реестра — режим не включается", async () => {
    const deps = makeDeps();
    const out = all(await run(text("/prepod"), deps, { username: "someone" }));
    expect(out).toMatch(/только для преподавателей из реестра/);
    expect(deps.repo.getUser(7)!.teacherMode).toBe(false);
  });

  it("преподаватель из реестра включает режим и видит своё расписание кнопками", async () => {
    const deps = makeDeps();
    const on = await run(text("/prepod"), deps, { username: "petrova_as" });
    expect(all(on)).toMatch(/Режим преподавателя/);
    const menu = JSON.stringify(on.map((c) => c.payload.reply_markup));
    expect(menu).toContain(BTN.students);
    expect(menu).not.toContain(BTN.otherGroups);
    const u = deps.repo.getUser(7)!;
    expect(u.teacherMode).toBe(true);
    expect(u.teacherName).toBe("Петрова Анна Сергеевна");

    const day = all(await run(text(BTN.today), deps, { username: "petrova_as" }));
    expect(day).toContain("👨‍🏫 <b>Петрова Анна Сергеевна</b>");
    expect(day).toContain("Программирование");
    expect(day).toContain("📍");

    // «Студенты» — то же, что «Др. группы»: расписание любой группы.
    const students = await run(text(BTN.students), deps, { username: "petrova_as" });
    expect(all(students)).toMatch(/Чьё расписание показать/);

    const week = all(await run(press(`w:${today}`), deps, { username: "petrova_as" }));
    expect(week).toContain("Неделя");
    expect(week).toContain("Программирование");

    const off = await run(text("/prepod"), deps, { username: "petrova_as" });
    expect(all(off)).toMatch(/выключен/);
    expect(deps.repo.getUser(7)!.teacherMode).toBe(false);
    expect(JSON.stringify(off.map((c) => c.payload.reply_markup))).toContain(BTN.otherGroups);
  });

  it("админ может проверить режим на любом преподавателе", async () => {
    const deps = makeDeps();
    await run(text("/prepod Петрова Анна Сергеевна", 99), deps, { userId: 99, admin: true, username: "admin" });
    expect(deps.repo.getUser(99)!.teacherMode).toBe(true);
    // А обычный человек так — нет.
    await run(text("/prepod Петрова Анна Сергеевна"), deps, { username: "someone" });
    expect(deps.repo.getUser(7)!.teacherMode).toBe(false);
  });

  it("календарь — файл с его парами", async () => {
    const deps = makeDeps();
    await run(text("/prepod"), deps, { username: "petrova_as" });
    const calls = await run(press("ics:0"), deps, { username: "petrova_as" });
    const doc = calls.find((c) => c.method === "sendDocument");
    expect(doc).toBeTruthy();
    expect(String(doc!.payload.caption)).toMatch(/Петрова А\. С\.: 1 пара/);
  });

  it("напоминание о первой паре приходит по его расписанию", async () => {
    const deps = makeDeps();
    await run(text("/prepod"), deps, { username: "petrova_as" });
    deps.repo.updateUser(7, { remindFirstMin: 120 });
    const sent: string[] = [];
    const api = new Api("123:FAKE");
    api.config.use(async (_prev, _method, payload) => {
      sent.push(String((payload as { text?: string }).text ?? ""));
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
    });
    const now = { ...wallClock(), date: today, minutes: 14 * 60 };
    await new Notifier(api, deps.repo, deps.service, null).tickReminders(now);
    expect(sent.join("\n")).toMatch(/Через 1 час первая пара/);
    expect(sent.join("\n")).toContain("Программирование");
  });
});

describe("/start — одно сообщение", () => {
  const startDeps = (withAsk: boolean): Deps => {
    const deps = makeDeps();
    deps.repo.touchUser(7, "u", "U");
    if (withAsk) deps.ask = {} as Deps["ask"];
    return deps;
  };
  const runStart = async (deps: Deps): Promise<Call[]> => {
    const calls: Call[] = [];
    const api = new Api("123:FAKE");
    api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
    });
    const { miscHandlers } = await import("../src/bot/handlers/misc.js");
    const ctx = new Context(text("/start"), api, ME) as BotContext;
    ctx.deps = deps;
    ctx.user = deps.repo.touchUser(7, "u", "U");
    ctx.isAdmin = false;
    await new Composer<BotContext>().use(miscHandlers).middleware()(ctx, async () => undefined);
    return calls;
  };
  const buttonTexts = (c: Call): string[] => ((c.payload.reply_markup as { inline_keyboard?: Array<Array<{ text: string }>> }).inline_keyboard ?? []).flat().map((b) => b.text);

  it("вернувшийся: приветствие и одна кнопка «Спросить?»", async () => {
    const deps = startDeps(true);
    deps.repo.updateUser(7, { groupKey: group.key });
    const calls = await runStart(deps);
    const sent = calls.filter((c) => c.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.payload.text)).toContain("С возвращением");
    expect(buttonTexts(sent[0]!)).toEqual(["💬 Спросить?"]);
  });

  it("новый: одно сообщение — приветствие, выбор группы и «Спросить?»", async () => {
    const deps = startDeps(true);
    const calls = await runStart(deps);
    const sent = calls.filter((c) => c.method === "sendMessage");
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.payload.text)).toMatch(/выбери свою группу/);
    const labels = buttonTexts(sent[0]!);
    expect(labels).toContain("12-23");
    expect(labels[labels.length - 1]).toBe("💬 Спросить?");
  });

  it("преподаватель — по имени-отчеству", async () => {
    const deps = startDeps(true);
    deps.repo.updateUser(7, { teacherMode: true, teacherName: "Петрова Анна Сергеевна", teacherRef: null });
    const calls = await runStart(deps);
    expect(String(calls.find((c) => c.method === "sendMessage")!.payload.text)).toContain("Здравствуйте, Анна Сергеевна!");
  });
});
