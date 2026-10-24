import { afterAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { loadConfig } from "../src/config.js";
import { CalendarPush, OPS_PER_USER, googleEvent, googleEventId } from "../src/calendar/push.js";
import { GOOGLE_SCOPE, GoogleCalendarClient } from "../src/calendar/google.js";
import { seal, tokenKey, unseal } from "../src/calendar/secret.js";
import { createHttpServer } from "../src/http/server.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import { addDays, todayMsk } from "../src/time.js";

const ENV = { BOT_TOKEN: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret", ADMIN_IDS: "7" };
const g = (n: number): LogicalGroup => ({ key: `виш-${n}-23`, title: `ВИШ-${n}-23`, prefix: "ВИШ", number: n, intake: 23, course: 4, portalIds: [n], portalNames: [] });
const GROUPS = [g(11), g(12)];
const today = todayMsk();

function lesson(groupKey: string, date: string, subject: string, extra: Partial<Occurrence> = {}): Occurrence {
  return { groupKey, period: 1, date, slot: 2, start: 9 * 60 + 50, end: 11 * 60 + 10, subject, type: "лк", room: "Т-310", teacher: "Иванов И. И.", subgroup: null, isDistance: false, status: "scheduled", sources: [], ...extra };
}

function makeService(lessons: Occurrence[]): ScheduleService {
  return {
    ppaLessons: () => [],
    group: (key: string) => GROUPS.find((x) => x.key === key) ?? null,
    groups: () => GROUPS,
    materialize: (grp: LogicalGroup, from: string, to: string) => lessons.filter((l) => l.groupKey === grp.key && l.date >= from && l.date <= to),
    semesterFor: () => 1 as const,
    weekOneMonday: () => "2026-08-31",
  } as unknown as ScheduleService;
}

/** Поддельный Google: токены, календари и события в памяти; можно «отозвать доступ», «удалить календарь», сломать ответы. */
class FakeGoogle {
  calendars = new Map<string, { summary: string; events: Map<string, { body: Record<string, unknown>; cancelled: boolean }> }>();
  revoked = false;
  revokedCalls = 0;
  calls: string[] = [];
  failNext: number[] = [];
  private seq = 0;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const json = (status: number, body: unknown) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    this.calls.push(`${method} ${url.pathname}`);
    const forced = this.failNext.shift();
    if (forced) return json(forced, { error: { errors: [{ reason: forced === 429 ? "rateLimitExceeded" : "backendError" }] } });
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("client_secret") !== "csecret") return json(401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("redirect_uri") !== "https://calendar.secretvish.ru/oauth/google") return json(400, { error: "redirect_uri_mismatch" });
        if (form.get("code") === "noscope") return json(200, { access_token: "a0", refresh_token: "r0", expires_in: 3600, scope: "openid" });
        if (form.get("code") !== "good") return json(400, { error: "invalid_grant" });
        this.revoked = false;
        return json(200, { access_token: "a1", refresh_token: "refresh-secret-1", expires_in: 3600, scope: GOOGLE_SCOPE });
      }
      if (this.revoked) return json(400, { error: "invalid_grant" });
      return json(200, { access_token: `a${++this.seq}`, expires_in: 3600 });
    }
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/revoke") {
      this.revokedCalls++;
      this.revoked = true;
      return json(200, {});
    }
    if (!String((init?.headers as Record<string, string>)?.Authorization ?? "").startsWith("Bearer a")) return json(401, { error: { status: "UNAUTHENTICATED" } });
    const m = /^\/calendar\/v3\/calendars(?:\/([^/]+))?(?:\/events(?:\/([^/]+))?)?$/.exec(url.pathname);
    if (!m) return json(404, null);
    const [, calId, eventId] = m;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (!calId) {
      const id = `cal${this.calendars.size + 1}@group.calendar.google.com`;
      this.calendars.set(id, { summary: String(body.summary), events: new Map() });
      return json(200, { id });
    }
    const cal = this.calendars.get(decodeURIComponent(calId));
    if (!cal) return json(404, { error: { errors: [{ reason: "notFound" }] } });
    if (!url.pathname.includes("/events")) {
      if (method === "PATCH") cal.summary = String(body.summary);
      return json(200, { summary: cal.summary });
    }
    if (method === "POST") {
      const id = String(body.id);
      if (cal.events.has(id)) return json(409, { error: { errors: [{ reason: "duplicate" }] } });
      cal.events.set(id, { body, cancelled: false });
      return json(200, { id });
    }
    const ev = cal.events.get(eventId!);
    if (method === "PUT") {
      if (!ev) return json(404, { error: { errors: [{ reason: "notFound" }] } });
      cal.events.set(eventId!, { body, cancelled: false });
      return json(200, { id: eventId });
    }
    if (method === "DELETE") {
      if (!ev || ev.cancelled) return json(410, { error: { errors: [{ reason: "deleted" }] } });
      ev.cancelled = true;
      return json(204, null);
    }
    return json(400, null);
  };

  live(calId: string): string[] {
    return [...(this.calendars.get(calId)?.events.values() ?? [])].filter((e) => !e.cancelled).map((e) => String(e.body.summary)).sort();
  }
}

