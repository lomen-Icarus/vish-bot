import { describe, expect, it } from "vitest";
import { Api, Context, GrammyError } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { isUnreachable } from "../src/bot/errors.js";
import { trustedNewsSender } from "../src/bot/handlers/news.js";
import { StudentDirectory } from "../src/students/directory.js";
import { buildPeopleResults, parseInlineQuery } from "../src/bot/inline.js";
import { Notifier } from "../src/notify/dispatcher.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import { todayMsk, wallClock } from "../src/time.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };

describe("журнал поисков: окно склейки повторов", () => {
  it("тот же запрос через три часа — это второй поиск, а не повтор", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const day = todayMsk();
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    repo.db.prepare("INSERT INTO poisk_log (user_id, day, query, student, created_at) VALUES (?, ?, ?, ?, ?)").run(1, day, "поиск: Иванов", null, threeHoursAgo);
    repo.logPoisk(1, day, "поиск: Иванов", null);
    expect(repo.poiskUsage(1, day)).toBe(2);
  });

  it("а повтор в пределах двух минут по-прежнему склеивается", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const day = todayMsk();
    repo.logPoisk(1, day, "поиск: Иванов", null);
    repo.logPoisk(1, day, "ии: Иванов", "abc");
    expect(repo.poiskUsage(1, day)).toBe(1);
  });
});

describe("inline: студенты по трём буквам не видны", () => {
  it("короткий запрос не показывает людей, длинный показывает и тратит лимит", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vb-"));
    const file = path.join(dir, "students.csv");
    writeFileSync(file, "ФИО;Группа\nИванов Иван Иванович;ВИШ-12-23\nИвашкин Пётр Петрович;ВИШ-13-23\n");
    const repo = new Repo(openDatabase(":memory:"));
    const user = repo.touchUser(42, "x", "x");
    const deps = {
      config: { POISK: true, POISK_DAILY_LIMIT: 1 },
      repo,
      students: new StudentDirectory(file),
      service: { groups: () => [], intakes: () => [], group: () => null, weekInfo: () => ({ week: null, parity: null, semester: 1 }) },
      webinars: null,
      teachers: null,
    } as unknown as Deps;
    for (let i = 0; i < 3; i++) {
      const res = await buildPeopleResults(deps, parseInlineQuery(deps, "студент Ива", user), user, {});
      expect(JSON.stringify(res)).not.toContain("Иванов Иван");
    }
    expect(repo.poiskUsage(42, todayMsk())).toBe(0);
    const full = await buildPeopleResults(deps, parseInlineQuery(deps, "студент Иванов", user), user, {});
    expect(JSON.stringify(full)).toContain("Иванов Иван");
    expect(repo.poiskUsage(42, todayMsk())).toBe(1);
    const limited = await buildPeopleResults(deps, parseInlineQuery(deps, "студент Ивашкин", user), user, {});
    expect(JSON.stringify(limited)).toContain("Лимит");
  });
});

describe("недоступный пользователь", () => {
  it("403 «bot can't initiate conversation» — тоже недоступен", () => {
    const err = new GrammyError("x", { ok: false, error_code: 403, description: "Forbidden: bot can't initiate conversation with a user" }, "sendMessage", {});
    expect(isUnreachable(err)).toBe(true);
    expect(isUnreachable(new Error("Bad Request: chat not found"))).toBe(true);
    expect(isUnreachable(new Error("Bad Request: message is too long"))).toBe(false);
  });

  it("inline-запрос не заводит пользователя и не снимает пометку blocked", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const ghost = repo.peekUser(99, "ghost", "G");
    expect(ghost.groupKey).toBeNull();
    expect(repo.getUser(99)).toBeNull();
    repo.touchUser(100, "real", "R");
    repo.updateUser(100, { blocked: true });
    expect(repo.peekUser(100, "real", "R").blocked).toBe(true);
    expect(repo.getUser(100)!.blocked).toBe(true);
  });
});

describe("новости из обычного чата", () => {
  const groupMsg = (fromId: number, extra: Record<string, unknown> = {}): Update => ({
    update_id: 1,
    message: { message_id: 5, date: 0, chat: { id: -100500, type: "supergroup", title: "чат" }, from: { id: fromId, is_bot: false, first_name: "U" }, text: "#всем привет", ...extra } as never,
  });
  const ctxFor = (update: Update, status: string): BotContext => {
    const api = new Api("123:FAKE");
    api.config.use(async (_prev, method) => {
      if (method === "getChatMember") return { ok: true, result: { status, user: { id: 0, is_bot: false, first_name: "x" } } as never };
      return { ok: true, result: true as never };
    });
    const ctx = new Context(update, api, ME) as BotContext;
    ctx.deps = { config: { ADMIN_IDS: [7] } } as unknown as Deps;
    return ctx;
  };

  it("участник чата не может разослать «#всем»", async () => {
    expect(await trustedNewsSender(ctxFor(groupMsg(501), "member"))).toBe(false);
  });
  it("админ чата, админ бота и анонимный админ — могут", async () => {
    expect(await trustedNewsSender(ctxFor(groupMsg(502), "administrator"))).toBe(true);
    expect(await trustedNewsSender(ctxFor(groupMsg(7), "member"))).toBe(true);
    expect(await trustedNewsSender(ctxFor(groupMsg(503, { sender_chat: { id: -100500, type: "supergroup", title: "чат" } }), "member"))).toBe(true);
  });
});

describe("напоминания уважают настройку «преподаватель»", () => {
  it("«не показывать» — фамилии в напоминании нет", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const group: LogicalGroup = { key: "g", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [1], portalNames: ["ВИШ-12-23"] };
    const now = wallClock(new Date("2026-09-14T05:00:00Z")); // 08:00 МСК
    const lesson: Occurrence = { groupKey: "g", period: 1, date: now.date, slot: 1, start: 8 * 60 + 20, end: 9 * 60 + 40, subject: "Физика", type: "лк", room: "Г-101", teacher: "Иванова Ирина Ивановна", subgroup: null, isDistance: false, status: "scheduled", sources: [] };
    const service = { group: () => group, lessonsOn: () => [lesson], weekInfo: () => ({ week: 3, parity: "odd", semester: 1 }) } as unknown as ScheduleService;
    repo.touchUser(7, "u", "U");
    repo.updateUser(7, { groupKey: "g", remindFirstMin: 60, teacherView: "off" });
    const sent: string[] = [];
    const api = new Api("123:FAKE");
    api.config.use(async (_prev, _method, payload) => {
      sent.push(String((payload as { text?: string }).text ?? ""));
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
    });
    await new Notifier(api, repo, service, null).tickReminders(now);
    expect(sent.join("\n")).toContain("Физика");
    expect(sent.join("\n")).not.toContain("Иванова");
  });
});
