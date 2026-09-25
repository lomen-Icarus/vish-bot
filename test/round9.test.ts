import { describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { WebinarService } from "../src/portal/webinars.js";
import { TeacherService, teacherMapKey } from "../src/portal/teachers.js";
import type { PortalClient } from "../src/portal/client.js";
import { KnownPeople } from "../src/students/known.js";
import { miscHandlers } from "../src/bot/handlers/misc.js";
import { scheduleHandlers } from "../src/bot/handlers/schedule.js";
import { teacherModeHandlers } from "../src/bot/teacherMode.js";
import { peopleHandlers, showPerson } from "../src/bot/people.js";
import { easterHandlers, isErshovQuery, ERSHOV_CARD } from "../src/bot/easter.js";
import { buildPeopleResults, parseInlineQuery } from "../src/bot/inline.js";
import { BTN, isMenuText, LEGACY_BTN } from "../src/bot/keyboards.js";
import { clearHit, tiedWith, type PersonHit } from "../src/people/search.js";
import { groupsAsLabel } from "../src/render/themes.js";
import { literalLabel, posterTeacher } from "../src/schedule/format.js";
import type { Renderer } from "../src/render/image.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import { todayMsk } from "../src/time.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
const today = todayMsk();
const group: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [1], portalNames: ["ВИШ-12-23"] };

function makeDeps(opts: { renderer?: Renderer | null } = {}): Deps {
  const repo = new Repo(openDatabase(":memory:"));
  repo.replaceWebinars(today, [{ date: today, slot: 1, start: 0, end: 23 * 60 + 59, subject: "Программирование", type: "лб", teacher: "Петрова Анна Сергеевна", position: "доцент", degree: "к.т.н.", subgroup: null, title: "Циклы", groups: ["ВИШ-12-23", "ВИШ-13-23"], scheduled: true }]);
  const dir = mkdtempSync(path.join(tmpdir(), "r9-"));
  const reg = path.join(dir, "teachers.csv");
  writeFileSync(reg, "ФИО;Телеграм\nПетрова Анна Сергеевна;petrova_as\n", "utf8");
  const service = {
    group: (k: string) => (k === group.key ? group : null),
    groups: () => [group],
    intakes: () => [23],
    stream: () => [group],
    lessonsOn: () => [],
    materialize: () => [],
    weekInfo: () => ({ week: 3, parity: "odd" as const, semester: 1 as const }),
    semesterFor: () => 1 as const,
    weekOneMonday: () => "2026-08-31",
    academicYear: 2026,
  } as unknown as ScheduleService;
  return {
    config: { ADMIN_IDS: [99], MEDIA_CHAT_IDS: [], POISK: false, POISK_DAILY_LIMIT: 30, AI_DAILY_LIMIT_PER_USER: 10, AI_DAILY_LIMIT_GLOBAL: 300 } as unknown as Deps["config"],
    repo,
    service,
    renderer: opts.renderer ?? null,
    ask: null,
    teachers: null,
    webinars: new WebinarService({} as PortalClient, repo, 32),
    students: null,
    known: null,
    teacherRegistry: new KnownPeople(reg),
    news: null,
    http: null,
    inline: true,
    botUsername: "vish_bot",
    pending: new Map(),
    startedAt: new Date(),
  };
}

interface Call {
  method: string;
  payload: Record<string, unknown>;
}

async function run(update: Update, deps: Deps, opts: { username?: string; composer?: Composer<BotContext> } = {}): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" }, photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }] } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = deps;
  ctx.user = deps.repo.touchUser(7, opts.username ?? "u", "U");
  ctx.isAdmin = false;
  const composer = opts.composer ?? new Composer<BotContext>().use(easterHandlers, teacherModeHandlers, miscHandlers, peopleHandlers, scheduleHandlers);
  await composer.middleware()(ctx, async () => undefined);
  return calls;
}

