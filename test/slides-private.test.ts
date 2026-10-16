import { describe, expect, it } from "vitest";
import { Api, Composer, Context, InlineKeyboard } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { addDeckButtons, deckRows, findDecks, parseSlidesQuery, slidesHandlers } from "../src/bot/handlers/slides.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import type { LogicalGroup } from "../src/schedule/groups.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
const USER = 7;
type Call = { method: string; payload: Record<string, unknown> };

function makeDeps(): Deps {
  const repo = new Repo(openDatabase(":memory:"));
  repo.touchUser(USER, "student_u", "Студент");
  repo.updateUser(USER, { groupKey: "виш-14-25" });
  const deck = (date: string, subject: string, groups: string[]) => {
    const id = repo.addSlideDeck({ date, subject, teacher: null, title: null, groups, slides: 12, file: "/нет/такого.pdf", bytes: 1 });
    repo.setDeckFileId(id, `file-${id}`);
    return id;
  };
  deck("2026-10-09", "История России", ["ВИШ-11-25", "ВИШ-14-25"]);
  deck("2026-10-16", "Экономика", ["ВИШ-11-25", "ВИШ-14-25", "ОЗВИШ-12-25"]);
  deck("2026-10-16", "Программирование станков с ЧПУ", ["ВИШ-12-23", "ВИШ-12-23иот (13.03.02)"]);
  deck("2026-10-02", "Экономика", ["ВИШ-11-25", "ВИШ-14-25"]);
  return { repo, config: { SLIDES_TOKEN: "x".repeat(16) } } as unknown as Deps;
}

async function run(deps: Deps, update: Update): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 50, date: 0, chat: { id: USER, type: "private" }, document: { file_id: "new", file_unique_id: "u" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = deps;
  ctx.user = deps.repo.getUser(USER)!;
  const chain = new Composer<BotContext>();
  chain.use(slidesHandlers);
  await chain.middleware()(ctx, async () => undefined);
  return calls;
}

let mid = 100;
const text = (t: string, type: "private" | "group" = "private"): Update => ({ update_id: mid, message: { message_id: mid++, date: 0, chat: type === "private" ? { id: USER, type, first_name: "U" } : { id: -5, type, title: "чат" }, from: { id: USER, is_bot: false, first_name: "U" }, text: t } });
const press = (data: string): Update => ({ update_id: mid++, callback_query: { id: "1", from: { id: USER, is_bot: false, first_name: "U" }, chat_instance: "1", data, message: { message_id: 3, date: 0, chat: { id: USER, type: "private", first_name: "U" }, text: "x" } as never } });
const doc = (calls: Call[]) => calls.find((c) => c.method === "sendDocument");
const markup = (c: Call | undefined) => JSON.stringify(c?.payload.reply_markup ?? null);

describe("слайды в личке по просьбе", () => {
  it("разбор: предмет и дата из «скинь слайды по экономике за 09.10», «вчера», «9 число»", () => {
    expect(parseSlidesQuery("по экономике за 09.10")).toEqual({ subject: "экономике", date: null, day: 9, month: 10 });
    expect(parseSlidesQuery("история вчера", "2026-10-16")).toMatchObject({ subject: "история", date: "2026-10-15" });
    expect(parseSlidesQuery("история 9 число")).toMatchObject({ subject: "история", day: 9, month: null });
    expect(parseSlidesQuery("физика 09.10.2026")).toMatchObject({ subject: "физика", date: "2026-10-09" });
    expect(parseSlidesQuery("")).toEqual({ subject: "", date: null, day: null, month: null });
  });

  it("«слайды экономика» — свежая запись своей группы файлом; остальные записи — кнопками", async () => {
    const calls = await run(makeDeps(), text("слайды экономика"));
    expect(doc(calls)?.payload.document).toBe("file-2");
    expect(String(doc(calls)?.payload.caption)).toContain("Экономика · 16.10");
    expect(markup(calls.find((c) => c.method === "sendMessage"))).toContain("sld:4");
  });

  it("с датой: «скинь слайды по экономике за 02.10» — именно та запись", async () => {
    const calls = await run(makeDeps(), text("скинь слайды по экономике за 02.10"));
    expect(doc(calls)?.payload.document).toBe("file-4");
  });

  it("просто «слайды» — список последних записей своей группы, без чужих", async () => {
    const calls = await run(makeDeps(), text("слайды"));
    const m = markup(calls.find((c) => c.method === "sendMessage"));
    expect(m).toContain("sld:1");
    expect(m).toContain("sld:2");
    expect(m).not.toContain("sld:3");
    expect(doc(calls)).toBeUndefined();
  });

  it("нет такой записи — честный ответ без файла", async () => {
    const calls = await run(makeDeps(), text("слайды матан"));
    expect(doc(calls)).toBeUndefined();
    expect(String(calls.find((c) => c.method === "sendMessage")?.payload.text)).toContain("записываются не все");
  });

  it("кнопка sld:<id> присылает файл; удалённая запись — текст, не падение", async () => {
    expect(doc(await run(makeDeps(), press("sld:3")))?.payload.document).toBe("file-3");
    const gone = await run(makeDeps(), press("sld:999"));
    expect(doc(gone)).toBeUndefined();
    expect(String(gone.find((c) => c.method === "sendMessage")?.payload.text)).toContain("уже нет");
  });

  it("в групповом чате «слайды …» этот обработчик не трогает (там свой путь через @бота)", async () => {
    expect(await run(makeDeps(), text("слайды экономика", "group"))).toEqual([]);
  });

  it("обычный текст про другое не перехватывается", async () => {
    expect(await run(makeDeps(), text("14-25"))).toEqual([]);
  });
});

describe("кнопка «📎 Слайды» под расписанием дня", () => {
  const g1425 = { key: "виш-14-25" } as LogicalGroup;
  const g1223 = { key: "виш-12-23" } as LogicalGroup;

  it("только записи этого дня и этой группы (подгруппа «иот» — та же группа)", () => {
    const deps = makeDeps();
    expect(deckRows(deps.repo.slideDecksOn("2026-10-16"), g1425, "2026-10-16").map((d) => d.subject)).toEqual(["Экономика"]);
    expect(deckRows(deps.repo.slideDecksOn("2026-10-16"), g1223, "2026-10-16").map((d) => d.subject)).toEqual(["Программирование станков с ЧПУ"]);
    expect(deckRows(deps.repo.slideDecksOn("2026-10-15"), g1425, "2026-10-15")).toEqual([]);
  });

  it("нет записей — клавиатура не меняется; есть — строка «📎 Слайды: предмет»", () => {
    const deps = makeDeps();
    const empty = addDeckButtons(new InlineKeyboard().text("◀️", "d:1"), deps, g1425, "2026-10-15");
    expect(empty.inline_keyboard).toHaveLength(1);
    const kb = addDeckButtons(new InlineKeyboard().text("◀️", "d:1"), deps, g1425, "2026-10-16");
    expect(kb.inline_keyboard[1]).toEqual([{ text: "📎 Слайды: Экономика", callback_data: "sld:2" }]);
  });

  it("findDecks: своя группа первой, потом остальные", () => {
    const deps = makeDeps();
    const all = deps.repo.recentSlideDecks(50);
    expect(findDecks(all, { subject: "", date: "2026-10-16", day: null, month: null }, "виш-12-23").map((d) => d.id)).toEqual([3, 2]);
  });
});
