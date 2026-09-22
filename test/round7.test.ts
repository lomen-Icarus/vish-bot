import { describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { scheduleHandlers } from "../src/bot/handlers/schedule.js";
import { BTN } from "../src/bot/keyboards.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import type { Renderer } from "../src/render/image.js";
import type { ScheduleFormat } from "../src/db/repo.js";
import { addDays, todayMsk } from "../src/time.js";
import { buildPeopleResults, parseInlineQuery } from "../src/bot/inline.js";
import { KnownPeople, normalizeHandle } from "../src/students/known.js";
import { StudentDirectory } from "../src/students/directory.js";
import { tildaDate, tildaFeeds } from "../src/news/fetchers.js";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { miscHandlers } from "../src/bot/handlers/misc.js";
import { settingsHandlers } from "../src/bot/handlers/settings.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { User } from "../src/db/repo.js";

const group: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [8524], portalNames: ["ВИШ-12-23"] };
const other: LogicalGroup = { ...group, key: "виш-14-24", title: "ВИШ-14-24", number: 14, intake: 24, course: 3 };
const today = todayMsk();

function lesson(subject: string, slot: number): Occurrence {
  return { groupKey: group.key, period: 1, date: today, slot, start: 8 * 60 + slot * 90, end: 9 * 60 + 30 + slot * 90, subject, type: "лк", room: "Т-310", teacher: "Иванов И. И.", subgroup: null, isDistance: false, status: "scheduled", sources: [group.title] };
}

function makeService(lessons: Occurrence[]): ScheduleService {
  return {
    group: (key: string) => [group, other].find((g) => g.key === key) ?? null,
    groups: () => [group, other],
    stream: () => [group, other],
    intakes: () => [23, 24],
    lessonsOn: () => lessons,
    materialize: () => lessons,
    weekInfo: () => ({ week: 3, parity: "odd" as const, semester: 1 as const }),
    semesterFor: () => 1 as const,
    weekOneMonday: () => "2026-09-01",
  } as unknown as ScheduleService;
}

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

const renderer = { renderDay: async () => Buffer.from("png"), renderWeek: async () => Buffer.from("png"), renderStreamDay: async () => Buffer.from("png") } as unknown as Renderer;

function makeDeps(lessons: Occurrence[]): Deps {
  const repo = new Repo(openDatabase(":memory:"));
  repo.touchUser(7, "u", "U");
  return { config: { ADMIN_IDS: [], MEDIA_CHAT_IDS: [], PUBLIC_URL: undefined, HTTP_PORT: 0, POISK: false } as unknown as Deps["config"], repo, service: makeService(lessons), renderer, ask: null, teachers: null, webinars: null, students: null, known: null, news: null, http: null, inline: true, botUsername: "vish_bot", pending: new Map(), startedAt: new Date() };
}

async function press(label: string, deps: Deps, username?: string, callback = false): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
  });
  const from = { id: 7, is_bot: false, first_name: "U", ...(username ? { username } : {}) };
  const update: Update = callback
    ? { update_id: 1, callback_query: { id: "1", from, chat_instance: "1", data: label, message: { message_id: 11, date: 0, chat: { id: 7, type: "private", first_name: "U" }, text: "настройки" } as never } }
    : { update_id: 1, message: { message_id: 10, date: 0, chat: { id: 7, type: "private", first_name: "U" }, from, text: label, ...(label.startsWith("/") ? { entities: [{ type: "bot_command" as const, offset: 0, length: label.length }] } : {}) } };
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = deps;
  ctx.user = deps.repo.touchUser(7, username ?? "u", "U");
  ctx.isAdmin = false;
  const composer = new Composer<BotContext>();
  composer.use(miscHandlers, settingsHandlers, scheduleHandlers);
  await composer.middleware()(ctx, async () => undefined);
  return calls;
}

function withFormat(lessons: Occurrence[], format: ScheduleFormat): Deps {
  const deps = makeDeps(lessons);
  deps.repo.updateUser(7, { groupKey: group.key, format });
  return deps;
}

