import { describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo, type ScheduleFormat } from "../src/db/repo.js";
import { Notifier } from "../src/notify/dispatcher.js";
import { settingsHandlers } from "../src/bot/handlers/settings.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import type { Renderer } from "../src/render/image.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { TeacherService } from "../src/portal/teachers.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import type { WallClock } from "../src/time.js";

const group: LogicalGroup = { key: "виш-14-24", title: "ВИШ-14-24", prefix: "ВИШ", number: 14, intake: 24, course: 3, portalIds: [1], portalNames: ["ВИШ-14-24"] };
const DAY = "2026-10-06";
const NEXT = "2026-10-07";

function lesson(date: string, slot: number, start: number, subject: string, isDistance = false): Occurrence {
  return { groupKey: group.key, period: 1, date, slot, start, end: start + 80, subject, type: "лк", room: "Г-402", teacher: null, subgroup: null, isDistance, status: "scheduled", sources: ["ВИШ-14-24"] };
}

const service = {
  group: (key: string) => (key === group.key ? group : null),
  groups: () => [group],
  lessonsOn: (_g: LogicalGroup, date: string) =>
    ({ [DAY]: [lesson(DAY, 4, 13 * 60 + 30, "ЭВМ и периферийные устройства"), lesson(DAY, 6, 16 * 60 + 40, "Языки ООП", true)], [NEXT]: [lesson(NEXT, 2, 9 * 60 + 50, "Киберимунные системы")] })[date] ?? [],
  weekInfo: () => ({ week: 6, parity: "even" as const, semester: 1 as const }),
} as unknown as ScheduleService;

type Sent = { method: "sendMessage" | "sendPhoto"; text?: string; caption?: string; markup?: string };

function setup(format: ScheduleFormat, opts: { renderer?: "ok" | "fail" | "none" } = {}) {
  const repo = new Repo(openDatabase(":memory:"));
  repo.touchUser(1, "u", "U");
  repo.updateUser(1, { groupKey: group.key, format, remindFirstMin: 120, remindEachMin: 10, eveningAt: "20:00" });
  const sent: Sent[] = [];
  const api = {
    sendMessage: async (_id: number, text: string, o: { reply_markup?: unknown }) => (sent.push({ method: "sendMessage", text, markup: JSON.stringify(o?.reply_markup ?? null) }), { message_id: 1 }),
    sendPhoto: async (_id: number, _f: unknown, o: { caption?: string; reply_markup?: unknown }) => (sent.push({ method: "sendPhoto", caption: o?.caption, markup: JSON.stringify(o?.reply_markup ?? null) }), { message_id: 2 }),
  } as never;
  const mode = opts.renderer ?? "ok";
  const renderer = mode === "none" ? null : ({ renderDay: async () => (mode === "ok" ? Buffer.from("png") : Promise.reject(new Error("render"))) } as unknown as Renderer);
  return { repo, sent, n: new Notifier(api, repo, service, renderer) };
}

const clock = (date: string, hh: number, mm: number): WallClock => ({ date, minutes: hh * 60 + mm, weekday: 2, ms: 0 });

