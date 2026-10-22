import { describe, expect, it } from "vitest";
import { Api, InlineKeyboard, InputFile, Keyboard } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { loadConfig } from "../src/config.js";
import { createBot } from "../src/bot/index.js";
import { menuFor } from "../src/bot/keyboards.js";
import type { Deps } from "../src/bot/context.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import { todayMsk } from "../src/time.js";
import { MaxBridge } from "../src/max/bridge.js";
import { entitiesToHtml, markupToButtons, rewriteBotLinks } from "../src/max/format.js";
import { isMaxChat, MAX_UID_BASE, MaxMessageStore } from "../src/max/store.js";
import { toTelegramUpdate } from "../src/max/updates.js";
import type { MaxUpdate } from "../src/max/api.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };

describe("МАКС: текст и кнопки", () => {
  it("разметка Telegram → HTML с вложенностью и экранированием", () => {
    const text = "Важно: <пары> завтра";
    expect(
      entitiesToHtml(text, [
        { type: "bold", offset: 0, length: 6 },
        { type: "italic", offset: 0, length: 5 },
        { type: "text_link", offset: 14, length: 6, url: 'https://x.ru/?a="1"' },
      ]),
    ).toBe('<b><i>Важно</i>:</b> &lt;пары&gt; <a href="https://x.ru/?a=&quot;1&quot;">завтра</a>');
    expect(entitiesToHtml("a<b", undefined)).toBe("a&lt;b");
  });

  it("кнопки под сообщением: callback и ссылка остаются, inline-режима у МАКС нет", () => {
    const kb = new InlineKeyboard().text("◀️ 20.10", "d:2026-10-20").url("Сайт", "https://tt.chuvsu.ru").row().switchInline("В чат", "неделя");
    expect(markupToButtons(kb)).toEqual([
      [
        { type: "callback", text: "◀️ 20.10", payload: "d:2026-10-20" },
        { type: "link", text: "Сайт", url: "https://tt.chuvsu.ru" },
      ],
    ]);
  });

  it("нижнее меню → кнопки «message»: подпись приходит боту как сообщение", () => {
    expect(markupToButtons(new Keyboard().text("📅 Сегодня").text("📅 Завтра"))).toEqual([[
      { type: "message", text: "📅 Сегодня" },
      { type: "message", text: "📅 Завтра" },
    ]]);
    expect(markupToButtons({ remove_keyboard: true })).toBeNull();
  });

  it("ссылки t.me/бот?start= ведут на того же бота в МАКС", () => {
    expect(rewriteBotLinks('<a href="https://t.me/vish_bot?start=ics_1">файл</a> t.me/other', "vish_bot", "id123_bot")).toBe('<a href="https://max.ru/id123_bot?start=ics_1">файл</a> t.me/other');
    expect(rewriteBotLinks("https://t.me/vish_bot2", "vish_bot", "id123_bot")).toBe("https://t.me/vish_bot2");
  });
});

