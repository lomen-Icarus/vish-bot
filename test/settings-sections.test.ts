/**
 * Настройки разделами: главный экран — разделы с текущим состоянием в подписи,
 * в разделе не больше 6 пунктов, после нажатия экран остаётся в разделе пункта
 * (и для старых сообщений настроек со всеми переключателями), /stats считает
 * каждый пункт отдельно.
 */
import { describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { menuSettingsKeyboard, SETTINGS_CLICK_LABELS, SETTINGS_SECTION_OF, SETTINGS_SECTIONS, settingsKeyboard, TOPICS, type SettingsOpts, type SettingsSection } from "../src/bot/keyboards.js";
import { settingsHandlers } from "../src/bot/handlers/settings.js";
import { callbackCounterKey } from "../src/bot/index.js";
import type { BotContext, Deps } from "../src/bot/context.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
type Call = { method: string; payload: Record<string, unknown> };
type Btn = { text: string; callback_data?: string };

const FULL: SettingsOpts = { topics: [...TOPICS], hasImages: true, watchCount: 2, defaultTheme: "midnight", teacherCount: 1, slides: true, known: true };
const buttons = (kb: unknown): Btn[] => ((JSON.parse(JSON.stringify(kb)) as { inline_keyboard: Btn[][] }).inline_keyboard ?? []).flat();
const markup = (c: Call | undefined): Btn[] => buttons(c?.payload.reply_markup ?? { inline_keyboard: [] });

function makeRepo(): Repo {
  const repo = new Repo(openDatabase(":memory:"));
  repo.touchUser(7, "u", "U");
  return repo;
}

async function run(update: Update, repo: Repo): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = { repo, config: { POSTER_THEME: "midnight", SLIDES_TOKEN: "" }, service: { group: () => null, groups: () => [] }, renderer: null, known: null, teachers: null } as unknown as Deps;
  ctx.user = repo.getUser(7)!;
  ctx.isAdmin = false;
  await new Composer<BotContext>().use(settingsHandlers).middleware()(ctx, async () => undefined);
  return calls;
}

const cb = (data: string): Update => ({ update_id: 1, callback_query: { id: "1", from: { id: 7, is_bot: false, first_name: "U" }, chat_instance: "1", data, message: { message_id: 3, date: 0, chat: { id: 7, type: "private", first_name: "U" }, text: "x" } as never } });
const edited = (calls: Call[]): Call | undefined => calls.find((c) => c.method === "editMessageText");

describe("настройки разделами: клавиатуры", () => {
  it("главный экран — не больше 6 разделов (+ «Закрыть»), в подписи — что включено", () => {
    const user = makeRepo().getUser(7)!;
    const main = buttons(settingsKeyboard({ ...user, notifyChanges: true, topics: ["announcements"], remindFirstMin: 120, remindDistanceMin: 5, quietFrom: "23:00", quietTo: "07:00", subgroup: 1 }, null, FULL));
    const sections = main.filter((b) => b.callback_data !== "s:close");
    expect(sections.length).toBeLessThanOrEqual(6);
    expect(main.map((b) => b.text)).toEqual([
      "👥 Группа: не выбрана · подгруппа 1",
      "🔔 Что присылать: изменения, 1 тема",
      "⏰ Напоминания: 2 из 4, тихие часы",
      "🖼 Вид расписания: оба, тёмная",
      "⌨️ Нижнее меню: сворачивается",
      "🕶 Усиленная анонимность: выкл ◻️",
      "✖️ Закрыть",
    ]);
    // Ничего не включено — так и написано, без пустой подписи.
    const off = buttons(settingsKeyboard({ ...user, notifyChanges: false, notifySession: false, topics: [], remindFirstMin: null, remindEachMin: null, remindDistanceMin: null, eveningAt: null }, null, FULL));
    expect(off.map((b) => b.text)).toEqual(expect.arrayContaining(["🔔 Что присылать: ничего", "⏰ Напоминания: выкл"]));
    // Без узнавания по нику пункта анонимности нет вовсе.
    expect(buttons(settingsKeyboard(user, null, { ...FULL, known: false })).some((b) => b.callback_data === "s:anon")).toBe(false);
  });

  it("в каждом разделе не больше 6 пунктов и «◀️ Назад»; каждый пункт ведёт обратно в свой раздел", () => {
    const user = makeRepo().getUser(7)!;
    const seen = new Set<string>();
    for (const section of SETTINGS_SECTIONS) {
      const kb = buttons(settingsKeyboard(user, null, FULL, section));
      expect(kb.at(-1)).toEqual({ text: "◀️ Назад", callback_data: "s:home" });
      const items = kb.slice(0, -1);
      expect(items.length, section).toBeLessThanOrEqual(6);
      for (const b of items) {
        const field = b.callback_data!.split(":")[1]!;
        expect(SETTINGS_SECTION_OF[field], b.callback_data).toBe(section);
        // У каждого пункта есть подпись для /stats.
        expect(SETTINGS_CLICK_LABELS[field], field).toBeTruthy();
        seen.add(field);
      }
    }
    // Ни один прежний переключатель не потерялся.
    for (const f of ["group", "subgroup", "watch", "teachers", "changes", "session", "slides", "topic", "first", "each", "distance", "evening", "quiet", "format", "theme", "teacher"]) expect(seen.has(f), f).toBe(true);
    expect(buttons(menuSettingsKeyboard(user)).length).toBeLessThanOrEqual(6);
  });
});

