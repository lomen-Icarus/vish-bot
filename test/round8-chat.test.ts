import { beforeEach, describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Message, Update, UserFromGetMe } from "grammy/types";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { decodeText, parseQa, QaBase, qaLine } from "../src/chat/qa.js";
import { ChatService, type ChatClient } from "../src/chat/service.js";
import { addressedToBot, groupChatHandlers, resetGroupChatState, stripMention } from "../src/bot/handlers/groupChat.js";
import { chatAdminHandlers } from "../src/bot/handlers/chatAdmin.js";
import { setChatLimit } from "../src/chat/limits.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import { todayMsk } from "../src/time.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
const CHAT = -1001234567890;

function tmpFile(name: string, content?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "chatqa-"));
  const file = path.join(dir, name);
  if (content !== undefined) writeFileSync(file, content, "utf8");
  return file;
}

describe("сценарий «вопрос → ответ»: разбор CSV", () => {
  it("Excel: «;», заголовок, варианты через «|», подсказка, кавычки и многострочный ответ", () => {
    const csv = '﻿вопрос;ответ;подсказка\n# комментарий\nсосал?|ты сосал?;Ответ админа;дословно\n"как дела; вообще";"Норм, ""живём""\nвторая строка"\nпустой ответ;\n;без вопроса\n';
    const r = parseQa(csv);
    expect(r.delimiter).toBe(";");
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]).toMatchObject({ questions: ["сосал?", "ты сосал?"], answer: "Ответ админа", hint: "дословно", norm: ["сосал", "ты сосал"] });
    expect(r.entries[1]!.questions).toEqual(["как дела; вообще"]);
    expect(r.entries[1]!.answer).toBe('Норм, "живём"\nвторая строка');
    expect(r.skipped).toBe(2);
  });

  it("Google Таблицы: «,» и кавычки вокруг полей с запятыми", () => {
    const r = parseQa('question,answer\nпривет,"Привет, как сам?"\n');
    expect(r.delimiter).toBe(",");
    expect(r.entries).toEqual([expect.objectContaining({ questions: ["привет"], answer: "Привет, как сам?" })]);
  });

  it("Windows-1251 от русского Excel читается так же, как UTF-8", () => {
    const cp1251 = Buffer.from([0xef, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x3b, 0xef, 0xee, 0xea, 0xe0]); // «привет;пока»
    expect(decodeText(cp1251)).toBe("привет;пока");
    expect(parseQa(decodeText(cp1251)).entries[0]!.answer).toBe("пока");
  });

  it("строка из /qa_add читается обратно без потерь", () => {
    const line = qaLine(["а; б", "в"], 'ответ "в кавычках"\nи вторая строка', "шутливо");
    const r = parseQa(`вопрос;ответ\n${line}\n`);
    expect(r.entries[0]).toMatchObject({ questions: ["а; б", "в"], answer: 'ответ "в кавычках"\nи вторая строка', hint: "шутливо" });
  });
});

describe("сценарий: поиск заготовки", () => {
  const qa = new QaBase(tmpFile("qa.csv", "вопрос;ответ\nсосал?|ты сосал;Заготовка-1\nкак дела;Заготовка-2\nкак дела на парах;Заготовка-3\n"));

  it("точное совпадение, фраза внутри реплики и опечатка", () => {
    expect(qa.match("Сосал?!")[0]).toMatchObject({ how: "exact", entry: { answer: "Заготовка-1" } });
    expect(qa.match("слушай, ты сосал вообще")[0]).toMatchObject({ how: "phrase", entry: { answer: "Заготовка-1" } });
    expect(qa.match("сасал?")[0]).toMatchObject({ how: "typo", entry: { answer: "Заготовка-1" } });
    expect(qa.match("погода сегодня")).toEqual([]);
  });

  it("длинный вопрос важнее короткого", () => {
    const hits = qa.match("ну как дела на парах");
    expect(hits[0]!.entry.answer).toBe("Заготовка-3");
    expect(hits[1]!.entry.answer).toBe("Заготовка-2");
  });

  it("/qa_add дописывает файл, пустой импорт не затирает старую базу", () => {
    const file = tmpFile("new.csv");
    const base = new QaBase(file);
    expect(base.stats()).toMatchObject({ count: 0, error: "файла нет" });
    base.append(["привет"], "Здарова");
    base.append(["пока", "до свидания"], "Бывай", "коротко");
    expect(base.stats().count).toBe(2);
    expect(readFileSync(file, "utf8").split("\n")[0]).toBe("вопрос;ответ;подсказка");
    expect(base.replace("вопрос;ответ\n").entries).toHaveLength(0);
    expect(base.stats().count).toBe(2);
    expect(base.replace("вопрос;ответ\nа;б\n").entries).toHaveLength(1);
    expect(base.stats().count).toBe(1);
    expect(existsSync(`${file}.bak`)).toBe(true);
  });
});