describe("МАКС: uid и события", () => {
  it("uid выдаётся от 2^52, один на человека, и не путается с чатами Telegram", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const a = repo.maxUid(555, MAX_UID_BASE);
    const b = repo.maxUid(777, MAX_UID_BASE);
    expect(a).toBe(MAX_UID_BASE + 1);
    expect(b).toBe(MAX_UID_BASE + 2);
    expect(repo.maxUid(555, MAX_UID_BASE)).toBe(a);
    expect(repo.maxIdOf(b)).toBe(777);
    expect(Number.isSafeInteger(b)).toBe(true);
    expect(isMaxChat(a)).toBe(true);
    expect(isMaxChat(-1001234567890)).toBe(false);
    expect(isMaxChat(2 ** 52 - 1)).toBe(false);
  });

  const deps = () => ({ uid: (id: number) => MAX_UID_BASE + id, messages: new MaxMessageStore(), bot: ME });
  const msg = (text: string, chatType = "dialog") => ({ sender: { user_id: 5, first_name: "Аня", username: "anya" }, recipient: { chat_id: 99, chat_type: chatType, user_id: 1 }, timestamp: 1_760_000_000_000, body: { mid: "mid.1", text } });

  it("сообщение с командой — с разметкой bot_command и без ника из МАКС", () => {
    const u = toTelegramUpdate({ update_type: "message_created", timestamp: 0, message: msg("/today") } as MaxUpdate, 1, deps());
    expect(u?.message?.chat).toMatchObject({ id: MAX_UID_BASE + 5, type: "private" });
    expect(u?.message?.from).toEqual({ id: MAX_UID_BASE + 5, is_bot: false, first_name: "Аня" });
    expect(u?.message?.entities).toEqual([{ type: "bot_command", offset: 0, length: 6 }]);
    expect(u?.message?.date).toBe(1_760_000_000);
  });

  it("групповой чат МАКС мосту не нужен", () => {
    expect(toTelegramUpdate({ update_type: "message_created", timestamp: 0, message: msg("привет", "chat") } as MaxUpdate, 1, deps())).toBeNull();
  });

  it("нажатие кнопки → callback_query; сообщение с картинкой выглядит как фото", () => {
    const d = deps();
    const u = toTelegramUpdate(
      {
        update_type: "message_callback",
        timestamp: 0,
        callback: { callback_id: "cb1", payload: "d:2026-10-21", user: { user_id: 5, first_name: "Аня" }, timestamp: 0 },
        message: { recipient: { chat_id: 99, chat_type: "dialog", user_id: 5 }, timestamp: 0, body: { mid: "mid.9", text: "день", attachments: [{ type: "image", payload: { token: "t", url: "https://i/1.png" } }] } },
      } as MaxUpdate,
      2,
      d,
    );
    expect(u?.callback_query?.id).toBe("max:cb1");
    expect(u?.callback_query?.data).toBe("d:2026-10-21");
    const m = u?.callback_query?.message as { message_id: number; photo?: unknown[]; caption?: string };
    expect(m.photo).toHaveLength(1);
    expect(m.caption).toBe("день");
    expect(d.messages.get(m.message_id)).toMatchObject({ mid: "mid.9", media: [{ type: "image", payload: { token: "t" } }] });
  });

  it("«Начать» со ссылки max.ru/бот?start=… — /start с параметром", () => {
    const u = toTelegramUpdate({ update_type: "bot_started", timestamp: 0, chat_id: 99, user: { user_id: 5, first_name: "Аня" }, payload: "ics_abc" } as MaxUpdate, 3, deps());
    expect(u?.message?.text).toBe("/start ics_abc");
    expect(u?.message?.entities?.[0]).toMatchObject({ type: "bot_command", length: 6 });
  });
});

// ---- сквозной путь: человек в МАКС → тот же бот → ответ в МАКС ----

const group: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [8524], portalNames: ["ВИШ-12-23"] };
const today = todayMsk();
const lesson: Occurrence = { groupKey: group.key, period: 1, date: today, slot: 3, start: 11 * 60 + 40, end: 13 * 60, subject: "Патентоведение", type: "лк", room: "Т-310", teacher: null, subgroup: null, isDistance: false, status: "scheduled", sources: [group.title] };

function service(): ScheduleService {
  return {
    group: (key: string) => (key === group.key ? group : null),
    groups: () => [group],
    stream: () => [group],
    intakes: () => [23],
    lessonsOn: () => [lesson],
    materialize: () => [lesson],
    weekInfo: () => ({ week: 3, parity: "odd" as const, semester: 1 as const }),
    semesterFor: () => 1 as const,
    weekOneMonday: () => "2026-09-01",
  } as unknown as ScheduleService;
}

interface MaxCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Record<string, unknown> | null;
}

function setup(opts: { ask?: boolean } = {}) {
  const repo = new Repo(openDatabase(":memory:"));
  const calls: MaxCall[] = [];
  let mid = 0;
  const fakeFetch = (async (input: URL | string, init?: { method?: string; body?: unknown }) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    if (url.pathname === "/me") return json({ user_id: 900, username: "id2130000000_bot" });
    if (url.pathname === "/messages" && init?.method === "POST") return json({ message: { recipient: { chat_id: 1, chat_type: "dialog", user_id: 5 }, timestamp: 0, body: { mid: `mid.${++mid}`, text: null } } });
    if (url.pathname === "/uploads") return json({ url: "https://upload.max.example/u1" });
    if (url.host === "upload.max.example") return json({ photos: { p1: { token: "photo-token" } } });
    return json({ success: true });
  }) as never;
  const config = loadConfig({ BOT_TOKEN: `123456:${"x".repeat(30)}`, ADMIN_IDS: "42" } as NodeJS.ProcessEnv);
  const max = new MaxBridge({ token: "max-token", repo, botToken: config.BOT_TOKEN, newsChatIds: [], menuFor, fetch: fakeFetch });
  const deps: Deps = { config, repo, service: service(), renderer: null, ask: opts.ask ? ({} as Deps["ask"]) : null, teachers: null, webinars: null, students: null, known: null, news: null, http: null, inline: false, botUsername: "vish_bot", pending: new Map(), startedAt: new Date(), max };
  const bot = createBot(deps);
  bot.botInfo = ME;
  return { repo, calls, max, bot };
}

