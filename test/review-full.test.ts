import { describe, expect, it } from "vitest";
import { HttpError } from "grammy";
import { logLevel, scrubSecrets } from "../src/logger.js";
import { connect } from "node:net";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { createHttpServer } from "../src/http/server.js";
import type { ScheduleService } from "../src/schedule/service.js";
import { calendarWindow } from "../src/schedule/calendar.js";
import { diffOccurrences } from "../src/schedule/diff.js";
import type { Occurrence } from "../src/schedule/model.js";
import { parseRuDate } from "../src/time.js";
import { nameMatch, samePerson } from "../src/text/match.js";
import { sameGroup } from "../src/portal/webinars.js";
import { topicsForText } from "../src/bot/handlers/news.js";
import { dayNav, weekNav } from "../src/bot/keyboards.js";
import { KnownPeople } from "../src/students/known.js";
import { QaBase } from "../src/chat/qa.js";

describe("ревью всего проекта: логи", () => {
  it("токен бота из сетевой ошибки grammY не попадает в лог, а message и stack остаются", () => {
    const inner = new Error("request to https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawA/getMe failed, reason: ECONNRESET");
    const out = JSON.stringify(scrubSecrets({ err: new HttpError("Network request for 'getMe' failed!", inner) }));
    expect(out).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawA");
    expect(out).toContain("<bot-token>");
    expect(out).toContain("Network request for 'getMe' failed!");
    expect(out).toContain("ECONNRESET");
    expect(JSON.stringify(scrubSecrets({ err: "key sk-ant-api03-abcdefghijklmnop" }))).not.toContain("abcdefghijklmnop");
  });

  it("пустой или незнакомый LOG_LEVEL — info, а не падение при старте", () => {
    expect(logLevel(undefined)).toBe("info");
    expect(logLevel("")).toBe("info");
    expect(logLevel("verbose")).toBe("info");
    expect(logLevel(" DEBUG ")).toBe("debug");
  });
});

