import { describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { hubHandlers } from "../src/bot/handlers/hub.js";
import { freeTextSearch, miscHandlers } from "../src/bot/handlers/misc.js";
import type { BotContext, Deps, PendingState } from "../src/bot/context.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
const ADMIN = 900;
const USER = 7;

type Call = { method: string; payload: Record<string, unknown> };

function makeDeps(opts: { ask?: boolean } = {}) {
  const repo = new Repo(openDatabase(":memory:"));
  repo.touchUser(USER, "student_u", "Студент");
  repo.touchUser(ADMIN, "lomen", "Админ");
  const deps = {
    repo,
    config: { ADMIN_IDS: [ADMIN], SUPPORT_CONTACT: "@lomen_Icarus", POISK: false, POSTER_THEME: "midnight" },
    service: { group: () => null, groups: () => [], materialize: () => [] },
    renderer: null,
    ask: opts.ask ? {} : null,
    teachers: null,
    students: null,
    known: null,
    pending: new Map<number, PendingState>(),
  } as unknown as Deps;
  return deps;
}

async function run(deps: Deps, update: Update, from = USER): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === "copyMessages") return { ok: true, result: (payload as { message_ids: number[] }).message_ids.map((m) => ({ message_id: m + 1000 })) as never };
    return { ok: true, result: { message_id: 50, date: 0, chat: { id: from, type: "private" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = deps;
  ctx.user = deps.repo.getUser(from)!;
  ctx.isAdmin = from === ADMIN;
  // use() возвращает дочерний композер: собираем цепочку на одном объекте.
  const chain = new Composer<BotContext>();
  chain.use(hubHandlers);
  chain.use(miscHandlers);
  await chain.middleware()(ctx, async () => undefined);
  return calls;
}

let mid = 100;
const text = (t: string, from = USER): Update => ({ update_id: mid, message: { message_id: mid++, date: 0, chat: { id: from, type: "private", first_name: "U" }, from: { id: from, is_bot: false, first_name: "U", username: from === USER ? "student_u" : "lomen" }, text: t } });
const photo = (from = USER): Update => ({ update_id: mid, message: { message_id: mid++, date: 0, chat: { id: from, type: "private", first_name: "U" }, from: { id: from, is_bot: false, first_name: "U", username: "student_u" }, photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }], caption: "скрин" } });
const press = (data: string, from = USER): Update => ({ update_id: mid++, callback_query: { id: "1", from: { id: from, is_bot: false, first_name: "U" }, chat_instance: "1", data, message: { message_id: 3, date: 0, chat: { id: from, type: "private", first_name: "U" }, text: "x" } as never } });
const markup = (c: Call | undefined): string => JSON.stringify(c?.payload.reply_markup ?? null);

