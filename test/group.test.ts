import { beforeEach, describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Message, Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { groupHandlers, exactCanned, normTrigger, resetGroupState } from "../src/bot/handlers/group.js";
import { adminHandlers } from "../src/bot/handlers/admin.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import type { ScheduleService } from "../src/schedule/service.js";
import { todayMsk } from "../src/time.js";

const ME: UserFromGetMe = { id: 999, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
const CHAT = -100500;
const ADMIN = 1;
const STUDENT = 7;

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

interface AskCall {
  question: string;
  mode?: string;
  canned?: Array<{ trigger: string; answer: string }>;
  replyTo?: string;
}

function makeDeps(): { deps: Deps; asked: AskCall[] } {
  const repo = new Repo(openDatabase(":memory:"));
  const asked: AskCall[] = [];
  const ask = {
    answer: async (input: AskCall) => {
      asked.push(input);
      return { text: "ответ ИИ", inputTokens: 100, outputTokens: 20, mentions: { teachers: [], webinarTeachers: [], groupKeys: [], students: [] } };
    },
  };
  const service = { group: () => null, groups: () => [], weekInfo: () => ({ week: 3, parity: "odd", semester: 1 }), lastPollRun: () => null } as unknown as ScheduleService;
  const deps = {
    config: { ADMIN_IDS: [ADMIN], AI_DAILY_LIMIT_PER_USER: 10, AI_DAILY_LIMIT_GLOBAL: 300, POLL_CRON_BUSY: "*/6 7-21 * * 1-6", NEWS_CHANNEL_IDS: [], POISK: false } as unknown as Deps["config"],
    repo,
    service,
    renderer: null,
    ask: ask as unknown as Deps["ask"],
    teachers: null,
    webinars: null,
    students: null,
    known: null,
    news: null,
    http: null,
    inline: true,
    botUsername: "vish_bot",
    pending: new Map(),
    startedAt: new Date(),
  } as Deps;
  return { deps, asked };
}

async function run(update: Update, deps: Deps, fromId: number): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: CHAT, type: "supergroup" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = deps;
  ctx.user = deps.repo.touchUser(fromId, "u", "U");
  ctx.isAdmin = deps.config.ADMIN_IDS.includes(fromId);
  const composer = new Composer<BotContext>();
  composer.use(groupHandlers, adminHandlers);
  await composer.middleware()(ctx, async () => undefined);
  return calls;
}

let nextId = 100;
function groupMessage(text: string, opts: { from?: number; replyToBot?: boolean; replyToText?: string } = {}): Update {
  const from = { id: opts.from ?? STUDENT, is_bot: false, first_name: "U" };
  const at = text.indexOf("@vish_bot");
  const reply = opts.replyToBot
    ? ({ message_id: 5, date: 0, chat: { id: CHAT, type: "supergroup", title: "Чат" }, from: { id: ME.id, is_bot: true, first_name: "vish" }, text: "прошлый ответ" } as Message)
    : opts.replyToText
      ? ({ message_id: 6, date: 0, chat: { id: CHAT, type: "supergroup", title: "Чат" }, from: { id: 55, is_bot: false, first_name: "Друг" }, text: opts.replyToText } as Message)
      : undefined;
  return {
    update_id: nextId++,
    message: {
      message_id: nextId++,
      date: 0,
      chat: { id: CHAT, type: "supergroup", title: "Чат" },
      from,
      text,
      ...(at >= 0 ? { entities: [{ type: "mention" as const, offset: at, length: "@vish_bot".length }] } : {}),
      ...(reply ? { reply_to_message: reply as never } : {}),
    } as Message,
  } as Update;
}

const sent = (calls: Call[]): string[] => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text));

beforeEach(() => resetGroupState());

describe("база ответов: точное совпадение", () => {
  it("знаки, регистр и «ё» не важны", () => {
    expect(normTrigger("  СОСАЛ???  ")).toBe("сосал");
    expect(normTrigger("Ещё раз!")).toBe("еще раз");
    const base = [{ trigger: "сосал?", answer: "мой ответ" }];
    expect(exactCanned(base, "сосал???")).toBe("мой ответ");
    expect(exactCanned(base, "СОСАЛ")).toBe("мой ответ");
    expect(exactCanned(base, "ты сосал что ли")).toBeNull();
  });
});

