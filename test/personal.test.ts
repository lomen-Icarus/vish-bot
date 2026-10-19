import { beforeEach, describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import type Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { QaBase } from "../src/chat/qa.js";
import { ChatService, type ChatClient } from "../src/chat/service.js";
import { makeEntry, parsePercent, parsePersonal, parseWho, PersonalReplies, personalLine, pickPersonal } from "../src/chat/personal.js";
import { chatClock, groupChatHandlers, resetChatCooldowns, resetGroupChatState } from "../src/bot/handlers/groupChat.js";
import { chatAdminHandlers, parseQpAdd } from "../src/bot/handlers/chatAdmin.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import { todayMsk, wallClock } from "../src/time.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
const CHAT = -1001234567890;

function tmpFile(name: string, content?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "chatqp-"));
  const file = path.join(dir, name);
  if (content !== undefined) writeFileSync(file, content, "utf8");
  return file;
}

describe("личные ответы: разбор файла", () => {
  it("ник с @, без него, ссылкой и id; проценты «30», «30%», «2,5»", () => {
    expect(parseWho("@Ivan_P")).toEqual({ username: "ivan_p", userId: null });
    expect(parseWho("https://t.me/kira_s")).toEqual({ username: "kira_s", userId: null });
    expect(parseWho("123456789")).toEqual({ username: null, userId: 123456789 });
    expect(parseWho("Иван")).toBeNull();
    expect(parsePercent("30")).toBe(30);
    expect(parsePercent("30%")).toBe(30);
    expect(parsePercent("2,5")).toBe(2.5);
    expect(parsePercent("0")).toBe(0);
    expect(parsePercent("150")).toBeNull();
    expect(parsePercent("часто")).toBeNull();
  });

  it("заголовок и комментарии пропускаются, «;» в сообщении без кавычек не режет его, гифка — медиа", () => {
    const r = parsePersonal("ник;частота;сообщение\n# комментарий\n@ivan;30;Ваня, опять ты?\n@kira;100%;gif:ABC Кира пришла\n@petya;20;привет; как дела\nбез частоты;;текст\n@nobody;10;\n");
    expect(r.entries.map((e) => [e.username, e.percent, e.answer, e.media])).toEqual([
      ["ivan", 30, "Ваня, опять ты?", null],
      ["kira", 100, "Кира пришла", { kind: "gif", fileId: "ABC" }],
      ["petya", 20, "привет; как дела", null],
    ]);
    expect(r.skipped).toBe(2);
  });

  it("строка из /qp_add читается обратно без потерь; правка текста меняет метку «первого раза»", () => {
    const e = makeEntry({ username: "ivan", userId: null }, 2.5, 'текст; с "кавычками"\nи переносом')!;
    const back = parsePersonal(`ник;частота;сообщение\n${personalLine(e)}\n`).entries[0]!;
    expect(back).toEqual(e);
    expect(makeEntry({ username: "ivan", userId: null }, 2.5, "другой текст")!.key).not.toBe(e.key);
    // Частота на ключ не влияет: поменял шанс — первый раз второй раз не придёт.
    expect(makeEntry({ username: "ivan", userId: null }, 50, 'текст; с "кавычками"\nи переносом')!.key).toBe(e.key);
  });

  it("/qp_add: «@ник 30 текст», «@ник;30%;текст», гифка без текста; без частоты — нет", () => {
    expect(parseQpAdd("@ivan 30 Ваня, привет", null)).toMatchObject({ username: "ivan", percent: 30, answer: "Ваня, привет" });
    expect(parseQpAdd("@ivan;30%;Ваня", null)).toMatchObject({ username: "ivan", percent: 30, answer: "Ваня" });
    expect(parseQpAdd("@ivan 5", { kind: "gif", fileId: "X" })).toMatchObject({ percent: 5, answer: "", media: { kind: "gif", fileId: "X" } });
    expect(parseQpAdd("@ivan 5", null)).toBeNull();
    expect(parseQpAdd("@ivan Ваня привет", null)).toBeNull();
  });
});

