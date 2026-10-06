import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { CHANGES_HELD_KEY, CHANGES_RELEASE_KEY, isMassChange, Notifier } from "../src/notify/dispatcher.js";
import { changesCaption, changesMessageFit, laterText, markDay, markLine, splitByToday, todayCaption, weekPhrase } from "../src/notify/changes.js";
import { formatChangeEvent, formatDay } from "../src/schedule/format.js";
import { parseStartPayload, startLink, startPayload } from "../src/bot/deeplink.js";
import type { ChangeEvent } from "../src/schedule/diff.js";
import type { DayRenderInput, Renderer } from "../src/render/image.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import type { WallClock } from "../src/time.js";

const group: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [8524], portalNames: ["ВИШ-12-23"] };
const TODAY = "2026-10-05"; // понедельник
const info = { week: 6, parity: "even" as const, semester: 1 as const };
const clock = (date: string, hh: number, mm = 0): WallClock => ({ date, minutes: hh * 60 + mm, weekday: 1, ms: 0 });

function lesson(date: string, slot: number, start: number, subject: string, over: Partial<Occurrence> = {}): Occurrence {
  return { groupKey: group.key, period: 1, date, slot, start, end: start + 80, subject, type: "лк", room: "Т-310", teacher: null, subgroup: null, isDistance: false, status: "scheduled", sources: ["ВИШ-12-23"], ...over };
}
const ev = (e: Omit<ChangeEvent, "groupKey" | "period">): ChangeEvent => ({ groupKey: group.key, period: 1, ...e });