describe("формат «картинка» и «и так, и так»", () => {
  const short = [lesson("Физика", 2)];

  it("«картинка»: приходит один постер, без текста рядом и без подписи", async () => {
    const calls = await press(BTN.today, withFormat(short, "image"));
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto"]);
    expect(calls[0]!.payload.caption).toBeUndefined();
  });

  it("«и так, и так»: одно сообщение — постер с расписанием в подписи", async () => {
    const calls = await press(BTN.today, withFormat(short, "both"));
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto"]);
    expect(String(calls[0]!.payload.caption)).toContain("Физика");
    expect(calls[0]!.payload.parse_mode).toBe("HTML");
  });

  it("«текст»: постера нет вовсе", async () => {
    const calls = await press(BTN.today, withFormat(short, "text"));
    expect(calls.map((c) => c.method)).toEqual(["sendMessage"]);
  });

  it("длинное расписание в подпись не лезет: текст первым, постер последним", async () => {
    const long = Array.from({ length: 12 }, (_, i) => lesson(`Проектирование средств технологического оснащения ${i}`, i));
    const calls = await press(BTN.week, withFormat(long, "both"));
    expect(calls.map((c) => c.method)).toEqual(["sendMessage", "sendPhoto"]);
    // Подпись не шлём: Telegram обрежет её на 1024 и порвёт разметку.
    expect(calls[1]!.payload.caption).toBeUndefined();
    // Кнопки навигации — на последнем сообщении, листать вверх не придётся.
    expect(calls[0]!.payload.reply_markup).toBeUndefined();
    expect(calls[1]!.payload.reply_markup).toBeTruthy();
  });

  it("постер не отправился — человек всё равно получит текст", async () => {
    const d = withFormat(short, "image");
    const calls: Call[] = [];
    const api = new Api("123:FAKE");
    api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      if (method === "sendPhoto") throw new Error("Bad Request: PHOTO_INVALID_DIMENSIONS");
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
    });
    const update: Update = { update_id: 1, message: { message_id: 10, date: 0, chat: { id: 7, type: "private", first_name: "U" }, from: { id: 7, is_bot: false, first_name: "U" }, text: BTN.today } };
    const ctx = new Context(update, api, ME) as BotContext;
    ctx.deps = d;
    ctx.user = d.repo.touchUser(7, "u", "U");
    ctx.isAdmin = false;
    const composer = new Composer<BotContext>();
    composer.use(scheduleHandlers);
    await composer.middleware()(ctx, async () => undefined);
    expect(calls.map((c) => c.method)).toEqual(["sendPhoto", "sendMessage"]);
    expect(String(calls[1]!.payload.text)).toContain("Физика");
  });

  it("неделя в «и так, и так» больше не теряет постер", async () => {
    const calls = await press(BTN.week, withFormat(short, "both"));
    expect(calls.some((c) => c.method === "sendPhoto")).toBe(true);
  });
});

describe("inline про людей", () => {
  // Реестр из двух выдуманных людей: настоящий в тестах не нужен и не лежит.
  const registry = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "students-"));
    const f = join(dir, "students.csv");
    writeFileSync(f, "ФИО;Группа\nБеляев Иван Петрович;ВИШ-12-23\nБеляева Анна Ивановна;ВИШ-14-24\n", "utf8");
    return f;
  };
  const deps = (poisk = true): Deps => {
    const d = makeDeps([lesson("Физика", 2)]);
    d.config = { ...d.config, POISK: true, POISK_DAILY_LIMIT: 30 } as Deps["config"];
    if (poisk) d.students = new StudentDirectory(registry());
    return d;
  };
  const user = { id: 7, groupKey: group.key, subgroup: null } as unknown as User;

  it("«студент Беляев» — это человек, а не группа", () => {
    const req = parseInlineQuery(deps(), "студент Беляев", user);
    expect(req.person).toEqual({ kind: "student", query: "Беляев" });
    expect(req.unknownGroup).toBe(false);
    expect(req.groups).toEqual([]);
  });

  it("«завтра преподаватель Петров» — день и фамилия", () => {
    const req = parseInlineQuery(deps(), "завтра преподаватель Петров", user);
    expect(req.person).toEqual({ kind: "teacher", query: "Петров" });
    expect(req.date).toBe(addDays(today, 1));
    expect(req.mode).toBe("day");
  });

  it("«неделя препод Петров» — неделя", () => {
    const req = parseInlineQuery(deps(), "неделя препод Петров", user);
    expect(req.person?.kind).toBe("teacher");
    expect(req.mode).toBe("week");
  });

  it("«12-23» остаётся группой", () => {
    const req = parseInlineQuery(deps(), "12-23", user);
    expect(req.person).toBeNull();
    expect(req.groups[0]?.key).toBe(group.key);
  });

  it("находит человека и показывает, где он должен быть", async () => {
    const d = deps();
    const req = parseInlineQuery(d, "студент Беляев", user);
    const res = await buildPeopleResults(d, req, user);
    expect(res.length).toBeGreaterThan(0);
    const text = String(res[0]!.input_message_content && "message_text" in res[0]!.input_message_content ? res[0]!.input_message_content.message_text : "");
    expect(text).toContain("Беляев Иван Петрович");
    expect(text).toContain("ВИШ-12-23");
    // Ник человека в inline-выдаче не участвует никогда.
    expect(text).not.toMatch(/t\.me|@[a-z]/i);
  });

  it("лимит поисков действует и в inline", async () => {
    const d = deps();
    for (let i = 0; i < 30; i++) d.repo.logPoisk(7, today, `запрос ${i}`, null);
    const res = await buildPeopleResults(d, parseInlineQuery(d, "студент Беляев", user), user);
    expect(res[0]!.title).toMatch(/Лимит/i);
  });

  it("без реестра поиск студента честно говорит, что выключен", async () => {
    const d = makeDeps([lesson("Физика", 2)]);
    const req = parseInlineQuery(d, "студент Беляев", user);
    const res = await buildPeopleResults(d, req, user);
    expect(res).toHaveLength(1);
    expect(res[0]!.title).toMatch(/выключен/i);
  });

  it("кривой ввод не ломает ответ: HTML экранируется", async () => {
    const d = deps();
    const req = parseInlineQuery(d, "студент <b>Беляев", user);
    const res = await buildPeopleResults(d, req, user);
    const text = String(res[0]!.input_message_content && "message_text" in res[0]!.input_message_content ? res[0]!.input_message_content.message_text : "");
    expect(text).not.toContain("<b>Беляев");
    expect(text).toContain("&lt;b&gt;");
  });

  it("короткий запрос отвечает подсказкой, а не пустотой", async () => {
    const d = deps();
    const req = parseInlineQuery(d, "студент Бе", user);
    const res = await buildPeopleResults(d, req, user);
    expect(res[0]!.title).toMatch(/фамилию/i);
  });
});