/** Меню по умолчанию кнопками «message» — то, что МАКС ставит под каждым сообщением. */
const MENU_ROWS = [
  ["📅 Сегодня", "📅 Завтра", "🗓 Неделя"],
  ["🔍 Найти с ИИ", "🗂 Ещё", "🙋 Поддержка"],
].map((row) => row.map((text) => ({ type: "message", text })));

type Btn = { type: string; text: string; payload?: string };
const buttonsOf = (c: MaxCall | undefined): Btn[][] => ((c?.body?.attachments as Array<{ type: string; payload: { buttons: Btn[][] } }> | undefined) ?? []).find((a) => a.type === "inline_keyboard")?.payload.buttons ?? [];

const textFromMax = (text: string): MaxUpdate =>
  ({ update_type: "message_created", timestamp: Date.now(), message: { sender: { user_id: 5, first_name: "Аня" }, recipient: { chat_id: 1, chat_type: "dialog", user_id: 900 }, timestamp: Date.now(), body: { mid: `in.${text}`, text } } }) as MaxUpdate;

describe("МАКС: тот же бот", () => {
  it("«📅 Сегодня» из МАКС — расписание дня с теми же кнопками, ответ уходит в МАКС", async () => {
    const { repo, calls, max, bot } = setup();
    const uid = max.uid(5);
    repo.touchUser(uid, null, "Аня");
    repo.updateUser(uid, { groupKey: group.key, format: "text" });
    await max.handle(bot, textFromMax("📅 Сегодня"));
    const sent = calls.filter((c) => c.path === "/messages" && c.method === "POST");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.query.user_id).toBe("5");
    expect(sent[0]!.body?.format).toBe("html");
    expect(String(sent[0]!.body?.text)).toContain("Патентоведение");
    const kb = (sent[0]!.body?.attachments as Array<{ type: string; payload: { buttons: Array<Array<{ type: string; payload?: string }>> } }>).find((a) => a.type === "inline_keyboard")!;
    expect(kb.payload.buttons.flat().some((b) => b.type === "callback" && b.payload?.startsWith("d:"))).toBe(true);
  });

  it("стрелка под днём правит то же сообщение в МАКС (PUT), а не шлёт новое", async () => {
    const { repo, calls, max, bot } = setup();
    const uid = max.uid(5);
    repo.touchUser(uid, null, "Аня");
    repo.updateUser(uid, { groupKey: group.key, format: "text" });
    await max.handle(bot, textFromMax("📅 Сегодня"));
    calls.length = 0;
    await max.handle(bot, {
      update_type: "message_callback",
      timestamp: Date.now(),
      callback: { callback_id: "cb7", payload: `d:${today}`, user: { user_id: 5, first_name: "Аня" }, timestamp: Date.now() },
      message: { recipient: { chat_id: 1, chat_type: "dialog", user_id: 5 }, timestamp: Date.now(), body: { mid: "mid.1", text: "старый день" } },
    } as MaxUpdate);
    const edit = calls.find((c) => c.path === "/messages" && c.method === "PUT");
    expect(edit?.query.message_id).toBe("mid.1");
    // Своё сообщение мост помнит с разметкой: голый текст из нажатия его не затирает.
    expect(max.messages.get(max.messages.idOf("mid.1")!)?.text).toContain("<b>");
    expect(String(edit?.body?.text)).toContain("Патентоведение");
    expect(calls.some((c) => c.path === "/messages" && c.method === "POST")).toBe(false);
  });

  it("уведомление через Api бота (как у Notifier) человеку из МАКС уходит в МАКС, с картинкой — загрузкой", async () => {
    const { repo, calls, max } = setup();
    const uid = max.uid(5);
    repo.touchUser(uid, null, "Аня");
    const tg: string[] = [];
    const api = new Api(`123456:${"x".repeat(30)}`);
    api.config.use(async (_prev, method) => {
      tg.push(method);
      return { ok: true, result: true as never };
    });
    api.config.use(max.transformer());
    await api.sendPhoto(uid, new InputFile(Buffer.from([1, 2, 3]), "day.png"), { caption: "<b>Пары</b>", parse_mode: "HTML", reply_markup: new InlineKeyboard().text("🔕 Отключить", "rm:off:first") });
    expect(tg).toEqual([]);
    const sent = calls.find((c) => c.path === "/messages" && c.method === "POST");
    expect(sent?.body?.text).toBe("<b>Пары</b>");
    expect(sent?.body?.attachments).toEqual([
      { type: "image", payload: { photos: { p1: { token: "photo-token" } } } },
      { type: "inline_keyboard", payload: { buttons: [[{ type: "callback", text: "🔕 Отключить", payload: "rm:off:first" }], ...MENU_ROWS] } },
    ]);
    // Telegram-чаты мост не трогает.
    await api.sendMessage(12345, "hi");
    expect(tg).toEqual(["sendMessage"]);
  });

  it("обращение из МАКС админу в Telegram — текстом, раз переслать нельзя", async () => {
    const { repo, max, bot } = setup();
    const uid = max.uid(5);
    repo.touchUser(uid, null, "Аня");
    const tg: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const api = new Api(`123456:${"x".repeat(30)}`);
    api.config.use(async (_prev, method, payload) => {
      tg.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: { message_id: 77, date: 0, chat: { id: 42, type: "private" } } as never };
    });
    api.config.use(max.transformer());
    await max.handle(bot, textFromMax("ошибка: 3 < 4"));
    const id = max.messages.idOf("in.ошибка: 3 < 4")!;
    const res = await api.copyMessages(42, uid, [id]);
    expect(res).toEqual([{ message_id: 77 }]);
    expect(tg).toEqual([{ method: "sendMessage", payload: { chat_id: 42, text: "ошибка: 3 &lt; 4", parse_mode: "HTML" } }]);
  });

  it("неизвестный человек из МАКС — «чат не найден», как у Telegram", async () => {
    const { max } = setup();
    const api = new Api(`123456:${"x".repeat(30)}`);
    api.config.use(max.transformer());
    await expect(api.sendMessage(MAX_UID_BASE + 999, "x")).rejects.toThrow(/chat not found/);
  });
});

