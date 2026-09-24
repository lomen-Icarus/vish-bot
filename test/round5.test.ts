import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { nameMatch } from "../src/text/match.js";
import { StudentDirectory } from "../src/students/directory.js";
import { addAiBonus, aiAllowance, aiLimits, GLOBAL_STEPS, setAiLimit, stepValue, USER_STEPS } from "../src/ai/limits.js";
import { BTN, streamKeyboard, teacherDayNav } from "../src/bot/keyboards.js";
import { poiskHandlers } from "../src/bot/handlers/poisk.js";
import { peopleHandlers } from "../src/bot/people.js";
import { scheduleHandlers } from "../src/bot/handlers/schedule.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import { todayMsk } from "../src/time.js";

const group: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [8524], portalNames: ["ВИШ-12-23"] };
const today = todayMsk();

function lesson(subject: string, subgroup: number | null = null): Occurrence {
  return { groupKey: group.key, period: 1, date: today, slot: 3, start: 11 * 60 + 40, end: 13 * 60, subject, type: "лк", room: "Т-310", teacher: null, subgroup, isDistance: false, status: "scheduled", sources: [group.title] };
}

function makeService(): ScheduleService {
  const lessons = [lesson("Патентоведение"), lesson("Лаба по физике", 2)];
  return {
    group: (key: string) => (key === group.key ? group : null),
    groups: () => [group],
    stream: () => [group],
    intakes: () => [23],
    lessonsOn: () => lessons,
    materialize: () => lessons,
    weekInfo: () => ({ week: 3, parity: "odd" as const, semester: 1 as const }),
    semesterFor: () => 1 as const,
    weekOneMonday: () => "2026-09-01",
    academicYear: 2026,
  } as unknown as ScheduleService;
}

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "vish-students-"));
  const file = path.join(dir, name);
  writeFileSync(file, content, "utf8");
  return file;
}

const CSV = ["ФИО;Группа;Телефон", "Троишестов Иван Сергеевич;ВИШ-12-23;79990000000", "Иванова Мария Петровна;ВИШ-12-23;79990000001", "Кузнецов Пётр Ильич;ОЗВИШ-11-25;79990000002"].join("\n");

function makeDeps(opts: { poisk?: boolean; students?: StudentDirectory | null; admin?: boolean } = {}): Deps {
  const repo = new Repo(openDatabase(":memory:"));
  repo.touchUser(7, "u", "U");
  return {
    config: { ADMIN_IDS: opts.admin ? [7] : [], MEDIA_CHAT_IDS: [], PUBLIC_URL: undefined, HTTP_PORT: 0, POISK: opts.poisk ?? false, POISK_DAILY_LIMIT: 30, AI_DAILY_LIMIT_PER_USER: 10, AI_DAILY_LIMIT_GLOBAL: 300 } as unknown as Deps["config"],
    repo,
    service: makeService(),
    renderer: null,
    ask: null,
    teachers: null,
    webinars: null,
    students: opts.students ?? null,
    news: null,
    http: null,
    inline: true,
    botUsername: "vish_bot",
    pending: new Map(),
    startedAt: new Date(),
  };
}

async function run(update: Update, deps: Deps, opts: { admin?: boolean } = {}): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = deps;
  ctx.user = deps.repo.touchUser(7, "u", "U");
  ctx.isAdmin = opts.admin ?? false;
  const composer = new Composer<BotContext>();
  // Как в bot/index.ts: раздел «сыска» вообще не подключается при POISK=FALSE.
  composer.use(peopleHandlers);
  if (deps.config.POISK) composer.use(poiskHandlers);
  composer.use(scheduleHandlers);
  await composer.middleware()(ctx, async () => undefined);
  return calls;
}

const textUpdate = (text: string): Update => ({
  update_id: 1,
  message: {
    message_id: 10,
    date: 0,
    chat: { id: 7, type: "private", first_name: "U" },
    from: { id: 7, is_bot: false, first_name: "U" },
    text,
    ...(text.startsWith("/") ? { entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length }] } : {}),
  },
});

