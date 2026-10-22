import { describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { BTN, DEFAULT_MENU, isMenuText, mainKeyboard, MENU_CHOICES, menuButtonLabel, menuFor, menuRows, menuStamp, menuStampFor, normalizeMenu, settingsKeyboard } from "../src/bot/keyboards.js";
import { settingsHandlers } from "../src/bot/handlers/settings.js";
import { ppaHandlers } from "../src/bot/handlers/ppa.js";
import { miscHandlers } from "../src/bot/handlers/misc.js";
import type { BotContext, Deps } from "../src/bot/context.js";

const plain = (kb: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(kb)) as Record<string, unknown>;
const labels = (kb: unknown): string[][] => (plain(kb).keyboard as Array<Array<{ text: string }>>).map((r) => r.map((b) => b.text));

describe("свои кнопки нижнего меню: сборка", () => {
  it("у кого ничего не выбрано — меню прежнее 2 × 3, тот же отпечаток (никому не придёт «новое меню»)", () => {
    expect(labels(mainKeyboard())).toEqual([["📅 Сегодня", "📅 Завтра", "🗓 Неделя"], ["🔍 Найти с ИИ", "🗂 Ещё", "🙋 Поддержка"]]);
    expect(menuStamp(mainKeyboard("collapsible", null))).toBe(menuStamp(mainKeyboard()));
    // Выбрали ровно то же — это «как у всех».
    expect(normalizeMenu([...DEFAULT_MENU].reverse())).toBeNull();
    expect(menuStampFor({ teacherMode: false, menuMode: "collapsible", menuButtons: null })).toBe(menuStampFor({ teacherMode: false, menuMode: "collapsible" }));
  });

  it("порядок — как в списке, без повторов и неизвестных; без «Ещё» и «Настроек» сразу «Ещё» возвращается", () => {
    expect(normalizeMenu(["complaint", "changes", "today", "changes", "нет такой", "more"])).toEqual(["today", "changes", "more", "complaint"]);
    expect(normalizeMenu(["today", "week"])).toEqual(["today", "week", "more"]);
    expect(normalizeMenu(["today", "settings"])).toEqual(["today", "settings"]);
  });

  it("ряды по 3 и поровну; можно вынести хоть все кнопки", () => {
    expect(menuRows([1, 2, 3, 4, 5, 6, 7]).map((r) => r.length)).toEqual([3, 2, 2]);
    expect(menuRows([1, 2, 3, 4, 5, 6, 7, 8]).map((r) => r.length)).toEqual([3, 3, 2]);
    expect(menuRows([1, 2, 3, 4]).map((r) => r.length)).toEqual([2, 2]);
    const all = labels(mainKeyboard("collapsible", [...MENU_CHOICES]));
    expect(all.flat()).toHaveLength(MENU_CHOICES.length);
    expect(all.every((r) => r.length <= 3)).toBe(true);
    expect(labels(mainKeyboard("collapsible", ["today", "tomorrow", "week", "find", "changes", "teachers", "more", "complaint"]))).toEqual([
      ["📅 Сегодня", "📅 Завтра", "🗓 Неделя"],
      ["🔍 Найти с ИИ", "🔔 Изменения", "👨‍🏫 Где препод"],
      ["🗂 Ещё", "🙋 Поддержка"],
    ]);
  });

  it("каждая кнопка — подпись меню (её не съест ожидание ввода); у преподавателя «Группы» без «Другие»", () => {
    for (const b of MENU_CHOICES) {
      expect(isMenuText(menuButtonLabel(b))).toBe(true);
      expect(isMenuText(menuButtonLabel(b, true))).toBe(true);
    }
    expect(labels(menuFor({ teacherMode: true, menuMode: "collapsible", menuButtons: ["groups", "more"] })).flat()).toEqual(["👥 Группы", "🗂 Ещё"]);
    expect(labels(menuFor({ teacherMode: false, menuMode: "collapsible", menuButtons: ["groups", "more"] })).flat()).toEqual(["👥 Др. группы", "🗂 Ещё"]);
    // Скрытое меню остаётся скрытым, какие бы кнопки ни выбрали.
    expect(menuFor({ teacherMode: false, menuMode: "hidden", menuButtons: ["changes", "more"] })).toEqual({ remove_keyboard: true });
  });

  it("в базе: свои кнопки сохраняются, null — как у всех; в /stats — сколько собрали своё меню", () => {
    const repo = new Repo(openDatabase(":memory:"));
    expect(repo.touchUser(1, "u", "U").menuButtons).toBeNull();
    repo.updateUser(1, { menuButtons: ["today", "changes", "more"] });
    expect(repo.getUser(1)!.menuButtons).toEqual(["today", "changes", "more"]);
    expect(repo.countUsers().customMenu).toBe(1);
    repo.updateUser(1, { menuButtons: null });
    expect(repo.getUser(1)!.menuButtons).toBeNull();
    expect(repo.countUsers().customMenu).toBe(0);
  });

  it("в настройках — строка «🧩 Кнопки внизу»: «как у всех» или «свои (N)»", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const user = repo.touchUser(1, "u", "U");
    const opts = { topics: [], hasImages: false, watchCount: 0, defaultTheme: "midnight" };
    expect(JSON.stringify(settingsKeyboard(user, null, opts))).toContain("🧩 Кнопки внизу: как у всех");
    expect(JSON.stringify(settingsKeyboard({ ...user, menuButtons: ["today", "changes", "more"] }, null, opts))).toContain("🧩 Кнопки внизу: свои (3)");
  });
});

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };

type Call = { method: string; payload: Record<string, unknown> };

async function run(update: Update, repo: Repo, composer: Composer<BotContext> = settingsHandlers, extra: Partial<Deps> = {}): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = { repo, config: { POSTER_THEME: "midnight", POISK: false }, service: { group: () => null, groups: () => [] }, renderer: null, known: null, teachers: null, ask: null, pending: new Map(), ...extra } as unknown as Deps;
  ctx.user = repo.getUser(7)!;
  ctx.isAdmin = false;
  await new Composer<BotContext>().use(composer).middleware()(ctx, async () => undefined);
  return calls;
}

const cb = (data: string): Update => ({ update_id: 1, callback_query: { id: "1", from: { id: 7, is_bot: false, first_name: "U" }, chat_instance: "1", data, message: { message_id: 3, date: 0, chat: { id: 7, type: "private", first_name: "U" }, text: "x" } as never } });
const text = (t: string): Update => ({ update_id: 2, message: { message_id: 4, date: 0, chat: { id: 7, type: "private", first_name: "U" }, from: { id: 7, is_bot: false, first_name: "U" }, text: t } });

const edited = (calls: Call[]): string => JSON.stringify(calls.find((c) => c.method === "editMessageText")?.payload ?? {});
const alert = (calls: Call[]): Record<string, unknown> => calls.find((c) => c.method === "answerCallbackQuery")!.payload;

describe("⚙️ → 🧩 Кнопки внизу", () => {
  it("экран выбора: ✅ у кнопок по умолчанию, ➕ у остальных; поиск студента и ИИ — только если включены", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    const screen = edited(await run(cb("s:buttons"), repo));
    expect(screen).toContain("🧩 Кнопки внизу");
    expect(screen).toContain("Выбрано: <b>6</b> — как у всех");
    expect(screen).toContain("✅ 📅 Сегодня");
    expect(screen).toContain("➕ 🔔 Изменения");
    expect(screen).not.toContain("🕵️ Где студент");
    expect(screen).not.toContain("💬 Спросить ИИ");
    const withAi = edited(await run(cb("s:buttons"), repo, settingsHandlers, { ask: {} as never, config: { POSTER_THEME: "midnight", POISK: true } as never }));
    expect(withAi).toContain("➕ 💬 Спросить ИИ");
    expect(withAi).toContain("➕ 🕵️ Где студент");
  });

  it("добавил — сохранилось сразу; «Готово» присылает новое меню; «↩️ Как было» — меню как у всех", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    const add = await run(cb("mb:t:changes"), repo);
    expect(repo.getUser(7)!.menuButtons).toEqual(["today", "tomorrow", "week", "find", "changes", "more", "complaint"]);
    expect(String(alert(add).text)).toContain("Добавил: 🔔 Изменения");
    expect(edited(add)).toContain("✅ 🔔 Изменения");
    // Меню в чате меняется только новым сообщением — по «Готово», не на каждое нажатие.
    expect(add.filter((c) => c.method === "sendMessage")).toHaveLength(0);
    const done = await run(cb("mb:done"), repo);
    const sent = done.find((c) => c.method === "sendMessage")!;
    expect(labels(sent.payload.reply_markup).flat()).toContain("🔔 Изменения");
    expect(String(sent.payload.text)).toContain("↩️ Как было");
    // После «Готово» — снова настройки, уже с подписью «свои».
    expect(edited(done)).toContain("🧩 Кнопки внизу: свои (7)");
    const reset = await run(cb("mb:reset"), repo);
    expect(repo.getUser(7)!.menuButtons).toBeNull();
    expect(labels(reset.find((c) => c.method === "sendMessage")!.payload.reply_markup)).toEqual(labels(mainKeyboard()));
  });

  it("убрал всё до «Ещё» — её не убрать, пока нет «Настроек»; с «Настройками» — можно", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    const no = await run(cb("mb:t:more"), repo);
    expect(alert(no).show_alert).toBe(true);
    expect(repo.getUser(7)!.menuButtons).toBeNull();
    await run(cb("mb:t:settings"), repo);
    await run(cb("mb:t:more"), repo);
    expect(repo.getUser(7)!.menuButtons).toEqual(["today", "tomorrow", "week", "find", "settings", "complaint"]);
    // Вернул ровно стандартный набор — снова «как у всех».
    await run(cb("mb:t:more"), repo);
    await run(cb("mb:t:settings"), repo);
    expect(repo.getUser(7)!.menuButtons).toBeNull();
  });

  it("вынесенные кнопки работают: «📋 Пересдачи» и «💬 Спросить ИИ»", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    // Без группы пересдачи просят выбрать группу — главное, что кнопку услышали.
    const ppa = await run(text(BTN.ppa), repo, ppaHandlers);
    expect(ppa.some((c) => c.method === "sendMessage")).toBe(true);
    const deps: Partial<Deps> = { pending: new Map() };
    const ask = await run(text(BTN.askAi), repo, miscHandlers, deps);
    expect(String(ask.find((c) => c.method === "sendMessage")!.payload.text)).toMatch(/Что ищем|Спрашивай/);
    expect(deps.pending!.get(7)?.kind).toBe("search");
  });
});
