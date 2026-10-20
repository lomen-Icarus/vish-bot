import { afterAll, describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import type { Server } from "node:http";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { createHttpServer } from "../src/http/server.js";
import { calFeedHandlers, parseFeedRequest } from "../src/bot/handlers/calFeeds.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import { addDays, todayMsk } from "../src/time.js";
import { subjectKey } from "../src/schedule/subjects.js";

const g = (n: number, intake = 23): LogicalGroup => ({ key: `виш-${n}-${intake}`, title: `ВИШ-${n}-${intake}`, prefix: "ВИШ", number: n, intake, course: 4, portalIds: [n], portalNames: [`ВИШ-${n}-${intake}`] });
const GROUPS = [g(11), g(12), g(14, 24)];

function lesson(groupKey: string, date: string, subject: string, subgroup: number | null = null): Occurrence {
  return { groupKey, period: 1, date, slot: 2, start: 9 * 60 + 50, end: 11 * 60 + 10, subject, type: "лк", room: "Т-310", teacher: null, subgroup, isDistance: false, status: "scheduled", sources: [] };
}

/** Пересдача группы 12-23: «Матанализ» — в ленту попадает только с «+ппа». */
const PPA_DATE = addDays(todayMsk(), 2);

function makeService(lessons: Occurrence[]): ScheduleService {
  return {
    ppaItems: (grp: LogicalGroup) => (grp.key === "виш-12-23" ? [{ subject: "Матанализ", date: PPA_DATE }] : []),
    ppaLessons: (grp: LogicalGroup, keys: readonly string[]) => (keys.includes(subjectKey("Матанализ")) ? [{ ...lesson(grp.key, PPA_DATE, "Матанализ"), type: "ппа" }] : []),
    group: (key: string) => GROUPS.find((x) => x.key === key) ?? null,
    groups: () => GROUPS,
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
    expect(parseFeedRequest("Петров", GROUPS)!.ppa).toBe(false);
    const ppa = parseFeedRequest("Петров +ППА: 12-23", GROUPS)!;
    expect(ppa).toMatchObject({ label: "Петров", ppa: true });
    expect(ppa.groups.map((x) => x.title)).toEqual(["ВИШ-12-23"]);
    expect(parseFeedRequest("Петров: 12-23 +ппа", GROUPS)!).toMatchObject({ label: "Петров", ppa: true, unknown: [] });
    // «ППА» без плюса — часть подписи, а не пометка.
    expect(parseFeedRequest("Отдел ППА", GROUPS)!).toMatchObject({ label: "Отдел ППА", ppa: false });
  });

  it("повторный выпуск для того же получателя отдаёт те же ссылки; отозванная не находится", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const a = repo.ensureCalFeed("виш-12-23", "Петров", 99);
    expect(repo.ensureCalFeed("виш-12-23", "петров", 99).token).toBe(a.token);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const b = repo.ensureCalFeed("виш-12-23", "Иванова", 99);
    expect(b.token).not.toBe(a.token);
    expect(repo.calFeeds("ПЕТРОВ").map((f) => f.id)).toEqual([a.id]);
    expect(repo.revokeCalFeeds([a.id])).toBe(1);
    expect(repo.revokeCalFeeds([a.id])).toBe(0);
    expect(repo.calFeedByToken(a.token)).toBeNull();
    expect(repo.calFeeds().map((f) => f.id)).toEqual([b.id]);
    // После отзыва выпуск даёт новую ссылку, старая так и не работает.
    expect(repo.ensureCalFeed("виш-12-23", "Петров", 99).token).not.toBe(a.token);
    // «+ппа» в повторном выпуске включает пересдачи в той же ссылке.
    const c = repo.ensureCalFeed("виш-14-24", "Петров", 99);
    expect(c.ppa).toBe(false);
    const d = repo.ensureCalFeed("виш-14-24", "Петров", 99, true);
    expect(d).toMatchObject({ token: c.token, ppa: true });
    expect(repo.calFeedByToken(c.token)!.ppa).toBe(true);
  });
});