const texts = (calls: Call[]): string => calls.map((c) => String(c.payload.text ?? "")).join("\n");

describe("name matching with typos", () => {
  it("forgives a typo but marks the match as a guess", () => {
    expect(nameMatch("Троишестова Д.А.", "троишестова").score).toBeGreaterThan(0);
    expect(nameMatch("Троишестова Д.А.", "троишестова").fuzzy).toBe(false);
    const typo = nameMatch("Троишестова Д.А.", "троишестава");
    expect(typo.score).toBeGreaterThan(0);
    expect(typo.fuzzy).toBe(true);
    expect(nameMatch("Троишестова Д.А.", "трошиестова").score).toBeGreaterThan(0);
  });

  it("still refuses people who are simply different", () => {
    expect(nameMatch("Иванов И.И.", "Петров").score).toBe(0);
    expect(nameMatch("Кожина Т. Н.", "Троишестова").score).toBe(0);
    expect(nameMatch("Иванова К. Ю.", "к ю").score).toBe(0);
    // Три буквы — слишком коротко, чтобы прощать опечатку.
    expect(nameMatch("Ким А.А.", "Кин").score).toBe(0);
  });
});

describe("student directory", () => {
  it("reads ФИО and группа and ignores every other column", () => {
    const dir = new StudentDirectory(tempFile("students.csv", CSV));
    expect(dir.count()).toBe(3);
    const hit = dir.search("Троишестов")[0]!;
    expect(hit.student.groupTitle).toBe("ВИШ-12-23");
    expect(JSON.stringify(hit.student)).not.toContain("7999");
  });

  it("finds a person through a typo and says it is a guess", () => {
    const dir = new StudentDirectory(tempFile("students.csv", CSV));
    const hit = dir.search("Троишестав")[0]!;
    expect(hit.student.name).toContain("Троишестов");
    expect(dir.search("Ктототамнесуществует")).toEqual([]);
  });

  it("reads JSON just as well and reloads when the file changes", () => {
    const file = tempFile("students.json", JSON.stringify([{ fio: "Сидоров Сидор Сидорович", group: "ВИШ-12-23", subgroup: 2 }]));
    const dir = new StudentDirectory(file);
    expect(dir.count()).toBe(1);
    expect(dir.search("Сидоров")[0]!.student.subgroup).toBe(2);
    writeFileSync(file, JSON.stringify([{ fio: "Сидоров Сидор Сидорович", group: "ВИШ-12-23" }, { fio: "Новиков Новик Новикович", group: "ВИШ-12-23" }]), "utf8");
    expect(dir.count()).toBe(2);
  });

  it("survives a missing file instead of crashing the bot", () => {
    const dir = new StudentDirectory("/nope/students.csv");
    expect(dir.count()).toBe(0);
    expect(dir.stats().error).toMatch(/не найден/);
    expect(dir.search("Иванов")).toEqual([]);
  });
});

describe("AI limits", () => {
  it("takes the .env value until an admin overrides it", () => {
    const deps = makeDeps();
    const day = todayMsk();
    expect(aiLimits(deps.repo, deps.config, day).perUser).toBe(10);
    setAiLimit(deps.repo, "user", 25);
    expect(aiLimits(deps.repo, deps.config, day).perUser).toBe(25);
    expect(aiLimits(deps.repo, deps.config, day).userOverridden).toBe(true);
    setAiLimit(deps.repo, "user", null);
    expect(aiLimits(deps.repo, deps.config, day).perUser).toBe(10);
  });

  it("adds a one-day boost that does not touch tomorrow", () => {
    const deps = makeDeps();
    const day = todayMsk();
    addAiBonus(deps.repo, "global", day, 200);
    expect(aiLimits(deps.repo, deps.config, day).global).toBe(500);
    expect(aiLimits(deps.repo, deps.config, "2030-01-01").global).toBe(300);
  });

  it("stops a student at the limit and never stops an admin", () => {
    const deps = makeDeps();
    const day = todayMsk();
    setAiLimit(deps.repo, "user", 1);
    expect(aiAllowance(deps.repo, deps.config, 7, false, day).verdict).toBe("ok");
    deps.repo.bumpAiUsage(7, day, 10, 10);
    expect(aiAllowance(deps.repo, deps.config, 7, false, day).verdict).toBe("limit-user");
    expect(aiAllowance(deps.repo, deps.config, 7, true, day).verdict).toBe("ok");
  });
});