describe("бот узнаёт своих", () => {
  const file = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "known-"));
    const f = join(dir, "known.csv");
    writeFileSync(f, "ФИО;Телеграм\nАлбуткин Данил Иванович;nortch\nИванов Андрей Иванович;https://t.me/@Shiish\nПетров Иван;dubl\nСидоров Иван;dubl\n", "utf8");
    return f;
  };

  it("ник читается в любом виде, включая «https://t.me/@ник»", () => {
    expect(normalizeHandle("https://t.me/nortch")).toBe("nortch");
    expect(normalizeHandle("@Nortch")).toBe("nortch");
    expect(normalizeHandle("https://t.me/@Shiish")).toBe("shiish");
    expect(normalizeHandle("t.me/+79001234567")).toBeNull();
    expect(normalizeHandle("")).toBeNull();
  });

  it("узнаёт по нику и зовёт по имени, а не по фамилии", () => {
    const k = new KnownPeople(file());
    expect(k.byUsername("NORTCH")?.firstName).toBe("Данил");
    expect(k.byUsername("shiish")?.name).toBe("Иванов Андрей Иванович");
    expect(k.byUsername("кто-то-другой")).toBeNull();
  });

  it("один ник на двоих не узнаётся вовсе: чужим именем не здороваемся", () => {
    const k = new KnownPeople(file());
    expect(k.byUsername("dubl")).toBeNull();
    expect(k.count()).toBe(2);
  });

  it("/start здоровается по имени, а с анонимностью — нет", async () => {
    const d = makeDeps([lesson("Физика", 2)]);
    d.known = new KnownPeople(file());
    d.repo.updateUser(7, { groupKey: group.key });
    const hello = await press("/start", d, "nortch");
    expect(hello.map((c) => String(c.payload.text ?? "")).join("\n")).toContain("Привет, Данил");

    d.repo.updateUser(7, { anon: true });
    const quiet = await press("/start", d, "nortch");
    const text = quiet.map((c) => String(c.payload.text ?? "")).join("\n");
    expect(text).not.toContain("Данил");
    expect(text).toContain("С возвращением");
  });

  it("настройки переключают анонимность туда и обратно", async () => {
    const d = makeDeps([lesson("Физика", 2)]);
    d.known = new KnownPeople(file());
    d.repo.updateUser(7, { groupKey: group.key });
    await press("s:anon", d, "nortch", true);
    expect(d.repo.getUser(7)?.anon).toBe(true);
    await press("s:anon", d, "nortch", true);
    expect(d.repo.getUser(7)?.anon).toBe(false);
  });
});

describe("разбор лент Tilda", () => {
  it("находит все ленты страницы парами recid+feeduid, а не первые попавшиеся", () => {
    const html = `var options={recid:'1304571431',feeduid:'625661625801',previewmode:'yes'};
                  var options={recid:'1863632681',feeduid:'244426457331',previewmode:'yes'};`;
    expect(tildaFeeds(html)).toEqual([
      { recid: "1304571431", feeduid: "625661625801" },
      { recid: "1863632681", feeduid: "244426457331" },
    ]);
  });

  it("свежесть считается по дате публикации, а не по дате в карточке", () => {
    // Редакторы ставят дату задним числом: пост от «18.09», выложенный 22.09,
    // по старой логике сразу считался протухшим и не доходил вообще никогда.
    // Секунды для свежести не нужны, главное — что «published» вообще разбирается.
    expect(tildaDate("2026-09-22 09:59:14")).toBe(new Date("2026-09-22T09:59:00+03:00").toISOString());
    expect(tildaDate("2026-09-18 16:00")).toBe(new Date("2026-09-18T16:00:00+03:00").toISOString());
  });
});

describe("журнал поисков", () => {
  it("один человек через чат и через inline — один поиск, а не два", () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    repo.logPoisk(7, today, "поиск: Беляев Иван Петрович", "id1");
    repo.logPoisk(7, today, "поиск: Беляев Иван Петрович", "id1");
    expect(repo.poiskUsage(7, today)).toBe(1);
  });
});
