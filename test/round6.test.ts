import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { Notifier } from "../src/notify/dispatcher.js";
import { createHttpServer } from "../src/http/server.js";
import { buildInlineResults, parseInlineQuery } from "../src/bot/inline.js";
import { formatWeek } from "../src/schedule/format.js";
import { addDays, mondayOf, parseDayWord, todayMsk } from "../src/time.js";
import type { Deps } from "../src/bot/context.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import type { User } from "../src/db/repo.js";

const group: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [8524], portalNames: ["ВИШ-12-23"] };
const other: LogicalGroup = { ...group, key: "виш-14-23", title: "ВИШ-14-23", number: 14 };
const today = todayMsk();

function lesson(date: string, subject: string): Occurrence {
  return { groupKey: group.key, period: 1, date, slot: 3, start: 11 * 60 + 40, end: 13 * 60, subject, type: "лк", room: "Т-310", teacher: null, subgroup: null, isDistance: false, status: "scheduled", sources: [group.title] };
}

function makeService(): ScheduleService {
  const all = [lesson(today, "Патентоведение"), lesson(addDays(today, 1), "Физика")];
  return {
    group: (key: string) => [group, other].find((g) => g.key === key) ?? null,
    groups: () => [group, other],
    stream: () => [group, other],
    intakes: () => [23],
    lessonsOn: (_g: LogicalGroup, date: string) => all.filter((o) => o.date === date),
    materialize: (_g: LogicalGroup, from: string, to: string) => all.filter((o) => o.date >= from && o.date <= to),
    weekInfo: () => ({ week: 3, parity: "odd" as const, semester: 1 as const }),
    semesterFor: () => 1 as const,
    weekOneMonday: () => "2026-09-01",
    academicYear: 2026,
    lastPollRun: () => null,
  } as unknown as ScheduleService;
}

function makeDeps(repo = new Repo(openDatabase(":memory:"))): Deps {
  return {
    config: { ADMIN_IDS: [], MEDIA_CHAT_IDS: [], POISK: false, POISK_DAILY_LIMIT: 30 } as unknown as Deps["config"],
    repo,
    service: makeService(),
    renderer: null,
    ask: null,
    teachers: null,
    webinars: null,
    students: null, known: null,
    news: null,
    http: null,
    inline: true,
    botUsername: "vish_bot",
    pending: new Map(),
    startedAt: new Date(),
  };
}

const user = (groupKey: string | null): User => ({ id: 7, groupKey, subgroup: null } as unknown as User);

describe("слова-даты", () => {
  it("каждое «после» двигает день вперёд, «поза» — назад", () => {
    expect(parseDayWord("сегодня")).toBe(0);
    expect(parseDayWord("завтра")).toBe(1);
    expect(parseDayWord("послезавтра")).toBe(2);
    expect(parseDayWord("послепослезавтра")).toBe(3);
    expect(parseDayWord("вчера")).toBe(-1);
    expect(parseDayWord("позавчера")).toBe(-2);
    expect(parseDayWord("позапозавчера")).toBe(-3);
    expect(parseDayWord("понедельник")).toBeNull();
    expect(parseDayWord("14.09")).toBeNull();
  });
});