function setup(lessons: Occurrence[], env: Record<string, string> = {}) {
  const repo = new Repo(openDatabase(":memory:"));
  const config = loadConfig({ ...ENV, ...env });
  const fake = new FakeGoogle();
  const notes: Array<{ userId: number; text: string }> = [];
  const service = makeService(lessons);
  const make = () =>
    new CalendarPush(
      { repo, service, config, notify: async (userId, text) => void notes.push({ userId, text }) },
      new GoogleCalendarClient({ clientId: "cid", clientSecret: "csecret", redirectUri: "https://calendar.secretvish.ru/oauth/google" }, fake.fetch as typeof fetch),
    );
  repo.touchUser(7, "s", "S");
  repo.updateUser(7, { groupKey: "виш-11-23", subgroup: 1, calAlarmMin: 15 });
  return { repo, config, fake, notes, service, make, push: make() };
}

async function connect(push: CalendarPush, userId = 7, code = "good") {
  const url = new URL(push.connectUrl(userId)!);
  return { url, res: await push.finishConnect(url.searchParams.get("state")!, code, null) };
}

describe("прямая запись в Google: вход", () => {
  it("ссылка на вход — одно право, offline, метка; возврат создаёт календарь группы; токен в базе зашифрован; метка одноразовая", async () => {
    const { push, repo, fake } = setup([]);
    const { url, res } = await connect(push);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toBe("https://calendar.secretvish.ru/oauth/google");
    expect(res).toEqual({ ok: true, calendarName: "ВИШ-11-23", reused: false });
    const link = repo.calLink(7, "google")!;
    expect(link).toMatchObject({ status: "ok", groupKey: "виш-11-23", calendarId: "cal1@group.calendar.google.com" });
    expect(link.tokenEnc).not.toContain("refresh-secret-1");
    expect([...fake.calendars.values()][0]!.summary).toBe("ВИШ-11-23");
    expect(await push.finishConnect(url.searchParams.get("state")!, "good", null)).toEqual({ ok: false, reason: "expired" });
  });

  it("отказ, чужая метка, нет права на календарь, нет группы — понятная причина, ничего не сохранено", async () => {
    const { push, repo } = setup([]);
    expect(await push.finishConnect("чужая", "good", null)).toEqual({ ok: false, reason: "expired" });
    let u = new URL(push.connectUrl(7)!);
    expect(await push.finishConnect(u.searchParams.get("state")!, null, "access_denied")).toEqual({ ok: false, reason: "denied" });
    u = new URL(push.connectUrl(7)!);
    expect(await push.finishConnect(u.searchParams.get("state")!, "noscope", null)).toEqual({ ok: false, reason: "scope" });
    repo.updateUser(7, { groupKey: null });
    u = new URL(push.connectUrl(7)!);
    expect(await push.finishConnect(u.searchParams.get("state")!, "good", null)).toEqual({ ok: false, reason: "no_group" });
    expect(repo.calLink(7, "google")).toBeNull();
  });

  it("кнопка видна: admins — только админам; all — всем; off или нет ключей — никому", () => {
    expect(setup([]).push.allowed(7)).toBe(true);
    expect(setup([]).push.allowed(8)).toBe(false);
    expect(setup([], { CAL_PUSH: "all" }).push.allowed(8)).toBe(true);
    expect(setup([], { CAL_PUSH: "off" }).push.allowed(7)).toBe(false);
    const repo = new Repo(openDatabase(":memory:"));
    const noKeys = new CalendarPush({ repo, service: makeService([]), config: loadConfig({ BOT_TOKEN: ENV.BOT_TOKEN, ADMIN_IDS: "7" }), notify: async () => undefined });
    expect(noKeys.google).toBeNull();
    expect(noKeys.allowed(7)).toBe(false);
  });
});