describe("обращение к боту в группе", () => {
  const msg = (extra: Partial<Message>): Message => ({ message_id: 5, date: 0, chat: { id: CHAT, type: "supergroup", title: "ВИШ-12-23" }, from: { id: 7, is_bot: false, first_name: "Аня" }, ...extra }) as Message;

  it("@упоминание, ответ на сообщение бота; чужой @ник и inline-сообщение — нет", () => {
    expect(addressedToBot(msg({ text: "@vish_bot привет", entities: [{ type: "mention", offset: 0, length: 9 }] }), ME)).toBe(true);
    expect(addressedToBot(msg({ text: "эй @VISH_BOT", entities: [{ type: "mention", offset: 3, length: 9 }] }), ME)).toBe(true);
    expect(addressedToBot(msg({ text: "@other_bot привет", entities: [{ type: "mention", offset: 0, length: 10 }] }), ME)).toBe(false);
    expect(addressedToBot(msg({ text: "ага", reply_to_message: { message_id: 1, date: 0, chat: { id: CHAT, type: "supergroup", title: "x" }, from: { id: 1, is_bot: true, first_name: "vish" } } as Message["reply_to_message"] }), ME)).toBe(true);
    expect(addressedToBot(msg({ text: "ага", reply_to_message: { message_id: 1, date: 0, chat: { id: CHAT, type: "supergroup", title: "x" }, from: { id: 1, is_bot: true, first_name: "vish" }, via_bot: ME } as Message["reply_to_message"] }), ME)).toBe(false);
    expect(addressedToBot(msg({ text: "просто текст" }), ME)).toBe(false);
  });

  it("упоминание вырезается из реплики", () => {
    expect(stripMention("@vish_bot, привет", "vish_bot")).toBe("привет");
    expect(stripMention("ну ты @Vish_Bot и шутник", "vish_bot")).toBe("ну ты и шутник");
    expect(stripMention("@vish_botx привет", "vish_bot")).toBe("@vish_botx привет");
  });
});

interface Sent {
  method: string;
  payload: Record<string, unknown>;
}