describe("inline", () => {
  it("понимает день, неделю, поток и общие пары", () => {
    const deps = makeDeps();
    const day = parseInlineQuery(deps, "12-23 послезавтра", user(null));
    expect(day.date).toBe(addDays(today, 2));
    expect(day.groups[0]!.key).toBe(group.key);

    expect(parseInlineQuery(deps, "неделя", user(group.key)).mode).toBe("week");
    expect(parseInlineQuery(deps, "поток 23", user(group.key)).mode).toBe("stream");
    expect(parseInlineQuery(deps, "общие", user(group.key)).mode).toBe("common");
    const next = parseInlineQuery(deps, "след неделя", user(group.key));
    expect(next.mode).toBe("week");
    expect(mondayOf(next.date)).toBe(addDays(mondayOf(today), 7));
  });

  it("без запроса показывает свою группу: день, неделю, поток и общие", () => {
    const deps = makeDeps();
    const req = parseInlineQuery(deps, "", user(group.key));
    const results = buildInlineResults(deps, req, user(group.key));
    const titles = results.map((r) => r.title).join(" | ");
    expect(titles).toMatch(/📅/);
    expect(titles).toMatch(/🗓/);
    expect(titles).toMatch(/🎓/);
    // Telegram режет id по 64 байтам — кириллица занимает по два.
    for (const r of results) expect(Buffer.byteLength(r.id)).toBeLessThanOrEqual(64);
    for (const r of results) expect(String(r.input_message_content && "message_text" in r.input_message_content ? r.input_message_content.message_text : "").length).toBeLessThanOrEqual(4096);
  });

  it("берёт поток у названной группы, а не у смотрящего", () => {
    const deps = makeDeps();
    // Смотрящий из набора 23, спрашивает про группу набора 23 другого номера —
    // поток должен быть её, а не «своего» по умолчанию.
    const req = parseInlineQuery(deps, "поток 14-23", user(group.key));
    expect(req.mode).toBe("stream");
    expect(req.intake).toBe(other.intake);
  });

  it("не подсовывает своё расписание вместо ненайденной группы", () => {
    const deps = makeDeps();
    const req = parseInlineQuery(deps, "99-99 завтра", user(group.key));
    expect(req.unknownGroup).toBe(true);
    const results = buildInlineResults(deps, req, user(group.key));
    expect(results[0]!.title).toMatch(/не нашёл/i);
  });

  it("id остаётся в 64 байтах даже у группы с длинным названием", () => {
    const deps = makeDeps();
    const long: LogicalGroup = { ...group, key: "виш-12-23 (11.03.04 индивидуальный учебный план)", title: "ВИШ-12-23 (11.03.04 индивидуальный учебный план)" };
    deps.service = { ...makeService(), groups: () => [long], group: () => long, stream: () => [long] } as unknown as ScheduleService;
    const req = parseInlineQuery(deps, "", user(null));
    for (const r of buildInlineResults(deps, req, user(null))) {
      expect(Buffer.byteLength(r.id)).toBeLessThanOrEqual(64);
      expect(r.id).not.toContain("\uFFFD");
    }
  });

  it("работает для человека без группы: показывает первые группы школы", () => {
    const deps = makeDeps();
    const req = parseInlineQuery(deps, "завтра", null);
    expect(req.groups.length).toBeGreaterThan(0);
    expect(buildInlineResults(deps, req, null).length).toBeGreaterThan(0);
  });
});

describe("неделя текстом", () => {
  it("показывает и начало, и конец пары", () => {
    const byDate = new Map<string, Occurrence[]>([[today, [lesson(today, "Патентоведение")]]]);
    const text = formatWeek(group, mondayOf(today), byDate, { week: 3, parity: "odd", semester: 1 }, today);
    expect(text).toContain("11:40–13:00");
  });
});

describe("карта преподавателей и слежение", () => {
  it("копит пометку ВИШ и не теряет её при повторном обходе", () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.seedTeacherMap("t1", 1, "Иванова И. И.");
    expect(repo.teacherMapById(1)?.vish).toBe(false);
    repo.upsertTeacherMap({ key: "t1", teacherId: 1, name: "Иванова Ирина Ивановна", vish: true, groups: ["ВИШ-12-23"], subjects: ["Физика"], department: "Каф. физики", degree: null, photoUrl: "/photo/1", photoFileId: null, source: "portal", checkedAt: new Date().toISOString() });
    const row = repo.teacherMapById(1)!;
    expect(row.vish).toBe(true);
    expect(row.groups).toEqual(["ВИШ-12-23"]);
    // Повторный обход без групп (например, у преподавателя сейчас нет пар) не снимает пометку.
    repo.upsertTeacherMap({ ...row, vish: false, groups: [], subjects: [] });
    expect(repo.teacherMapById(1)!.vish).toBe(true);
    // Фото помним по file_id, чтобы не качать его с портала снова.
    repo.setTeacherPhotoFileId("t1", "AgACphoto");
    expect(repo.teacherMapById(1)!.photoFileId).toBe("AgACphoto");
  });

  it("слежение включается и выключается одной кнопкой", () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    expect(repo.toggleWatchTeacher(7, 42, "Иванова И. И.")).toBe(true);
    expect(repo.watchesTeacher(7, 42)).toBe(true);
    expect(repo.teacherWatchers()).toEqual([{ teacherId: 42, name: "Иванова И. И.", userIds: [7] }]);
    expect(repo.toggleWatchTeacher(7, 42, "Иванова И. И.")).toBe(false);
    expect(repo.watchedTeachers(7)).toEqual([]);
  });
});