const text = (t: string): Update => ({
  update_id: 1,
  message: { message_id: 10, date: 0, chat: { id: 7, type: "private", first_name: "U" }, from: { id: 7, is_bot: false, first_name: "U" }, text: t, ...(t.startsWith("/") ? { entities: [{ type: "bot_command" as const, offset: 0, length: t.split(" ")[0]!.length }] } : {}) },
});
const all = (calls: Call[]): string => calls.map((c) => String(c.payload.text ?? c.payload.caption ?? "")).join("\n");

describe("кнопка «🔍 ИИ поисковик»", () => {
  it("новая подпись, старая «🔍 Поиск» из прежнего меню тоже работает", async () => {
    expect(BTN.search).toBe("🔍 ИИ поисковик");
    expect(isMenuText(LEGACY_BTN.search)).toBe(true);
    const deps = makeDeps();
    for (const label of [BTN.search, LEGACY_BTN.search]) {
      const out = all(await run(text(label), deps));
      expect(out).toMatch(/Что ищем\?/);
    }
  });
});

describe("преподаватель из реестра на /start", () => {
  it("режим включается сам: приветствие по имени-отчеству, его меню и напоминания", async () => {
    const deps = makeDeps();
    const calls = await run(text("/start"), deps, { username: "petrova_as" });
    const out = all(calls);
    expect(out).toContain("Здравствуйте, Анна Сергеевна! Рад вас видеть");
    expect(out).not.toMatch(/выбери свою группу/);
    expect(out).toContain("Программирование");
    expect(out).toMatch(/Включить напоминания/);
    expect(JSON.stringify(calls.map((c) => c.payload.reply_markup))).toContain(BTN.students);
    expect(JSON.stringify(calls.map((c) => c.payload.reply_markup))).toContain("ob:on");
    const u = deps.repo.getUser(7)!;
    expect(u.teacherMode).toBe(true);
    expect(u.teacherName).toBe("Петрова Анна Сергеевна");
    // Повторный /start — обычное короткое приветствие преподавателя.
    expect(all(await run(text("/start"), deps, { username: "petrova_as" }))).toMatch(/Здравствуйте, Анна Сергеевна! Рад вас видеть.*ваши пары/s);
  });

  it("«включить рекомендуемые» — текст про напоминания преподавателя", async () => {
    const deps = makeDeps();
    await run(text("/start"), deps, { username: "petrova_as" });
    const press: Update = { update_id: 3, callback_query: { id: "1", from: { id: 7, is_bot: false, first_name: "U" }, chat_instance: "1", data: "ob:on", message: { message_id: 11, date: 0, chat: { id: 7, type: "private", first_name: "U" }, text: "x" } as never } };
    expect(all(await run(press, deps, { username: "petrova_as" }))).toMatch(/Напоминания включены: за 2 часа/);
    expect(deps.repo.getUser(7)!.remindFirstMin).toBe(120);
  });

  it("сам выключил режим через /prepod — /start его обратно не включает", async () => {
    const deps = makeDeps();
    await run(text("/start"), deps, { username: "petrova_as" });
    await run(text("/prepod"), deps, { username: "petrova_as" });
    expect(deps.repo.getUser(7)!.teacherMode).toBe(false);
    const out = all(await run(text("/start"), deps, { username: "petrova_as" }));
    expect(out).toMatch(/выбери свою группу/);
    expect(deps.repo.getUser(7)!.teacherMode).toBe(false);
    // А /prepod включает снова.
    await run(text("/prepod"), deps, { username: "petrova_as" });
    expect(deps.repo.getUser(7)!.teacherMode).toBe(true);
  });

  it("не из реестра — обычный /start с выбором группы", async () => {
    const out = all(await run(text("/start"), makeDeps(), { username: "someone" }));
    expect(out).toMatch(/выбери свою группу/);
  });
});