describe("личные ответы: первый раз — всегда, дальше по шансу", () => {
  const entries = parsePersonal("ник;частота;сообщение\n@ivan;30;Ваня!\n").entries;
  const from = { id: 7, username: "Ivan" };

  it("первый раз — без броска; потом шанс с точностью до сотой процента", () => {
    const never = (): number => 9999;
    expect(pickPersonal(entries, from, () => false, never)).toMatchObject({ first: true, entry: { answer: "Ваня!" } });
    expect(pickPersonal(entries, from, () => true, never)).toBeNull();
    // 30% — это броски 0…2999 из 10000.
    expect(pickPersonal(entries, from, () => true, () => 2999)).toMatchObject({ first: false });
    expect(pickPersonal(entries, from, () => true, () => 3000)).toBeNull();
  });

  it("чужим и людям без ника — ничего; 0% — только первый раз; 100% — всегда", () => {
    expect(pickPersonal(entries, { id: 8, username: "petya" }, () => false, () => 0)).toBeNull();
    expect(pickPersonal(entries, { id: 8 }, () => false, () => 0)).toBeNull();
    const zero = parsePersonal("ник;частота;сообщение\n@ivan;0;раз\n").entries;
    expect(pickPersonal(zero, from, () => true, () => 0)).toBeNull();
    const all = parsePersonal("ник;частота;сообщение\n@ivan;100;всегда\n").entries;
    expect(pickPersonal(all, from, () => true, () => 9999)).toMatchObject({ first: false });
  });
});

