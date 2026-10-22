import { afterAll, describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import type { Server } from "node:http";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { createHttpServer, feedClient } from "../src/http/server.js";
import { calFeedHandlers, chunkBlocks, parseFeedRequest } from "../src/bot/handlers/calFeeds.js";
import { calendarFunnel } from "../src/bot/handlers/admin.js";
import { FEED_PAST_DAYS, groupCalendar } from "../src/schedule/calendar.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import { addDays, todayMsk } from "../src/time.js";
import { subjectKey } from "../src/schedule/subjects.js";

const g = (n: number, intake = 23, profile = ""): LogicalGroup => {
  const title = `ВИШ-${n}-${intake}${profile ? ` (${profile})` : ""}`;
  return { key: title.toLowerCase(), title, prefix: "ВИШ", number: n, intake, course: 4, portalIds: [n], portalNames: [title] };
};
const GROUPS = [g(11), g(12), g(14, 24)];

function lesson(groupKey: string, date: string, subject: string, subgroup: number | null = null): Occurrence {
  return { groupKey, period: 1, date, slot: 2, start: 9 * 60 + 50, end: 11 * 60 + 10, subject, type: "лк", room: "Т-310", teacher: null, subgroup, isDistance: false, status: "scheduled", sources: [] };
}

/** Пересдача группы 12-23: «Матанализ» — в ленту попадает только с «+ппа». */
const PPA_DATE = addDays(todayMsk(), 2);

function makeService(lessons: Occurrence[], groups: LogicalGroup[] = GROUPS): ScheduleService {
  return {
    ppaLessons: (grp: LogicalGroup, keys: readonly string[] | "all") =>
      grp.key === "виш-12-23" && (keys === "all" || keys.includes(subjectKey("Матанализ"))) ? [{ ...lesson(grp.key, PPA_DATE, "Матанализ"), type: "ппа" }] : [],
    group: (key: string) => groups.find((x) => x.key === key) ?? null,
    groups: () => groups,
    materialize: (grp: LogicalGroup, from: string, to: string) => lessons.filter((l) => l.groupKey === grp.key && l.date >= from && l.date <= to),
    weekInfo: () => ({ week: 3, parity: "odd" as const, semester: 1 as const }),
    semesterFor: () => 1 as const,
    weekOneMonday: () => "2026-09-01",
  } as unknown as ScheduleService;
}

describe("календари групп от админа: разбор и база", () => {
  it("«Петров» — все группы; «Петров: 12-23 14-24» — только эти; незнакомые — отдельно", () => {
    expect(parseFeedRequest("Петров", GROUPS)!.groups.map((x) => x.title)).toEqual(["ВИШ-11-23", "ВИШ-12-23", "ВИШ-14-24"]);
    const some = parseFeedRequest("Петров, мероприятия: 12-23, 14-24 12-23 99-99", GROUPS)!;
    expect(some.label).toBe("Петров, мероприятия");
    expect(some.groups.map((x) => x.title)).toEqual(["ВИШ-12-23", "ВИШ-14-24"]);
    expect(some.unknown).toEqual(["99-99"]);
    expect(parseFeedRequest("   ", GROUPS)).toBeNull();
    expect(parseFeedRequest(": 12-23", GROUPS)).toBeNull();
    // Подпись из одних цифр /calfeed_del принял бы за номер ссылки.
    expect(parseFeedRequest("2024", GROUPS)).toBeNull();
    expect(parseFeedRequest("#17: 12-23", GROUPS)).toBeNull();
  });

  it("«+ппа» включает, «-ппа» выключает, без пометки — не трогать; «ППА» без знака — часть подписи", () => {
    expect(parseFeedRequest("Петров", GROUPS)!.ppa).toBeUndefined();
    const ppa = parseFeedRequest("Петров +ППА: 12-23", GROUPS)!;
    expect(ppa).toMatchObject({ label: "Петров", ppa: true });
    expect(ppa.groups.map((x) => x.title)).toEqual(["ВИШ-12-23"]);
    expect(parseFeedRequest("Петров: 12-23 +ппа", GROUPS)!).toMatchObject({ label: "Петров", ppa: true, unknown: [] });
    expect(parseFeedRequest("Петров -ппа", GROUPS)!).toMatchObject({ label: "Петров", ppa: false });
    expect(parseFeedRequest("Отдел ППА", GROUPS)!).toMatchObject({ label: "Отдел ППА", ppa: undefined });
  });

  it("неясный запрос группы («23») не берёт молча первую; «11-23» у двух профилей — обе", () => {
    const groups = [g(11, 23, "ЭиЭА"), g(11, 23, "РЗиАЭС"), g(12), g(14, 24)];
    const r = parseFeedRequest("Петров: 23 11-23", groups)!;
    expect(r.groups.map((x) => x.title)).toEqual(["ВИШ-11-23 (ЭиЭА)", "ВИШ-11-23 (РЗиАЭС)"]);
    expect(r.ambiguous).toEqual([{ query: "23", titles: ["ВИШ-11-23 (ЭиЭА)", "ВИШ-11-23 (РЗиАЭС)", "ВИШ-12-23"] }]);
  });

  it("повторный выпуск отдаёт те же ссылки; подпись получателя одна; отозванная не находится", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const a = repo.ensureCalFeed("виш-12-23", "Петров", 99);
    expect(repo.ensureCalFeed("виш-12-23", "петров", 99).token).toBe(a.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    // Новая группа того же получателя, написанного иначе, — под его прежней подписью.
    expect(repo.ensureCalFeed("виш-11-23", "  петров ", 99).label).toBe("Петров");
    const b = repo.ensureCalFeed("виш-12-23", "Иванова", 99);
    expect(b.token).not.toBe(a.token);
    expect(repo.calFeeds("ПЕТРОВ")).toHaveLength(2);
    expect(repo.revokeCalFeeds([a.id])).toBe(1);
    expect(repo.revokeCalFeeds([a.id])).toBe(0);
    expect(repo.calFeedByToken(a.token)).toBeNull();
    // После отзыва выпуск даёт новую ссылку, старая так и не работает.
    expect(repo.ensureCalFeed("виш-12-23", "Петров", 99).token).not.toBe(a.token);
  });

  it("пересдачи меняет только явная пометка; новая группа берёт то же, что у остальных ссылок получателя", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const c = repo.ensureCalFeed("виш-12-23", "Петров", 99, true);
    expect(c.ppa).toBe(true);
    // Повтор без пометки (например, чтобы добавить группу) пересдачи не выключает.
    expect(repo.ensureCalFeed("виш-12-23", "Петров", 99).ppa).toBe(true);
    expect(repo.ensureCalFeed("виш-14-24", "Петров", 99).ppa).toBe(true);
    expect(repo.ensureCalFeed("виш-12-23", "Петров", 99, false)).toMatchObject({ token: c.token, ppa: false });
    expect(repo.calFeedByToken(c.token)!.ppa).toBe(false);
    // Смешанно (одна с ППА, другая без) — новая без пересдач.
    expect(repo.ensureCalFeed("виш-11-23", "Петров", 99).ppa).toBe(false);
  });

  it("UID событий в календаре группы — с группой: общая потоковая пара в двух календарях не совпадает; личные UID прежние", () => {
    const soon = addDays(todayMsk(), 1);
    const svc = makeService([lesson("виш-11-23", soon, "Физика"), lesson("виш-12-23", soon, "Физика")]);
    const uids = (ics: string) => ics.split("\r\n").filter((l) => l.startsWith("UID:"));
    const a = uids(groupCalendar(svc, GROUPS[0]!, { subgroup: null, alarmMinutes: null, uidScope: GROUPS[0]!.key }).ics);
    const b = uids(groupCalendar(svc, GROUPS[1]!, { subgroup: null, alarmMinutes: null, uidScope: GROUPS[1]!.key }).ics);
    expect(a).toHaveLength(1);
    expect(a[0]).not.toBe(b[0]);
    const personalA = uids(groupCalendar(svc, GROUPS[0]!, { subgroup: null, alarmMinutes: null }).ics);
    const personalB = uids(groupCalendar(svc, GROUPS[1]!, { subgroup: null, alarmMinutes: null }).ics);
    expect(personalA).toEqual(personalB);
  });

  it("длинное режется на сообщения не длиннее 4096", () => {
    const blocks = Array.from({ length: 200 }, (_, i) => `<b>ВИШ-${i}-23</b> · #${i}\n<code>https://bot.example/cal/${"x".repeat(24)}.ics</code>`);
    const parts = chunkBlocks(blocks, "\n\n");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4096)).toBe(true);
    expect(parts.join("\n\n")).toBe(blocks.join("\n\n"));
    expect(chunkBlocks(["x".repeat(10_000)], "\n").every((p) => p.length <= 4096)).toBe(true);
  });
});

