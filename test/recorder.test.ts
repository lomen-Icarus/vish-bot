import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { earlierSlides } from "../recorder/src/deliver.js";
import path from "node:path";
import { joinWithProfiles, looksLikeLoginPage, parseWebinarRows } from "../recorder/src/portal.js";
import { deckBaseName, keyOf, matchesGroups, mskNow, planRecording, profileSummary, profilesFor, wanted, type RecordState } from "../recorder/src/plan.js";
import { envNumber, loadConfig } from "../recorder/src/config.js";
import { PORTAL_CA_CERTS as RECORDER_CA } from "../recorder/src/certs.js";
import { padClip } from "../recorder/src/frame.js";
import { PORTAL_CA_CERTS as BOT_CA } from "../src/portal/certs.js";
import type { WebinarRow } from "../recorder/src/portal.js";

const html = readFileSync(path.resolve("test/fixtures/webinar-fac32.html"), "utf8");
const login = readFileSync(path.resolve("test/fixtures/portal-login.html"), "utf8");

describe("записывалка вебинаров: разбор страницы", () => {
  it("берёт пару целиком: предмет, преподаватель, группы и время", () => {
    const rows = parseWebinarRows(html);
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0]!;
    // Предмет должен быть предметом, а не всей ячейкой с ФИО и группами.
    expect(row.subject).toBe("Безопасность жизнедеятельности");
    expect(row.teacher).toContain("Иванова");
    expect(row.groups).toContain("ВИШ-11-24");
    expect(row.startMinutes).toBe(11 * 60 + 40);
    expect(row.endMinutes).toBe(13 * 60);
    expect(row.scheduled).toBe(true);
  });

  it("не записывает встречи вне расписания и пары без групп", () => {
    const row = parseWebinarRows(html)[0]!;
    expect(wanted(row, { subjects: [], groups: [] })).toBe(true);
    expect(wanted({ ...row, scheduled: false }, { subjects: [], groups: [] })).toBe(false);
    expect(wanted({ ...row, groups: [] }, { subjects: [], groups: [] })).toBe(false);
    // Фильтры по предмету и группе работают по части названия.
    expect(wanted(row, { subjects: ["безопасность"], groups: [] })).toBe(true);
    expect(wanted(row, { subjects: ["физика"], groups: [] })).toBe(false);
    expect(wanted(row, { subjects: [], groups: ["11-24"] })).toBe(true);
    expect(wanted(row, { subjects: [], groups: ["99-99"] })).toBe(false);
  });

  it("узнаёт форму входа, чтобы перелогиниться, а не считать, что пар нет", () => {
    expect(looksLikeLoginPage(login)).toBe(true);
    expect(looksLikeLoginPage(html)).toBe(false);
  });

  it("ключ пары различает разные пары и не зависит от регистра", () => {
    const row = parseWebinarRows(html)[0]!;
    expect(keyOf("2026-09-21", row)).toBe(keyOf("2026-09-21", { ...row, subject: row.subject.toUpperCase() }));
    expect(keyOf("2026-09-21", row)).not.toBe(keyOf("2026-09-21", { ...row, startMinutes: 600 }));
  });

  it("московское время считается от UTC, а не от часов машины", () => {
    const at = new Date("2026-09-21T21:30:00Z");
    expect(mskNow(at)).toEqual({ date: "2026-09-22", minutes: 30 });
  });
});