describe("пометки на расписании дня", () => {
  const physics = lesson(TODAY, 1, 8 * 60 + 20, "Физика");
  const mathBefore = lesson(TODAY, 2, 9 * 60 + 50, "Матан");
  const mathAfter = { ...mathBefore, room: "Т-204" };
  const chem = lesson(TODAY, 3, 11 * 60 + 40, "Химия");
  const prog = lesson(TODAY, 4, 13 * 60 + 30, "Программирование");

  it("изменённая — ✏️ с пояснением, новая — ➕, отменённая возвращается зачёркнутой с ❌; остальные без значка", () => {
    const lessons = [physics, mathAfter, prog];
    const marked = markDay(lessons, [ev({ kind: "changed", date: TODAY, before: mathBefore, after: mathAfter, fields: ["room"] }), ev({ kind: "removed", date: TODAY, before: chem }), ev({ kind: "added", date: TODAY, after: prog })], TODAY);
    expect(marked.map((o) => [o.subject, o.mark?.kind ?? null, o.mark?.note ?? null])).toEqual([
      ["Физика", null, null],
      ["Матан", "changed", "ауд. Т-310 → Т-204"],
      ["Химия", "cancelled", ""],
      ["Программирование", "added", ""],
    ]);
    // Пометки — только на копиях: расписание из сервиса не трогаем.
    expect(lessons.some((o) => "mark" in o)).toBe(false);

    const text = formatDay(group, TODAY, marked, info, TODAY, { hideTitle: true });
    expect(text).toContain("1️⃣ <code>08:20–09:40</code> <b>Физика</b>");
    expect(text).not.toMatch(/[✏️➕❌] 1️⃣/u);
    expect(text).toContain("✏️ 2️⃣ <code>09:50–11:10</code> <b>Матан</b>");
    expect(text).toContain("✏️ <b>Изменено:</b> ауд. Т-310 → Т-204");
    expect(text).toContain("❌ 3️⃣ <code>11:40–13:00</code> <s>Химия</s>");
    expect(text).toContain("❌ <b>ОТМЕНЕНА</b>");
    expect(text).toContain("➕ 4️⃣ <code>13:30–14:50</code> <b>Программирование</b>");
    // Отменённая в счёт пар не идёт.
    expect(text).toContain("3 пары · 08:20–14:50");
  });

  it("переносы: с сегодня на другой день — «перенесена на …» (не «отменена»), на сегодня — новая «перенос с …», внутри дня — изменена", () => {
    const tue = "2026-10-06";
    const away = markDay([physics], [ev({ kind: "moved", date: tue, before: chem, after: { ...chem, date: tue, slot: 2, start: 9 * 60 + 50, end: 11 * 60 + 10 } })], TODAY);
    const gone = away.find((o) => o.subject === "Химия")!;
    expect(gone.mark).toEqual({ kind: "moved", note: "на 06.10 (2 пара)" });
    expect(markLine(gone)).toBe("↪️ 3 пара <code>11:40–13:00</code> <b>Химия</b> — <b>перенесена</b> на 06.10 (2 пара)");
    const text = formatDay(group, TODAY, away, info, TODAY, { hideTitle: true });
    expect(text).toContain("↪️ 3️⃣ <code>11:40–13:00</code> <s>Химия</s>");
    expect(text).toContain("↪️ <b>ПЕРЕНЕСЕНА</b> на 06.10 (2 пара)");
    expect(text).not.toContain("ОТМЕНЕНА");
    // Перенесённая в счёт пар дня не идёт.
    expect(text).toContain("1 пара · 08:20–09:40");
    const fri = { ...chem, date: "2026-10-02" };
    const here = markDay([chem], [ev({ kind: "moved", date: TODAY, before: fri, after: chem })], TODAY);
    expect(here[0]!.mark).toEqual({ kind: "added", note: "перенос с 02.10 (3 пара)" });
    const later = { ...chem, slot: 5, start: 15 * 60 + 10, end: 16 * 60 + 30 };
    const inside = markDay([later], [ev({ kind: "moved", date: TODAY, before: chem, after: later })], TODAY);
    expect(inside[0]!.mark).toEqual({ kind: "changed", note: "была 3 пара (11:40–13:00)" });
  });

  it("срочное на сегодня отдельно от будущего; будущее — со строкой, какая неделя", () => {
    const tue = lesson("2026-10-06", 2, 9 * 60 + 50, "Химия");
    const nextWeek = lesson("2026-10-13", 2, 9 * 60 + 50, "Химия");
    const events = [ev({ kind: "removed", date: TODAY, before: chem }), ev({ kind: "removed", date: "2026-10-06", before: tue }), ev({ kind: "added", date: "2026-10-13", after: nextWeek })];
    const { today, later } = splitByToday(events, TODAY);
    expect(today).toHaveLength(1);
    expect(later).toHaveLength(2);
    expect(weekPhrase(["2026-10-06"], TODAY)).toBe("на этой неделе");
    expect(weekPhrase(["2026-10-13"], TODAY)).toBe("на следующей неделе");
    expect(weekPhrase(["2026-10-06", "2026-10-13"], TODAY)).toBe("на этой и следующей неделе");
    const text = laterText(group, later, TODAY);
    expect(text).toMatch(/^🗓 <b>Изменения на будущее<\/b> · ВИШ-12-23\n<i>на этой и следующей неделе<\/i>/);
    expect(text).toContain("<b>Вторник, 6 октября</b> · <i>завтра</i>");
    expect(text).toContain("— <b>отменена</b>");
    expect(todayCaption(group, markDay([], [today[0]!], TODAY))).toBe("🚨 <b>ИЗМЕНЕНИЯ НА СЕГОДНЯ</b> · ВИШ-12-23\n\n❌ 3 пара <code>11:40–13:00</code> <b>Химия</b> — <b>отменена</b>");
  });
});

// ---- рассылка ----

function makeService(byDate: Record<string, Occurrence[]>): ScheduleService {
  return {
    group: (key: string) => (key === group.key ? group : null),
    groups: () => [group],
    lessonsOn: (_g: LogicalGroup, date: string) => byDate[date] ?? [],
    weekInfo: () => info,
  } as unknown as ScheduleService;
}

function makeApi() {
  const sent: Array<{ chatId: number; text: string; markup?: unknown }> = [];
  const photos: Array<{ chatId: number; caption?: string; markup?: unknown }> = [];
  const albums: Array<{ chatId: number; count: number; caption?: string }> = [];
  const api = {
    sendMessage: async (chatId: number, text: string, opts?: { reply_markup?: unknown }) => (sent.push({ chatId, text, markup: opts?.reply_markup }), {} as never),
    sendPhoto: async (chatId: number, _photo: unknown, opts?: { caption?: string; reply_markup?: unknown }) => (photos.push({ chatId, caption: opts?.caption, markup: opts?.reply_markup }), {} as never),
    sendMediaGroup: async (chatId: number, media: Array<{ caption?: string }>) => (albums.push({ chatId, count: media.length, caption: media[0]?.caption }), [] as never),
  };
  return { api: api as never, sent, photos, albums };
}

