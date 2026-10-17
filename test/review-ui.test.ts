/**
 * Ревью PR #34–#52, часть C: интерфейс. Ожидание ввода снимается кнопкой меню,
 * обращение из нескольких сообщений, слайды (даты, части PDF, не перехватывают
 * чужой ввод), «Спросить ИИ» под своим ответом, подтверждение «Отклонить»,
 * счётчики по кнопкам панелей, справка под скрытое меню и преподавателя.
 */
import { describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo, type SlideDeckRow } from "../src/db/repo.js";
import { hubHandlers } from "../src/bot/handlers/hub.js";
import { freeTextSearch, miscHandlers } from "../src/bot/handlers/misc.js";
import { newestFirst, parseSlidesQuery, slidesHandlers } from "../src/bot/handlers/slides.js";
import { recSlotsHandlers } from "../src/bot/handlers/recSlots.js";
import { parseAlarm } from "../src/bot/handlers/calendar.js";
import { deckFileName, deckPartLabel } from "../src/notify/deckName.js";
import { BTN, btnLabels, currentLabel, FIND_BTN, isMenuText, MORE_BTN } from "../src/bot/keyboards.js";
import { featuresText } from "../src/bot/views.js";
import type { BotContext, Deps, PendingState } from "../src/bot/context.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
const ADMIN = 900;
const USER = 7;
type Call = { method: string; payload: Record<string, unknown> };

function makeDeps(opts: { answer?: (q: string) => string } = {}) {
  const repo = new Repo(openDatabase(":memory:"));
  repo.touchUser(USER, "student_u", "Студент");
  repo.touchUser(ADMIN, "admin_u", "Админ");
  const asked: string[] = [];
  const ask = opts.answer
    ? {
        answer: async (a: { question: string }) => {
          asked.push(a.question);
          return { text: opts.answer!(a.question), inputTokens: 1, outputTokens: 1, mentions: { teachers: [], webinarTeachers: [], students: [], groupKeys: [] } };
        },
      }
    : null;
  const deps = {
    repo,
    config: { ADMIN_IDS: [ADMIN], SUPPORT_CONTACT: "@support", POISK: false, POSTER_THEME: "midnight", SLIDES_TOKEN: "x".repeat(16), AI_DAILY_LIMIT_PER_USER: 10, AI_DAILY_LIMIT_GLOBAL: 100, POLL_CRON_BUSY: "*/6 * * * *", BOT_TOKEN: "123:FAKE-TOKEN-FOR-TESTS-ONLY", NEWS_CHANNEL_IDS: [], MEDIA_CHAT_IDS: [] },
    service: { group: () => null, groups: () => [], materialize: () => [], intakes: () => [], stream: () => [] },
    renderer: null,
    ask,
    teachers: null,
    students: null,
    known: null,
    http: null,
    inline: false,
    botUsername: "vish_bot",
    pending: new Map<number, PendingState>(),
  } as unknown as Deps;
  return { deps, asked };
}

let mid = 1000;
const text = (t: string, from = USER): Update => ({ update_id: mid, message: { message_id: mid++, date: 0, chat: { id: from, type: "private", first_name: "U" }, from: { id: from, is_bot: false, first_name: "U", username: "student_u" }, text: t } });
const press = (data: string, from = USER): Update => ({ update_id: mid++, callback_query: { id: "1", from: { id: from, is_bot: false, first_name: "U" }, chat_instance: "1", data, message: { message_id: 3, date: 0, chat: { id: from, type: "private", first_name: "U" }, text: "x" } as never } });

async function run(deps: Deps, update: Update, from = USER, chain: Composer<BotContext>[] = [hubHandlers, slidesHandlers, miscHandlers]): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 500 + calls.length, date: 0, chat: { id: from, type: "private" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = deps;
  ctx.user = deps.repo.getUser(from)!;
  ctx.isAdmin = from === ADMIN;
  const all = new Composer<BotContext>();
  for (const c of chain) all.use(c);
  await all.middleware()(ctx, async () => undefined);
  return calls;
}

async function botWith(deps: Deps) {
  const { createBot } = await import("../src/bot/index.js");
  const bot = createBot(deps);
  bot.botInfo = ME;
  const calls: Call[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 77, date: 0, chat: { id: USER, type: "private" } } as never };
  });
  return { bot, calls };
}

const deck = (id: number, date: string, subject: string, title: string | null = null): SlideDeckRow => ({ id, date, subject, teacher: null, title, groups: ["ВИШ-14-25"], slides: 5, file: "/nope.pdf", bytes: 1, fileId: null, sent: 0, createdAt: "" });

