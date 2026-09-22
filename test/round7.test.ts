import { describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { scheduleHandlers } from "../src/bot/handlers/schedule.js";
import { BTN } from "../src/bot/keyboards.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import type { Renderer } from "../src/render/image.js";
import type { ScheduleFormat } from "../src/db/repo.js";
import { addDays, todayMsk } from "../src/time.js";
import { buildPeopleResults, parseInlineQuery } from "../src/bot/inline.js";
import type { User } from "../src/db/repo.js";

const group: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [8524], portalNames: ["ВИШ-12-23"] };
const other: LogicalGroup = { ...group, key: "виш-14-24", title: "ВИШ-14-24", number: 14, intake: 24, course: 3 };
const today = todayMsk();

function lesson(subject: string, slot: number): Occurrence {
  return { groupKey: group.key, period: 1, date: today, slot, start: 8 * 60 + slot * 90, end: 9 * 60 + 30 + slot * 90, subject, type: "лк", room: "Т-310", teacher: "Иванов И. И.", subgroup: null, isDistance: false, status: "scheduled", sources: [group.title] };
}

function makeService(lessons: Occurrence[]): ScheduleService {
  return {
    group: (key: string) => [group, other].find((g) => g.key === key) ?? null,
    groups: () => [group, other],
    stream: () => [group, other],
    intakes: () => [23, 24],
    lessonsOn: () => lessons,
    materialize: () => lessons,
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

const renderer = { renderDay: async () => Buffer.from("png"), renderWeek: async () => Buffer.from("png"), renderStreamDay: async () => Buffer.from("png") } as unknown as Renderer;

function makeDeps(lessons: Occurrence[]): Deps {
  const repo = new Repo(openDatabase(":memory:"));
  repo.touchUser(7, "u", "U");
  return { config: { ADMIN_IDS: [], MEDIA_CHAT_IDS: [], PUBLIC_URL: undefined, HTTP_PORT: 0, POISK: false } as unknown as Deps["config"], repo, service: makeService(lessons), renderer, ask: null, teachers: null, webinars: null, students: null, news: null, http: null, inline: true, botUsername: "vish_bot", pending: new Map(), startedAt: new Date() };
}

async function press(label: string, deps: Deps): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
  });
  const update: Update = { update_id: 1, message: { message_id: 10, date: 0, chat: { id: 7, type: "private", first_name: "U" }, from: { id: 7, is_bot: false, first_name: "U" }, text: label } };
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = deps;
  ctx.user = deps.repo.touchUser(7, "u", "U");
  ctx.isAdmin = false;
  const composer = new Composer<BotContext>();
  composer.use(scheduleHandlers);
  await composer.middleware()(ctx, async () => undefined);
  return calls;
}

function withFormat(lessons: Occurrence[], format: ScheduleFormat): Deps {
  const deps = makeDeps(lessons);
  deps.repo.updateUser(7, { groupKey: group.key, format });
  return deps;
}

describe("формат «картинка» и «и так, и так»", () => {
  const short = [lesson("Физика", 2)];

  it("«картинка»: приходит один постер, без текста рядом и без подписи", async () => {
    const calls = await press(BTN.today, withFormat(short, "image"));
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto"]);
    expect(calls[0]!.payload.caption).toBeUndefined();
  });

  it("«и так, и так»: одно сообщение — постер с расписанием в подписи", async () => {
    const calls = await press(BTN.today, withFormat(short, "both"));
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto"]);
    expect(String(calls[0]!.payload.caption)).toContain("Физика");
    expect(calls[0]!.payload.parse_mode).toBe("HTML");
  });

  it("«текст»: постера нет вовсе", async () => {
    const calls = await press(BTN.today, withFormat(short, "text"));
    expect(calls.map((c) => c.method)).toEqual(["sendMessage"]);
  });

  it("длинное расписание в подпись не лезет: текст первым, постер последним", async () => {
    const long = Array.from({ length: 12 }, (_, i) => lesson(`Проектирование средств технологического оснащения ${i}`, i));
    const calls = await press(BTN.week, withFormat(long, "both"));
    expect(calls.map((c) => c.method)).toEqual(["sendMessage", "sendPhoto"]);
    // Подпись не шлём: Telegram обрежет её на 1024 и порвёт разметку.
    expect(calls[1]!.payload.caption).toBeUndefined();
    // Кнопки навигации — на последнем сообщении, листать вверх не придётся.
    expect(calls[0]!.payload.reply_markup).toBeUndefined();
    expect(calls[1]!.payload.reply_markup).toBeTruthy();
  });

  it("неделя в «и так, и так» больше не теряет постер", async () => {
    const calls = await press(BTN.week, withFormat(short, "both"));
    expect(calls.some((c) => c.method === "sendPhoto")).toBe(true);
  });
});

describe("inline про людей", () => {
  const deps = (): Deps => {
    const d = makeDeps([lesson("Физика", 2)]);
    d.config = { ...d.config, POISK: true, POISK_DAILY_LIMIT: 30 } as Deps["config"];
    return d;
  };
  const user = { id: 7, groupKey: group.key, subgroup: null } as unknown as User;

  it("«студент Беляев» — это человек, а не группа", () => {
    const req = parseInlineQuery(deps(), "студент Беляев", user);
    expect(req.person).toEqual({ kind: "student", query: "Беляев" });
    expect(req.unknownGroup).toBe(false);
    expect(req.groups).toEqual([]);
  });

  it("«завтра преподаватель Петров» — день и фамилия", () => {
    const req = parseInlineQuery(deps(), "завтра преподаватель Петров", user);
    expect(req.person).toEqual({ kind: "teacher", query: "Петров" });
    expect(req.date).toBe(addDays(today, 1));
    expect(req.mode).toBe("day");
  });

  it("«неделя препод Петров» — неделя", () => {
    const req = parseInlineQuery(deps(), "неделя препод Петров", user);
    expect(req.person?.kind).toBe("teacher");
    expect(req.mode).toBe("week");
  });

  it("«12-23» остаётся группой", () => {
    const req = parseInlineQuery(deps(), "12-23", user);
    expect(req.person).toBeNull();
    expect(req.groups[0]?.key).toBe(group.key);
  });

  it("без реестра поиск студента честно говорит, что выключен", async () => {
    const d = makeDeps([lesson("Физика", 2)]);
    const req = parseInlineQuery(d, "студент Беляев", user);
    const res = await buildPeopleResults(d, req, user);
    expect(res).toHaveLength(1);
    expect(res[0]!.title).toMatch(/выключен/i);
  });

  it("короткий запрос отвечает подсказкой, а не пустотой", async () => {
    const d = deps();
    const req = parseInlineQuery(d, "студент Бе", user);
    const res = await buildPeopleResults(d, req, user);
    expect(res[0]!.title).toMatch(/фамилию/i);
  });
});