function fakeRenderer(calls: DayRenderInput[]): Renderer {
  return {
    renderDay: async (input) => (calls.push(input), Buffer.from("png")),
    renderWeek: async () => Buffer.from("png"),
    renderStreamDay: async () => Buffer.from("png"),
  };
}

function subscriber(repo: Repo, id: number, format: "text" | "image" | "both"): void {
  repo.touchUser(id, `u${id}`, "U");
  repo.updateUser(id, { groupKey: group.key, notifyChanges: true, format });
}

describe("уведомления: на сегодня и на будущее — одним сообщением", () => {
  const physics = lesson(TODAY, 1, 8 * 60 + 20, "Физика");
  const mathBefore = lesson(TODAY, 2, 9 * 60 + 50, "Матан");
  const mathAfter = { ...mathBefore, room: "Т-204" };
  const tue = lesson("2026-10-06", 3, 11 * 60 + 40, "Химия");
  const thu = lesson("2026-10-08", 1, 8 * 60 + 20, "История");

  function setup() {
    const repo = new Repo(openDatabase(":memory:"));
    repo.insertChangeEvents([
      { groupKey: group.key, date: TODAY, period: 1, kind: "changed", payload: { before: mathBefore, after: mathAfter, fields: ["room"] } },
      { groupKey: group.key, date: "2026-10-06", period: 1, kind: "removed", payload: { before: tue } },
      { groupKey: group.key, date: "2026-10-08", period: 1, kind: "removed", payload: { before: thu } },
    ]);
    return repo;
  }

  it("текстом: одно сообщение — «ИЗМЕНЕНИЯ НА СЕГОДНЯ» со всем днём, следом будущее; кнопка календаря", async () => {
    const repo = setup();
    subscriber(repo, 1, "text");
    const { api, sent, photos, albums } = makeApi();
    const calls: DayRenderInput[] = [];
    const n = new Notifier(api, repo, makeService({ [TODAY]: [physics, mathAfter] }), fakeRenderer(calls));
    expect(await n.dispatchChangeEvents(clock(TODAY, 7))).toBe(1);
    expect(photos).toHaveLength(0);
    expect(albums).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(sent).toHaveLength(1);
    const text = sent[0]!.text;
    expect(text).toMatch(/^🚨 <b>ИЗМЕНЕНИЯ НА СЕГОДНЯ<\/b> · ВИШ-12-23/);
    expect(text).toContain("1️⃣ <code>08:20–09:40</code> <b>Физика</b>");
    expect(text).toContain("✏️ 2️⃣");
    // Будущее — следом, без второго названия группы.
    expect(text).toContain("\n\n🗓 <b>Изменения на будущее</b>\n<i>на этой неделе</i>");
    expect(text).toContain("Химия");
    expect(text).toContain("История");
    expect(JSON.stringify(sent[0]!.markup)).toContain("cics:");
  });

  it("картинкой: один альбом — сегодня (красная полоса) и дни (синяя), подпись под альбомом; больше ничего", async () => {
    const repo = setup();
    subscriber(repo, 1, "image");
    const { api, sent, photos, albums } = makeApi();
    const calls: DayRenderInput[] = [];
    const n = new Notifier(api, repo, makeService({ [TODAY]: [physics, mathAfter] }), fakeRenderer(calls));
    expect(await n.dispatchChangeEvents(clock(TODAY, 7))).toBe(1);
    expect(calls.map((c) => [c.date, c.banner?.tone, c.banner?.text])).toEqual([
      [TODAY, "urgent", "ИЗМЕНЕНИЯ НА СЕГОДНЯ"],
      ["2026-10-06", "info", "ИЗМЕНЕНИЯ НА ЗАВТРА · 06.10"],
      ["2026-10-08", "info", "ИЗМЕНЕНИЯ НА ЧТ 08.10"],
    ]);
    expect(calls[0]!.lessons.map((o) => o.mark?.kind ?? null)).toEqual([null, "changed"]);
    expect(calls[1]!.lessons.map((o) => [o.subject, o.mark?.kind])).toEqual([["Химия", "cancelled"]]);
    expect(sent).toHaveLength(0);
    expect(photos).toHaveLength(0);
    expect(albums).toHaveLength(1);
    expect(albums[0]!.count).toBe(3);
    const caption = albums[0]!.caption!;
    expect(caption.startsWith("🚨 <b>ИЗМЕНЕНИЯ НА СЕГОДНЯ</b> · ВИШ-12-23\n\n✏️ 2 пара <code>09:50–11:10</code> <b>Матан</b> — ауд. Т-310 → Т-204\n\n🗓 <b>Изменения на будущее</b>")).toBe(true);
    expect(caption).toContain("История");
    // Имени бота нет — ссылок тоже нет.
    expect(caption).not.toContain("t.me/");
  });

  it("у альбома нет кнопок: календарь (и «не следить» у чужой группы) — ссылками в подписи", async () => {
    const repo = setup();
    subscriber(repo, 1, "image");
    repo.touchUser(2, "w", "W");
    repo.updateUser(2, { format: "image" });
    repo.toggleWatchGroup(2, group.key);
    const { api, albums } = makeApi();
    const n = new Notifier(api, repo, makeService({ [TODAY]: [physics, mathAfter] }), fakeRenderer([]), [], null, null, "vish_test_bot");
    expect(await n.dispatchChangeEvents(clock(TODAY, 7))).toBe(2);
    const own = albums.find((a) => a.chatId === 1)!.caption!;
    const ics = startLink("vish_test_bot", "ics", group.key)!;
    expect(own).toContain(`<a href="${ics}">📆 Файл изменений в календарь</a>`);
    expect(own).not.toContain("Не следить");
    const watched = albums.find((a) => a.chatId === 2)!.caption!;
    expect(watched).toContain("👁 Не следить за группой");
    expect(parseStartPayload(new URL(ics).searchParams.get("start")!)).toEqual({ action: "ics", groupKey: group.key });
  });

  it("«и так, и так»: в подписи к альбому — полный день, если влезает", async () => {
    const repo = setup();
    subscriber(repo, 1, "both");
    const { api, sent, albums } = makeApi();
    const n = new Notifier(api, repo, makeService({ [TODAY]: [physics, mathAfter] }), fakeRenderer([]));
    await n.dispatchChangeEvents(clock(TODAY, 7));
    expect(sent).toHaveLength(0);
    expect(albums[0]!.caption).toContain("1️⃣ <code>08:20–09:40</code> <b>Физика</b>");
    expect(albums[0]!.caption).toContain("✏️ <b>Изменено:</b> ауд. Т-310 → Т-204");
    expect(albums[0]!.caption).toContain("История");
  });

  it("один затронутый день — один постер с подписью и кнопкой", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.insertChangeEvents([{ groupKey: group.key, date: "2026-10-06", period: 1, kind: "removed", payload: { before: tue } }]);
    subscriber(repo, 1, "image");
    const { api, sent, photos, albums } = makeApi();
    const n = new Notifier(api, repo, makeService({}), fakeRenderer([]));
    expect(await n.dispatchChangeEvents(clock(TODAY, 7))).toBe(1);
    expect(albums).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(photos).toHaveLength(1);
    expect(photos[0]!.caption).toMatch(/^🗓 <b>Изменения на будущее<\/b> · ВИШ-12-23/);
    expect(JSON.stringify(photos[0]!.markup)).toContain("cics:");
  });

  it("перенос «сегодня → пятница»: зачёркнут в сегодня и «＋ новая пара» на картинке пятницы — в том же альбоме", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const fri = "2026-10-09";
    const chem = lesson(TODAY, 3, 11 * 60 + 40, "Химия");
    const chemFri = { ...chem, date: fri, slot: 2, start: 9 * 60 + 50, end: 11 * 60 + 10, movedFrom: { date: TODAY, slot: 3 } };
    repo.insertChangeEvents([{ groupKey: group.key, date: fri, period: 1, kind: "moved", payload: { before: chem, after: chemFri } }]);
    subscriber(repo, 1, "image");
    const { api, albums } = makeApi();
    const calls: DayRenderInput[] = [];
    const n = new Notifier(api, repo, makeService({ [TODAY]: [physics], [fri]: [chemFri] }), fakeRenderer(calls));
    expect(await n.dispatchChangeEvents(clock(TODAY, 7))).toBe(1);
    expect(calls.map((c) => [c.date, c.banner?.text])).toEqual([
      [TODAY, "ИЗМЕНЕНИЯ НА СЕГОДНЯ"],
      [fri, "ИЗМЕНЕНИЯ НА ПТ 09.10"],
    ]);
    expect(calls[0]!.lessons.find((o) => o.subject === "Химия")!.mark).toEqual({ kind: "moved", note: "на 09.10 (2 пара)" });
    expect(calls[1]!.lessons[0]!.mark).toEqual({ kind: "added", note: "перенос с 05.10 (3 пара)" });
    expect(albums).toHaveLength(1);
    // В тексте перенос один раз — в «сегодня»; второго раздела ради него нет.
    expect(albums[0]!.caption).toContain("— <b>перенесена</b> на 09.10 (2 пара)");
    expect(albums[0]!.caption).not.toContain("Изменения на будущее");
  });

  it("одинаковые постеры за одну рассылку рисуются один раз", async () => {
    const repo = setup();
    for (const id of [1, 2, 3]) subscriber(repo, id, "image");
    const { api, albums } = makeApi();
    const calls: DayRenderInput[] = [];
    const n = new Notifier(api, repo, makeService({ [TODAY]: [physics, mathAfter] }), fakeRenderer(calls));
    expect(await n.dispatchChangeEvents(clock(TODAY, 7))).toBe(3);
    // Три подписчика, три дня — а рисовали по разу на день.
    expect(calls).toHaveLength(3);
    expect(albums.filter((a) => a.caption?.includes("ИЗМЕНЕНИЯ НА СЕГОДНЯ"))).toHaveLength(3);
  });
});