describe("кнопка меню снимает ожидание ввода", () => {
  it("«🙋 Поддержка» → «🔍 Найти» → «14-24»: это уже поиск, а не обращение", async () => {
    const { deps } = makeDeps();
    const { bot, calls } = await botWith(deps);
    await bot.handleUpdate(text(BTN.complaint));
    await bot.handleUpdate(text(BTN.find));
    expect(deps.pending.get(USER)).toBeUndefined();
    calls.length = 0;
    await bot.handleUpdate(text("14-24"));
    expect(JSON.stringify(calls)).not.toContain("sup:send");
  });
});

describe("обращение из нескольких сообщений", () => {
  it("текст, потом ещё текст — уходят оба, «Отправить?» переезжает под последнее", async () => {
    const { deps } = makeDeps();
    await run(deps, text(BTN.complaint));
    const first = await run(deps, text("в пятницу не те пары"));
    expect(String(first.find((c) => c.method === "sendMessage")!.payload.text)).toContain("Можно дописать");
    const second = await run(deps, text("и аудитория другая"));
    expect(second.some((c) => c.method === "deleteMessage")).toBe(true);
    expect(String(second.find((c) => c.method === "sendMessage")!.payload.text)).toContain("эти 2 сообщения");
    const sent = await run(deps, press("sup:send"));
    const copies = sent.filter((c) => c.method === "copyMessage");
    expect(copies).toHaveLength(2);
    // Кнопки «Ответить / Не принимать» — только под последним.
    expect(JSON.stringify(copies[0]!.payload.reply_markup ?? null)).not.toContain("supa:r");
    expect(JSON.stringify(copies[1]!.payload.reply_markup)).toContain("supa:r:1");
  });
});

describe("слайды", () => {
  it("даты — как в расписании: запятые, «позавчера», несуществующий день", () => {
    expect(parseSlidesQuery("история, вчера", "2026-10-16")).toMatchObject({ subject: "история", date: "2026-10-15" });
    expect(parseSlidesQuery("экономика позавчера!", "2026-10-16")).toMatchObject({ subject: "экономика", date: "2026-10-14" });
    expect(parseSlidesQuery("физика (09.10)")).toMatchObject({ subject: "физика", day: 9, month: 10 });
    expect(parseSlidesQuery("физика 31.02.2026")).toMatchObject({ subject: "физика", date: null, day: 31, month: 2 });
    expect(parseSlidesQuery("история 9-го числа")).toMatchObject({ subject: "история", day: 9, month: null });
  });

  it("«слайдики» тоже просьба", async () => {
    const { deps } = makeDeps();
    const calls = await run(deps, text("слайдики"));
    expect(String(calls.find((c) => c.method === "sendMessage")!.payload.text)).toContain("Записанных вебинаров у меня пока нет");
  });

  it("бот ждёт ввод — «слайды…» достаётся тому диалогу", async () => {
    const { deps } = makeDeps();
    deps.pending.set(USER, { kind: "people", expiresAt: Date.now() + 60_000 });
    const calls = await run(deps, text("слайды экономика"), USER, [slidesHandlers]);
    expect(calls).toEqual([]);
  });

  it("части большого PDF: подписи «ч. 2/3», своё имя файла, по порядку 1, 2, 3", () => {
    const parts = [deck(12, "2026-10-09", "Физика", "Тема · часть 3 из 3"), deck(11, "2026-10-09", "Физика", "Тема · часть 2 из 3"), deck(10, "2026-10-09", "Физика", "Тема · часть 1 из 3"), deck(9, "2026-10-10", "Химия")];
    expect(newestFirst(parts).map((d) => d.id)).toEqual([9, 10, 11, 12]);
    expect(deckPartLabel("Тема · часть 2 из 3")).toBe(" · ч. 2/3");
    expect(deckPartLabel(null)).toBe("");
    expect(deckFileName({ date: "2026-10-09", subject: "Физика", title: "часть 2 из 3" })).toBe("2026-10-09-Физика-часть 2.pdf");
    expect(deckFileName({ date: "2026-10-09", subject: "Физика" })).toBe("2026-10-09-Физика.pdf");
  });
});