describe("AI limit steps", () => {
  it("«+» never lowers the limit, «−» never raises it", () => {
    // Значение из .env может быть вне лесенки — кнопка не должна его «чинить» вниз.
    expect(stepValue(GLOBAL_STEPS, 10000, 1)).toBeGreaterThanOrEqual(10000);
    expect(stepValue(GLOBAL_STEPS, 10000, -1)).toBeLessThan(10000);
    expect(stepValue(USER_STEPS, 0, -1)).toBe(0);
    expect(stepValue(USER_STEPS, 10, 1)).toBe(15);
  });
});

describe("student directory, tricky files", () => {
  it("reads «Фамилия;Имя;Отчество;Группа» and does not import the header as a person", () => {
    const dir = new StudentDirectory(tempFile("students.csv", ["Фамилия;Имя;Отчество;Группа", "Троишестов;Иван;Сергеевич;ВИШ-12-23"].join("\n")));
    expect(dir.count()).toBe(1);
    expect(dir.search("Троишестов")[0]!.student.name).toBe("Троишестов Иван Сергеевич");
  });

  it("does not trip over commas inside a quoted header", () => {
    const dir = new StudentDirectory(tempFile("students.csv", ['"Фамилия, имя, отчество";"Группа"', "Иванова Мария Петровна;ВИШ-12-23"].join("\n")));
    expect(dir.count()).toBe(1);
    expect(dir.search("Иванова")[0]!.student.groupTitle).toBe("ВИШ-12-23");
  });

  it("keeps someone else's name out of the error text", () => {
    const dir = new StudentDirectory(tempFile("students.json", '[{"fio":"Сидорова Мария Ивановна","group":"ВИШ-12-23"},}]'));
    expect(dir.count()).toBe(0);
    expect(dir.stats().error ?? "").not.toMatch(/Сидорова/);
  });
});

describe("keyboards", () => {
  it("the teacher day navigation has no «сегодня» button either", () => {
    const markup = JSON.stringify(teacherDayNav(42, today));
    expect(markup).toContain("▶️");
    expect(markup).not.toContain("сегодня");
  });

  it("the stream keyboard shows «Где студент» only when the search is on", () => {
    expect(JSON.stringify(streamKeyboard({ poisk: true }))).toContain(BTN.whereStudent);
    expect(JSON.stringify(streamKeyboard())).not.toContain(BTN.whereStudent);
  });
});

