import { describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { calendarHandlers, calendarKeyboard, parseAlarm } from "../src/bot/handlers/calendar.js";
import type { BotContext, Deps, PendingState } from "../src/bot/context.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import { addDays, todayMsk } from "../src/time.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
const USER = 7;
const group: LogicalGroup = { key: "виш-14-24", title: "ВИШ-14-24", prefix: "ВИШ", number: 14, intake: 24, course: 3, portalIds: [1], portalNames: ["ВИШ-14-24"] };
const day = addDays(todayMsk(), 1);
const lesson = { groupKey: group.key, period: 1, date: day, slot: 2, start: 590, end: 670, subject: "Базы данных", type: "лк", room: "Б-315", teacher: null, subgroup: null, isDistance: false, status: "scheduled", sources: [] };

function makeDeps(opts: { http?: boolean } = {}) {
  const repo = new Repo(openDatabase(":memory:"));
  repo.touchUser(USER, "u", "U");
  repo.updateUser(USER, { groupKey: group.key });
  return {
    repo,
    config: { PUBLIC_URL: opts.http ? "https://cal.example" : "" },
    http: opts.http ? { listening: true } : null,
    service: { group: (k: string) => (k === group.key ? group : null), weekOneMonday: () => null, semesterFor: () => 1, materialize: () => [lesson] },
    pending: new Map<number, PendingState>(),
  } as unknown as Deps;
}

type Call = { method: string; payload: Record<string, unknown> };
async function run(deps: Deps, update: Update): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 5, date: 0, chat: { id: USER, type: "private" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = deps;
  ctx.user = deps.repo.getUser(USER)!;
  ctx.isAdmin = false;
  const chain = new Composer<BotContext>();
  chain.use(calendarHandlers);
  await chain.middleware()(ctx, async () => undefined);
  return calls;
}
let n = 1;
const text = (t: string): Update => ({ update_id: n, message: { message_id: n++, date: 0, chat: { id: USER, type: "private", first_name: "U" }, from: { id: USER, is_bot: false, first_name: "U" }, text: t } });
const press = (data: string): Update => ({ update_id: n++, callback_query: { id: "1", from: { id: USER, is_bot: false, first_name: "U" }, chat_instance: "1", data, message: { message_id: 3, date: 0, chat: { id: USER, type: "private", first_name: "U" }, text: "x" } as never } });
const icsOf = (calls: Call[]): string => {
  const doc = calls.find((c) => c.method === "sendDocument")?.payload.document as { fileData?: Buffer } | undefined;
  return doc?.fileData ? Buffer.from(doc.fileData).toString("utf8") : "";
};

describe("календарь: «✏️ Своё» — напоминание за сколько угодно минут", () => {
  it("вместо «за 60 мин» — «✏️ Своё»; 15 и 30 остались", () => {
    const ctx = { deps: makeDeps(), user: { teacherMode: false } } as unknown as BotContext;
    const kb = JSON.stringify(calendarKeyboard(ctx));
    expect(kb).toContain("ics:own");
    expect(kb).toContain("ics:15");
    expect(kb).toContain("ics:30");
    expect(kb).not.toContain("ics:60");
  });

  it("parseAlarm: 1…1440, «45 мин» тоже; больше суток, буквы и пустое — нет", () => {
    expect(parseAlarm("45")).toBe(45);
    expect(parseAlarm(" 90 мин ")).toBe(90);
    expect(parseAlarm("1440")).toBe(1440);
    expect(parseAlarm("0")).toBe(0);
    expect(parseAlarm("1441")).toBeNull();
    expect(parseAlarm("час")).toBeNull();
    expect(parseAlarm("-5")).toBeNull();
  });

  it("файл: «Своё» → бот спрашивает число → «45» → файл с напоминанием за 45 минут", async () => {
    const deps = makeDeps();
    const ask = await run(deps, press("ics:own"));
    expect(String(ask.find((c) => c.method === "sendMessage")!.payload.text)).toContain("от 1 до 1440");
    const wrong = await run(deps, text("пять"));
    expect(String(wrong.find((c) => c.method === "sendMessage")!.payload.text)).toContain("Нужно число");
    const ok = await run(deps, text("45"));
    expect(icsOf(ok)).toContain("TRIGGER:-PT45M");
    expect(String(ok.find((c) => c.method === "sendDocument")!.payload.caption)).toContain("напоминание за 45 мин");
    // Режим закрыт: следующее число — уже не про календарь.
    expect((await run(deps, text("30"))).some((c) => c.method === "sendDocument")).toBe(false);
  });

  it("подписка: «Своё» → «1440» → ссылка, а в настройке подписки — 1440 минут", async () => {
    const deps = makeDeps({ http: true });
    await run(deps, press("ics:sub:own"));
    const ok = await run(deps, text("1440"));
    expect(String(ok.find((c) => c.method === "sendMessage")!.payload.text)).toContain("напоминание за 1440 мин");
    expect(deps.repo.getUser(USER)!.calAlarmMin).toBe(1440);
  });

  it("кнопкой меню посреди ввода — выходим из режима", async () => {
    const deps = makeDeps();
    await run(deps, press("ics:own"));
    await run(deps, text("📅 Сегодня"));
    expect((await run(deps, text("45"))).some((c) => c.method === "sendDocument")).toBe(false);
  });
});

describe("календарь: ⚡ Google Календарь (прямая запись)", () => {
  const withPush = (allowed: boolean) => {
    const deps = makeDeps();
    (deps as { calendarPush?: unknown }).calendarPush = {
      allowed: () => allowed,
      connectUrl: () => "https://accounts.google.com/o/oauth2/v2/auth?state=s",
      kick: () => undefined,
      disconnect: async (id: number) => deps.repo.updateCalLink(id, "google", { status: "off", tokenEnc: null }),
    };
    return deps;
  };

  it("кнопка первой — только кому можно; не подключён — экран со ссылкой на вход и честным «доступ только к этому календарю»", async () => {
    const deps = withPush(true);
    const kb = JSON.stringify(calendarKeyboard({ deps, user: deps.repo.getUser(USER)! } as unknown as BotContext));
    expect(kb.indexOf("gcal")).toBeGreaterThan(-1);
    expect(kb.indexOf("gcal")).toBeLessThan(kb.indexOf("ics:0"));
    expect(JSON.stringify(calendarKeyboard({ deps: withPush(false), user: deps.repo.getUser(USER)! } as unknown as BotContext))).not.toContain("gcal");
    const calls = await run(deps, press("gcal"));
    const msg = calls.find((c) => c.method === "sendMessage")!;
    expect(String(msg.payload.text)).toContain("отдельный календарь «ВИШ-14-24»");
    expect(String(msg.payload.text)).toContain("другие твои календари и события бот не видит");
    expect(JSON.stringify(msg.payload.reply_markup)).toContain("https://accounts.google.com/o/oauth2/v2/auth?state=s");
  });

  it("подключён — статус, «Сверить сейчас» и «Отключить» с подтверждением", async () => {
    const deps = withPush(true);
    deps.repo.saveCalLink(USER, "google", { tokenEnc: "x", calendarId: "c", groupKey: group.key });
    expect(JSON.stringify(calendarKeyboard({ deps, user: deps.repo.getUser(USER)! } as unknown as BotContext))).toContain("Google Календарь: подключён");
    const screen = await run(deps, press("gcal"));
    expect(String(screen.find((c) => c.method === "sendMessage")!.payload.text)).toContain("Google Календарь подключён");
    const ask = await run(deps, press("gcal:off"));
    expect(JSON.stringify(ask.find((c) => c.method === "editMessageText")!.payload.reply_markup)).toContain("gcal:offy");
    expect(deps.repo.calLink(USER, "google")!.status).toBe("ok");
    await run(deps, press("gcal:offy"));
    expect(deps.repo.calLink(USER, "google")!.status).toBe("off");
  });
});