describe("«💬 Спросить ИИ» под ответом поиска", () => {
  it("кнопка под старым ответом спрашивает про тот текст, а не про последний", async () => {
    const { deps, asked } = makeDeps({ answer: (q) => `ответ на ${q}` });
    const markups: string[] = [];
    for (const q of ["когда матан", "где физра"]) {
      const calls = await run(deps, text(q), USER, []);
      const api = new Api("123:FAKE");
      api.config.use(async (_p, method, payload) => {
        if (method === "sendMessage") markups.push(JSON.stringify((payload as { reply_markup?: unknown }).reply_markup));
        return { ok: true, result: { message_id: 1, date: 0, chat: { id: USER, type: "private" } } as never };
      });
      const ctx = new Context(text(q), api, ME) as BotContext;
      Object.assign(ctx, { deps, user: deps.repo.getUser(USER)!, isAdmin: false });
      await freeTextSearch(ctx, q);
      expect(calls).toEqual([]);
    }
    const first = /fx:ai:(\d+)/.exec(markups[0]!)![0];
    expect(/fx:ai:(\d+)/.exec(markups[1]!)![0]).not.toBe(first);
    await run(deps, press(first));
    expect(asked).toEqual(["когда матан"]);
    // Кнопка из прошлой версии (без номера) не падает.
    await run(deps, press("fx:ai"));
  });
});

describe("заявка на запись: «Отклонить» с подтверждением", () => {
  it("первое нажатие только спрашивает, «Да, отклонить» — отклоняет", async () => {
    const { deps } = makeDeps();
    const id = deps.repo.createRecRequest({ userId: USER, username: "student_u", groupKey: "виш-14-25", groupTitle: "ВИШ-14-25", envelopeJson: "{}" });
    deps.repo.setRecRequestState(id, "verified");
    const ask = await run(deps, press(`rq:no:${id}`, ADMIN), ADMIN, [recSlotsHandlers]);
    expect(deps.repo.recRequest(id)!.state).toBe("verified");
    const edit = ask.find((c) => c.method === "editMessageText")!;
    expect(String(edit.payload.text)).toContain("Отклонить?");
    expect(JSON.stringify(edit.payload.reply_markup)).toContain(`rq:noy:${id}`);
    await run(deps, press(`rq:noy:${id}`, ADMIN), ADMIN, [recSlotsHandlers]);
    expect(deps.repo.recRequest(id)!.state).toBe("rejected");
  });
});

describe("подписи и счётчики", () => {
  it("старые подписи — те же кнопки; в /stats сводятся к нынешней", () => {
    expect(btnLabels("complaint")).toEqual(["🙋 Поддержка", "🏛 Жалоба", "👥 Поддержка", "💬 Поддержка"]);
    expect(isMenuText("👥 Поддержка")).toBe(true);
    expect(currentLabel("☰ Ещё")).toBe(BTN.more);
    expect(currentLabel(BTN.today)).toBe(BTN.today);
  });

  it("кнопки панелей считаются по отдельности, старая подпись — вместе с новой", async () => {
    const { deps } = makeDeps();
    const { bot } = await botWith(deps);
    await bot.handleUpdate(press("hub:stream"));
    await bot.handleUpdate(press("more:help"));
    await bot.handleUpdate(text("☰ Ещё"));
    const keys = deps.repo.countersSince("2000-01-01").map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["cb:hub:stream", "cb:more:help", `btn:${BTN.more}`]));
    expect(keys).not.toContain("btn:☰ Ещё");
  });

  it("«Найти»: «👥 Другие группы» не путается с «👥 Группа» в настройках", () => {
    expect(FIND_BTN.groups).toBe("👥 Другие группы");
    expect(MORE_BTN.changes).toBe("🔔 Изменения и объявления");
  });
});

describe("справка", () => {
  it("скрытое меню — команды вместо «🔍 Найти → …»; преподавателю — «👥 Группы»", () => {
    const { deps } = makeDeps();
    const hidden = featuresText(deps, { menuHidden: true });
    expect(hidden).not.toContain(`${BTN.find} →`);
    expect(hidden).not.toContain(`${BTN.more} →`);
    expect(hidden).toContain("/groups");
    expect(hidden).toContain("/changes");
    const teacher = featuresText(deps, { teacher: true });
    expect(teacher).toContain(`${BTN.find} → «${FIND_BTN.teacherGroups}»`);
    expect(teacher).not.toContain(FIND_BTN.groups);
    expect(featuresText(deps)).toContain(`${BTN.more} → «${MORE_BTN.changes}»`);
  });
});

describe("календарь: «✏️ Своё»", () => {
  it("«15 минут», «20 мин.» — кириллица после числа понимается", () => {
    expect(parseAlarm("15 минут")).toBe(15);
    expect(parseAlarm("20 мин.")).toBe(20);
    expect(parseAlarm("45")).toBe(45);
    expect(parseAlarm("15 часов")).toBeNull();
  });
});