describe("напоминания о парах — в выбранном формате", () => {
  it("«картинка» — только постер, в подписи одна строка, что это за напоминание", async () => {
    const t = setup("image");
    expect(await t.n.tickReminders(clock(DAY, 11, 30))).toBe(1);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.method).toBe("sendPhoto");
    expect(t.sent[0]!.caption).toBe("⏰ Через 2 часа первая пара");
    expect(t.sent[0]!.markup).toContain("rm:off:first");
    // Вечером — так же: «🌙 Завтра», без двоеточия и без текста расписания.
    expect(await t.n.tickReminders(clock(DAY, 20, 0))).toBe(1);
    expect(t.sent[1]!.caption).toBe("🌙 Завтра");
    expect(t.sent[1]!.markup).toContain("rm:off:evening");
  });

  it("«оба» — постер с расписанием в подписи; «текст» — только текст", async () => {
    const both = setup("both");
    await both.n.tickReminders(clock(DAY, 11, 30));
    expect(both.sent).toHaveLength(1);
    expect(both.sent[0]!.method).toBe("sendPhoto");
    expect(both.sent[0]!.caption).toMatch(/^⏰ Через 2 часа первая пара\n\n/);
    expect(both.sent[0]!.caption).toContain("ЭВМ и периферийные устройства");

    const text = setup("text");
    await text.n.tickReminders(clock(DAY, 11, 30));
    expect(text.sent.map((s) => s.method)).toEqual(["sendMessage"]);
    expect(text.sent[0]!.text).toContain("ЭВМ и периферийные устройства");
    expect(text.sent[0]!.markup).toContain("rm:off:first");
  });

  it("постер не нарисовался — у «картинки» приходит текст целиком, а не одна строка", async () => {
    const t = setup("image", { renderer: "fail" });
    await t.n.tickReminders(clock(DAY, 11, 30));
    expect(t.sent.map((s) => s.method)).toEqual(["sendMessage"]);
    expect(t.sent[0]!.text).toMatch(/^⏰ Через 2 часа первая пара\n\n/);
    expect(t.sent[0]!.text).toContain("ЭВМ и периферийные устройства");
  });

  it("под напоминанием перед дистантом — и ссылка на вебинары, и «отключить»", async () => {
    const t = setup("image");
    t.repo.updateUser(1, { remindFirstMin: null });
    await t.n.tickReminders(clock(DAY, 16, 30));
    const markup = JSON.parse(t.sent[0]!.markup!) as { inline_keyboard: Array<Array<{ url?: string; callback_data?: string }>> };
    expect(markup.inline_keyboard[0]![0]!.url).toMatch(/webinar/);
    expect(markup.inline_keyboard[1]![0]!.callback_data).toBe("rm:off:each");
  });

  it("слежение за преподавателем: «картинка» — постер, под ним «Не следить за преподом»", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(1, "u", "U");
    repo.updateUser(1, { format: "image" });
    repo.toggleWatchTeacher(1, 55, "Путевская И. В.");
    const sent: Sent[] = [];
    const api = {
      sendMessage: async (_id: number, text: string) => (sent.push({ method: "sendMessage", text }), { message_id: 1 }),
      sendPhoto: async (_id: number, _f: unknown, o: { caption?: string; reply_markup?: unknown }) => (sent.push({ method: "sendPhoto", caption: o?.caption, markup: JSON.stringify(o?.reply_markup ?? null) }), { message_id: 2 }),
    } as never;
    let labels: unknown;
    const renderer = { renderDay: async (a: { labels?: unknown }) => ((labels = a.labels), Buffer.from("png")) } as unknown as Renderer;
    const teachers = { lessons: async (_t: unknown, from: string) => ({ lessons: [lesson(from, 4, 13 * 60 + 30, "ЭВМ")], fullName: "Путевская Ирина Владимировна" }) } as unknown as TeacherService;
    const n = new Notifier(api, repo, service, renderer, [], null, teachers);
    expect(await n.tickTeacherWatches(clock(DAY, 11, 30))).toBe(1);
    expect(sent[0]!.method).toBe("sendPhoto");
    expect(sent[0]!.caption).toBe("👨‍🏫 Через 2 часа первая пара у <b>Путевская Ирина Владимировна</b>");
    expect(sent[0]!.markup).toContain("twf:55");
    expect(labels).toBe("groups");
  });
});

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };

type Call = { method: string; payload: Record<string, unknown> };
type Markup = { inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>> };

async function press(repo: Repo, data: string, markup: Markup): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: true as never };
  });
  const update: Update = { update_id: 1, callback_query: { id: "1", from: { id: 7, is_bot: false, first_name: "U" }, chat_instance: "1", data, message: { message_id: 3, date: 0, chat: { id: 7, type: "private", first_name: "U" }, text: "x", reply_markup: markup } as never } };
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = { repo, config: { POSTER_THEME: "midnight" }, service: { group: () => null }, renderer: null, known: null, teachers: null } as unknown as Deps;
  ctx.user = repo.getUser(7)!;
  ctx.isAdmin = false;
  await new Composer<BotContext>().use(settingsHandlers).middleware()(ctx, async () => undefined);
  return calls;
}