describe("настройки разделами: переходы", () => {
  it("раздел открывается в том же сообщении; нажатие пункта оставляет экран в разделе; «◀️ Назад» — на главный", async () => {
    const repo = makeRepo();
    const open = edited(await run(cb("s:open:remind"), repo));
    expect(String(open!.payload.text)).toContain("⏰ Напоминания о парах");
    expect(markup(open).some((b) => b.callback_data === "s:first")).toBe(true);

    const after = edited(await run(cb("s:first"), repo));
    expect(repo.getUser(7)!.remindFirstMin).toBe(30);
    expect(markup(after).map((b) => b.text)).toContain("⏰ До первой пары: 30 мин");
    expect(markup(after).at(-1)?.callback_data).toBe("s:home");

    const home = edited(await run(cb("s:home"), repo));
    expect(markup(home).map((b) => b.callback_data)).toContain("s:open:remind");
    expect(markup(home).some((b) => b.callback_data === "s:first")).toBe(false);
  });

  it("старое сообщение настроек со всеми переключателями: нажатие работает и открывает раздел пункта", async () => {
    const repo = makeRepo();
    const calls = await run(cb("s:topic:contests"), repo);
    expect(repo.getUser(7)!.topics).toContain("contests");
    expect(String(edited(calls)!.payload.text)).toContain("🔔 Что присылать");
  });

  it("непонятный раздел — главный экран, а не ошибка", async () => {
    const repo = makeRepo();
    expect(markup(edited(await run(cb("s:open:nope"), repo))).map((b) => b.callback_data)).toContain("s:open:group");
  });

  it("«⌨️ Нижнее меню» → «🧩 Кнопки внизу» → «◀️ Назад» возвращает в раздел меню, оттуда «◀️ Назад» — на главный", async () => {
    const repo = makeRepo();
    expect(markup(edited(await run(cb("s:buttons"), repo))).some((b) => b.callback_data === "mb:back")).toBe(true);
    const menu = edited(await run(cb("mb:back"), repo));
    expect(String(menu!.payload.text)).toContain("⌨️ Нижнее меню");
    expect(markup(menu).map((b) => b.callback_data)).toEqual(expect.arrayContaining(["menu:collapsible", "s:buttons", "menu:back"]));
    expect(markup(edited(await run(cb("menu:back"), repo))).map((b) => b.callback_data)).toContain("s:open:look");
  });

  it("«Готово» в слежении за группами возвращает в раздел «👥 Группа»", async () => {
    const repo = makeRepo();
    const calls = await run(cb("wt:done"), repo);
    const sent = calls.find((c) => c.method === "sendMessage")!;
    expect(String(sent.payload.text)).toContain("👥 Группа");
    expect(markup(sent).some((b) => b.callback_data === "s:watch")).toBe(true);
  });
});

describe("/stats: нажатия в настройках — по пунктам", () => {
  it("пункт без значения, раздел — с именем, панели — как раньше", () => {
    const cases: Array<[string, string]> = [
      ["s:first", "cb:s:first"],
      ["s:topic:contests", "cb:s:topic"],
      ["s:open:remind", "cb:s:open:remind"],
      ["s:home", "cb:s:home"],
      ["hub:groups", "cb:hub:groups"],
      ["more:help:x", "cb:more:help"],
      ["ppa:mark:3", "cb:ppa"],
    ];
    for (const [data, key] of cases) expect(callbackCounterKey(data)).toBe(key);
    for (const s of SETTINGS_SECTIONS satisfies readonly SettingsSection[]) expect(SETTINGS_CLICK_LABELS[`open:${s}`]).toBeTruthy();
  });
});
