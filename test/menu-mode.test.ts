import { describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { mainKeyboard, menuFor, menuStamp, streamKeyboard } from "../src/bot/keyboards.js";
import { menuRefresher } from "../src/bot/menuRefresh.js";
import { settingsHandlers } from "../src/bot/handlers/settings.js";
import type { BotContext, Deps } from "../src/bot/context.js";

const plain = (kb: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(kb)) as Record<string, unknown>;

describe("нижнее меню: сворачивается, всегда на экране, скрыто", () => {
  it("по умолчанию без is_persistent — на телефоне его сворачивает значок ▦; «всегда» — с ним; «скрыто» — убрать", () => {
    expect(plain(mainKeyboard()).is_persistent).toBeUndefined();
    expect(plain(mainKeyboard()).resize_keyboard).toBe(true);
    expect(plain(menuFor({ teacherMode: false, menuMode: "always" })).is_persistent).toBe(true);
    expect(menuFor({ teacherMode: true, menuMode: "hidden" })).toEqual({ remove_keyboard: true });
    expect(JSON.stringify(menuFor({ teacherMode: true, menuMode: "collapsible" }))).toContain("Студенты");
    // Меню потока открывают сами — оно приходит и тем, кто скрыл основное.
    expect(plain(streamKeyboard({ mode: "hidden" })).keyboard).toBeTruthy();
    expect(plain(streamKeyboard({ mode: "always" })).is_persistent).toBe(true);
  });

  it("режим хранится у человека; «сворачивается» — значение по умолчанию (NULL)", () => {
    const repo = new Repo(openDatabase(":memory:"));
    expect(repo.touchUser(1, "u", "U").menuMode).toBe("collapsible");
    repo.updateUser(1, { menuMode: "hidden" });
    expect(repo.getUser(1)!.menuMode).toBe("hidden");
    repo.updateUser(1, { menuMode: "collapsible" });
    expect(repo.getUser(1)!.menuMode).toBe("collapsible");
  });
});

describe("меню приходит заново, только когда поменялось", () => {
  function setup() {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    let fail = false;
    const prev = (async (method: string, payload: Record<string, unknown>) => {
      if (fail) throw new Error("network");
      calls.push({ method, payload });
      return { ok: true, result: true };
    }) as never;
    const send = (t: ReturnType<typeof menuRefresher>, payload: Record<string, unknown> = {}) => t(prev, "sendMessage", { chat_id: 7, text: "x", ...payload } as never);
    return { repo, calls, send, failNext: (v: boolean) => (fail = v) };
  }

  it("одно сообщение с меню — и всё; после перезапуска бота свёрнутое меню не раскрывается", async () => {
    const { repo, calls, send } = setup();
    const t = menuRefresher(repo);
    await send(t);
    await send(t);
    expect(calls.map((c) => !!c.payload.reply_markup)).toEqual([true, false]);
    expect(plain(calls[0]!.payload.reply_markup).is_persistent).toBeUndefined();
    // «Перезапуск»: новый преобразователь, та же база.
    await send(menuRefresher(repo));
    expect(calls[2]!.payload.reply_markup).toBeUndefined();
  });

  it("сменил режим — новое меню (или «убрать») уходит с первым же сообщением", async () => {
    const { repo, calls, send } = setup();
    const t = menuRefresher(repo);
    await send(t);
    repo.updateUser(7, { menuMode: "hidden" });
    await send(t);
    expect(calls[1]!.payload.reply_markup).toEqual({ remove_keyboard: true });
    await send(t);
    expect(calls[2]!.payload.reply_markup).toBeUndefined();
  });

  it("меню потока основное не заменяет; кнопки под сообщением не трогаем; не ушло — не запоминаем", async () => {
    const { repo, calls, send, failNext } = setup();
    const t = menuRefresher(repo);
    await send(t);
    await send(t, { reply_markup: streamKeyboard() });
    await send(t);
    expect(calls[2]!.payload.reply_markup).toBeUndefined();
    await send(t, { reply_markup: { inline_keyboard: [[{ text: "a", callback_data: "a" }]] } });
    expect(JSON.stringify(calls[3]!.payload.reply_markup)).toContain("inline_keyboard");
    repo.updateUser(7, { menuMode: "always" });
    failNext(true);
    await expect(send(t)).rejects.toThrow("network");
    failNext(false);
    await send(t);
    expect(plain(calls.at(-1)!.payload.reply_markup).is_persistent).toBe(true);
    expect(repo.getUser(7)!.menuSent).toBe(menuStamp(menuFor(repo.getUser(7))));
  });
});

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };

async function run(update: Update, repo: Repo): Promise<Array<{ method: string; payload: Record<string, unknown> }>> {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = { repo, config: {}, service: { group: () => null } } as unknown as Deps;
  ctx.user = repo.getUser(7)!;
  ctx.isAdmin = false;
  await new Composer<BotContext>().use(settingsHandlers).middleware()(ctx, async () => undefined);
  return calls;
}

const cb = (data: string): Update => ({ update_id: 1, callback_query: { id: "1", from: { id: 7, is_bot: false, first_name: "U" }, chat_instance: "1", data, message: { message_id: 3, date: 0, chat: { id: 7, type: "private", first_name: "U" }, text: "x" } as never } });
const cmd = (text: string): Update => ({ update_id: 2, message: { message_id: 4, date: 0, chat: { id: 7, type: "private", first_name: "U" }, from: { id: 7, is_bot: false, first_name: "U" }, text, entities: [{ type: "bot_command", offset: 0, length: text.length }] } });

describe("⚙️ Нижнее меню и /menu", () => {
  it("выбор «скрыто» — меню убирается сразу; /menu возвращает кнопки («сворачивается»)", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    const screen = await run(cb("s:menu"), repo);
    expect(String(screen.find((c) => c.method === "sendMessage")!.payload.text)).toContain("✅ <b>сворачивается</b>");
    const hide = await run(cb("menu:hidden"), repo);
    expect(repo.getUser(7)!.menuMode).toBe("hidden");
    const sent = hide.find((c) => c.method === "sendMessage")!;
    expect(sent.payload.reply_markup).toEqual({ remove_keyboard: true });
    expect(String(sent.payload.text)).toMatch(/кнопке «Меню»/);
    const back = await run(cmd("/menu"), repo);
    expect(repo.getUser(7)!.menuMode).toBe("collapsible");
    expect(plain(back.find((c) => c.method === "sendMessage")!.payload.reply_markup).keyboard).toBeTruthy();
  });

  it("«всегда на экране» — меню с is_persistent, как раньше", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    const calls = await run(cb("menu:always"), repo);
    expect(repo.getUser(7)!.menuMode).toBe("always");
    expect(plain(calls.find((c) => c.method === "sendMessage")!.payload.reply_markup).is_persistent).toBe(true);
  });
});