describe("ревью всего проекта: настройки", () => {
  it("пустое число в .env — значение по умолчанию, а не 0 (лимиты не превращаются в безлимит или запрет)", async () => {
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig({ BOT_TOKEN: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", POISK_DAILY_LIMIT: "", AI_DAILY_LIMIT_PER_USER: " ", CHAT_DAILY_LIMIT_GLOBAL: "", FACULTY_ID: "", LOG_LEVEL: "" });
    expect(cfg.POISK_DAILY_LIMIT).toBe(30);
    expect(cfg.AI_DAILY_LIMIT_PER_USER).toBe(10);
    expect(cfg.CHAT_DAILY_LIMIT_GLOBAL).toBe(400);
    expect(cfg.FACULTY_ID).toBe(32);
    expect(cfg.LOG_LEVEL).toBe("info");
    // Явный ноль остаётся нулём.
    expect(loadConfig({ BOT_TOKEN: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", POISK_DAILY_LIMIT: "0" }).POISK_DAILY_LIMIT).toBe(0);
  });
});


describe("ревью всего проекта: HTTP", () => {
  it("кривой адрес запроса — ответ 400, а бот не падает", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const server = createHttpServer({ repo, service: { groups: () => [] } as unknown as ScheduleService, port: 0, host: "127.0.0.1" });
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    const reply = await new Promise<string>((resolve, reject) => {
      const s = connect(port, "127.0.0.1", () => s.write("GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
      let data = "";
      s.on("data", (c) => (data += c.toString()));
      s.on("end", () => resolve(data));
      s.on("error", reject);
    });
    expect(reply).toMatch(/^HTTP\/1\.1 400/);
    // Сервер жив: следующий запрос обслуживается.
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    server.close();
  });
});

describe("ревью всего проекта: база", () => {
  it("/soon стирает и подписки на преподавателей", () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    repo.toggleWatchTeacher(7, 42, "Иванова И. И.");
    repo.forgetUser(7);
    expect(repo.teacherWatchers().some((w) => w.userIds.includes(7))).toBe(false);
  });
});

describe("ревью всего проекта: расписание", () => {
  const service = (anchor: string | null) => ({ weekOneMonday: () => anchor, semesterFor: () => 1 as const }) as unknown as ScheduleService;

  it("календарь держит всю зимнюю сессию и не пустеет после конца семестра", () => {
    const w = calendarWindow(service("2026-08-31"), "2026-12-01");
    expect(w.to >= "2027-01-31").toBe(true);
    const late = calendarWindow(service("2026-08-31"), "2027-01-25");
    expect(late.to > late.from).toBe(true);
    expect(late.to >= "2027-03-01").toBe(true);
  });

  it("перенос пары с видимой целью — одно событие «перенос», без лишнего «добавлено»", () => {
    const base = { groupKey: "g", period: 1 as const, room: null, teacher: "Петрова А. С.", subgroup: null, isDistance: false, sources: [], subject: "Физика", type: "лк", start: 600, end: 690 };
    const before: Occurrence = { ...base, date: "2026-09-28", slot: 2, status: "scheduled" } as Occurrence;
    const vacated: Occurrence = { ...before, status: "moved", movedTo: { date: "2026-09-30", slot: 4 } } as Occurrence;
    const target: Occurrence = { ...base, date: "2026-09-30", slot: 4, status: "scheduled", movedFrom: { date: "2026-09-28", slot: 2 } } as Occurrence;
    const events = diffOccurrences([before], [vacated, target], { from: "2026-09-25", to: "2026-10-09" });
    expect(events.map((e) => e.kind)).toEqual(["moved"]);
  });

  it("несуществующие даты («31.09», «30.02») не превращаются в «31 сентября»", () => {
    expect(parseRuDate("31.09", "2026-09-25")).toBeNull();
    expect(parseRuDate("30.02", "2026-09-25")).toBeNull();
    expect(parseRuDate("29.02.2028", "2026-09-25")).toBe("2028-02-29");
    expect(parseRuDate("25.09", "2026-09-25")).toBe("2026-09-25");
  });

  it("кнопки чужой группы с длинным названием укладываются в 64 байта", () => {
    const key = "виш-11-23 (радиотехника и телекоммуникации)";
    const kbs = [dayNav("2026-09-25", "2026-09-25", { image: true, peekKey: key }), weekNav("2026-09-21", { image: true, peekKey: key })];
    for (const kb of kbs) for (const row of kb.inline_keyboard) for (const b of row) expect(Buffer.byteLength((b as { callback_data: string }).callback_data)).toBeLessThanOrEqual(64);
  });
});

describe("ревью всего проекта: имена и группы", () => {
  it("инициал впереди не отнимает место фамилии; двойная фамилия — не другой человек", () => {
    expect(nameMatch("Иванова Ирина Ивановна", "И. Иванова")).toEqual({ score: 7, fuzzy: false });
    expect(samePerson("Иванова-Смирнова Анна Викторовна", "Иванова С. А.")).toBe(false);
    expect(samePerson("Иванова-Смирнова Анна Викторовна", "Иванова-Смирнова А. В.")).toBe(true);
  });

  it("группы с разным профилем в скобках — разные, ИОТ — та же группа", () => {
    expect(sameGroup("ВИШ-11-23 (ЭиЭА)", "ВИШ-11-23(РЗиАЭС)")).toBe(false);
    expect(sameGroup("ВИШ-12-23иот (ИОТ)", "ВИШ-12-23")).toBe(true);
    expect(sameGroup("ВИШ-11-23 (ЭиЭА)", "ВИШ-11-23")).toBe(true);
  });

  it("реестр в cp1251 (CSV из русского Excel) читается, а не превращается в «������»", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rv-"));
    const file = path.join(dir, "known.csv");
    // «Иванов Иван;ivanov» в Windows-1251.
    const cp1251 = Buffer.from([0xc8, 0xe2, 0xe0, 0xed, 0xee, 0xe2, 0x20, 0xc8, 0xe2, 0xe0, 0xed, 0x3b, ...Buffer.from("ivanov")]);
    writeFileSync(file, cp1251);
    expect(new KnownPeople(file).byUsername("ivanov")?.name).toBe("Иванов Иван");
  });
});

describe("ревью всего проекта: новости и болталка", () => {
  it("хэштеги: русские окончания и граница слова", () => {
    expect(topicsForText("#сантехника")).toEqual([]);
    expect(topicsForText("#важное завтра")).toEqual(["announcements"]);
    expect(topicsForText("Тайный #Санта")).toEqual(["events"]);
    expect(topicsForText("#стипендия")).toEqual(["contests"]);
  });

  it("сценарий: удаление не пересобирает файл, в котором есть неразобранные строки", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qa-"));
    const file = path.join(dir, "qa.csv");
    const body = "вопрос;ответ\nпривет;здравствуй\nбез ответа;\nкак дела;норм\n";
    writeFileSync(file, body, "utf8");
    const qa = new QaBase(file);
    expect(() => qa.removeAt(1)).toThrow(/не разобрал/);
    expect(readFileSync(file, "utf8")).toBe(body);
  });

  it("сценарий: новая строка пишется разделителем того файла, что лежит сейчас", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "qa-"));
    const file = path.join(dir, "qa.csv");
    writeFileSync(file, "вопрос;ответ\nпривет;здравствуй\n", "utf8");
    const qa = new QaBase(file);
    qa.entries();
    // Файл заменили на хостинге: теперь он через запятую.
    writeFileSync(file, "вопрос,ответ\nпривет,здравствуй\n", "utf8");
    qa.append(["пока"], "до встречи, друг");
    expect(readFileSync(file, "utf8")).toContain('пока,"до встречи, друг"');
  });
});