function fakeMessage(text: string, stop: Anthropic.Message["stop_reason"] = "end_turn"): Anthropic.Message {
  return { id: "m", type: "message", role: "assistant", model: "test", content: text ? [{ type: "text", text, citations: null }] : [], stop_reason: stop, stop_sequence: null, stop_details: null, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Message;
}

function setup(opts: { qa?: string; enabled?: boolean; answers?: string[] } = {}) {
  const repo = new Repo(openDatabase(":memory:"));
  const qa = new QaBase(tmpFile("qa.csv", opts.qa ?? "вопрос;ответ\nсосал?;Заготовка админа\n"));
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const answers = [...(opts.answers ?? [])];
  const client: ChatClient = {
    messages: {
      create: async (params) => {
        requests.push(structuredClone(params));
        return fakeMessage(answers.shift() ?? "ответ бота");
      },
    },
  };
  const chat = new ChatService(null, { model: "test-model", contextMessages: 30, botUsername: "vish_bot" }, qa, client);
  const config = { ADMIN_IDS: [99], CHAT_AI: true, CHAT_GROUP_IDS: [], CHAT_DAILY_LIMIT_PER_USER: 20, CHAT_DAILY_LIMIT_PER_CHAT: 150, CHAT_DAILY_LIMIT_GLOBAL: 400, BOT_TOKEN: "123:FAKE" } as unknown as Deps["config"];
  const deps = { config, repo, chat, pending: new Map() } as unknown as Deps;
  if (opts.enabled !== false) repo.upsertChatGroup(CHAT, { title: "ВИШ-12-23", enabled: true });
  return { deps, repo, requests, qa };
}

async function send(deps: Deps, update: Update, userId = 7, composer: Composer<BotContext> = groupChatHandlers): Promise<Sent[]> {
  const sent: Sent[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 500 + sent.length, date: 0, chat: { id: CHAT, type: "supergroup" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = deps;
  ctx.user = deps.repo.peekUser(userId, null, "U");
  ctx.isAdmin = deps.config.ADMIN_IDS.includes(userId);
  await new Composer<BotContext>().use(composer).middleware()(ctx, async () => undefined);
  return sent;
}

let nextId = 100;
function groupText(text: string, opts: { userId?: number; name?: string; mention?: boolean; replyToBot?: boolean; chatId?: number } = {}): Update {
  const userId = opts.userId ?? 7;
  const full = opts.mention === false ? text : `@vish_bot ${text}`;
  return {
    update_id: nextId,
    message: {
      message_id: nextId++,
      date: 0,
      chat: { id: opts.chatId ?? CHAT, type: "supergroup", title: "ВИШ-12-23" },
      from: { id: userId, is_bot: false, first_name: opts.name ?? "Аня" },
      text: full,
      ...(opts.mention === false ? {} : { entities: [{ type: "mention" as const, offset: 0, length: 9 }] }),
      ...(opts.replyToBot ? { reply_to_message: { message_id: 1, date: 0, chat: { id: opts.chatId ?? CHAT, type: "supergroup" as const, title: "x" }, from: { id: 1, is_bot: true, first_name: "vish" } } as never } : {}),
    },
  };
}

const lastUserText = (req: Anthropic.MessageCreateParamsNonStreaming): string => String(req.messages[req.messages.length - 1]!.content);
const systemText = (req: Anthropic.MessageCreateParamsNonStreaming): string => (req.system as Anthropic.TextBlockParam[]).map((b) => b.text).join("\n");

describe("болталка в группе", () => {
  beforeEach(() => resetGroupChatState());

  it("отвечает на обращение ответом на сообщение, со сценарием в промпте и учётом расхода", async () => {
    const { deps, repo, requests } = setup({ answers: ["Привет, Аня!"] });
    const sent = await send(deps, groupText("привет"));
    const reply = sent.find((s) => s.method === "sendMessage")!;
    expect(reply.payload.text).toBe("Привет, Аня!");
    expect(reply.payload.reply_parameters).toMatchObject({ allow_sending_without_reply: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.model).toBe("test-model");
    expect(systemText(requests[0]!)).toContain("В: сосал?\nО: Заготовка админа");
    expect((requests[0]!.system as Anthropic.TextBlockParam[]).at(-1)!.cache_control).toEqual({ type: "ephemeral" });
    expect(lastUserText(requests[0]!)).toContain("Аня пишет тебе: «привет»");
    expect(lastUserText(requests[0]!)).not.toContain("@vish_bot");
    expect(repo.chatUsage({ userId: 7 }, todayMsk())).toBe(1);
    expect(repo.recentChat(CHAT, 7, 60_000, 5)).toEqual([expect.objectContaining({ question: "привет", answer: "Привет, Аня!" })]);
  });

  it("помнит разговор: прошлые обмены — диалогом, переписка чата — контекстом, заготовка — подсказкой", async () => {
    const { deps, requests } = setup({ answers: ["Первый ответ", "Второй ответ"] });
    await send(deps, groupText("меня зовут Аня, я с 12-23"));
    await send(deps, groupText("сегодня физика отменилась", { mention: false, userId: 8, name: "Петя" }), 8);
    await send(deps, groupText("сосал?", { replyToBot: true, mention: false }));
    const req = requests[1]!;
    expect(req.messages[0]).toEqual({ role: "user", content: "Аня: меня зовут Аня, я с 12-23" });
    expect(req.messages[1]).toEqual({ role: "assistant", content: "Первый ответ" });
    const last = lastUserText(req);
    expect(last).toContain("Петя: сегодня физика отменилась");
    // Свой прошлый обмен в переписке второй раз не дублируется.
    expect(last).not.toContain("Ты (бот): Первый ответ");
    expect(last).toContain("«сосал?» → «Заготовка админа»");
    expect(last).toContain("Аня пишет тебе: «сосал?»");
  });

  it("чат не включён: одна подсказка, модель не зовётся; админ бота включает чат одним обращением", async () => {
    const { deps, repo, requests } = setup({ enabled: false });
    const first = await send(deps, groupText("привет"));
    expect(first.find((s) => s.method === "sendMessage")!.payload.text).toMatch(/пока не включили/);
    expect((await send(deps, groupText("алло"))).filter((s) => s.method === "sendMessage")).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(repo.chatGroup(CHAT)).toMatchObject({ enabled: false, title: "ВИШ-12-23" });
    await send(deps, groupText("я админ", { userId: 99 }), 99);
    expect(repo.chatGroup(CHAT)!.enabled).toBe(true);
    expect(requests).toHaveLength(1);
  });

  it("лимит на человека: одно сообщение об этом, дальше тишина; админу лимит не мешает", async () => {
    const { deps, repo, requests } = setup();
    setChatLimit(repo, "user", 1);
    await send(deps, groupText("раз"));
    const over = await send(deps, groupText("два"));
    expect(over.find((s) => s.method === "sendMessage")!.payload.text).toMatch(/наговорился/);
    expect((await send(deps, groupText("три"))).filter((s) => s.method === "sendMessage")).toHaveLength(0);
    expect(requests).toHaveLength(1);
    await send(deps, groupText("админ", { userId: 99 }), 99);
    await send(deps, groupText("админ ещё", { userId: 99 }), 99);
    expect(requests).toHaveLength(3);
  });

  it("реплики без обращения не трогают модель, команды уходят дальше", async () => {
    const { deps, requests } = setup();
    expect(await send(deps, groupText("просто болтаем", { mention: false }))).toEqual([]);
    expect(await send(deps, groupText("/start@vish_bot", { mention: false }))).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("effort: не шлётся моделям, которые его не знают, и отключается после отказа API", async () => {
    const { qa } = setup();
    const input = { chatTitle: null, speaker: "Аня", speakerId: 7, text: "привет", history: [], transcript: [], repliedTo: null, now: { date: todayMsk(), minutes: 600 } };
    const noop: ChatClient = { messages: { create: async () => fakeMessage("ok") } };
    expect(new ChatService(null, { model: "claude-haiku-4-5", contextMessages: 0, botUsername: null }, qa, noop).buildRequest(input, []).output_config).toBeUndefined();
    const sonnet = new ChatService(null, { model: "claude-sonnet-5", contextMessages: 0, botUsername: null }, qa, noop);
    expect(sonnet.buildRequest(input, []).output_config).toEqual({ effort: "low" });
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const seen: unknown[] = [];
    const picky: ChatClient = {
      messages: {
        create: async (params) => {
          seen.push(params.output_config);
          if (params.output_config) throw new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "effort is not supported" } }, "effort is not supported", new Headers());
          return fakeMessage("без effort");
        },
      },
    };
    const svc = new ChatService(null, { model: "future-model", contextMessages: 0, botUsername: null }, qa, picky);
    expect((await svc.reply(input)).text).toBe("без effort");
    expect(seen).toEqual([{ effort: "low" }, undefined]);
    await svc.reply(input);
    expect(seen).toHaveLength(3);
  });

  it("отказ модели — короткая фраза вместо пустоты", async () => {
    const { deps, repo, qa } = setup();
    const chat = new ChatService(null, { model: "m", contextMessages: 10, botUsername: "vish_bot" }, qa, { messages: { create: async () => fakeMessage("", "refusal") } });
    const sent = await send({ ...deps, chat } as Deps, groupText("что-то плохое"));
    expect(sent.find((s) => s.method === "sendMessage")!.payload.text).toMatch(/не буду/);
    expect(repo.chatUsage({ chatId: CHAT }, todayMsk())).toBe(1);
  });

  it("бота добавил админ — чат включён сразу; добавил кто-то другой — выключен", async () => {
    const { deps, repo } = setup({ enabled: false });
    const added = (chatId: number, by: number): Update => ({
      update_id: nextId++,
      my_chat_member: { chat: { id: chatId, type: "supergroup", title: `Чат ${chatId}` }, from: { id: by, is_bot: false, first_name: "A" }, date: 0, old_chat_member: { status: "left", user: ME }, new_chat_member: { status: "member", user: ME } },
    });
    const hello = await send(deps, added(-100500, 99), 99);
    expect(repo.chatGroup(-100500)).toMatchObject({ enabled: true, present: true });
    expect(String(hello.find((s) => s.method === "sendMessage")!.payload.text)).toContain("@vish_bot");
    await send(deps, added(-100600, 7), 7);
    expect(repo.chatGroup(-100600)).toMatchObject({ enabled: false, present: true });
  });

  it("/soon стирает реплики, но не расход", async () => {
    const { deps, repo } = setup();
    await send(deps, groupText("привет"));
    repo.forgetUser(7);
    expect(repo.recentChat(CHAT, 7, 60_000, 5)).toEqual([]);
    expect(repo.chatUsage({ userId: 7 }, todayMsk())).toBe(1);
  });
});

describe("админка болталки", () => {
  const privateText = (text: string): Update => ({
    update_id: nextId++,
    message: { message_id: nextId, date: 0, chat: { id: 99, type: "private", first_name: "A" }, from: { id: 99, is_bot: false, first_name: "A" }, text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] },
  });
  const press = (data: string): Update => ({
    update_id: nextId++,
    callback_query: { id: "1", from: { id: 99, is_bot: false, first_name: "A" }, chat_instance: "1", data, message: { message_id: 3, date: 0, chat: { id: 99, type: "private", first_name: "A" }, text: "x" } as never },
  });

  it("экран лимитов и чатов, кнопки меняют лимит и включают чат", async () => {
    const { deps, repo } = setup({ enabled: false });
    repo.upsertChatGroup(CHAT, { title: "ВИШ-12-23", present: true });
    const screen = await send(deps, press("adm:chat"), 99, chatAdminHandlers);
    const text = String(screen.find((s) => s.method === "editMessageText")!.payload.text);
    expect(text).toContain("Болталка в группах");
    expect(text).toContain("модель <code>test-model</code>");
    expect(text).toContain("⛔ ВИШ-12-23");
    await send(deps, press(`chg:${CHAT}`), 99, chatAdminHandlers);
    expect(repo.chatGroup(CHAT)!.enabled).toBe(true);
    await send(deps, press("chl:user:up"), 99, chatAdminHandlers);
    expect(repo.getMeta("chat:limit:user")).toBe("30");
  });

  it("/qa_add и /qa_test", async () => {
    const { deps, qa } = setup();
    const added = await send(deps, privateText("/qa_add как дела | как ты = Лучше всех! = шутливо"), 99, chatAdminHandlers);
    expect(String(added[0]!.payload.text)).toMatch(/Добавил/);
    expect(qa.match("как ты")[0]!.entry).toMatchObject({ answer: "Лучше всех!", hint: "шутливо" });
    const test = await send(deps, privateText("/qa_test ну как ты"), 99, chatAdminHandlers);
    expect(String(test[0]!.payload.text)).toContain("Лучше всех!");
  });

  it("обычному человеку админка недоступна", async () => {
    const { deps } = setup();
    const u = privateText("/qa_add а = б");
    (u.message as { from: { id: number } }).from.id = 7;
    expect(await send(deps, u, 7, chatAdminHandlers)).toEqual([]);
  });
});