describe("пасхалка про Кирилла Ершова", () => {
  it("узнаёт запрос, но не любую фразу с этой фамилией", () => {
    for (const q of ["Ершов", "кирилл ершов", "Ершов Кирилл", "кто такой Ершов?", "ершов спорторг", "спорторг", "Ершов Кирил"]) expect(isErshovQuery(q)).toBe(true);
    for (const q of ["Ершова Ирина Петровна", "ершов завтра пары", "Петров", "где ершов сейчас сидит", "Ершов 25.09", "ершов 12-23", "ершову 14:00", "Ершова"]) expect(isErshovQuery(q)).toBe(false);
    expect(isErshovQuery("про Кирилла Ершова")).toBe(true);
  });

  it("карточка в поиске и секретная /ershov", async () => {
    const deps = makeDeps();
    expect(all(await run(text("/search Ершов"), deps))).toContain("Кирилл Ершов");
    const ach = all(await run(text("/ershov"), deps));
    expect(ach).toContain("Достижение открыто");
    expect(ach).toContain("Уронил расписание всему ВИШу");
  });

  it("inline: первой карточкой, без «никого не нашёл»", async () => {
    const deps = makeDeps();
    const req = parseInlineQuery(deps, "Ершов", null);
    const res = await buildPeopleResults(deps, req, null);
    expect(res[0]!.id).toBe("p:ershov");
    expect((res[0]!.input_message_content as { message_text: string }).message_text).toBe(ERSHOV_CARD);
    expect(res.some((r) => r.id.startsWith("p:nf:"))).toBe(false);
  });
});

describe("наши преподаватели (ВИШ) впереди однофамильцев", () => {
  it("при равных очках первым идёт ВИШ, а ВИШ из карты находится, даже если его нет в справочнике", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    // Справочник портала: три «Петрова К.», по алфавиту наш — последний.
    const dir = [
      { id: 1, name: "Петров Константин Андреевич" },
      { id: 2, name: "Петров Кирилл Борисович" },
      { id: 3, name: "Петров Кирилл Юрьевич" },
    ];
    repo.setMeta("teachers:list", JSON.stringify(dir));
    repo.setMeta("teachers:fetchedAt", String(Date.now()));
    repo.markTeacherVish(teacherMapKey(3, "Петров Кирилл Юрьевич"), 3, "Петров Кирилл Юрьевич", ["ВИШ-12-23"]);
    // Новый преподаватель ВИШ, которого суточный справочник ещё не знает.
    repo.markTeacherVish(teacherMapKey(4, "Кузнецова Ольга Игоревна"), 4, "Кузнецова Ольга Игоревна", ["ВИШ-14-24"]);
    const t = new TeacherService({} as PortalClient, repo, {} as ScheduleService, 32);
    const hits = await t.searchScored("Петров Кирилл", 6);
    expect(hits.map((h) => h.ref.id).slice(0, 2)).toEqual([3, 2]);
    expect((await t.searchScored("Кузнецова", 6)).map((h) => h.ref.id)).toEqual([4]);
  });

  it("из одинаково подходящих преподавателей ВИШ ровно один — карточка сразу его", () => {
    const h = (name: string, vish: boolean, role: "teacher" | "student" = "teacher"): PersonHit => ({ ref: { kind: "teacher", id: name.length }, role, name, fuzzy: false, score: 10, vish });
    expect(clearHit([h("Петров Кирилл Юрьевич", true), h("Петров Кирилл Борисович", false)])?.name).toBe("Петров Кирилл Юрьевич");
    expect(clearHit([h("Петров Кирилл Юрьевич", true), h("Петров Кирилл Олегович", true)])).toBeNull();
    expect(clearHit([h("Петров Кирилл Юрьевич", true), h("Петров Кирилл Борисович", true, "student")])).toBeNull();
  });
});