describe("ревью всего проекта: начало семестра", () => {
  it("первая калибровка недели семестра — база перестраивается молча, без «➕» по всем парам", async () => {
    const { PortalClient } = await import("../src/portal/client.js");
    const { ScheduleService } = await import("../src/schedule/service.js");
    const { addDays, todayMsk } = await import("../src/time.js");
    const repo = new Repo(openDatabase(":memory:"));
    const html = readFileSync("test/fixtures/group-8524-p1.html", "utf8");
    const client = new PortalClient({});
    Object.assign(client.http, {
      clearCookies: () => undefined,
      post: async (url: string) => ({ status: 302, body: "", url }),
      postFollow: async (url: string) => ({ status: 200, body: html, url }),
      getFollow: async (url: string) => ({ status: 200, body: html, url }),
    });
    const portal = { authenticated: false, getFacultyGroups: async () => [{ id: 8524, name: "ВИШ-12-23" }], getGroupPage: (id: number, period: 1 | 2 | 3 | 4) => client.getGroupPage(id, period) };
    const svc = new ScheduleService(repo, portal as never, { facultyId: 32, hiddenPrefixes: [] });
    await svc.poll();
    const key = svc.groups()[0]!.key;
    const today = todayMsk();
    const lessons = repo.occurrences(key, today, addDays(today, 14));
    expect(lessons.length).toBeGreaterThan(0);
    // Новый семестр: метки недели ещё нет, в базе — только старьё вне окна.
    const semester = svc.semesterFor(today);
    repo.setMeta(svc.anchorKey(semester), "");
    repo.replaceOccurrences(key, addDays(today, -60), addDays(today, 60), [{ ...lessons[0]!, date: addDays(today, -50) }]);
    const calibration = await svc.poll();
    expect(calibration.events).toEqual([]);
    // База восстановлена: следующее сравнение не объявит «новыми» все пары.
    const next = await svc.poll({ force: true });
    expect(next.events).toEqual([]);
    expect(repo.occurrences(key, today, addDays(today, 14)).length).toBe(lessons.length);
  });
});