describe("прямая запись в Google: сверка", () => {
  const day = (n: number) => addDays(today, n);

  it("ставит пары своей подгруппы, меняет изменённые, убирает исчезнувшие; прошедшие не трогает; повтор — без запросов", async () => {
    const lessons = [
      lesson("виш-11-23", day(1), "Физика"),
      lesson("виш-11-23", day(2), "Химия", { subgroup: 1 }),
      lesson("виш-11-23", day(2), "Чужая подгруппа", { subgroup: 2 }),
      lesson("виш-11-23", day(3), "Перенесённая", { status: "moved" }),
      lesson("виш-12-23", day(1), "Чужая группа"),
    ];
    const { push, repo, fake } = setup(lessons);
    await connect(push);
    await push.tick();
    const cal = repo.calLink(7, "google")!.calendarId!;
    expect(fake.live(cal)).toEqual(["Физика (ЛК)", "Химия (ЛК)"]);
    const physics = [...fake.calendars.get(cal)!.events.values()].find((e) => String(e.body.summary).startsWith("Физика"))!.body;
    expect(physics).toMatchObject({ location: "ауд. Т-310, ЧувГУ", start: { dateTime: `${day(1)}T09:50:00`, timeZone: "Europe/Moscow" }, reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 15 }] } });
    expect(String(physics.description)).toContain("Иванов И. И.");

    // Пара, которая уже прошла (поставлена раньше), остаётся как история.
    repo.putCalEvent(7, "google", { uid: "past", eventId: "pastevent", hash: "h", date: day(-1) });

    fake.calls = [];
    await push.tick();
    expect(fake.calls.filter((c) => c.includes("/events"))).toEqual([]);

    lessons[0]!.room = "Г-101";
    lessons.splice(1, 1);
    await push.tick();
    expect(fake.live(cal)).toEqual(["Физика (ЛК)"]);
    expect(JSON.stringify([...fake.calendars.get(cal)!.events.values()].find((e) => !e.cancelled)!.body)).toContain("Г-101");
    expect(repo.calEvents(7, "google").map((e) => e.uid)).toContain("past");
  });

  it("сбой посреди записи и перезапуск бота — без дублей (id события из uid пары)", async () => {
    const { push, repo, fake, make } = setup([lesson("виш-11-23", day(1), "Физика"), lesson("виш-11-23", day(2), "Химия")]);
    await connect(push);
    await push.tick();
    const cal = repo.calLink(7, "google")!.calendarId!;
    // Google событие поставил, а запись в базу «не успела».
    for (const e of repo.calEvents(7, "google")) repo.dropCalEvent(7, "google", e.uid);
    await make().tick();
    expect(fake.live(cal)).toEqual(["Физика (ЛК)", "Химия (ЛК)"]);
    expect(fake.calendars.get(cal)!.events.size).toBe(2);
    expect(repo.calEvents(7, "google")).toHaveLength(2);
    expect(googleEventId("x")).toMatch(/^[0-9a-f]{40}$/);
  });

  it("лимиты Google — повтор на следующем проходе; первая загрузка — порциями", async () => {
    const lessons: Occurrence[] = [];
    const { push, repo, fake } = setup(lessons);
    await connect(push);
    await push.tick();
    for (let i = 0; i < OPS_PER_USER + 30; i++) lessons.push(lesson("виш-11-23", day(1 + Math.floor(i / 6)), `Пара ${i}`, { slot: (i % 6) + 1, start: 480 + (i % 6) * 100, end: 560 + (i % 6) * 100 }));
    const link = () => repo.calLink(7, "google")!;
    fake.failNext = [429];
    await expect(push.syncUser(link(), OPS_PER_USER)).rejects.toMatchObject({ kind: "retry" });
    expect(repo.calEvents(7, "google")).toHaveLength(0);
    expect(link()).toMatchObject({ status: "ok", error: "rateLimitExceeded" });
    expect(await push.syncUser(link(), OPS_PER_USER)).toBe(OPS_PER_USER);
    expect(repo.calEvents(7, "google")).toHaveLength(OPS_PER_USER);
    expect(await push.syncUser(link(), OPS_PER_USER)).toBe(30);
    expect(repo.calEvents(7, "google")).toHaveLength(OPS_PER_USER + 30);
    expect(link().error).toBeNull();
  });

  it("доступ отозван — запись останавливается, человеку одно сообщение; отключение и повторное подключение — тот же календарь, без дублей", async () => {
    const { push, repo, fake, notes, make } = setup([lesson("виш-11-23", day(1), "Физика")]);
    await connect(push);
    await push.tick();
    const cal = repo.calLink(7, "google")!.calendarId!;
    fake.revoked = true;
    const fresh = make();
    repo.updateUser(7, { calAlarmMin: 30 });
    await fresh.tick();
    expect(repo.calLink(7, "google")).toMatchObject({ status: "revoked", tokenEnc: null });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain("доступ к Google Календарю отозван");
    await fresh.tick();
    expect(notes).toHaveLength(1);

    const again = await connect(fresh);
    expect(again.res).toEqual({ ok: true, calendarName: "ВИШ-11-23", reused: true });
    await fresh.tick();
    expect(fake.calendars.size).toBe(1);
    expect(fake.live(cal)).toEqual(["Физика (ЛК)"]);

    await fresh.disconnect(7);
    expect(repo.calLink(7, "google")).toMatchObject({ status: "off", tokenEnc: null });
    expect(fake.revokedCalls).toBe(1);
  });

  it("календарь удалили в Google — запись останавливается; сменил группу — календарь переименован, пары другие", async () => {
    const { push, repo, fake, notes } = setup([lesson("виш-11-23", day(1), "Физика"), lesson("виш-12-23", day(1), "Экономика")]);
    await connect(push);
    await push.tick();
    const cal = repo.calLink(7, "google")!.calendarId!;
    repo.updateUser(7, { groupKey: "виш-12-23" });
    await push.tick();
    expect(fake.calendars.get(cal)!.summary).toBe("ВИШ-12-23");
    expect(fake.live(cal)).toEqual(["Экономика (ЛК)"]);
    fake.calendars.delete(cal);
    repo.updateUser(7, { calAlarmMin: 5 });
    await push.tick();
    expect(repo.calLink(7, "google")!.status).toBe("gone");
    expect(notes.at(-1)!.text).toContain("календарь «ВИШ-12-23» удалён из Google");
  });

  it("событие: дистанционная пара без аудитории; без напоминания — без всплывашек", () => {
    const ev = googleEvent(lesson("g", "2026-10-26", "Физика", { isDistance: true, start: 8 * 60 + 20, end: 9 * 60 + 40 }), "ВИШ-11-23", null);
    expect(ev.location).toBeUndefined();
    expect(ev.start).toEqual({ dateTime: "2026-10-26T08:20:00", timeZone: "Europe/Moscow" });
    expect(ev.end.dateTime).toBe("2026-10-26T09:40:00");
    expect(ev.reminders).toEqual({ useDefault: false });
    expect(ev.description).toContain("дистанционно");
  });
});