describe("карточка человека картинкой", () => {
  function fakeRenderer() {
    const days: Array<{ title: string; labels: string | undefined; groups: Array<string[] | undefined> }> = [];
    const renderer: Renderer = {
      renderDay: async (input) => {
        days.push({ title: input.group.title, labels: input.labels, groups: input.lessons.map((o) => o.groups) });
        return Buffer.from("png");
      },
      renderWeek: async () => Buffer.from("png"),
      renderStreamDay: async () => Buffer.from("png"),
    };
    return { renderer, days };
  }

  it("в формате «картинка» — постер с подписью «кто и где сейчас»; у преподавателя на постере группы", async () => {
    const { renderer, days } = fakeRenderer();
    const deps = makeDeps({ renderer });
    deps.repo.touchUser(7, "u", "U");
    deps.repo.updateUser(7, { format: "image" });
    const calls: Call[] = [];
    const api = new Api("123:FAKE");
    api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
    });
    const ctx = new Context(text("x"), api, ME) as BotContext;
    ctx.deps = deps;
    ctx.user = deps.repo.getUser(7)!;
    ctx.isAdmin = false;
    const { webinarNameKey } = await import("../src/people/ref.js");
    await showPerson(ctx, { kind: "webinar", key: webinarNameKey("Петрова Анна Сергеевна") }, today);
    const photo = calls.find((c) => c.method === "sendPhoto");
    expect(photo).toBeTruthy();
    expect(String(photo!.payload.caption)).toContain("Петрова Анна Сергеевна");
    expect(calls.some((c) => c.method === "sendMessage")).toBe(false);
    expect(days[0]!.title).toBe("Петрова А. С.");
    // Группы вместо фамилии рисует сам рендерер: данные расписания не трогаем.
    expect(days[0]!.labels).toBe("groups");
    expect(days[0]!.groups).toEqual([["ВИШ-12-23", "ВИШ-13-23"]]);
  });

  it("на входе в отрисовку группы встают в строку пары вместо преподавателя", () => {
    const o = { groupKey: "t", period: 1 as const, date: today, slot: 1, start: 0, end: 60, subject: "Физика", type: "лк", room: null, teacher: "Петрова Анна Сергеевна", subgroup: null, isDistance: false, status: "scheduled" as const, sources: [], groups: ["ВИШ-12-23", "ВИШ-13-23 (ЭиЭА)"] };
    expect(posterTeacher(groupsAsLabel(o).teacher, "plain")).toBe("12-23, 13-23 ЭиЭА");
    expect(groupsAsLabel({ ...o, groups: [] }).teacher).toBeNull();
  });

  it("студент без группы в расписании — не пустой постер, а текст с объяснением", async () => {
    const { renderer, days } = fakeRenderer();
    const deps = makeDeps({ renderer });
    const { deliverPersonPoster } = await import("../src/bot/people.js");
    const { InlineKeyboard } = await import("grammy");
    const ctx = { deps, user: { ...deps.repo.touchUser(7, "u", "U"), format: "image" }, callbackQuery: undefined } as unknown as BotContext;
    const p = { ref: { kind: "student", id: "s1" }, role: "student", name: "Иванов Иван", group: null } as never;
    const view = { text: "нет группы", caption: "нет группы", lessons: [], failed: false, needsGroup: false };
    expect(await deliverPersonPoster(ctx, p, view, { mode: "day", date: today, kb: new InlineKeyboard(), edit: false })).toBe(false);
    expect(days).toHaveLength(0);
  });

  it("метка «как есть» проходит мимо сокращения фамилии", () => {
    expect(posterTeacher(literalLabel("12-23, 13-23"), "plain")).toBe("12-23, 13-23");
    expect(posterTeacher("Иванова Ирина Ивановна", "bold")).toBe("Иванова И. И.");
  });
});

