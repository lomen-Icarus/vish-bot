import { afterAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { loadConfig } from "../src/config.js";
import { CalendarPush } from "../src/calendar/push.js";
import { YandexCalendarClient, parseCalendars } from "../src/calendar/yandex.js";
import { createHttpServer } from "../src/http/server.js";
import { oauthResultPage } from "../src/http/sitePages.js";
import { icsUid } from "../src/schedule/ics.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import { addDays, todayMsk } from "../src/time.js";

const ENV = { BOT_TOKEN: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", YANDEX_CLIENT_ID: "ycid", YANDEX_CLIENT_SECRET: "ysecret", ADMIN_IDS: "7" };
const g = (n: number): LogicalGroup => ({ key: `виш-${n}-23`, title: `ВИШ-${n}-23`, prefix: "ВИШ", number: n, intake: 23, course: 4, portalIds: [n], portalNames: [] });
const GROUPS = [g(11)];
const day = (n: number) => addDays(todayMsk(), n);

function lesson(date: string, subject: string, extra: Partial<Occurrence> = {}): Occurrence {
  return { groupKey: "виш-11-23", period: 1, date, slot: 2, start: 9 * 60 + 50, end: 11 * 60 + 10, subject, type: "лк", room: "Т-310", teacher: null, subgroup: null, isDistance: false, status: "scheduled", sources: [], ...extra };
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

const HOME = "/calendars/student@yandex.ru/";

/** Поддельный Яндекс: OAuth и CalDAV в памяти. mkcalendar=false — как Яндекс, который не даёт создать календарь. */
class FakeYandex {
  mkcalendar = true;
  revoked = false;
  revokeCalls = 0;
  calendars = new Map<string, { name: string; events: Map<string, string> }>();
  calls: string[] = [];

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    const res = (status: number, body = "") => new Response(status === 204 ? null : body, { status });
    if (url.host === "oauth.yandex.ru") {
      const form = new URLSearchParams(String(init?.body));
      if (form.get("client_secret") !== "ysecret") return res(400, '{"error":"invalid_client"}');
      if (url.pathname === "/revoke_token") {
        this.revokeCalls++;
        return res(200, "{}");
      }
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "good") return res(400, '{"error":"invalid_grant"}');
        this.revoked = false;
        return res(200, JSON.stringify({ access_token: "ya1", refresh_token: "y-refresh-secret", expires_in: 31536000, token_type: "bearer" }));
      }
      if (this.revoked) return res(400, '{"error":"invalid_grant"}');
      return res(200, JSON.stringify({ access_token: "ya2", refresh_token: "y-refresh-secret", expires_in: 31536000 }));
    }
    if ((init?.headers as Record<string, string>)?.Authorization?.startsWith("OAuth ya") !== true) return res(401);
    const path = decodeURIComponent(url.pathname);
    if (method === "PROPFIND" && path === "/") return res(207, `<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:current-user-principal><d:href>/principals/users/student@yandex.ru/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>`);
    if (method === "PROPFIND" && path.startsWith("/principals/")) return res(207, `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:propstat><D:prop><C:calendar-home-set><D:href>${HOME}</D:href></C:calendar-home-set></D:prop></D:propstat></D:response></D:multistatus>`);
    if (method === "PROPFIND" && path === HOME) {
      const items = [...this.calendars].map(([href, c]) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:displayname>${c.name}</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response>`).join("");
      return res(207, `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>${HOME}</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>${items}</d:multistatus>`);
    }
    if (method === "MKCALENDAR") {
      if (!this.mkcalendar) return res(501);
      const name = /<d:displayname>([^<]*)</.exec(String(init?.body))?.[1] ?? "";
      this.calendars.set(path, { name, events: new Map() });
      return res(201);
    }
    const calHref = [...this.calendars.keys()].find((h) => path.startsWith(h));
    if (method === "PROPFIND") return res(calHref && path === calHref ? 207 : 404, "<d:multistatus xmlns:d=\"DAV:\"/>");
    if (method === "PROPPATCH" && calHref) {
      this.calendars.get(calHref)!.name = /<d:displayname>([^<]*)</.exec(String(init?.body))?.[1] ?? "";
      return res(207);
    }
    if (!calHref) return res(404);
    const file = path.slice(calHref.length);
    const cal = this.calendars.get(calHref)!;
    if (method === "PUT") {
      const existed = cal.events.has(file);
      cal.events.set(file, String(init?.body));
      return res(existed ? 204 : 201);
    }
    if (method === "DELETE") return res(cal.events.delete(file) ? 204 : 404);
    return res(400);
  };

  summaries(): string[] {
    return [...this.calendars.values()].flatMap((c) => [...c.events.values()]).map((ics) => /SUMMARY:([^\r\n]+)/.exec(ics)?.[1] ?? "").sort();
  }
}

function setup(lessons: Occurrence[]) {
  const repo = new Repo(openDatabase(":memory:"));
  const fake = new FakeYandex();
  const notes: string[] = [];
  const service = makeService(lessons);
  const push = new CalendarPush(
    { repo, service, config: loadConfig(ENV), notify: async (_u, text) => void notes.push(text) },
    null,
    new YandexCalendarClient({ clientId: "ycid", clientSecret: "ysecret", redirectUri: "https://calendar.secretvish.ru/oauth/yandex" }, fake.fetch as typeof fetch),
  );
  repo.touchUser(7, "s", "S");
  repo.updateUser(7, { groupKey: "виш-11-23", calAlarmMin: 10 });
  return { repo, fake, notes, push, service };
}

async function connect(push: CalendarPush, code = "good") {
  const url = new URL(push.connectUrl(7, "yandex")!);
  return { url, res: await push.finishConnect(url.searchParams.get("state")!, code, null, "yandex") };
}

describe("прямая запись в Яндекс", () => {
  it("вход: oauth.yandex.ru с меткой и выбором аккаунта; календарь создаётся по CalDAV; пары ставятся файлами .ics со своим UID; повтор — без запросов", async () => {
    const lessons = [lesson(day(1), "Физика"), lesson(day(2), "Химия")];
    const { push, repo, fake } = setup(lessons);
    const { url, res } = await connect(push);
    expect(url.origin + url.pathname).toBe("https://oauth.yandex.ru/authorize");
    expect(url.searchParams.get("force_confirm")).toBe("yes");
    expect(url.searchParams.get("redirect_uri")).toBe("https://calendar.secretvish.ru/oauth/yandex");
    expect(res).toEqual({ ok: true, calendarName: "ВИШ-11-23", reused: false });
    const link = repo.calLink(7, "yandex")!;
    expect(link.calendarId).toMatch(/^\/calendars\/student@yandex\.ru\/vish-[0-9a-f]{12}\/$/);
    expect(link.tokenEnc).not.toContain("y-refresh-secret");
    await push.tick();
    expect(fake.summaries()).toEqual(["Физика (ЛК)", "Химия (ЛК)"]);
    const ics = [...fake.calendars.get(link.calendarId!)!.events.values()][0]!;
    expect(ics).toContain("TRIGGER:-PT10M");
    expect(ics).not.toContain(`UID:${icsUid(lessons[0]!)}`);
    fake.calls = [];
    await push.tick();
    expect(fake.calls.filter((c) => c.startsWith("PUT") || c.startsWith("DELETE"))).toEqual([]);
    lessons.splice(1, 1);
    lessons[0]!.room = "Г-101";
    await push.tick();
    expect(fake.summaries()).toEqual(["Физика (ЛК)"]);
    expect([...fake.calendars.get(link.calendarId!)!.events.values()][0]).toContain("Г-101");
  });

  it("Яндекс не даёт создать календарь — просьба создать его самому; создал — бот находит по названию", async () => {
    const { push, repo, fake } = setup([lesson(day(1), "Физика")]);
    fake.mkcalendar = false;
    expect((await connect(push)).res).toEqual({ ok: false, reason: "need_calendar", calendarName: "ВИШ-11-23" });
    expect(repo.calLink(7, "yandex")).toBeNull();
    expect(oauthResultPage({ ok: false, reason: "need_calendar", calendarName: "ВИШ-11-23" }, "Яндекс Календарь")).toContain("назови его «ВИШ-11-23»");
    fake.calendars.set(`${HOME}personal/`, { name: "Личное", events: new Map() });
    fake.calendars.set(`${HOME}abc123/`, { name: "ВИШ-11-23", events: new Map() });
    expect((await connect(push)).res).toEqual({ ok: true, calendarName: "ВИШ-11-23", reused: false });
    expect(repo.calLink(7, "yandex")!.calendarId).toBe(`${HOME}abc123/`);
    await push.tick();
    expect(fake.calendars.get(`${HOME}abc123/`)!.events.size).toBe(1);
    expect(fake.calendars.get(`${HOME}personal/`)!.events.size).toBe(0);
  });

  it("доступ отозван — запись остановлена, одно сообщение про Яндекс; календарь удалён — тоже; отключение отзывает токен", async () => {
    const { push, repo, fake, notes } = setup([lesson(day(1), "Физика")]);
    await connect(push);
    await push.tick();
    const cal = repo.calLink(7, "yandex")!.calendarId!;
    fake.calendars.delete(cal);
    repo.updateUser(7, { calAlarmMin: 20 });
    await push.tick();
    expect(repo.calLink(7, "yandex")!.status).toBe("gone");
    expect(notes.at(-1)).toContain("удалён из Яндекса");

    await connect(push);
    await push.tick();
    await push.disconnect(7, "yandex");
    expect(repo.calLink(7, "yandex")).toMatchObject({ status: "off", tokenEnc: null });
    expect(fake.revokeCalls).toBe(1);
  });

  it("старая подписка у подключившего пустеет только для Яндекса; /oauth/yandex — страница результата", async () => {
    const { push, repo, service } = setup([lesson(day(1), "Физика")]);
    const token = repo.ensureCalToken(7);
    const server: Server = createHttpServer({ repo, service, port: 0, host: "127.0.0.1", calendarPush: push });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const state = new URL(push.connectUrl(7, "yandex")!).searchParams.get("state")!;
    const page = await fetch(`http://127.0.0.1:${port}/oauth/yandex?state=${state}&code=good`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Яндекс Календарь подключён");
    const feed = (ua: string) => fetch(`http://127.0.0.1:${port}/cal/${token}.ics`, { headers: { "user-agent": ua } }).then((r) => r.text());
    expect(await feed("Mozilla/5.0 (compatible; YandexCalendar/1.0)")).not.toContain("BEGIN:VEVENT");
    expect(await feed("Google-Calendar-Importer")).toContain("Физика");
  });

  it("без ключей Яндекса кнопки нет; разбор списка календарей", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const p = new CalendarPush({ repo, service: makeService([]), config: loadConfig({ BOT_TOKEN: ENV.BOT_TOKEN, ADMIN_IDS: "7" }), notify: async () => undefined });
    expect(p.allowed(7, "yandex")).toBe(false);
    expect(parseCalendars(`<D:multistatus xmlns:D="DAV:"><D:response><D:href>/c/a/</D:href><D:propstat><D:prop><D:displayname>A &amp; B</D:displayname><D:resourcetype><D:collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></D:resourcetype></D:prop></D:propstat></D:response><D:response><D:href>/c/</D:href></D:response></D:multistatus>`)).toEqual([{ href: "/c/a/", name: "A & B" }]);
  });
});

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));