describe("global student search", () => {
  it("is invisible when POISK is off", async () => {
    const deps = makeDeps({ poisk: false });
    const calls = await run(textUpdate(BTN.otherGroups), deps);
    expect(JSON.stringify(calls)).not.toContain("poisk");
    // И команда не отвечает ничем.
    expect(await run(textUpdate("/poisk"), deps)).toEqual([]);
  });

  it("offers the entry point under the group picker when POISK is on", async () => {
    const deps = makeDeps({ poisk: true, students: new StudentDirectory(tempFile("students.csv", CSV)) });
    const calls = await run(textUpdate(BTN.otherGroups), deps);
    expect(JSON.stringify(calls)).toContain("poisk:menu");
  });

  it("explains itself, then shows where the person should be now", async () => {
    const deps = makeDeps({ poisk: true, students: new StudentDirectory(tempFile("students.csv", CSV)) });
    const intro = await run(textUpdate("/poisk"), deps);
    expect(texts(intro)).toMatch(/Глобальный поиск студента/);
    expect(texts(intro)).toMatch(/2, 3, 4 курсы|В реестре/);

    const card = await run(textUpdate("Троишестов"), deps);
    const out = texts(card);
    expect(out).toContain("Троишестов Иван Сергеевич");
    expect(out).toContain("ВИШ-12-23");
    expect(out).toMatch(/📍/);
    expect(out).toMatch(/Патентоведение/);
    // Поиск попал в журнал: и аудит, и защита от выкачивания базы.
    expect(deps.repo.poiskUsage(7, todayMsk())).toBe(1);
  });

  it("tells the truth about a correspondence group instead of showing nothing", async () => {
    const deps = makeDeps({ poisk: true, students: new StudentDirectory(tempFile("students.csv", CSV)) });
    await run(textUpdate("/poisk"), deps);
    const out = texts(await run(textUpdate("Кузнецов Пётр"), deps));
    expect(out).toMatch(/заочная группа/i);
  });

  it("does not open a schedule silently when only a typo matched", async () => {
    const deps = makeDeps({ poisk: true, students: new StudentDirectory(tempFile("students.csv", CSV)) });
    await run(textUpdate("/poisk"), deps);
    const calls = await run(textUpdate("Троишестав"), deps);
    const out = texts(calls);
    // Предлагаем кнопками, а не показываем «где он сейчас» как факт.
    expect(out).toMatch(/Точного совпадения/);
    expect(JSON.stringify(calls)).toContain("ppo:s");
    expect(out).not.toMatch(/📍/);
  });

  it("asks which group when the registry line matches two different ones", async () => {
    const deps = makeDeps({ poisk: true, students: new StudentDirectory(tempFile("students.csv", ["ФИО;Группа", "Сорокин Иван Петрович;ВИШ-11-23"].join("\n"))) });
    const twins: LogicalGroup[] = [
      { key: "виш-11-23 (эиэа)", title: "ВИШ-11-23 (ЭиЭА)", prefix: "ВИШ", number: 11, intake: 23, course: 4, portalIds: [1], portalNames: ["ВИШ-11-23 (ЭиЭА)"] },
      { key: "виш-11-23 (рзиаэс)", title: "ВИШ-11-23 (РЗиАЭС)", prefix: "ВИШ", number: 11, intake: 23, course: 4, portalIds: [2], portalNames: ["ВИШ-11-23(РЗиАЭС)"] },
    ];
    deps.service = { ...makeService(), groups: () => twins, group: (k: string) => twins.find((g) => g.key === k) ?? null } as unknown as ScheduleService;
    await run(textUpdate("/poisk"), deps);
    const calls = await run(textUpdate("Сорокин"), deps);
    const out = texts(calls);
    expect(out).toMatch(/несколько разных групп/);
    expect(JSON.stringify(calls)).toContain("ppg:");
    expect(out).not.toMatch(/📍/);
  });

  it("считает один и тот же запрос одним поиском, а не двумя", () => {
    const deps = makeDeps({ poisk: true, students: new StudentDirectory(tempFile("students.csv", CSV)) });
    const day = todayMsk();
    // Локальный поиск и инструмент ИИ по одному запросу — это один поиск.
    deps.repo.logPoisk(7, day, "поиск: Троишестов", null);
    deps.repo.logPoisk(7, day, "ии: Троишестов", "abc");
    expect(deps.repo.poiskUsage(7, day)).toBe(1);
    deps.repo.logPoisk(7, day, "поиск: Иванова", null);
    expect(deps.repo.poiskUsage(7, day)).toBe(2);
  });

  it("holds the daily limit", async () => {
    const deps = makeDeps({ poisk: true, students: new StudentDirectory(tempFile("students.csv", CSV)) });
    const day = todayMsk();
    // Разные запросы: одинаковые подряд теперь склеиваются в один поиск.
    for (let i = 0; i < 30; i++) deps.repo.logPoisk(7, day, `кто-то-${i}`, null);
    const out = texts(await run(textUpdate("/poisk"), deps));
    expect(out).toMatch(/лимит поисков/i);
  });
});