describe("календари групп от админа: лента", () => {
  let server: Server | null = null;
  afterAll(() => server?.close());

  it("расписание группы со всеми подгруппами, без напоминаний; ППА — с «+ппа»; чужие действия не меняют; отзыв — 404; пропала группа — 404; личная ссылка рядом работает как была", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const soon = addDays(todayMsk(), 1);
    const groups = [...GROUPS];
    const service = makeService([lesson("виш-12-23", soon, "Физика", 1), lesson("виш-12-23", soon, "Химия", 2), lesson("виш-11-23", soon, "Чужая")], groups);
    const feed = repo.ensureCalFeed("виш-12-23", "Петров", 99);
    const other = repo.ensureCalFeed("виш-12-23", "Иванова", 99);
    // Админ, выпустивший ссылку, — обычный пользователь бота со своими настройками и своей подпиской.
    repo.touchUser(99, "admin", "A");
    repo.updateUser(99, { groupKey: "виш-11-23", subgroup: 1, calAlarmMin: 30 });
    const personal = repo.ensureCalToken(99);
    server = createHttpServer({ repo, service, port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const url = (t: string) => `http://127.0.0.1:${port}/cal/${t}.ics`;
    const res = await fetch(url(feed.token));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("X-WR-CALNAME:ВИШ-12-23");
    expect(body).toContain("Физика");
    expect(body).toContain("Химия");
    expect(body).not.toContain("Чужая");
    expect(body).not.toContain("VALARM");
    expect(body).not.toContain("Матанализ");
    // Лента одной группы у разных получателей — одна и та же.
    expect(await (await fetch(url(other.token))).text()).toBe(body);
    // Личная подписка админа — своя группа и своё напоминание, как и раньше.
    const own = await (await fetch(url(personal)).then((r) => r.text()));
    expect(own).toContain("Чужая");
    expect(own).toContain("TRIGGER:-PT30M");
    // Кто бы что ни менял в боте — у ссылки группы своя жизнь.
    repo.updateUser(99, { groupKey: "виш-14-24", subgroup: 2, calAlarmMin: 15 });
    const again = await (await fetch(url(feed.token))).text();
    expect(again).toContain("Химия");
    expect(again).not.toContain("VALARM");
    // С «+ппа» — все пересдачи группы, в той же ссылке и сразу (ключ кеша другой).
    repo.ensureCalFeed("виш-12-23", "Петров", 99, true);
    const withPpa = await (await fetch(url(feed.token))).text();
    expect(withPpa).toContain("Матанализ");
    expect(withPpa).toContain("Химия");
    expect(withPpa).not.toContain("VALARM");
    // У Ивановой ППА не включали.
    expect(await (await fetch(url(other.token))).text()).not.toContain("Матанализ");
    repo.revokeCalFeeds([feed.id]);
    // Кеш ленты общий, но отзыв проверяется по базе раньше кеша: 404 сразу.
    expect((await fetch(url(feed.token))).status).toBe(404);
    // Группа исчезла из расписания — ссылка отвечает 404, а не падает.
    groups.splice(groups.findIndex((x) => x.key === "виш-12-23"), 1);
    expect((await fetch(url(other.token))).status).toBe(404);
  });
});

describe("прошедшие пары в лентах", () => {
  let server: Server | null = null;
  afterAll(() => server?.close());

  it("лента держит полгода прошлого без напоминаний; файл .ics — с сегодня", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const today = todayMsk();
    const service = makeService([
      lesson("виш-12-23", addDays(today, -3), "Недавняя"),
      lesson("виш-12-23", addDays(today, -FEED_PAST_DAYS - 5), "Давняя"),
      lesson("виш-12-23", addDays(today, 1), "Завтрашняя"),
    ]);
    repo.touchUser(7, "s", "S");
    repo.updateUser(7, { groupKey: "виш-12-23", calAlarmMin: 15 });
    const token = repo.ensureCalToken(7);
    const feed = repo.ensureCalFeed("виш-12-23", "Петров", 99);
    server = createHttpServer({ repo, service, port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const get = async (t: string) => (await fetch(`http://127.0.0.1:${port}/cal/${t}.ics`)).text();
    for (const body of [await get(token), await get(feed.token)]) {
      expect(body).toContain("Недавняя");
      expect(body).toContain("Завтрашняя");
      expect(body).not.toContain("Давняя");
    }
    // Напоминание — только у будущей пары.
    const own = await get(token);
    expect(own.match(/BEGIN:VALARM/g)).toHaveLength(1);
    expect(own.split("BEGIN:VEVENT").find((e) => e.includes("Недавняя"))).not.toContain("VALARM");
    const file = groupCalendar(service, GROUPS[1]!, { subgroup: null, alarmMinutes: 15 }).ics;
    expect(file).not.toContain("Недавняя");
    expect(file).toContain("Завтрашняя");
  });
});

describe("воронка подписки: кто забирает ленты", () => {
  let server: Server | null = null;
  afterAll(() => server?.close());

  it("клиент — по User-Agent", () => {
    expect(feedClient("Google-Calendar-Importer")).toBe("google");
    expect(feedClient("Mozilla/5.0 (compatible; Google-Calendar-Importer)")).toBe("google");
    expect(feedClient("Mozilla/5.0 (compatible; YandexCalendar/1.0; +http://yandex.com/bots)")).toBe("yandex");
    expect(feedClient("iOS/18.1 (22B83) dataaccessd/1.0")).toBe("apple");
    expect(feedClient("macOS/15.1 (24B83) CalendarAgent/1000")).toBe("apple");
    expect(feedClient("Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0)")).toBe("outlook");
    expect(feedClient("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36")).toBe("browser");
    expect(feedClient("okhttp/4.12")).toBe("other");
    expect(feedClient(undefined)).toBe("other");
  });

  it("забор ленты записывается по владельцу и клиенту; HEAD и 404 не считаются", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const service = makeService([lesson("виш-12-23", addDays(todayMsk(), 1), "Физика")]);
    repo.touchUser(7, "s", "S");
    repo.updateUser(7, { groupKey: "виш-12-23" });
    const token = repo.ensureCalToken(7);
    repo.touchUser(8, "t", "T");
    repo.ensureCalToken(8);
    const feed = repo.ensureCalFeed("виш-12-23", "Петров", 99);
    server = createHttpServer({ repo, service, port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const get = (t: string, ua: string, method = "GET") => fetch(`http://127.0.0.1:${port}/cal/${t}.ics`, { method, headers: { "user-agent": ua } });
    await get(token, "Google-Calendar-Importer");
    await get(token, "Google-Calendar-Importer");
    await get(token, "iOS/18.1 (22B83) dataaccessd/1.0");
    await get(feed.token, "YandexCalendar/1.0");
    await get(feed.token, "okhttp/4", "HEAD");
    await get("nonexistent-token-123", "Google-Calendar-Importer");
    const s = repo.calFetchStats(new Date(Date.now() - 86_400_000).toISOString());
    expect(s.issued).toBe(2);
    expect(s.feeds).toBe(1);
    expect(s.byKind.u).toEqual({ ever: 1, live: 1, clients: { google: 1, apple: 1 } });
    expect(s.byKind.f).toEqual({ ever: 1, live: 1, clients: { yandex: 1 } });
    // «За 7 дней» считает по последнему забору.
    expect(repo.calFetchStats(new Date(Date.now() + 60_000).toISOString()).byKind.u).toEqual({ ever: 1, live: 0, clients: {} });
    const lines = calendarFunnel(repo, 3).join("\n");
    expect(lines).toContain("Ссылку получили: 2 (за 7 дней — 3) · забирали хоть раз: 1 · за 7 дней: 1");
    expect(lines).toContain("Чем забирают за 7 дней: Google 1 · Apple 1");
    expect(lines).toContain("Ссылки групп от админа: 1 · забирали за 7 дней: 1 (Яндекс 1)");
  });
});

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
type Call = { method: string; payload: Record<string, unknown> };

async function run(update: Update, repo: Repo, opts: { admin?: boolean; listening?: boolean } = {}): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 99, type: "private" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = { repo, config: { PUBLIC_URL: "https://bot.example" }, service: makeService([]), http: { listening: opts.listening ?? true } } as unknown as Deps;
  ctx.user = repo.touchUser(99, "admin", "A");
  ctx.isAdmin = opts.admin ?? true;
  await new Composer<BotContext>().use(calFeedHandlers).middleware()(ctx, async () => undefined);
  return calls;
}

const cmd = (text: string): Update => ({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 99, type: "private", first_name: "A" }, from: { id: 99, is_bot: false, first_name: "A" }, text, entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } });
const cb = (data: string): Update => ({ update_id: 2, callback_query: { id: "1", from: { id: 99, is_bot: false, first_name: "A" }, chat_instance: "1", data, message: { message_id: 3, date: 0, chat: { id: 99, type: "private", first_name: "A" }, text: "x" } as never } });
const texts = (calls: Call[]): string => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload.text)).join("\n");
const LINK = /https:\/\/bot\.example\/cal\/[A-Za-z0-9_-]+\.ics/g;
/** callback_data кнопки «Да» из ответа бота. */
const yesButton = (calls: Call[]): string => {
  const markup = calls.find((c) => c.method === "sendMessage")!.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
  return markup.inline_keyboard[0]![0]!.callback_data;
};