describe("слайды вебинаров", () => {
  let server: Server | null = null;
  afterAll(() => server?.close());

  it("принимает PDF по токену, кладёт в базу и зовёт рассылку", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const dir = mkdtempSync(path.join(tmpdir(), "vish-slides-"));
    const got: unknown[] = [];
    server = createHttpServer({ repo, service: makeService(), port: 0, host: "127.0.0.1", slidesToken: "x".repeat(20), slidesDir: dir, onSlides: (d) => got.push(d) });
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const meta = Buffer.from(JSON.stringify({ date: today, subject: "Правоведение", teacher: "Кожина Т. Н.", groups: ["ВИШ-12-23"], slides: 3 })).toString("base64");
    const pdf = Buffer.from("%PDF-1.4\n% тест\n");

    const bad = await fetch(`http://127.0.0.1:${port}/slides`, { method: "POST", headers: { Authorization: "Bearer nope", "X-Slides-Meta": meta }, body: pdf });
    expect(bad.status).toBe(403);

    const notPdf = await fetch(`http://127.0.0.1:${port}/slides`, { method: "POST", headers: { Authorization: `Bearer ${"x".repeat(20)}`, "X-Slides-Meta": meta }, body: Buffer.from("не пдф") });
    expect(notPdf.status).toBe(400);

    const ok = await fetch(`http://127.0.0.1:${port}/slides`, { method: "POST", headers: { Authorization: `Bearer ${"x".repeat(20)}`, "X-Slides-Meta": meta }, body: pdf });
    expect(ok.status).toBe(200);
    expect(got.length).toBe(1);
    const decks = repo.recentSlideDecks(5);
    expect(decks[0]!.subject).toBe("Правоведение");
    expect(decks[0]!.groups).toEqual(["ВИШ-12-23"]);
    expect(readFileSync(decks[0]!.file).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("рассылает PDF студентам этой группы и один раз его загружает", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const dir = mkdtempSync(path.join(tmpdir(), "vish-slides-"));
    const file = path.join(dir, "deck.pdf");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, Buffer.from("%PDF-1.4\n"));
    repo.touchUser(1, "a", "A");
    repo.updateUser(1, { groupKey: group.key });
    repo.touchUser(2, "b", "B");
    repo.updateUser(2, { groupKey: group.key });
    repo.touchUser(3, "c", "C");
    repo.updateUser(3, { groupKey: other.key });
    repo.touchUser(4, "d", "D");
    repo.updateUser(4, { groupKey: group.key, wantSlides: false });

    const uploads: Array<{ chatId: number; byFileId: boolean }> = [];
    const api = {
      sendDocument: async (chatId: number, doc: unknown) => {
        uploads.push({ chatId, byFileId: typeof doc === "string" });
        return { document: { file_id: "BQACdeck" } };
      },
    } as never;
    const deckId = repo.addSlideDeck({ date: today, subject: "Правоведение", teacher: "Кожина Т. Н.", title: null, groups: ["ВИШ-12-23"], slides: 3, file, bytes: 9 });
    const n = new Notifier(api, repo, makeService(), null);
    const sent = await n.sendSlideDeck({ deckId, date: today, subject: "Правоведение", teacher: "Кожина Т. Н.", title: null, groups: ["ВИШ-12-23"], slides: 3, file });
    expect(sent).toBe(2);
    expect(uploads.map((u) => u.chatId)).toEqual([1, 2]);
    // Первому — файл, дальше по file_id.
    expect(uploads[0]!.byFileId).toBe(false);
    expect(uploads[1]!.byFileId).toBe(true);
    expect(repo.recentSlideDecks(1)[0]!.sent).toBe(2);
  });
});