describe("подпись влезает в лимит Telegram, ссылки и строка изменения", () => {
  it("много изменений на будущее — в подписи сколько влезет и «…и ещё N»", () => {
    const later: ChangeEvent[] = Array.from({ length: 30 }, (_, i) => ev({ kind: "removed", date: `2026-10-${String(6 + (i % 10)).padStart(2, "0")}`, before: lesson(`2026-10-${String(6 + (i % 10)).padStart(2, "0")}`, 1 + (i % 5), 8 * 60 + 20, `Очень длинное название предмета номер ${i}`) }));
    const caption = changesCaption(group, { todayMarked: null, later, today: TODAY, full: null, head: "", tail: "" });
    expect(caption.replace(/<[^>]+>/g, "").length).toBeLessThanOrEqual(1000);
    expect(caption).toMatch(/…и ещё \d+ изменени[йяе] — все в «🔔 Изменения»/);
  });

  it("текстом: сегодня целиком, а будущее, если не влезает в сообщение, — «…и ещё N»", () => {
    const chem = lesson(TODAY, 3, 11 * 60 + 40, "Химия");
    const todayMarked = markDay([], [ev({ kind: "removed", date: TODAY, before: chem })], TODAY);
    const later: ChangeEvent[] = Array.from({ length: 80 }, (_, i) => {
      const d = `2026-10-${String(6 + (i % 20)).padStart(2, "0")}`;
      return ev({ kind: "removed", date: d, before: lesson(d, 1 + (i % 5), 8 * 60 + 20, `Очень длинное название предмета номер ${i}`) });
    });
    const text = changesMessageFit(group, todayMarked, later, info, clock(TODAY, 7), undefined, "");
    expect(text.length).toBeLessThanOrEqual(3900);
    expect(text).toContain("<s>Химия</s>");
    expect(text).toMatch(/…и ещё \d+ изменени[йяе] — все в «🔔 Изменения»<\/i>$/);
  });

  it("сменилась аудитория — она в строке один раз", () => {
    const before = lesson("2026-10-06", 2, 9 * 60 + 50, "Матан");
    const line = formatChangeEvent(ev({ kind: "changed", date: "2026-10-06", before, after: { ...before, room: "Т-204" }, fields: ["room"] }));
    expect(line).toBe("✏️ 06.10 (вт), 2 пара 09:50–11:10: <b>Матан</b> (ЛК) — ауд. Т-310 → Т-204");
    // Другие изменения аудиторию по-прежнему называют.
    const teacher = formatChangeEvent(ev({ kind: "changed", date: "2026-10-06", before: { ...before, teacher: "Петров К. А." }, after: { ...before, teacher: "Андреев И. И." }, fields: ["teacher"] }));
    expect(teacher).toContain("· ауд. Т-310 — преп.");
  });

  it("ссылка /start: кириллица ключа — в base64url, длинный ключ — без ссылки", () => {
    const p = startPayload("ics", group.key)!;
    expect(p).toMatch(/^ics_[A-Za-z0-9_-]+$/);
    expect(parseStartPayload(p)).toEqual({ action: "ics", groupKey: group.key });
    expect(parseStartPayload("inline")).toBeNull();
    expect(startPayload("ics", "я".repeat(40))).toBeNull();
    expect(startLink(null, "ics", group.key)).toBeNull();
  });
});