describe("панели «🔍 Найти» и «🗂 Ещё»", () => {
  it("«Найти»: другие группы, поток, преподы и вопрос ИИ; у преподавателя первая кнопка — «Группы»", async () => {
    const deps = makeDeps({ ask: true });
    const calls = await run(deps, text("🔍 Найти"));
    const msg = calls.find((c) => c.method === "sendMessage")!;
    expect(String(msg.payload.text)).toContain("Просто напиши");
    for (const cb of ["hub:groups", "hub:stream", "hub:teachers", "hub:ask"]) expect(markup(msg)).toContain(cb);
    expect(markup(msg)).toContain("👥 Др. группы");
    expect(markup(msg)).toContain("👨‍🏫 Где препод");
    deps.repo.updateUser(USER, { teacherMode: true });
    expect(markup((await run(deps, text("🔍 Найти"))).find((c) => c.method === "sendMessage"))).toContain("\"👥 Группы\"");
  });

  it("«Найти» с поиском студента: «Где препод» и «Где студент» в одном ряду, «Спросить ИИ» — отдельным рядом ниже", async () => {
    const deps = makeDeps({ ask: true });
    (deps.config as { POISK: boolean }).POISK = true;
    (deps as { students?: unknown }).students = {};
    const msg = (await run(deps, text("🔍 Найти"))).find((c) => c.method === "sendMessage")!;
    const rows = (msg.payload.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard.map((r) => r.map((b) => b.text));
    expect(rows).toEqual([["👥 Др. группы", "🎓 Поток"], ["👨‍🏫 Где препод", "🕵️ Где студент"], ["💬 Спросить ИИ"]]);
  });

  it("«Ещё»: изменения, календарь, настройки, справка; старая подпись «☰ Ещё» тоже открывает", async () => {
    for (const label of ["🗂 Ещё", "☰ Ещё"]) {
      const msg = (await run(makeDeps(), text(label))).find((c) => c.method === "sendMessage")!;
      for (const cb of ["more:changes", "more:calendar", "more:settings", "more:help"]) expect(markup(msg)).toContain(cb);
    }
  });

  it("старая подпись «👥 Поддержка» открывает Министерство Жалоб", async () => {
    const msg = (await run(makeDeps(), text("👥 Поддержка"))).find((c) => c.method === "sendMessage")!;
    expect(String(msg.payload.text)).toContain("Министерство Жалоб");
  });
});

describe("🏛 Министерство Жалоб", () => {
  it("с ником: админ видит, от кого, и получает копию сообщения с кнопками «Ответить» / «Не принимать»", async () => {
    const deps = makeDeps();
    const open = await run(deps, text("💬 Поддержка"));
    const panel = open.find((c) => c.method === "sendMessage")!;
    expect(String(panel.payload.text)).toContain("Министерство Жалоб");
    expect(String(panel.payload.text)).toContain("@lomen_Icarus");
    expect(markup(panel)).toContain("sup:anon");
    expect(markup(panel)).toContain("sup:back");
    const typed = await run(deps, text("Пары в пятницу показывает не те"));
    // Сразу не уходит: сначала «Отправить?» — кнопку жмут и из любопытства.
    expect(typed.some((c) => c.payload.chat_id === ADMIN)).toBe(false);
    expect(markup(typed.find((c) => c.method === "sendMessage"))).toContain("sup:send");
    const sent = await run(deps, press("sup:send"));
    const header = sent.find((c) => c.method === "sendMessage" && c.payload.chat_id === ADMIN)!;
    expect(String(header.payload.text)).toContain("Обращение #1");
    expect(String(header.payload.text)).toContain("@student_u");
    const copy = sent.find((c) => c.method === "copyMessages")!;
    expect(copy.payload.chat_id).toBe(ADMIN);
    // Кнопки — под заголовком, когда копия дошла.
    expect(markup(sent.find((c) => c.method === "editMessageReplyMarkup" && c.payload.chat_id === ADMIN))).toContain("supa:r:1");
    expect(sent.some((c) => c.method === "forwardMessage")).toBe(false);
    expect(String(sent.find((c) => c.method === "editMessageText")!.payload.text)).toContain("Обращение #1");
  });

  it("анонимно: ни ника, ни id в заголовке, только копия (у пересылки Telegram показал бы автора); фото тоже принимается", async () => {
    const deps = makeDeps();
    await run(deps, text("🏛 Жалоба"));
    const toggled = await run(deps, press("sup:anon"));
    expect(String(toggled.find((c) => c.method === "editMessageText")!.payload.text)).toContain("анонимно");
    await run(deps, photo());
    const sent = await run(deps, press("sup:send"));
    const header = String(sent.find((c) => c.method === "sendMessage" && c.payload.chat_id === ADMIN)!.payload.text);
    expect(header).toContain("анонимно");
    expect(header).not.toContain("student_u");
    expect(header).not.toContain(String(USER));
    expect(sent.some((c) => c.method === "copyMessages")).toBe(true);
    expect(sent.some((c) => c.method === "forwardMessage")).toBe(false);
  });

  it("«Назад» закрывает панель и выходит из режима: следующее сообщение — уже не обращение", async () => {
    const deps = makeDeps();
    await run(deps, text("🏛 Жалоба"));
    const back = await run(deps, press("sup:back"));
    expect(back.some((c) => c.method === "deleteMessage")).toBe(true);
    const after = await run(deps, text("просто текст"));
    expect(after.some((c) => c.payload.chat_id === ADMIN)).toBe(false);
    // Нажал «Жалоба», потом написал «14-24» и передумал — «Не отправлять».
    await run(deps, text("🏛 Жалоба"));
    await run(deps, text("14-24"));
    await run(deps, press("sup:back"));
    expect((await run(deps, press("sup:send"))).some((c) => c.payload.chat_id === ADMIN)).toBe(false);
  });

  it("на экране «Отправить?» можно переключить анонимность — написанное не теряется", async () => {
    const deps = makeDeps();
    await run(deps, text("🏛 Жалоба"));
    await run(deps, text("жалоба"));
    const toggled = await run(deps, press("sup:anon"));
    const edit = toggled.find((c) => c.method === "editMessageText")!;
    expect(String(edit.payload.text)).toContain("анонимно");
    expect(markup(edit)).toContain("sup:send");
    const sent = await run(deps, press("sup:send"));
    expect(String(sent.find((c) => c.method === "sendMessage" && c.payload.chat_id === ADMIN)!.payload.text)).toContain("анонимно");
  });

  it("админ отвечает — ответ приходит человеку, даже анонимному; «Не принимать» — дальше обращения не уходят", async () => {
    const deps = makeDeps();
    await run(deps, text("🏛 Жалоба"));
    await run(deps, press("sup:anon"));
    await run(deps, text("анонимная жалоба"));
    await run(deps, press("sup:send"));
    const ask = await run(deps, press("supa:r:1", ADMIN), ADMIN);
    expect(String(ask.find((c) => c.method === "sendMessage")!.payload.text)).toContain("#1");
    const reply = await run(deps, text("Спасибо, поправим", ADMIN), ADMIN);
    expect(reply.find((c) => c.method === "sendMessage" && c.payload.chat_id === USER)).toBeTruthy();
    expect(reply.find((c) => c.method === "copyMessage" && c.payload.chat_id === USER)).toBeTruthy();

    // Не админ кнопкой ответа воспользоваться не может.
    expect((await run(deps, press("supa:r:1"))).some((c) => c.method === "sendMessage")).toBe(false);

    await run(deps, press("supa:b:1", ADMIN), ADMIN);
    await run(deps, text("🏛 Жалоба"));
    await run(deps, text("ещё жалоба"));
    const blocked = await run(deps, press("sup:send"));
    expect(blocked.some((c) => c.payload.chat_id === ADMIN)).toBe(false);
    expect(String(blocked.find((c) => c.method === "editMessageText")!.payload.text)).toMatch(/не принимает/);
  });

  it("анонимно — не больше 5 за сутки", async () => {
    const deps = makeDeps();
    for (let i = 0; i < 5; i++) {
      await run(deps, text("🏛 Жалоба"));
      await run(deps, press("sup:anon"));
      await run(deps, text(`жалоба ${i}`));
      await run(deps, press("sup:send"));
    }
    await run(deps, text("🏛 Жалоба"));
    await run(deps, press("sup:anon"));
    await run(deps, text("шестая"));
    const sixth = await run(deps, press("sup:send"));
    expect(sixth.some((c) => c.payload.chat_id === ADMIN)).toBe(false);
    expect(String(sixth.find((c) => c.method === "editMessageText")!.payload.text)).toMatch(/хватит/);
  });

  it("/soon стирает обращения — ответить на старое уже некому", async () => {
    const deps = makeDeps();
    await run(deps, text("🏛 Жалоба"));
    await run(deps, text("жалоба"));
    await run(deps, press("sup:send"));
    expect(deps.repo.supportTicket(1)).not.toBeNull();
    deps.repo.forgetUser(USER);
    expect(deps.repo.supportTicket(1)).toBeNull();
  });
});

describe("текст без кнопки — поиск по своей базе, без ИИ", () => {
  it("ничего не нашёл — подсказка и «💬 Спросить ИИ» (если ИИ включён); сам ИИ не вызывается", async () => {
    const deps = makeDeps({ ask: true });
    const calls: Call[] = [];
    const api = new Api("123:FAKE");
    api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: true as never };
    });
    const ctx = new Context(text("спасибо"), api, ME) as BotContext;
    ctx.deps = deps;
    ctx.user = deps.repo.getUser(USER)!;
    ctx.isAdmin = false;
    await freeTextSearch(ctx, "спасибо");
    const msg = calls.find((c) => c.method === "sendMessage")!;
    expect(String(msg.payload.text)).toContain("Не нашёл");
    expect(markup(msg)).toContain("fx:ai");
    // ИИ здесь — пустой объект без answer(): позови его поиск, тест упал бы.
    expect(deps.repo.countersSince("2000-01-01")).toEqual([{ key: "text:miss", n: 1 }]);

    // Без ИИ — без кнопки.
    const noAi = makeDeps();
    calls.length = 0;
    ctx.deps = noAi;
    ctx.user = noAi.repo.getUser(USER)!;
    await freeTextSearch(ctx, "спасибо");
    expect(markup(calls.find((c) => c.method === "sendMessage"))).not.toContain("fx:ai");
  });

  it("счётчики нажатий — по дням, без людей", () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.bumpCounter("2026-10-14", "btn:📅 Сегодня");
    repo.bumpCounter("2026-10-14", "btn:📅 Сегодня");
    repo.bumpCounter("2026-10-15", "btn:📅 Сегодня");
    repo.bumpCounter("2026-10-15", "cb:hub");
    expect(repo.countersSince("2026-10-14")).toEqual([{ key: "btn:📅 Сегодня", n: 3 }, { key: "cb:hub", n: 1 }]);
    expect(repo.countersSince("2026-10-15")).toEqual([{ key: "btn:📅 Сегодня", n: 1 }, { key: "cb:hub", n: 1 }]);
  });
});