describe("/calfeed_new, /calfeeds, /calfeed_del", () => {
  it("админ выпускает по ссылке на группу; повтор и /calfeeds дают те же ссылки; не админу — ничего", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const first = texts(await run(cmd("/calfeed_new Петров"), repo));
    expect(first).toContain("для «Петров»</b> (3)");
    const links = first.match(LINK)!;
    expect(links).toHaveLength(3);
    expect(first).toContain("ВИШ-14-24");
    expect(first).toContain("Google Календарь");
    expect(texts(await run(cmd("/calfeed_new Петров"), repo)).match(LINK)).toEqual(links);
    expect(texts(await run(cmd("/calfeeds  Петров"), repo)).match(LINK)).toEqual(links);
    const ppa = texts(await run(cmd("/calfeed_new петров +ппа"), repo));
    expect(ppa).toContain("для «Петров»</b> (3, с ППА)");
    expect(ppa).toContain("с сессией и пересдачами (ППА), без напоминаний");
    expect(ppa.match(LINK)).toEqual(links);
    // Один получатель — одна строка в списке, как бы ни писали подпись.
    const list = texts(await run(cmd("/calfeeds"), repo));
    expect(list).toContain("Петров — 3 группы, с ППА · ");
    expect(list.match(/Петров —/gi)).toHaveLength(1);
    expect(await run(cmd("/calfeed_new Чужой"), repo, { admin: false })).toEqual([]);
    expect(repo.calFeeds("Чужой")).toHaveLength(0);
  });

  it("подпись с HTML-символами экранируется; неясная группа — подсказка, а не молча первая", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const out = texts(await run(cmd("/calfeed_new <b>Петров & Ко: 12-23 23 99-99"), repo));
    expect(out).toContain("&lt;b&gt;Петров &amp; Ко");
    expect(out).not.toContain("<b>Петров");
    expect(out).toContain("Не нашёл группы: 99-99");
    expect(out).toContain("Неясно, какие группы");
    expect(out.match(LINK)).toHaveLength(1);
  });

  it("без публичного адреса или сервера ссылки не выдаются", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    expect(texts(await run(cmd("/calfeed_new Петров"), repo, { listening: false }))).toMatch(/не работают/);
    expect(repo.calFeeds()).toHaveLength(0);
  });

  it("отзыв — только по «Да» и ровно тех ссылок, что были в вопросе; кнопки — только админу", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    await run(cmd("/calfeed_new Петров: 12-23 14-24 11-23"), repo);
    const [a, b, c] = repo.calFeeds("Петров");
    const ask = await run(cmd("/calfeed_del Петров"), repo);
    expect(texts(ask)).toContain("Отозвать все ссылки для «Петров» — 3 группы?");
    const yes = yesButton(ask);
    expect(yes).toMatch(/^cfd:set:[0-9a-f]{8}$/);
    // Не админ кнопку нажать не может.
    expect(await run(cb(yes), repo, { admin: false })).toEqual([]);
    expect(repo.calFeeds("Петров")).toHaveLength(3);
    // До «Да» одну ссылку отозвали отдельно, а одну выпустили заново после вопроса.
    await run(cb(yesButton(await run(cmd(`/calfeed_del ${a!.id}`), repo))), repo);
    const extra = repo.ensureCalFeed("виш-15-24", "Петров", 99);
    const done = await run(cb(yes), repo);
    expect(String(done.find((c2) => c2.method === "editMessageText")!.payload.text)).toContain("Отозвал 2 ссылки");
    expect(repo.calFeedByToken(b!.token)).toBeNull();
    expect(repo.calFeedByToken(c!.token)).toBeNull();
    expect(repo.calFeedByToken(extra.token)).not.toBeNull();
    // Повторное нажатие той же кнопки — вопрос устарел.
    const again = await run(cb(yes), repo);
    expect(again.find((c2) => c2.method === "answerCallbackQuery")!.payload.show_alert).toBe(true);
  });

  it("«Нет» ничего не трогает; кнопка первого выпуска (cfd:all) — устарела, ничего не отзывает", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    await run(cmd("/calfeed_new Петров: 12-23 14-24"), repo);
    const ask = await run(cmd("/calfeed_del Петров"), repo);
    const no = (ask.find((c2) => c2.method === "sendMessage")!.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }).inline_keyboard[0]![1]!.callback_data;
    await run(cb(no), repo);
    expect(repo.calFeeds("Петров")).toHaveLength(2);
    // После «Нет» та же «Да» уже не срабатывает.
    await run(cb(yesButton(ask)), repo);
    expect(repo.calFeeds("Петров")).toHaveLength(2);
    await run(cb(`cfd:all:${repo.calFeeds("Петров")[0]!.id}`), repo);
    expect(repo.calFeeds("Петров")).toHaveLength(2);
  });
});