describe("тормоз массовой рассылки", () => {
  function flood(repo: Repo, n: number): void {
    repo.insertChangeEvents(Array.from({ length: n }, (_, i) => ({ groupKey: group.key, date: "2026-10-06", period: 1 as const, kind: "added", payload: { after: lesson("2026-10-06", 1 + (i % 6), 8 * 60 + i, `Предмет ${i}`) } })));
  }

  it("порог: 40 всего или 25 в одной группе; обычный поток (по паре на 5 групп) — не повод", () => {
    expect(isMassChange(Array.from({ length: 5 }, (_, i) => ({ groupKey: `g${i}` })))).toBe(false);
    expect(isMassChange(Array.from({ length: 24 }, () => ({ groupKey: "g" })))).toBe(false);
    expect(isMassChange(Array.from({ length: 25 }, () => ({ groupKey: "g" })))).toBe(true);
    expect(isMassChange(Array.from({ length: 40 }, (_, i) => ({ groupKey: `g${i % 10}` })))).toBe(true);
  });

  it("большая пачка не уходит людям: админам — вопрос один раз; «Разослать» — уходит; «Не рассылать» — стирается", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    subscriber(repo, 1, "text");
    flood(repo, 30);
    const { api, sent } = makeApi();
    const n = new Notifier(api, repo, makeService({}), null, [99]);
    expect(await n.dispatchChangeEvents(clock(TODAY, 12))).toBe(0);
    expect(sent.filter((s) => s.chatId === 1)).toHaveLength(0);
    const alert = sent.find((s) => s.chatId === 99)!;
    expect(alert.text).toContain("Подозрительно много изменений");
    expect(JSON.stringify(alert.markup)).toContain("chg:release");
    expect(JSON.stringify(alert.markup)).toContain("chg:drop");
    expect(repo.getMeta(CHANGES_HELD_KEY)).toBeTruthy();
    // Следующий опрос: всё ещё придержано, админу второй раз не пишем.
    expect(await n.dispatchChangeEvents(clock(TODAY, 12, 5))).toBe(0);
    expect(sent.filter((s) => s.chatId === 99)).toHaveLength(1);
    // Добор после тихих часов придержанное тоже не трогает.
    expect(await n.flushQuietBacklog(clock(TODAY, 12, 6))).toBe(0);
    expect(await n.flushQuietBacklog(clock(TODAY, 12, 7))).toBe(0);
    expect(sent.filter((s) => s.chatId === 1)).toHaveLength(0);

    repo.setMeta(CHANGES_RELEASE_KEY, "1");
    expect(await n.dispatchChangeEvents(clock(TODAY, 12, 8))).toBe(1);
    expect(sent.filter((s) => s.chatId === 1)).toHaveLength(1);
    expect(repo.getMeta(CHANGES_RELEASE_KEY)).toBe("");
    expect(repo.getMeta(CHANGES_HELD_KEY)).toBe("");

    // Снова пачка — и решение «не рассылать»: изменения стираются, никто их не получит.
    flood(repo, 30);
    expect(await n.dispatchChangeEvents(clock(TODAY, 13))).toBe(0);
    expect(repo.dropUnnotifiedEvents()).toBe(30);
    expect(await n.dispatchChangeEvents(clock(TODAY, 13, 5))).toBe(0);
    expect(sent.filter((s) => s.chatId === 1)).toHaveLength(1);
  });

  it("обычные изменения идут сразу, без вопросов админам", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    subscriber(repo, 1, "text");
    flood(repo, 3);
    const { api, sent } = makeApi();
    const n = new Notifier(api, repo, makeService({}), null, [99]);
    expect(await n.dispatchChangeEvents(clock(TODAY, 12))).toBe(1);
    expect(sent.filter((s) => s.chatId === 99)).toHaveLength(0);
  });
});