describe("записывалка вебинаров: планировщик", () => {
  const base = parseWebinarRows(html)[0]!;
  const row = (subject: string, start: number, end: number, extra: Partial<WebinarRow> = {}): WebinarRow => ({ ...base, subject, startMinutes: start, endMinutes: end, joinId: "j1", ...extra });
  const cfg = { subjects: [], groups: [], leadMinutes: 7, maxParallel: 2 };
  const fresh = (): RecordState => ({ done: new Set(), active: new Set(), retryAt: new Map() });
  const at = (minutes: number) => ({ date: "2026-09-21", minutes });

  it("пара в работе от «за leadMinutes до начала» до её конца, не дольше", () => {
    const r = row("Физика", 600, 690);
    expect(planRecording([r], at(590), cfg, fresh(), 0).start).toEqual([]);
    expect(planRecording([r], at(593), cfg, fresh(), 0).start).toEqual([r]);
    expect(planRecording([r], at(689), cfg, fresh(), 0).start).toEqual([r]);
    expect(planRecording([r], at(690), cfg, fresh(), 0).start).toEqual([]);
  });

  it("одна пара двумя строками (поток, комната на группу) — один бот; группы слиты, вторая комната — запасная", () => {
    const a = row("Экономика", 600, 690, { joinId: "j1", groups: ["ВИШ-11-23"] });
    const b = row("Экономика", 600, 690, { joinId: "j2", groups: ["ВИШ-12-23"] });
    const start = planRecording([a, b], at(600), cfg, fresh(), 0).start;
    expect(start).toHaveLength(1);
    expect(start[0]).toMatchObject({ joinId: "j1", groups: ["ВИШ-11-23", "ВИШ-12-23"], alts: [b] });
  });

  it("у первой строки пары ещё нет кнопки входа — основной становится открытая комната", () => {
    const a = row("Экономика", 600, 690, { joinId: "", groups: ["ВИШ-11-23"] });
    const b = row("Экономика", 600, 690, { joinId: "j2", groups: ["ВИШ-12-23"] });
    const start = planRecording([a, b], at(600), cfg, fresh(), 0).start;
    expect(start).toEqual([expect.objectContaining({ joinId: "j2", groups: ["ВИШ-11-23", "ВИШ-12-23"], alts: [] })]);
  });

  it("слитая пара с группой, у которой своя учётка, — идёт первой и пробует эту учётку", () => {
    const other = row("Физика", 600, 690, { joinId: "x", groups: ["ВИШ-14-25"] });
    const a = row("Экономика", 600, 690, { joinId: "j1", groups: ["ВИШ-11-23"] });
    const b = row("Экономика", 600, 690, { joinId: "j2", groups: ["ВИШ-15-25"] });
    const profiles = [{ name: "slot:ВИШ-15-25", authMode: "1" as const, login: "l", password: "p", groups: ["15-25"] }];
    const start = planRecording([other, a, b], at(600), { ...cfg, maxParallel: 1, profiles }, fresh(), 0).start;
    expect(start[0]!.subject).toBe("Экономика");
    expect(profilesFor(start[0]!, profiles).map((p) => p.name)).toEqual(["slot:ВИШ-15-25"]);
  });

  it("неудачная попытка повторяется, пока пара идёт, а не теряется после трёх осечек", () => {
    const r = row("Физика", 600, 690);
    const state = fresh();
    state.retryAt.set(keyOf("2026-09-21", r), 5_000);
    const early = planRecording([r], at(620), cfg, state, 4_999);
    expect(early.start).toEqual([]);
    expect(early.waiting).toEqual([r]);
    expect(planRecording([r], at(620), cfg, state, 5_000).start).toEqual([r]);
  });

  it("записанные и записываемые пары второй раз не берутся; без «Подключиться» — ждём", () => {
    const a = row("Физика", 600, 690);
    const b = row("Химия", 600, 690);
    const c = row("История", 600, 690, { joinId: "" });
    const state = fresh();
    state.done.add(keyOf("2026-09-21", a));
    state.active.add(keyOf("2026-09-21", b));
    const plan = planRecording([a, b, c], at(610), cfg, state, 0);
    expect(plan.start).toEqual([]);
    expect(plan.waiting).toEqual([c]);
  });

  it("параллельные пары пишутся одновременно, лишние ждут свободного места", () => {
    const rows = [row("Физика", 610, 700), row("Химия", 600, 690), row("История", 605, 695)];
    const plan = planRecording(rows, at(612), cfg, fresh(), 0);
    // Раньше начавшиеся — первыми.
    expect(plan.start.map((r) => r.subject)).toEqual(["Химия", "История"]);
    expect(plan.skipped.map((r) => r.subject)).toEqual(["Физика"]);
    const busy = fresh();
    busy.active.add("другая пара");
    expect(planRecording(rows, at(612), cfg, busy, 0).start.map((r) => r.subject)).toEqual(["Химия"]);
  });

  it("сначала пары групп со своим профилем (поток 4 курса), потом остальные; SKIP_SUBJECTS не занимает места", () => {
    const g = (subject: string, groups: string[]) => ({ ...row(subject, 590, 670), groups });
    // Порядок, как на портале 16.10 в 9:50.
    const rows = [
      g("Экономика", ["ВИШ-11-25", "ОЗВИШ-12-25"]),
      g("Элективные дисциплины (модули) по физической культуре и спорту", ["ВИШ-15-26"]),
      g("Иностранный язык", ["ВИШ-12-26"]),
      g("Метрология", ["ВИШ-15-24"]),
      g("Источники вторичного электропитания", ["ВИШ-14-23"]),
      g("Физические основы нанотехнологий", ["ВИШ-12-23иот (13.03.02)"]),
    ];
    const profiles = [
      { name: "1", authMode: "1" as const, login: "a", password: "a", groups: [] },
      { name: "2", authMode: "1" as const, login: "b", password: "b", groups: ["11-25", "12-25"] },
      { name: "3", authMode: "1" as const, login: "c", password: "c", groups: ["11-23", "12-23", "13-23", "14-23"] },
    ];
    const plan = planRecording(rows, at(612), { ...cfg, maxParallel: 2, profiles }, fresh(), 0);
    expect(plan.start.map((r) => r.subject)).toEqual(["Экономика", "Источники вторичного электропитания"]);
    // Экономика уже пишется — свободное место достаётся паре 4 курса, а не физкультуре.
    const busy = fresh();
    busy.active.add(keyOf("2026-09-21", rows[0]!));
    expect(planRecording(rows, at(612), { ...cfg, maxParallel: 2, profiles }, busy, 0).start.map((r) => r.subject)).toEqual(["Источники вторичного электропитания"]);
    // Без профилей — по порядку, как раньше; SKIP_SUBJECTS убирает физкультуру, но не «Физические основы…».
    const skip = ["физической культур", "физическая культура"];
    const free = planRecording(rows, at(612), { ...cfg, maxParallel: 9, skipSubjects: skip }, fresh(), 0);
    expect(free.start.map((r) => r.subject)).toEqual(["Экономика", "Иностранный язык", "Метрология", "Источники вторичного электропитания", "Физические основы нанотехнологий"]);
  });

  it("имя пачки: дата, время начала и предмет — две пары одного предмета в день не затирают друг друга", () => {
    expect(deckBaseName("2026-09-21", 9 * 60 + 5, "Физика")).toBe("2026-09-21-0905-Физика");
    expect(deckBaseName("2026-09-21", 13 * 60, "Физика")).not.toBe(deckBaseName("2026-09-21", 9 * 60 + 5, "Физика"));
    expect(deckBaseName("2026-09-21", null, "Мат/анализ: часть 1")).toBe("2026-09-21-xxxx-Матанализ-часть-1");
    expect(deckBaseName("2026-09-21", 600, "///")).toBe("2026-09-21-1000-вебинар");
    // Одна пара в одно время у двух потоков — разные папки и PDF.
    expect(deckBaseName("2026-09-21", 600, "Иностранный язык", "Иванова А. Б.")).toMatch(/^2026-09-21-1000-Иностранный-язык-Иванова-АБ-[0-9a-f]{6}$/);
    // Тёзки с теми же инициалами и длинные предметы с общим началом — тоже разные.
    expect(deckBaseName("2026-09-21", 600, "Высшая математика", "Иванов Иван Ильич")).not.toBe(deckBaseName("2026-09-21", 600, "Высшая математика", "Иванов Игорь Иванович"));
    const long = "Информационные технологии в профессиональной деятельности";
    expect(deckBaseName("2026-09-21", 600, `${long} (лекция)`, "Петров В. Г.")).not.toBe(deckBaseName("2026-09-21", 600, `${long} (практика)`, "Петров В. Г."));
    // Однофамильцы в одно время — разные папки.
    expect(deckBaseName("2026-09-21", 600, "Экономика", "Иванов И. И.")).not.toBe(deckBaseName("2026-09-21", 600, "Экономика", "Иванов П. П."));
    expect(deckBaseName("2026-09-21", 600, "Иностранный язык", "Петров В. Г.")).not.toBe(deckBaseName("2026-09-21", 600, "Иностранный язык", "Иванова А. Б."));
  });

  it("пустое значение в .env — это «не задано», а не ноль", () => {
    expect(envNumber(undefined, 5)).toBe(5);
    expect(envNumber("", 5)).toBe(5);
    expect(envNumber("  ", 5)).toBe(5);
    expect(envNumber("abc", 5)).toBe(5);
    expect(envNumber("0", 5)).toBe(0);
    expect(envNumber("12", 5)).toBe(12);
  });
});