describe("бот в группе", () => {
  it("в чате вне белого списка молчит", async () => {
    const { deps, asked } = makeDeps();
    const calls = await run(groupMessage("@vish_bot привет"), deps, STUDENT);
    expect(sent(calls)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("не отвечает на сообщения, где его не звали", async () => {
    const { deps, asked } = makeDeps();
    deps.repo.enableGroupChat(CHAT, "Чат", ADMIN);
    const calls = await run(groupMessage("когда матан"), deps, STUDENT);
    expect(sent(calls)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("совпадение с базой — ответ сразу, без ИИ и без траты лимита", async () => {
    const { deps, asked } = makeDeps();
    deps.repo.enableGroupChat(CHAT, "Чат", ADMIN);
    deps.repo.addCannedReply("сосал?", "мой ответ <жирно>");
    const calls = await run(groupMessage("@vish_bot СОСАЛ???"), deps, STUDENT);
    expect(sent(calls)).toEqual(["мой ответ &lt;жирно&gt;"]);
    expect(asked).toEqual([]);
    expect(deps.repo.aiUsage(CHAT, todayMsk())).toBe(0);
  });

  it("остальное идёт в ИИ в режиме группы вместе с базой; счёт — на чат, не на человека", async () => {
    const { deps, asked } = makeDeps();
    deps.repo.enableGroupChat(CHAT, "Чат", ADMIN);
    deps.repo.addCannedReply("сосал?", "мой ответ");
    const calls = await run(groupMessage("@vish_bot ты чё, сосал что ли"), deps, STUDENT);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.question).toBe("ты чё, сосал что ли");
    expect(asked[0]!.mode).toBe("group");
    expect(asked[0]!.canned).toEqual([{ id: 1, trigger: "сосал?", answer: "мой ответ" }]);
    expect(sent(calls)).toEqual(["ответ ИИ"]);
    // Ответ в тред, реплаем на того, кто спросил.
    expect(calls.find((c) => c.method === "sendMessage")!.payload.reply_parameters).toBeTruthy();
    expect(deps.repo.aiUsage(CHAT, todayMsk())).toBe(1);
    expect(deps.repo.aiUsage(STUDENT, todayMsk())).toBe(0);
  });

  it("ответ на сообщение бота тоже считается обращением", async () => {
    const { deps, asked } = makeDeps();
    deps.repo.enableGroupChat(CHAT, "Чат", ADMIN);
    await run(groupMessage("а завтра?", { replyToBot: true }), deps, STUDENT);
    expect(asked[0]!.question).toBe("а завтра?");
  });

  it("упомянули в ответ на чужое сообщение — это сообщение идёт как контекст", async () => {
    const { deps, asked } = makeDeps();
    deps.repo.enableGroupChat(CHAT, "Чат", ADMIN);
    await run(groupMessage("@vish_bot это правда?", { replyToText: "завтра пар нет" }), deps, STUDENT);
    expect(asked[0]!.replyTo).toBe("завтра пар нет");
  });

  it("пауза между ответами: второй вызов сразу после первого молчит", async () => {
    const { deps, asked } = makeDeps();
    deps.repo.enableGroupChat(CHAT, "Чат", ADMIN);
    await run(groupMessage("@vish_bot раз"), deps, STUDENT);
    const calls = await run(groupMessage("@vish_bot два"), deps, STUDENT);
    expect(asked).toHaveLength(1);
    expect(sent(calls)).toEqual([]);
  });

  it("лимит на чат: одно объявление, дальше тишина", async () => {
    const { deps, asked } = makeDeps();
    deps.repo.enableGroupChat(CHAT, "Чат", ADMIN);
    deps.repo.setMeta("group:dailyLimit", "1");
    deps.repo.bumpAiUsage(CHAT, todayMsk(), 1, 1);
    const first = await run(groupMessage("@vish_bot раз"), deps, STUDENT);
    // Объявление о лимите не ставит паузу: второй вызов молчит именно из-за
    // отметки «уже сказали», а не из-за паузы между ответами.
    const second = await run(groupMessage("@vish_bot два"), deps, STUDENT);
    expect(sent(first)[0]).toMatch(/выговорился/);
    expect(sent(second)).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("лимит 0 — в группах работает только база ответов, ИИ молчит без объявлений", async () => {
    const { deps, asked } = makeDeps();
    deps.repo.enableGroupChat(CHAT, "Чат", ADMIN);
    deps.repo.setMeta("group:dailyLimit", "0");
    deps.repo.addCannedReply("привет", "здарова");
    expect(sent(await run(groupMessage("@vish_bot привет"), deps, STUDENT))).toEqual(["здарова"]);
    resetGroupState();
    expect(sent(await run(groupMessage("@vish_bot как дела"), deps, STUDENT))).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("включить в чате может только админ", async () => {
    const { deps } = makeDeps();
    // Та же самая команда, с разметкой команды: отличается только автор.
    const command = (from: number): Update => {
      const u = groupMessage("/chaton", { from });
      (u.message as Message).entities = [{ type: "bot_command", offset: 0, length: 7 }];
      return u;
    };
    await run(command(STUDENT), deps, STUDENT);
    expect(deps.repo.groupChatEnabled(CHAT)).toBe(false);
    await run(command(ADMIN), deps, ADMIN);
    expect(deps.repo.groupChatEnabled(CHAT)).toBe(true);
  });
});

describe("бота добавили в чат", () => {
  const joined = (by: number, status: "member" | "left" = "member"): Update => ({
    update_id: nextId++,
    my_chat_member: {
      chat: { id: CHAT, type: "supergroup", title: "Чат группы" },
      from: { id: by, is_bot: false, first_name: "U" },
      date: 0,
      old_chat_member: { status: "left", user: { id: ME.id, is_bot: true, first_name: "vish" } },
      new_chat_member: status === "member" ? { status: "member", user: { id: ME.id, is_bot: true, first_name: "vish" } } : { status: "left", user: { id: ME.id, is_bot: true, first_name: "vish" } },
    } as never,
  });

  it("админ добавил сам — включается сразу", async () => {
    const { deps } = makeDeps();
    await run(joined(ADMIN), deps, ADMIN);
    expect(deps.repo.groupChatEnabled(CHAT)).toBe(true);
  });

  it("добавил кто-то другой — молчит, а админу приходит вопрос с кнопкой", async () => {
    const { deps } = makeDeps();
    const calls = await run(joined(STUDENT), deps, STUDENT);
    expect(deps.repo.groupChatEnabled(CHAT)).toBe(false);
    const notice = calls.find((c) => c.method === "sendMessage" && c.payload.chat_id === ADMIN);
    expect(String(notice?.payload.text)).toContain("Чат группы");
    expect(deps.repo.groupChats()[0]?.title).toBe("Чат группы");
  });

  it("бота выгнали — чат выключается", async () => {
    const { deps } = makeDeps();
    deps.repo.enableGroupChat(CHAT, "Чат", ADMIN);
    await run(joined(STUDENT, "left"), deps, STUDENT);
    expect(deps.repo.groupChatEnabled(CHAT)).toBe(false);
  });
});

describe("управление базой ответов", () => {
  const privateCommand = (text: string): Update => ({
    update_id: nextId++,
    message: {
      message_id: nextId++,
      date: 0,
      chat: { id: ADMIN, type: "private", first_name: "A" },
      from: { id: ADMIN, is_bot: false, first_name: "A" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0]!.length }],
    } as Message,
  });

  it("триггер и ответ разделяются «=>», ответ может быть многострочным", async () => {
    const { deps } = makeDeps();
    await run(privateCommand("/reply_add сосал? => нет\nа ты?"), deps, ADMIN);
    expect(deps.repo.cannedReplies()).toEqual([{ id: 1, trigger: "сосал?", answer: "нет\nа ты?" }]);
  });

  it("без «=>» ничего не добавляет и показывает подсказку", async () => {
    const { deps } = makeDeps();
    const calls = await run(privateCommand("/reply_add просто текст"), deps, ADMIN);
    expect(deps.repo.cannedReplies()).toEqual([]);
    expect(sent(calls)[0]).toContain("=&gt;");
  });
});

describe("ИИ в группе не ищет людей", () => {
  it("инструмента поиска студентов в режиме группы нет, в личке есть", async () => {
    const { AskService } = await import("../src/ai/ask.js");
    const lookup = { search: () => [], allowed: () => true, note: () => undefined, whereabouts: () => null };
    const svc = new AskService("sk-test", {} as ScheduleService, { model: "claude-sonnet-5" }, null, null, lookup);
    const mentions = { teachers: [], webinarTeachers: [], groupKeys: [], students: [] };
    const names = (mode: "private" | "group") =>
      (svc as unknown as { tools: (...a: unknown[]) => Array<{ name: string }> }).tools(null, null, "", mentions, 1, mode).map((t) => t.name);
    expect(names("private")).toContain("find_student");
    expect(names("group")).not.toContain("find_student");
    expect(names("group")).toContain("get_schedule");
  });
});

describe("пересылки", () => {
  it("пересланное сообщение с упоминанием бота — не обращение", async () => {
    const { deps, asked } = makeDeps();
    deps.repo.enableGroupChat(CHAT, "Чат", ADMIN);
    const u = groupMessage("@vish_bot купи крипту");
    (u.message as Message & { forward_origin?: unknown }).forward_origin = { type: "hidden_user", sender_user_name: "спамер", date: 0 };
    const calls = await run(u, deps, STUDENT);
    expect(asked).toEqual([]);
    expect(sent(calls)).toEqual([]);
  });
});