describe("правки по ревью раунда 9", () => {
  const press = (data: string): Update => ({ update_id: 5, callback_query: { id: "1", from: { id: 7, is_bot: false, first_name: "U" }, chat_instance: "1", data, message: { message_id: 11, date: 0, chat: { id: 7, type: "private", first_name: "U" }, text: "x" } as never } });

  it("ВИШ из карты открывается: byId знает не только суточный справочник", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.setMeta("teachers:list", JSON.stringify([{ id: 1, name: "Сидоров Олег" }]));
    repo.setMeta("teachers:fetchedAt", String(Date.now()));
    repo.markTeacherVish(teacherMapKey(4, "Кузнецова Ольга Игоревна"), 4, "Кузнецова Ольга Игоревна", ["ВИШ-14-24"]);
    const t = new TeacherService({} as PortalClient, repo, {} as ScheduleService, 32);
    expect(await t.byId(4)).toEqual({ id: 4, name: "Кузнецова Ольга Игоревна" });
    expect(await t.byId(9)).toBeNull();
  });

  it("тёзки, подошедшие так же точно, — кнопками под карточкой", () => {
    const h = (name: string, vish: boolean): PersonHit => ({ ref: { kind: "teacher", id: name.length }, role: "teacher", name, fuzzy: false, score: 10, vish });
    const hits = [h("Петров Кирилл Юрьевич", true), h("Петров Кирилл Борисович", false), { ...h("Петров Константин", false), score: 7 }];
    const chosen = clearHit(hits)!;
    expect(tiedWith(hits, chosen).map((x) => x.name)).toEqual(["Петров Кирилл Борисович"]);
  });

  it("выключал режим ещё до метки (ФИО есть, режима нет) — /start его не включает", async () => {
    const deps = makeDeps();
    deps.repo.touchUser(7, "petrova_as", "U");
    deps.repo.updateUser(7, { teacherName: "Петрова Анна Сергеевна", teacherMode: false });
    expect(all(await run(text("/start"), deps, { username: "petrova_as" }))).toMatch(/выбери свою группу/);
    expect(deps.repo.getUser(7)!.teacherMode).toBe(false);
  });

  it("«усиленная анонимность» — бот не связывает аккаунт с реестром", async () => {
    const deps = makeDeps();
    deps.repo.touchUser(7, "petrova_as", "U");
    deps.repo.updateUser(7, { anon: true });
    expect(all(await run(text("/start"), deps, { username: "petrova_as" }))).toMatch(/выбери свою группу/);
    expect(deps.repo.getUser(7)!.teacherMode).toBe(false);
  });

  it("не нашёлся при первом /start — ищется снова, когда он открывает свои пары", async () => {
    const deps = makeDeps();
    deps.repo.replaceWebinars(today, []);
    await run(text("/start"), deps, { username: "petrova_as" });
    expect(deps.repo.getUser(7)).toMatchObject({ teacherMode: true, teacherRef: null });
    deps.repo.replaceWebinars(today, [{ date: today, slot: 1, start: 0, end: 23 * 60 + 59, subject: "Программирование", type: "лб", teacher: "Петрова Анна Сергеевна", position: null, degree: null, subgroup: null, title: null, groups: ["ВИШ-12-23"], scheduled: true }]);
    // Как после очередного опроса страницы вебинаров: сервис читает свежие строки.
    deps.webinars = new WebinarService({} as PortalClient, deps.repo, 32);
    expect(all(await run(text(BTN.today), deps, { username: "petrova_as" }))).toContain("Программирование");
    expect(deps.repo.getUser(7)!.teacherRef).toMatch(/^w/);
  });

  it("онбординг преподавателя: без рассылки изменений группы, дальше — его день", async () => {
    const deps = makeDeps();
    deps.repo.touchUser(7, "petrova_as", "U");
    deps.repo.updateUser(7, { groupKey: group.key, notifyChanges: false });
    await run(text("/start"), deps, { username: "petrova_as" });
    const out = all(await run(press("ob:on"), deps, { username: "petrova_as" }));
    expect(deps.repo.getUser(7)).toMatchObject({ notifyChanges: false, remindFirstMin: 120 });
    expect(out).toContain("Программирование");
    // И в рассылку изменений по старой группе он не попадает.
    deps.repo.updateUser(7, { notifyChanges: true });
    expect(deps.repo.usersForGroupChanges(group.key, false).map((u) => u.id)).not.toContain(7);
  });

  it("выбор себя из тёзок: двойной тап — одно приветствие", async () => {
    const deps = makeDeps();
    deps.repo.touchUser(7, "petrova_as", "U");
    deps.repo.updateUser(7, { teacherName: "Петрова Анна Сергеевна" });
    deps.repo.setMeta("tmode:welcome:7", "1");
    const { webinarNameKey } = await import("../src/people/ref.js");
    const data = `tmode:w${webinarNameKey("Петрова Анна Сергеевна")}`;
    const first = all(await run(press(data), deps, { username: "petrova_as" }));
    const second = await run(press(data), deps, { username: "petrova_as" });
    expect(first).toContain("Рад вас видеть");
    expect(second.filter((c) => c.method === "sendMessage")).toHaveLength(0);
    expect(deps.repo.getMeta("tmode:welcome:7")).toBe("");
  });

  it("/soon стирает и метки режима преподавателя", () => {
    const deps = makeDeps();
    deps.repo.touchUser(7, "u", "U");
    deps.repo.setMeta("tmode:off:7", "1");
    deps.repo.setMeta("tmode:welcome:7", "1");
    deps.repo.forgetUser(7);
    expect(deps.repo.getMeta("tmode:off:7")).toBeNull();
    expect(deps.repo.getMeta("tmode:welcome:7")).toBeNull();
  });
});