describe("календари групп от админа: лента", () => {
  let server: Server | null = null;
  afterAll(() => server?.close());

  it("отдаёт расписание группы со всеми подгруппами, без напоминаний и пересдач; чьи-то действия в боте её не меняют; отзыв — 404", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const soon = addDays(todayMsk(), 1);
    const service = makeService([lesson("виш-12-23", soon, "Физика", 1), lesson("виш-12-23", soon, "Химия", 2), lesson("виш-11-23", soon, "Чужая")]);
    const feed = repo.ensureCalFeed("виш-12-23", "Петров", 99);
    // Админ, выпустивший ссылку, — обычный пользователь бота со своими настройками.
    repo.touchUser(99, "admin", "A");
    repo.updateUser(99, { groupKey: "виш-11-23", subgroup: 1, calAlarmMin: 30 });
    server = createHttpServer({ repo, service, port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/cal/${feed.token}.ics`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("X-WR-CALNAME:ВИШ-12-23");
    expect(body).toContain("Физика");
    expect(body).toContain("Химия");
    expect(body).not.toContain("Чужая");
    expect(body).not.toContain("VALARM");
    // Кто бы что ни менял в боте — у ссылки группы своя жизнь.
    repo.updateUser(99, { groupKey: "виш-14-24", subgroup: 2, calAlarmMin: 15 });
    const again = await (await fetch(url)).text();
    expect(again).toContain("Химия");
    expect(again).not.toContain("VALARM");
    expect(again).not.toContain("Матанализ");
    // С «+ппа» — все пересдачи группы, в той же ссылке и сразу (ключ кеша другой).
    repo.ensureCalFeed("виш-12-23", "Петров", 99, true);
    const withPpa = await (await fetch(url)).text();
    expect(withPpa).toContain("Матанализ");
    expect(withPpa).toContain("Химия");
    expect(withPpa).not.toContain("VALARM");
    repo.revokeCalFeeds([feed.id]);
    // Кеш ленты — по ссылке; отозванная перестаёт открываться сразу.
    expect((await fetch(url)).status).toBe(404);
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

describe("/calfeed_new, /calfeeds, /calfeed_del", () => {
  it("админ выпускает по ссылке на группу; повтор и /calfeeds дают те же ссылки; не админу — ничего", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const first = texts(await run(cmd("/calfeed_new Петров"), repo));
    expect(first).toContain("для «Петров»</b> (3)");
    const links = first.match(/https:\/\/bot\.example\/cal\/[A-Za-z0-9_-]+\.ics/g)!;
    expect(links).toHaveLength(3);
    expect(first).toContain("ВИШ-14-24");
    expect(first).toContain("Google Календарь");
    const again = texts(await run(cmd("/calfeed_new Петров"), repo));
    expect(again.match(/https:\/\/bot\.example\/cal\/[A-Za-z0-9_-]+\.ics/g)).toEqual(links);
    expect(texts(await run(cmd("/calfeeds Петров"), repo)).match(/https:\/\/bot\.example\/cal\/[A-Za-z0-9_-]+\.ics/g)).toEqual(links);
    expect(texts(await run(cmd("/calfeeds"), repo))).toContain("Петров — 3 группы · ");
    const ppa = texts(await run(cmd("/calfeed_new Петров +ппа"), repo));
    expect(ppa).toContain("(3, с ППА)");
    expect(ppa).toContain("с сессией и пересдачами (ППА), без напоминаний");
    expect(ppa.match(/https:\/\/bot\.example\/cal\/[A-Za-z0-9_-]+\.ics/g)).toEqual(links);
    expect(await run(cmd("/calfeed_new Чужой"), repo, { admin: false })).toEqual([]);
    expect(repo.calFeeds("Чужой")).toHaveLength(0);
  });

  it("без публичного адреса или сервера ссылки не выдаются", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    expect(texts(await run(cmd("/calfeed_new Петров"), repo, { listening: false }))).toMatch(/не работают/);
    expect(repo.calFeeds()).toHaveLength(0);
  });

  it("отзыв — только по «Да»: сначала вопрос, «Нет» ничего не трогает", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    await run(cmd("/calfeed_new Петров: 12-23 14-24"), repo);
    expect(repo.calFeeds("Петров")).toHaveLength(2);
    const ask = await run(cmd("/calfeed_del Петров"), repo);
    expect(texts(ask)).toContain("Отозвать все ссылки для «Петров» — 2 группы?");
    expect(repo.calFeeds("Петров")).toHaveLength(2);
    await run(cb("cfd:no"), repo);
    expect(repo.calFeeds("Петров")).toHaveLength(2);
    const one = repo.calFeeds("Петров")[0]!;
    await run(cb(`cfd:one:${one.id}`), repo);
    expect(repo.calFeeds("Петров").map((f) => f.id)).not.toContain(one.id);
    await run(cb(`cfd:all:${repo.calFeeds("Петров")[0]!.id}`), repo);
    expect(repo.calFeeds("Петров")).toHaveLength(0);
  });
});