describe("весь бот (createBot): порядок обработчиков, счётчики, текст без кнопки", () => {
  async function botWith(deps: Deps) {
    const { createBot } = await import("../src/bot/index.js");
    const bot = createBot(deps);
    bot.botInfo = ME;
    const calls: Call[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      if (method === "copyMessages") return { ok: true, result: [{ message_id: 78 }] as never };
      return { ok: true, result: { message_id: 77, date: 0, chat: { id: USER, type: "private" } } as never };
    });
    return { bot, calls };
  }
  function fullDeps() {
    const deps = makeDeps();
    Object.assign(deps.config, { BOT_TOKEN: "123:FAKE-TOKEN-FOR-TESTS-ONLY", NEWS_CHANNEL_IDS: [], MEDIA_CHAT_IDS: [] });
    return deps;
  }

  it("«спасибо» — поиск («Не нашёл»), а не «Не понял»; /foo — «Не знаю такой команды»; нажатие кнопки посчитано", async () => {
    const deps = fullDeps();
    const { bot, calls } = await botWith(deps);
    await bot.handleUpdate(text("спасибо"));
    expect(String(calls.find((c) => c.method === "sendMessage")!.payload.text)).toContain("Не нашёл");
    calls.length = 0;
    await bot.handleUpdate(text("/foo"));
    expect(String(calls.find((c) => c.method === "sendMessage")!.payload.text)).toContain("Не знаю такой команды");
    await bot.handleUpdate(text("🗂 Ещё"));
    const keys = deps.repo.countersSince("2000-01-01").map((c) => c.key);
    expect(keys).toContain("btn:🗂 Ещё");
    expect(keys).toContain("cmd:/foo");
    expect(keys).toContain("text:miss");
  });

  it("«🏛 Жалоба» → сообщение → «Отправить» доходит до админа копией при полном порядке обработчиков", async () => {
    const deps = fullDeps();
    const { bot, calls } = await botWith(deps);
    await bot.handleUpdate(text("🏛 Жалоба"));
    await bot.handleUpdate(text("в расписании ошибка"));
    expect(calls.some((c) => c.payload.chat_id === ADMIN)).toBe(false);
    await bot.handleUpdate(press("sup:send"));
    expect(calls.find((c) => c.method === "copyMessages" && c.payload.chat_id === ADMIN)).toBeTruthy();
  });
});