describe("правки по ревью всего src и записывалки", () => {
  const press = (data: string): Update => ({ update_id: 6, callback_query: { id: "2", from: { id: 7, is_bot: false, first_name: "U" }, chat_instance: "1", data, message: { message_id: 12, date: 0, chat: { id: 7, type: "private", first_name: "U" }, text: "x" } as never } });
  const lesson = (teacher: string) => ({ date: today, slot: 2, start: 0, end: 23 * 60 + 59, subject: "Физкультура", type: "пр", teacher, position: null, degree: null, subgroup: null, title: null, groups: ["ВИШ-12-23"], scheduled: true });
  const markups = (calls: Call[]): string => JSON.stringify(calls.map((c) => c.payload.reply_markup ?? null));

  function withKirill(extra: string[] = []): Deps {
    const deps = makeDeps();
    deps.repo.replaceWebinars(today, [lesson("Смирнов Кирилл Андреевич"), ...extra.map(lesson)]);
    deps.webinars = new WebinarService({} as PortalClient, deps.repo, 32);
    return deps;
  }

  it("«Кирилл Ершов» — карточка, а не расписание первого попавшегося Кирилла", async () => {
    const deps = withKirill();
    const calls = await run(text("/search Кирилл Ершов"), deps);
    expect(all(calls)).toContain("Кирилл Ершов");
    expect(all(calls) + markups(calls)).not.toContain("Смирнов");
    const { runPeopleSearch } = await import("../src/bot/people.js");
    const ctxCalls: Call[] = [];
    const api = new Api("123:FAKE");
    api.config.use(async (_prev, method, payload) => {
      ctxCalls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
    });
    const ctx = new Context(text("x"), api, ME) as BotContext;
    ctx.deps = deps;
    ctx.user = deps.repo.touchUser(7, "u", "U");
    ctx.isAdmin = false;
    await runPeopleSearch(ctx, "Кирилл Ершов", "teacher");
    expect(all(ctxCalls) + markups(ctxCalls)).not.toContain("Смирнов");
    const inline = await buildPeopleResults(deps, parseInlineQuery(deps, "Кирилл Ершов", null), null);
    expect(inline[0]!.id).toBe("p:ershov");
    expect(JSON.stringify(inline)).not.toContain("Смирнов");
  });

  it("настоящий однофамилец Ершов после карточки всё-таки находится", async () => {
    const deps = withKirill(["Ершов Пётр Ильич"]);
    const calls = await run(text("/search Кирилл Ершов"), deps);
    expect(all(calls)).toContain("однофамильцы");
    expect(markups(calls)).toContain("Ершов Пётр Ильич");
    expect(markups(calls)).not.toContain("Смирнов");
  });

  it("выбор себя из тёзок в /prepod не считается «выключил сам»: /start встречает", async () => {
    const deps = makeDeps();
    // Два полных тёзки в справочнике, ни один не отмечен как ВИШ — нужен выбор.
    const twins = [1, 2].map((id) => ({ ref: { id, name: "Петрова Анна Сергеевна" }, fuzzy: false, score: 10 }));
    deps.teachers = { searchScored: async () => twins, searchLocal: () => twins, ensureMapped: async () => undefined } as unknown as Deps["teachers"];
    const chooser = await run(text("/prepod"), deps, { username: "petrova_as" });
    expect(all(chooser)).toMatch(/несколько/);
    expect(deps.repo.getUser(7)!.teacherName).toBeNull();
    expect(deps.repo.getMeta("tmode:fio:7")).toBe("Петрова Анна Сергеевна");
    // Не выбрал, пришёл позже — это не отказ от режима.
    const start = all(await run(text("/start"), deps, { username: "petrova_as" }));
    expect(start).toContain("Здравствуйте, Анна Сергеевна");
    expect(start).not.toMatch(/выбери свою группу/);
    await run(press("tmode:t2"), deps, { username: "petrova_as" });
    expect(deps.repo.getUser(7)).toMatchObject({ teacherMode: true, teacherName: "Петрова Анна Сергеевна", teacherRef: "t2" });
    expect(deps.repo.getMeta("tmode:fio:7")).toBe("");
  });

  it("тёзки под карточкой не пропадают, когда листают дни того же человека", async () => {
    const deps = withKirill(["Смирнов Кирилл Олегович"]);
    const { webinarNameKey } = await import("../src/people/ref.js");
    const a = { kind: "webinar" as const, key: webinarNameKey("Смирнов Кирилл Андреевич") };
    const b = { kind: "webinar" as const, key: webinarNameKey("Смирнов Кирилл Олегович") };
    const other: PersonHit = { ref: b, role: "teacher", name: "Смирнов Кирилл Олегович", fuzzy: false, score: 10, vish: true, webinarOnly: true };
    const calls: Call[] = [];
    const api = new Api("123:FAKE");
    api.config.use(async (_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
    });
    const ctx = new Context(text("x"), api, ME) as BotContext;
    ctx.deps = deps;
    ctx.user = deps.repo.touchUser(7, "u", "U");
    ctx.isAdmin = false;
    await showPerson(ctx, a, today, { others: [other] });
    expect(markups(calls)).toContain(`ppo:w${b.key}`);
    // Стрелка «день вперёд» перерисовывает карточку — тёзка остаётся.
    const next = await run(press(`pp:w${a.key}:${today}`), deps);
    expect(markups(next)).toContain(`ppo:w${b.key}`);
    // Открыли другого человека заново — чужой список к нему не прилипает.
    const fresh = await run(press(`ppo:w${b.key}`), deps);
    expect(markups(fresh)).not.toContain("ppo:");
  });

  it("пары по датам раскладываются одним проходом и в исходном порядке", async () => {
    const { groupByDate } = await import("../src/people/profile.js");
    const o = (date: string, slot: number) => ({ date, slot }) as never;
    const byDate = groupByDate([o("2026-09-21", 1), o("2026-09-22", 1), o("2026-09-21", 3)]);
    expect([...byDate.keys()]).toEqual(["2026-09-21", "2026-09-22"]);
    expect(byDate.get("2026-09-21")!.map((x: { slot: number }) => x.slot)).toEqual([1, 3]);
  });
});
