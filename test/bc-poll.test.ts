/**
 * Опрос в рассылке админа: бот шлёт каждому свой анонимный опрос, голоса
 * собирает из обновлений poll (в МАКС — кнопками) и показывает админу итоги.
 */
import { describe, expect, it } from "vitest";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { createBot } from "../src/bot/index.js";
import { tallyText } from "../src/bot/handlers/bcPoll.js";
import { MAX_UID_BASE } from "../src/max/store.js";
import type { Deps, PendingState } from "../src/bot/context.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
const ADMIN = 900;
const A = 7;
const B = 8;
const MAXU = MAX_UID_BASE + 5;
type Call = { method: string; payload: Record<string, unknown> };

function setup() {
  const repo = new Repo(openDatabase(":memory:"));
  for (const id of [ADMIN, A, B]) repo.touchUser(id, null, "U");
  const deps = {
    repo,
    config: { ADMIN_IDS: [ADMIN], SUPPORT_CONTACT: "@support", POISK: false, BOT_TOKEN: "123:FAKE-TOKEN-FOR-TESTS-ONLY", NEWS_CHANNEL_IDS: [], MEDIA_CHAT_IDS: [] },
    service: { group: () => null, groups: () => [], materialize: () => [], intakes: () => [], stream: () => [] },
    renderer: null,
    ask: null,
    teachers: null,
    students: null,
    known: null,
    http: null,
    inline: false,
    botUsername: "vish_bot",
    pending: new Map<number, PendingState>(),
    startedAt: new Date(),
  } as unknown as Deps;
  const bot = createBot(deps);
  bot.botInfo = ME;
  const calls: Call[] = [];
  let next = 5000;
  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>;
    calls.push({ method, payload: p });
    const id = next++;
    if (method === "sendPoll") return { ok: true, result: { message_id: id, date: 0, chat: { id: p.chat_id, type: "private" }, poll: { id: `tgp-${String(p.chat_id)}` } } as never };
    return { ok: true, result: { message_id: id, date: 0, chat: { id: p.chat_id, type: "private" } } as never };
  });
  return { repo, deps, bot, calls };
}

let uid = 100;
const from = (id: number) => ({ id, is_bot: false, first_name: "U" });
const chat = (id: number) => ({ id, type: "private" as const, first_name: "U" });
const pollMsg = (opts: { type?: "regular" | "quiz"; multiple?: boolean } = {}): Update => ({
  update_id: uid,
  message: {
    message_id: uid++,
    date: 0,
    chat: chat(ADMIN),
    from: from(ADMIN),
    poll: {
      id: "admin-poll",
      question: "Нужен бот в МАКС?",
      options: ["Хз", "Буду", "Не буду"].map((text) => ({ text, voter_count: 0 })),
      total_voter_count: 0,
      is_closed: false,
      is_anonymous: false,
      type: opts.type ?? "regular",
      allows_multiple_answers: opts.multiple ?? false,
    },
  } as never,
});
const text = (t: string, id = ADMIN): Update => ({ update_id: uid, message: { message_id: uid++, date: 0, chat: chat(id), from: from(id), text: t, ...(t.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: t.split(" ")[0]!.length }] } : {}) } });
const press = (data: string, id = ADMIN, messageId = 3): Update => ({ update_id: uid++, callback_query: { id: "cb", from: from(id), chat_instance: "1", data, message: { message_id: messageId, date: 0, chat: chat(id), text: "x" } as never } });
const vote = (tgPollId: string, chosen: number[]): Update => ({
  update_id: uid++,
  poll: { id: tgPollId, question: "Нужен бот в МАКС?", options: [0, 1, 2].map((i) => ({ text: String(i), voter_count: chosen.includes(i) ? 1 : 0 })), total_voter_count: chosen.length ? 1 : 0, is_closed: false, is_anonymous: true, type: "regular", allows_multiple_answers: false },
});

async function broadcastPoll(s: ReturnType<typeof setup>, opts: { multiple?: boolean } = {}): Promise<number> {
  await s.bot.handleUpdate(text("/broadcast"));
  const msg = pollMsg(opts);
  await s.bot.handleUpdate(msg);
  await s.bot.handleUpdate(press("bc:all"));
  await s.bot.handleUpdate(press(`bc:go:${msg.message!.message_id}`));
  const report = s.calls.filter((c) => c.method === "sendMessage").pop()!;
  const kb = JSON.stringify(report.payload.reply_markup);
  return Number(/bpr:(\d+)/.exec(kb)![1]);
}