describe("прямая запись в Google: шифрование и сайт", () => {
  let server: Server | null = null;
  afterAll(() => server?.close());

  it("токен: свой ключ — читается, чужой — нет; CAL_TOKEN_KEY в hex и base64", () => {
    const k = tokenKey({ BOT_TOKEN: ENV.BOT_TOKEN });
    expect(unseal(k, seal(k, "секрет"))).toBe("секрет");
    expect(() => unseal(tokenKey({ BOT_TOKEN: "999:другой-токен-бота-длинный" }), seal(k, "секрет"))).toThrow();
    const hex = "ab".repeat(32);
    expect(tokenKey({ BOT_TOKEN: ENV.BOT_TOKEN, CAL_TOKEN_KEY: hex })).toEqual(Buffer.from(hex, "hex"));
    expect(tokenKey({ BOT_TOKEN: ENV.BOT_TOKEN, CAL_TOKEN_KEY: Buffer.alloc(32, 1).toString("base64") })).toEqual(Buffer.alloc(32, 1));
    expect(() => tokenKey({ BOT_TOKEN: ENV.BOT_TOKEN, CAL_TOKEN_KEY: "коротко" })).toThrow();
  });

  it("/oauth/google — страница результата; старая подписка у подключившего пустеет только для Google", async () => {
    const { push, repo, service } = setup([lesson("виш-11-23", addDays(today, 1), "Физика")]);
    const token = repo.ensureCalToken(7);
    server = createHttpServer({ repo, service, port: 0, host: "127.0.0.1", calendarPush: push });
    await new Promise<void>((resolve) => server!.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const state = new URL(push.connectUrl(7)!).searchParams.get("state")!;
    const ok = await fetch(`http://127.0.0.1:${port}/oauth/google?state=${state}&code=good`);
    expect(ok.status).toBe(200);
    const okHtml = await ok.text();
    expect(okHtml).toContain("Google Календарь подключён");
    expect(okHtml).not.toContain("refresh-secret-1");
    const stale = await fetch(`http://127.0.0.1:${port}/oauth/google?state=${state}&code=good`);
    expect(stale.status).toBe(400);
    expect(await stale.text()).toContain("Ссылка устарела");
    const feed = (ua: string) => fetch(`http://127.0.0.1:${port}/cal/${token}.ics`, { headers: { "user-agent": ua } }).then((r) => r.text());
    const google = await feed("Google-Calendar-Importer");
    expect(google).not.toContain("BEGIN:VEVENT");
    expect(google).toContain("старая подписка");
    expect(await feed("iOS/18.1 (22B83) dataaccessd/1.0")).toContain("Физика");
    await push.disconnect(7);
    expect(await feed("Google-Calendar-Importer")).toContain("Физика");
  });
});
