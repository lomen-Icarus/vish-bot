import { describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { miscHandlers } from "../src/bot/handlers/misc.js";
import { askHandlers } from "../src/bot/handlers/ask.js";
import { teacherHandlers } from "../src/bot/handlers/teachers.js";
import { streamHandlers } from "../src/bot/handlers/stream.js";
import { calendarHandlers } from "../src/bot/handlers/calendar.js";
import { settingsHandlers } from "../src/bot/handlers/settings.js";
import { scheduleHandlers } from "../src/bot/handlers/schedule.js";
import { BTN } from "../src/bot/keyboards.js";
import { setPending } from "../src/bot/context.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import { todayMsk } from "../src/time.js";

const group: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [8524], portalNames: ["ВИШ-12-23"] };
const other: LogicalGroup = { ...group, key: "виш-14-24", title: "ВИШ-14-24", number: 14, intake: 24, course: 3 };
const today = todayMsk();

function lesson(subject: string): Occurrence {
  return { groupKey: group.key, period: 1, date: today, slot: 3, start: 11 * 60 + 40, end: 13 * 60, subject, type: "лк", room: "Т-310", teacher: null, subgroup: null, isDistance: false, status: "scheduled", sources: [group.title] };
}

function makeService(): ScheduleService {
  const byGroup: Record<string, Occurrence[]> = { [group.key]: [lesson("Патентоведение")], [other.key]: [lesson("Физика")] };
  return {
    group: (key: string) => [group, other].find((g) => g.key === key) ?? null,
    groups: () => [group, other],
    stream: () => [group, other],
    intakes: () => [23, 24],
    lessonsOn: (g: LogicalGroup) => byGroup[g.key] ?? [],
    materialize: (g: LogicalGroup) => byGroup[g.key] ?? [],
    weekInfo: () => ({ week: 3, parity: "odd" as const, semester: 1 as const }),
    semesterFor: () => 1 as const,
    weekOneMonday: () => "2026-09-01",
  } as unknown as ScheduleService;
}

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

/** Run one update through the real handler chain, in the order src/bot/index.ts uses. */
async function run(update: Update, deps: Deps, userId = 7): Promise<{ calls: Call[]; fellThrough: boolean }> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: method === "sendMessage" || method === "sendPhoto" ? ({ message_id: 1, date: 0, chat: { id: userId, type: "private" } } as never) : (true as never) };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = deps;
  ctx.user = deps.repo.touchUser(userId, "u", "U");
  ctx.isAdmin = false;
  const composer = new Composer<BotContext>();
  composer.use(miscHandlers, askHandlers, teacherHandlers, streamHandlers, calendarHandlers, settingsHandlers, scheduleHandlers);
  let fellThrough = false;
  await composer.middleware()(ctx, async () => {
    fellThrough = true;
  });
  return { calls, fellThrough };
}

function makeDeps(userId = 7): Deps {
  const repo = new Repo(openDatabase(":memory:"));
  repo.touchUser(userId, "u", "U");
  return { config: { ADMIN_IDS: [], MEDIA_CHAT_IDS: [], PUBLIC_URL: undefined, HTTP_PORT: 0 } as unknown as Deps["config"], repo, service: makeService(), renderer: null, ask: null, teachers: null, webinars: null, news: null, http: null, pending: new Map(), startedAt: new Date() };
}

const textUpdate = (text: string, userId = 7): Update => ({
  update_id: 1,
  message: { message_id: 10, date: 0, chat: { id: userId, type: "private", first_name: "U" }, from: { id: userId, is_bot: false, first_name: "U" }, text },
});

const callbackUpdate = (data: string, userId = 7, photo = false): Update => ({
  update_id: 2,
  callback_query: {
    id: "1",
    from: { id: userId, is_bot: false, first_name: "U" },
    chat_instance: "1",
    data,
    message: { message_id: 11, date: 0, chat: { id: userId, type: "private", first_name: "U" }, ...(photo ? { photo: [{ file_id: "f", file_unique_id: "u", width: 100, height: 100 }] } : { text: "старое сообщение" }) } as never,
  },
});

const texts = (calls: Call[]): string[] => calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText").map((c) => String(c.payload.text ?? ""));

describe("menu buttons", () => {
  it("every main-menu button is handled", async () => {
    const deps = makeDeps();
    deps.repo.updateUser(7, { groupKey: group.key });
    for (const label of [BTN.today, BTN.tomorrow, BTN.otherGroups, BTN.week, BTN.nextWeek, BTN.stream, BTN.changes, BTN.calendar, BTN.teachers, BTN.features, BTN.search, BTN.settings]) {
      const { calls, fellThrough } = await run(textUpdate(label), deps);
      expect(fellThrough, `${label} reached the "не понял" fallback`).toBe(false);
      expect(calls.length, `${label} answered nothing`).toBeGreaterThan(0);
    }
  });

  it("the calendar button opens the calendar screen", async () => {
    const deps = makeDeps();
    deps.repo.updateUser(7, { groupKey: group.key });
    const { calls } = await run(textUpdate(BTN.calendar), deps);
    expect(texts(calls)[0]).toMatch(/календарь телефона/i);
    // Without PUBLIC_URL only the file is offered, never a dead subscription link.
    expect(JSON.stringify(calls)).not.toContain("Подписка");
  });
});

describe("pending flows", () => {
  it("a menu button cancels the pending search instead of being searched for", async () => {
    const deps = makeDeps();
    deps.repo.updateUser(7, { groupKey: group.key });
    setPending(deps, 7, { kind: "search" });
    const { calls } = await run(textUpdate(BTN.today), deps);
    const out = texts(calls).join("\n");
    expect(out).toMatch(/Патентоведение/);
    expect(out).not.toMatch(/ничего не нашёл/i);
    expect(deps.pending.has(7)).toBe(false);
  });

  it("a menu button cancels the pending teacher search too", async () => {
    const deps = makeDeps();
    deps.repo.updateUser(7, { groupKey: group.key });
    setPending(deps, 7, { kind: "teacher" });
    const { calls } = await run(textUpdate(BTN.settings), deps);
    expect(texts(calls).join("\n")).toMatch(/Настройки/);
  });

  it("free text still reaches the pending search", async () => {
    const deps = makeDeps();
    deps.repo.updateUser(7, { groupKey: group.key });
    setPending(deps, 7, { kind: "search" });
    const { calls } = await run(textUpdate("патент"), deps);
    expect(texts(calls).join("\n")).toMatch(/Поиск: патент/);
  });
});

describe("peek navigation", () => {
  it("opens another group in a new message but navigates in place", async () => {
    const deps = makeDeps();
    deps.repo.updateUser(7, { groupKey: group.key });
    const opened = await run(callbackUpdate(`pdn:${other.key}:${today}`), deps);
    expect(opened.calls.map((c) => c.method)).toContain("sendMessage");
    expect(opened.calls.map((c) => c.method)).not.toContain("editMessageText");

    const navigated = await run(callbackUpdate(`pd:${other.key}:${today}`), deps);
    expect(navigated.calls.map((c) => c.method)).toContain("editMessageText");
    expect(texts(navigated.calls).join("\n")).toMatch(/ВИШ-14-24/);
  });
});