function fakeMessage(text: string): Anthropic.Message {
  return { id: "m", type: "message", role: "assistant", model: "test", content: [{ type: "text", text, citations: null }], stop_reason: "end_turn", stop_sequence: null, stop_details: null, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as Anthropic.Message;
}

function setup(personalCsv: string) {
  const repo = new Repo(openDatabase(":memory:"));
  const qa = new QaBase(tmpFile("qa.csv", "вопрос;ответ\nсосал?;Заготовка админа\n"));
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: ChatClient = {
    messages: {
      create: async (params) => {
        requests.push(structuredClone(params));
        return fakeMessage("ответ ИИ");
      },
    },
  };
  const chat = new ChatService(null, { model: "test-model", contextMessages: 30, botUsername: "vish_bot" }, qa, client);
  const personal = new PersonalReplies(tmpFile("personal.csv", personalCsv));
  const config = { ADMIN_IDS: [99], CHAT_AI: true, CHAT_GROUP_IDS: [], CHAT_DAILY_LIMIT_PER_USER: 20, CHAT_DAILY_LIMIT_PER_CHAT: 150, CHAT_DAILY_LIMIT_GLOBAL: 400, BOT_TOKEN: "123:FAKE" } as unknown as Deps["config"];
  const deps = { config, repo, chat, personal, pending: new Map() } as unknown as Deps;
  repo.upsertChatGroup(CHAT, { title: "ВИШ-12-23", enabled: true });
  chatClock.now = () => ({ ...wallClock(), minutes: 12 * 60 });
  return { deps, repo, requests, personal };
}

interface Sent {
  method: string;
  payload: Record<string, unknown>;
}

async function send(deps: Deps, update: Update, userId = 7, composer: Composer<BotContext> = groupChatHandlers): Promise<Sent[]> {
  resetChatCooldowns();
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
function message(text: string, opts: { userId?: number; username?: string; mention?: boolean; type?: "supergroup" | "private" } = {}): Update {
  const userId = opts.userId ?? 7;
  const mention = opts.mention !== false;
  const full = mention ? `@vish_bot ${text}` : text;
  const chat = opts.type === "private" ? { id: userId, type: "private" as const, first_name: "Ваня" } : { id: CHAT, type: "supergroup" as const, title: "ВИШ-12-23" };
  return {
    update_id: nextId,
    message: {
      message_id: nextId++,
      date: 0,
      chat,
      from: { id: userId, is_bot: false, first_name: "Ваня", ...(opts.username ? { username: opts.username } : {}) },
      text: full,
      ...(mention ? { entities: [{ type: "mention" as const, offset: 0, length: 9 }] } : {}),
    },
  } as Update;
}

const texts = (sent: Sent[]): unknown[] => sent.filter((s) => s.method === "sendMessage").map((s) => s.payload.text);

const realRandom = chatClock.random;

describe("личные ответы в групповом чате", () => {
  beforeEach(() => {
    resetGroupChatState();
    chatClock.random = realRandom;
  });

  it("первое обращение — личный ответ вместо ИИ и без лимита; дальше — по шансу, не выпал — отвечает ИИ", async () => {
    const { deps, repo, requests } = setup("ник;частота;сообщение\n@ivan;30;Ваня, опять ты?\n");
    chatClock.random = () => 9999;
    expect(texts(await send(deps, message("привет", { username: "Ivan" })))).toEqual(["Ваня, опять ты?"]);
    expect(requests).toHaveLength(0);
    expect(repo.chatUsage({ userId: 7 }, todayMsk())).toBe(0);
    // Первый раз уже был, бросок не выпал — обычный ответ ИИ.
    expect(texts(await send(deps, message("а где пара", { username: "Ivan" })))).toEqual(["ответ ИИ"]);
    expect(requests).toHaveLength(1);
    // Выпал — снова личный.
    chatClock.random = () => 0;
    expect(texts(await send(deps, message("ну что", { username: "Ivan" })))).toEqual(["Ваня, опять ты?"]);
    expect(requests).toHaveLength(1);
  });

  it("«первый раз» — один за всё время: переживает перезапуск (метка в базе)", async () => {
    const { deps } = setup("ник;частота;сообщение\n@ivan;0;только раз\n");
    expect(texts(await send(deps, message("привет", { username: "ivan" })))).toEqual(["только раз"]);
    resetGroupChatState();
    expect(texts(await send(deps, message("привет", { username: "ivan" })))).toEqual(["ответ ИИ"]);
  });

  it("без обращения к боту, в личке и другим людям — не срабатывает", async () => {
    const { deps, requests } = setup("ник;частота;сообщение\n@ivan;100;Ваня!\n");
    expect(texts(await send(deps, message("просто болтаю", { username: "ivan", mention: false })))).toEqual([]);
    expect(texts(await send(deps, message("привет", { username: "ivan", type: "private" })))).toEqual([]);
    expect(texts(await send(deps, message("привет", { userId: 8, username: "petya" }), 8))).toEqual(["ответ ИИ"]);
    expect(requests).toHaveLength(1);
  });

  it("гифка в личном ответе уходит гифкой с подписью", async () => {
    const { deps } = setup("ник;частота;сообщение\n@ivan;100;gif:GIF1 Ваня пришёл\n");
    const sent = await send(deps, message("привет", { username: "ivan" }));
    const anim = sent.find((s) => s.method === "sendAnimation")!;
    expect(anim.payload).toMatchObject({ animation: "GIF1", caption: "Ваня пришёл" });
  });

  it("старый сценарий не сломан: людям не из файла гифка-заготовка и ИИ работают как раньше", async () => {
    const { deps, requests } = setup("ник;частота;сообщение\n@ivan;100;Ваня!\n");
    expect(texts(await send(deps, message("сосал?", { userId: 8, username: "petya" }), 8))).toEqual(["ответ ИИ"]);
    expect(requests).toHaveLength(1);
  });

  it("админ: /qp_add дописывает строку в файл, /qp_del @ник её убирает", async () => {
    const { deps, personal } = setup("ник;частота;сообщение\n@ivan;30;Ваня!\n");
    const add = await send(deps, { update_id: 1, message: { message_id: 1, date: 0, chat: { id: 99, type: "private", first_name: "A" }, from: { id: 99, is_bot: false, first_name: "A" }, text: "/qp_add @kira 50 Кира, привет", entities: [{ type: "bot_command", offset: 0, length: 7 }] } } as Update, 99, chatAdminHandlers);
    expect(String(add[0]!.payload.text)).toContain("Личных ответов теперь: 2");
    expect(readFileSync(personal.file, "utf8")).toContain("@kira;50;Кира, привет");
    await send(deps, { update_id: 2, message: { message_id: 2, date: 0, chat: { id: 99, type: "private", first_name: "A" }, from: { id: 99, is_bot: false, first_name: "A" }, text: "/qp_del @ivan", entities: [{ type: "bot_command", offset: 0, length: 7 }] } } as Update, 99, chatAdminHandlers);
    expect(personal.entries().map((e) => e.username)).toEqual(["kira"]);
  });
});