describe("МАКС: меню под каждым сообщением", () => {
  const today7 = async (menu: Parameters<Repo["updateUser"]>[1] = {}) => {
    const env = setup({ ask: true });
    const uid = env.max.uid(5);
    env.repo.touchUser(uid, null, "Аня");
    env.repo.updateUser(uid, { groupKey: group.key, format: "text", ...menu });
    await env.max.handle(env.bot, textFromMax("📅 Сегодня"));
    return { ...env, uid, day: env.calls.find((c) => c.path === "/messages" && c.method === "POST") };
  };

  it("под расписанием дня — свои стрелки, а ниже меню человека", async () => {
    const { day } = await today7();
    const rows = buttonsOf(day);
    expect(rows.slice(-2)).toEqual(MENU_ROWS);
    expect(rows[0]!.every((b) => b.type === "callback")).toBe(true);
  });

  it("свои кнопки меню (⚙️ → 🧩) — они и под сообщением; «скрыто» — без меню", async () => {
    const custom = await today7({ menuButtons: ["today", "changes", "more"] });
    expect(buttonsOf(custom.day).slice(-1)).toEqual([[{ type: "message", text: "📅 Сегодня" }, { type: "message", text: "🔔 Изменения" }, { type: "message", text: "🗂 Ещё" }]]);
    const hidden = await today7({ menuMode: "hidden" });
    expect(buttonsOf(hidden.day).flat().some((b) => b.type === "message")).toBe(false);
  });

  it("стрелка правит сообщение — меню остаётся под ним", async () => {
    const { calls, max, bot } = await today7();
    calls.length = 0;
    await max.handle(bot, {
      update_type: "message_callback",
      timestamp: Date.now(),
      callback: { callback_id: "cb8", payload: `d:${today}`, user: { user_id: 5, first_name: "Аня" }, timestamp: Date.now() },
      message: { recipient: { chat_id: 1, chat_type: "dialog", user_id: 5 }, timestamp: Date.now(), body: { mid: "mid.1", text: "день" } },
    } as MaxUpdate);
    expect(buttonsOf(calls.find((c) => c.method === "PUT")).slice(-2)).toEqual(MENU_ROWS);
  });

  it("тихое сообщение без своих кнопок (текст перед постером) — без меню: оно будет под постером", async () => {
    const { calls, max, uid } = await today7();
    calls.length = 0;
    const api = new Api(`123456:${"x".repeat(30)}`);
    api.config.use(max.transformer());
    await api.sendMessage(uid, "неделя текстом", { disable_notification: true });
    expect(buttonsOf(calls[0])).toEqual([]);
    await api.sendMessage(uid, "ответ");
    expect(buttonsOf(calls[1])).toEqual(MENU_ROWS);
  });

  it("/start в МАКС — без плашки «💬 Спросить?»: «Найти с ИИ» и так в меню", async () => {
    const { calls, max, bot } = await today7();
    calls.length = 0;
    await max.handle(bot, { update_type: "bot_started", timestamp: Date.now(), chat_id: 1, user: { user_id: 5, first_name: "Аня" } } as MaxUpdate);
    const sent = calls.filter((c) => c.path === "/messages" && c.method === "POST");
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.body?.text)).toContain("С возвращением");
    expect(buttonsOf(sent[0]).flat().some((b) => b.text.includes("Спросить"))).toBe(false);
    expect(buttonsOf(sent[0])).toEqual(MENU_ROWS);
  });
});