const newMarkup = (calls: Call[]): Markup => calls.find((c) => c.method === "editMessageReplyMarkup")!.payload.reply_markup as Markup;
const toast = (calls: Call[]): string => String(calls.find((c) => c.method === "answerCallbackQuery")!.payload.text ?? "");
const datas = (m: Markup): string[] => m.inline_keyboard.flat().map((b) => b.callback_data ?? b.url ?? "");

describe("«🔕 Отключить эти уведомления» под напоминанием", () => {
  const webinarRow = [{ text: "💻 Вебинары портала", url: "https://tt.chuvsu.ru/webinar" }];

  it("одно нажатие выключает это напоминание; «↩️ Вернуть» возвращает прежнее значение, ссылка остаётся", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    repo.updateUser(7, { remindEachMin: 15, remindFirstMin: 120 });
    const off = await press(repo, "rm:off:each", { inline_keyboard: [webinarRow, [{ text: "🔕", callback_data: "rm:off:each" }]] });
    expect(repo.getUser(7)!.remindEachMin).toBeNull();
    expect(repo.getUser(7)!.remindFirstMin).toBe(120);
    expect(toast(off)).toMatch(/Отключено: напоминание перед каждой парой/);
    const m = newMarkup(off);
    expect(datas(m)).toEqual(["https://tt.chuvsu.ru/webinar", "rm:on:each:15", "rm:all:each:15"]);

    const on = await press(repo, "rm:on:each:15", m);
    expect(repo.getUser(7)!.remindEachMin).toBe(15);
    expect(datas(newMarkup(on))).toEqual(["https://tt.chuvsu.ru/webinar", "rm:off:each"]);
  });

  it("«отключить все» гасит все четыре, «вернуть все» возвращает их — вместе с выключенным шагом раньше", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    repo.updateUser(7, { remindFirstMin: 120, remindDistanceMin: 5, eveningAt: "21:00" });
    const off = await press(repo, "rm:off:first", { inline_keyboard: [[{ text: "🔕", callback_data: "rm:off:first" }]] });
    const all = await press(repo, datas(newMarkup(off))[1]!, newMarkup(off));
    const u = repo.getUser(7)!;
    expect([u.remindFirstMin, u.remindEachMin, u.remindDistanceMin, u.eveningAt]).toEqual([null, null, null, null]);
    const back = datas(newMarkup(all))[0]!;
    expect(back).toBe("rm:back:first:120|-|5|21:00");
    await press(repo, back, newMarkup(all));
    const r = repo.getUser(7)!;
    expect([r.remindFirstMin, r.remindEachMin, r.remindDistanceMin, r.eveningAt]).toEqual([120, null, 5, "21:00"]);
  });

  it("единственное включённое напоминание — без «отключить все»; повторное нажатие ничего не ломает", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    repo.updateUser(7, { eveningAt: "20:00" });
    const off = await press(repo, "rm:off:evening", { inline_keyboard: [[{ text: "🔕", callback_data: "rm:off:evening" }]] });
    expect(datas(newMarkup(off))).toEqual(["rm:on:evening:20:00"]);
    const again = await press(repo, "rm:off:evening", { inline_keyboard: [[{ text: "🔕", callback_data: "rm:off:evening" }]] });
    expect(toast(again)).toMatch(/уже отключено/);
    expect(datas(newMarkup(again))).toEqual(["noop"]);
    await press(repo, "rm:on:evening:20:00", newMarkup(off));
    expect(repo.getUser(7)!.eveningAt).toBe("20:00");
  });

  it("кривое значение в кнопке «Вернуть» не записывается", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    const calls = await press(repo, "rm:on:first:abc", { inline_keyboard: [] });
    expect(repo.getUser(7)!.remindFirstMin).toBeNull();
    expect(toast(calls)).toMatch(/Настройках/);
    await press(repo, "rm:on:evening:99:99", { inline_keyboard: [] });
    expect(repo.getUser(7)!.eveningAt).toBeNull();
  });
});