describe("опрос в рассылке", () => {
  it("каждому — свой анонимный опрос от бота, не копия; под отчётом — «📊 Итоги опроса»", async () => {
    const s = setup();
    await s.bot.handleUpdate(text("/broadcast"));
    const msg = pollMsg({ multiple: true });
    await s.bot.handleUpdate(msg);
    await s.bot.handleUpdate(press("bc:all"));
    const confirm = s.calls.filter((c) => c.method === "editMessageText").pop()!;
    expect(String(confirm.payload.text)).toContain("анонимным");
    // У опроса нет текста — на доску вешать нечего.
    expect(JSON.stringify(confirm.payload.reply_markup)).not.toContain("bc:board");
    s.calls.length = 0;
    await s.bot.handleUpdate(press(`bc:go:${msg.message!.message_id}`));
    expect(s.calls.some((c) => c.method === "copyMessage")).toBe(false);
    const polls = s.calls.filter((c) => c.method === "sendPoll");
    expect(polls.map((c) => c.payload.chat_id).sort()).toEqual([A, B, ADMIN].sort());
    expect(polls[0]!.payload).toMatchObject({ question: "Нужен бот в МАКС?", options: [{ text: "Хз" }, { text: "Буду" }, { text: "Не буду" }], is_anonymous: true, allows_multiple_answers: true });
    const report = s.calls.filter((c) => c.method === "sendMessage").pop()!;
    expect(String(report.payload.text)).toContain("доставлено 3");
    expect(JSON.stringify(report.payload.reply_markup)).toMatch(/📊 Итоги опроса.*bpr:\d+/);
    expect(s.repo.bcPoll(1)).toMatchObject({ sent: 3, multiple: true });
  });

  it("голоса из обновлений poll складываются в итоги; передумал — голос переезжает, отозвал — пропадает", async () => {
    const s = setup();
    const id = await broadcastPoll(s);
    await s.bot.handleUpdate(vote(`tgp-${A}`, [1]));
    await s.bot.handleUpdate(vote(`tgp-${B}`, [1]));
    await s.bot.handleUpdate(vote(`tgp-${ADMIN}`, [0]));
    expect(s.repo.bcPollTally(id, 3)).toEqual({ counts: [1, 2, 0], voters: 3 });
    await s.bot.handleUpdate(vote(`tgp-${B}`, [2]));
    await s.bot.handleUpdate(vote(`tgp-${ADMIN}`, []));
    expect(s.repo.bcPollTally(id, 3)).toEqual({ counts: [0, 1, 1], voters: 2 });
    // Чужой опрос (не из рассылки) ничего не меняет.
    await s.bot.handleUpdate(vote("someone-else", [0]));
    expect(s.repo.bcPollTally(id, 3).voters).toBe(2);
  });

  it("итоги: админ видит цифры и «🔄 Обновить»; студенту кнопка ничего не покажет", async () => {
    const s = setup();
    const id = await broadcastPoll(s);
    await s.bot.handleUpdate(vote(`tgp-${A}`, [1]));
    s.calls.length = 0;
    await s.bot.handleUpdate(press(`bpr:${id}`));
    const shown = s.calls.find((c) => c.method === "sendMessage")!;
    expect(String(shown.payload.text)).toContain("Проголосовали: <b>1</b> из 3");
    expect(String(shown.payload.text)).toContain("100% · <b>1</b> — Буду");
    expect(JSON.stringify(shown.payload.reply_markup)).toContain(`bpr:${id}:u`);
    await s.bot.handleUpdate(press(`bpr:${id}:u`));
    expect(s.calls.some((c) => c.method === "editMessageText")).toBe(true);
    s.calls.length = 0;
    await s.bot.handleUpdate(press(`bpr:${id}`, A));
    expect(s.calls.some((c) => c.method === "sendMessage" && String(c.payload.text).includes("Итоги"))).toBe(false);
  });

  it("викторину не рассылает и ждёт другое сообщение", async () => {
    const s = setup();
    await s.bot.handleUpdate(text("/broadcast"));
    await s.bot.handleUpdate(pollMsg({ type: "quiz" }));
    expect(String(s.calls.pop()!.payload.text)).toContain("Викторину разослать не могу");
    expect(s.deps.pending.get(ADMIN)?.kind).toBe("broadcast");
  });

  it("обычная рассылка (текст) — по-прежнему копией", async () => {
    const s = setup();
    await s.bot.handleUpdate(text("/broadcast"));
    const msg = text("Завтра пар нет");
    await s.bot.handleUpdate(msg);
    await s.bot.handleUpdate(press("bc:all"));
    s.calls.length = 0;
    await s.bot.handleUpdate(press(`bc:go:${msg.message!.message_id}`));
    expect(s.calls.filter((c) => c.method === "copyMessage")).toHaveLength(3);
    expect(s.calls.some((c) => c.method === "sendPoll")).toBe(false);
  });

  it("в МАКС опрос — кнопками: один вариант переключается, несколько — отмечаются и снимаются", async () => {
    const s = setup();
    s.repo.touchUser(MAXU, null, "Аня");
    const id = await broadcastPoll(s);
    const sent = s.calls.find((c) => c.method === "sendMessage" && c.payload.chat_id === MAXU)!;
    expect(String(sent.payload.text)).toContain("Нужен бот в МАКС?");
    expect(JSON.stringify(sent.payload.reply_markup)).toContain(`bpv:${id}:2`);
    expect(s.calls.some((c) => c.method === "sendPoll" && c.payload.chat_id === MAXU)).toBe(false);
    await s.bot.handleUpdate(press(`bpv:${id}:1`, MAXU));
    await s.bot.handleUpdate(press(`bpv:${id}:2`, MAXU));
    expect(s.repo.bcPollTally(id, 3)).toEqual({ counts: [0, 0, 1], voters: 1 });
    expect(JSON.stringify(s.calls.filter((c) => c.method === "editMessageReplyMarkup").pop()!.payload.reply_markup)).toContain("✅ Не буду");

    const m = await broadcastPoll(s, { multiple: true });
    await s.bot.handleUpdate(press(`bpv:${m}:0`, MAXU));
    await s.bot.handleUpdate(press(`bpv:${m}:2`, MAXU));
    expect(s.repo.bcPollVote(m, `u:${MAXU}`)).toEqual([0, 2]);
    await s.bot.handleUpdate(press(`bpv:${m}:0`, MAXU));
    expect(s.repo.bcPollTally(m, 3)).toEqual({ counts: [0, 0, 1], voters: 1 });
  });

  it("итоги без голосов — нули, без деления на ноль", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const id = repo.createBcPoll("Вопрос?", ["Да", "Нет"], false, ADMIN);
    repo.setBcPollSent(id, 10);
    const t = tallyText(repo, repo.bcPoll(id)!);
    expect(t).toContain("░░░░░░░░░░ 0% · <b>0</b> — Да");
    expect(t).toContain("Проголосовали: <b>0</b> из 10.");
  });
});