describe("записывалка вебинаров: сертификаты портала", () => {
  it("те же закреплённые сертификаты, что у бота: портал отдаёт неполную цепочку", () => {
    // Без них записывалка не могла даже войти гостем («unable to verify the first certificate»).
    expect(RECORDER_CA).toEqual(BOT_CA);
    expect(RECORDER_CA.length).toBeGreaterThan(0);
  });
});

describe("записывалка: образы и playwright-core одной версии", () => {
  const pkg = JSON.parse(readFileSync(path.resolve("recorder/package.json"), "utf8")) as { dependencies: Record<string, string> };
  const version = pkg.dependencies["playwright-core"]!;

  it("playwright-core закреплён точной версией", () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("Dockerfile для VPS берёт образ Playwright той же версии", () => {
    expect(readFileSync(path.resolve("recorder/Dockerfile"), "utf8")).toContain(`FROM mcr.microsoft.com/playwright:v${version}-noble`);
  });

  it("Dockerfile для Pterodactyl: та же версия по умолчанию и точка входа под Wings", () => {
    const df = readFileSync(path.resolve("recorder/Dockerfile.ptero"), "utf8");
    expect(df).toContain(`ARG PW_VERSION=${version}`);
    expect(df).toContain("FROM mcr.microsoft.com/playwright:v${PW_VERSION}-noble");
    expect(df).toContain('CMD ["/bin/bash", "/entrypoint.sh"]');
    const entry = readFileSync(path.resolve("recorder/deploy/ptero-entrypoint.sh"), "utf8");
    expect(entry).toContain("cd /home/container");
    expect(entry).toContain("${STARTUP}");
    expect(entry).toContain("eval ${MODIFIED_STARTUP}");
  });
});

describe("записывалка: кадр шире области презентации", () => {
  const viewport = { width: 1600, height: 900 };

  it("расширяет вверх и вниз на pad, ширину не трогает", () => {
    expect(padClip({ x: 300, y: 100, width: 1000, height: 600 }, 40, viewport)).toEqual({ x: 300, y: 60, width: 1000, height: 680 });
  });

  it("не вылезает за окно и не даёт отрицательных размеров", () => {
    expect(padClip({ x: 300, y: 10, width: 1000, height: 880 }, 40, viewport)).toEqual({ x: 300, y: 0, width: 1000, height: 900 });
    expect(padClip({ x: 1500, y: 0, width: 400, height: 10 }, 0, viewport)).toEqual({ x: 1500, y: 0, width: 100, height: 10 });
    expect(padClip({ x: 0, y: 0, width: 100, height: 100 }, -5, viewport)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
});

describe("записывалка: второй профиль для групп 11-25…15-25", () => {
  const p1 = { name: "1", authMode: "1" as const, login: "a-login", password: "a-secret", groups: [] };
  const p2 = { name: "2", authMode: "1" as const, login: "b-login", password: "b-secret", groups: ["11-25", "12-25", "13-25", "14-25", "15-25"] };

  it("группа должна стоять целиком: «11-25» — это ВИШ-11-25 и ОЗВИШ-11-25, но не ВИШ-111-25; «1-25» — не ВИШ-11-25", () => {
    expect(matchesGroups(["11-25"], ["ВИШ-11-25"])).toBe(true);
    expect(matchesGroups(["12-25"], ["ОЗВИШ-12-25"])).toBe(true);
    expect(matchesGroups(["ВИШ-11-25"], ["виш-11-25"])).toBe(true);
    expect(matchesGroups(["11-25"], ["ВИШ-111-25"])).toBe(false);
    expect(matchesGroups(["1-25"], ["ВИШ-11-25"])).toBe(false);
    expect(matchesGroups(["11-2"], ["ВИШ-11-25"])).toBe(false);
    expect(matchesGroups([""], ["ВИШ-11-25"])).toBe(false);
    // Тот же разбор — у фильтра RECORD_GROUPS.
    expect(wanted({ scheduled: true, joinId: "", joinType: "1", startMinutes: 0, endMinutes: 0, subject: "x", teacher: "", groups: ["ВИШ-11-25"], title: "", raw: "" }, { subjects: [], groups: ["1-25"] })).toBe(false);
  });

  it("для групп профиля 2 — сначала он, потом общий; для чужих групп профиль 2 не пробуется никогда", () => {
    expect(profilesFor({ groups: ["ВИШ-13-25", "ВИШ-14-25"] }, [p1, p2]).map((p) => p.name)).toEqual(["2", "1"]);
    expect(profilesFor({ groups: ["ВИШ-12-23"] }, [p1, p2]).map((p) => p.name)).toEqual(["1"]);
    // Первый профиль с группами — для остальных групп профиля нет.
    expect(profilesFor({ groups: ["ВИШ-12-23"] }, [{ ...p1, groups: ["11-24"] }, p2])).toEqual([]);
  });

  it("перебор профилей: сбой сети у одного — пробуется следующий; ошибки — без логинов", async () => {
    const calls: string[] = [];
    const portal = {
      getJoinUrl: async (_row: unknown, auth: { name: string }) => {
        calls.push(auth.name);
        if (auth.name === "b-login") throw new Error("timeout");
        return { url: "https://bbb/room" };
      },
    };
    const row = { joinId: "1", joinType: "1", groups: ["ВИШ-11-25"] };
    const ok = await joinWithProfiles(portal, row, [p1, p2]);
    expect(calls).toEqual(["b-login", "a-login"]);
    expect(ok).toEqual({ url: "https://bbb/room", profile: "1", errors: ["профиль 2: Error: timeout"] });

    const denied = await joinWithProfiles({ getJoinUrl: async () => ({ error: "нет доступа" }) }, row, [p1, p2]);
    expect(denied.url).toBeUndefined();
    expect(denied.errors).toEqual(["профиль 2: нет доступа", "профиль 1: нет доступа"]);
    expect(JSON.stringify(denied)).not.toMatch(/login|secret/);

    expect((await joinWithProfiles(portal, { ...row, groups: ["ВИШ-12-23"] }, [{ ...p1, groups: ["11-24"] }])).errors[0]).toMatch(/ни один профиль/);
  });

  it("профиль 3 — поток 4 курса: подходит ко всем названиям групп -23 с портала и ни к одному другому курсу", () => {
    const p3 = { name: "3", authMode: "1" as const, login: "c-login", password: "c-secret", groups: ["11-23", "12-23", "13-23", "14-23"] };
    for (const g of ["ВИШ-11-23(РЗиАЭС)", "ВИШ-11-23 (ЭиЭА)", "ВИШ-12-23", "ВИШ-12-23иот (11.03.04)", "ВИШ-13-23иот", "ВИШ-14-23"]) {
      expect(profilesFor({ groups: [g] }, [p1, p2, p3]).map((p) => p.name)).toEqual(["3", "1"]);
    }
    for (const g of ["ВИШ-11-24иот (13.03.02)", "ВИШ-13-24иот (09.03.01)-2", "ВИШ-15-25иот (11.03.04)", "ОЗВИШ-12-25"]) expect(matchesGroups(p3.groups, [g])).toBe(false);
  });

  it("в лог уходят только номера и группы профилей", () => {
    const summary = profileSummary([p1, p2]);
    expect(summary).toEqual(["1", "2 (11-25, 12-25, 13-25, 14-25, 15-25)"]);
    expect(JSON.stringify(summary)).not.toMatch(/login|secret/);
  });

  it("профили из окружения: режим профиля 2 по умолчанию — «обучающийся»; половина профиля — ошибка; группы без учётки — предупреждение", () => {
    // Изолируем все WEBINAR_*: иначе тест зависел бы от окружения запуска.
    const saved = Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("WEBINAR_")).map((k) => [k, process.env[k]]));
    for (const k of Object.keys(saved)) delete process.env[k];
    try {
      Object.assign(process.env, { WEBINAR_LOGIN: "one", WEBINAR_PASSWORD: "p1", WEBINAR_AUTH: "2", WEBINAR_LOGIN_2: "two", WEBINAR_PASSWORD_2: "p2", WEBINAR_GROUPS_2: "11-25, 12-25;13-25" });
      const cfg = loadConfig();
      expect(cfg.profiles).toEqual([
        { name: "1", authMode: "2", login: "one", password: "p1", groups: [] },
        { name: "2", authMode: "1", login: "two", password: "p2", groups: ["11-25", "12-25", "13-25"] },
      ]);
      expect(cfg.warnings).toEqual([]);
      Object.assign(process.env, { WEBINAR_LOGIN_3: "three", WEBINAR_PASSWORD_3: "p3", WEBINAR_GROUPS_3: "11-23,12-23,13-23,14-23" });
      expect(loadConfig().profiles.map((p) => [p.name, p.authMode, p.groups.join(",")])).toEqual([["1", "2", ""], ["2", "1", "11-25,12-25,13-25"], ["3", "1", "11-23,12-23,13-23,14-23"]]);
      delete process.env.WEBINAR_LOGIN_3;
      delete process.env.WEBINAR_PASSWORD_3;
      delete process.env.WEBINAR_GROUPS_3;
      process.env.WEBINAR_AUTH_2 = "4";
      expect(loadConfig().profiles[1]!.authMode).toBe("4");
      process.env.WEBINAR_PASSWORD_2 = "";
      expect(() => loadConfig()).toThrow(/WEBINAR_PASSWORD_2/);
      process.env.WEBINAR_LOGIN_2 = "";
      const noSecond = loadConfig();
      expect(noSecond.profiles).toHaveLength(1);
      expect(noSecond.warnings[0]).toMatch(/WEBINAR_GROUPS_2 задан/);
      process.env.WEBINAR_LOGIN = "";
      expect(() => loadConfig()).toThrow(/WEBINAR_LOGIN и WEBINAR_PASSWORD/);
    } finally {
      for (const k of Object.keys(process.env).filter((k) => k.startsWith("WEBINAR_"))) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("записывалка: перезапуск посреди пары не стирает снятое", () => {
  it("PDF пары ещё нет — кадры остаются и идут по номерам; PDF уже есть — папка чистится", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "rec-resume-"));
    const dir = path.join(root, "2026-10-16-0950-Экономика");
    const pdf = `${dir}.pdf`;
    mkdirSync(dir);
    for (const f of ["slide-002.png", "slide-010.png", "slide-001.png", "notes.txt"]) writeFileSync(path.join(dir, f), f);
    expect(earlierSlides(dir, pdf).map((f) => path.basename(f))).toEqual(["slide-001.png", "slide-002.png", "slide-010.png"]);
    expect(earlierSlides(path.join(root, "нет-такой"), `${root}/нет-такой.pdf`)).toEqual([]);
    writeFileSync(pdf, "pdf");
    expect(earlierSlides(dir, pdf)).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("записывалка: проверка учётки через личный кабинет", () => {
  it("ответ на вход: 302 в кабинет — вошли; «Неверн…» — пароль не тот; остальное — кабинет недоступен, а не плохой пароль", async () => {
    const { loginVerdict, groupIdFromTtPage } = await import("../recorder/src/lk.js");
    expect(loginVerdict(302, "/student/index.php", "")).toBe("ok");
    expect(loginVerdict(200, null, "<b>Неверный логин или пароль</b>")).toBe("bad");
    expect(loginVerdict(502, null, "Bad gateway")).toBe("down");
    expect(loginVerdict(200, null, "<html>техработы</html>")).toBe("down");
    expect(loginVerdict(302, "/info/login.php", "")).toBe("down");
    expect(groupIdFromTtPage('<a href="https://tt.chuvsu.ru/index/grouptt/gr/8526">Расписание</a>')).toBe(8526);
    expect(groupIdFromTtPage("<html></html>")).toBeNull();
  });

  it("11-23: код «11-23(эиэа)» различает две группы, хотя портал пишет одну со пробелом, другую без; голый «11-23» — обе", () => {
    expect(matchesGroups(["11-23(эиэа)"], ["ВИШ-11-23 (ЭиЭА)"])).toBe(true);
    expect(matchesGroups(["11-23(эиэа)"], ["ВИШ-11-23(РЗиАЭС)"])).toBe(false);
    expect(matchesGroups(["11-23 (рзиаэс)"], ["ВИШ-11-23(РЗиАЭС)"])).toBe(true);
    expect(matchesGroups(["11-23"], ["ВИШ-11-23 (ЭиЭА)"])).toBe(true);
    expect(matchesGroups(["11-23"], ["ВИШ-11-23(РЗиАЭС)"])).toBe(true);
  });
});
