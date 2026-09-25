import { parseGroupButtons, parseGroupName, parseGroupSchedule, parseTeacherButtons, parseTeacherInfo, parseTeacherSchedule, parseWebinars, type ParsedScheduleDay } from "chuvsu-js/parsers";
import type { TeacherInfo, Webinar } from "chuvsu-js";
import { PortalHttp, PortalHttpError, type PortalHttpOptions } from "./http.js";
import { isLoginPage, parseAcademicYear, parseBanner, parsePeriod, parseWeekMarker, type WeekMarker } from "./pageMeta.js";
import type { Period } from "../schedule/model.js";
import { sha1 } from "../schedule/model.js";
import { logger } from "../logger.js";
import type { LocalDate } from "../time.js";

export const PORTAL_BASE = "https://tt.chuvsu.ru";

const ENTITIES: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&quot;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" };

/**
 * Преподаватели на странице портала: кнопки `.techbut` с `val(<id>)` (так
 * устроены список и поиск), а на всякий случай ещё кнопки `name="tech<id>"`
 * и ссылки на `/index/techtt/tech/<id>` — чтобы смена разметки не обнуляла
 * справочник.
 */
export function parseTeacherList(html: string): Array<{ id: number; name: string }> {
  const byId = new Map<number, string>();
  for (const t of parseTeacherButtons(html)) {
    const name = t.name.replace(/\s+/g, " ").trim();
    if (name) byId.set(t.id, name);
  }
  // Кнопки вида name="tech123" value="…" — так на портале устроен список аудиторий.
  for (const m of html.matchAll(/<button\b[^>]*\bname=["']tech(\d+)["'][^>]*\bvalue=["']([^"']*)["']/gi)) {
    const id = Number(m[1]);
    const name = m[2]!.replace(/\s+/g, " ").trim();
    if (name && !byId.has(id)) byId.set(id, name);
  }
  for (const m of html.matchAll(/<a\b[^>]*href=["'][^"']*\/index\/techtt\/tech\/(\d+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const id = Number(m[1]);
    const name = m[2]!.replace(/<[^>]+>/g, " ").replace(/&[#a-z0-9]+;/gi, (e) => ENTITIES[e] ?? " ").replace(/\s+/g, " ").trim();
    if (name && !byId.has(id)) byId.set(id, name);
  }
  return [...byId].map(([id, name]) => ({ id, name }));
}

export interface PortalGroup {
  id: number;
  name: string;
}

export interface GroupPage {
  groupId: number;
  period: Period;
  name: string | null;
  days: ParsedScheduleDay[];
  academicYear: number | null;
  pagePeriod: Period | null;
  weekMarker: WeekMarker | null;
  banner: string | null;
  htmlHash: string;
  /** Hash of the parsed structure (ignores irrelevant markup churn). */
  contentHash: string;
  fetchedAt: Date;
}

export class PortalAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortalAuthError";
  }
}

/**
 * Guest-mode client for tt.chuvsu.ru. Keeps one session and transparently
 * re-logs in when the portal answers with its login form.
 */
export interface PortalCredentials {
  login: string;
  password: string;
}

/** Сколько ждать, прежде чем снова пробовать учётку после падения на гостя. */
const ACCOUNT_RETRY_MS = 30 * 60_000;

export class PortalClient {
  readonly http: PortalHttp;
  private loggedIn = false;
  private loginPromise: Promise<void> | null = null;
  private readonly credentials: PortalCredentials | undefined;
  /** Учётка задана, но не сработала — сидим гостем и периодически пробуем снова. */
  private degraded = false;
  private degradedAt = 0;
  private lastError: string | null = null;

  constructor(opts: PortalHttpOptions & { credentials?: PortalCredentials } = {}) {
    this.http = new PortalHttp(opts);
    this.credentials = opts.credentials;
  }

  /** Сейчас мы правда под учёткой (а не свалились на гостя). */
  get authenticated(): boolean {
    return !!this.credentials && !this.degraded;
  }

  /** Сессия под учёткой уже открыта (а не просто учётка задана). */
  get accountSession(): boolean {
    return this.loggedIn && this.authenticated;
  }

  /** Что показывать в /health: как бот сейчас ходит на портал. */
  mode(): { mode: "guest" | "account" | "degraded"; error: string | null } {
    if (!this.credentials) return { mode: "guest", error: null };
    return this.degraded ? { mode: "degraded", error: this.lastError } : { mode: "account", error: null };
  }

  private async loginAs(useAccount: boolean): Promise<void> {
    this.http.clearCookies();
    const form: Record<string, string> = useAccount && this.credentials
      ? { wname: this.credentials.login, wpass: this.credentials.password, wauto: "1", auth: "Войти", hfac: "0", pertt: "1" }
      : { guest: "Войти гостем", hfac: "0", pertt: "1" };
    const res = await this.http.post(`${PORTAL_BASE}/auth`, form);
    if (res.status !== 302) throw new PortalAuthError(`${useAccount ? "Account" : "Guest"} login failed: HTTP ${res.status}`);
    this.loggedIn = true;
  }

  /**
   * Вход. Если учётка задана, идём под ней: только она видит преподавателей.
   * Не пустила — не падаем, а садимся гостем: расписание групп открыто всем, и
   * лучше показать его без фамилий, чем не показать вовсе. Учётку пробуем
   * снова каждые полчаса, и как только она оживёт, фамилии вернутся сами.
   */
  async login(): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const tryAccount = !!this.credentials && (!this.degraded || Date.now() - this.degradedAt > ACCOUNT_RETRY_MS);
      if (tryAccount) {
        try {
          await this.loginAs(true);
          if (this.degraded) logger.info("portal: учётка снова работает, преподаватели вернулись");
          this.degraded = false;
          this.lastError = null;
          logger.info({ mode: "account" }, "portal: session established");
          return;
        } catch (err) {
          this.degraded = true;
          this.degradedAt = Date.now();
          this.lastError = String(err).slice(0, 200);
          logger.error({ err: String(err) }, "portal: вход под учёткой не удался — работаем гостем, расписание без преподавателей");
        }
      }
      await this.loginAs(false);
      logger.info({ mode: this.credentials ? "guest (degraded)" : "guest" }, "portal: session established");
    })();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  loginAsGuest(): Promise<void> {
    return this.login();
  }

  private async ensureLogin(): Promise<void> {
    // Сидим гостем после неудачного входа под учёткой — раз в полчаса пробуем
    // её снова. Раньше повтор был только внутри login(), а login() не звался,
    // пока гостевая сессия жива: фамилии пропадали до ночной проверки.
    if (!this.loggedIn || (this.degraded && Date.now() - this.degradedAt > ACCOUNT_RETRY_MS)) await this.login();
  }

  /** POST + follow, retrying once after a fresh login if the session expired. */
  private async authPost(url: string, form: Record<string, string>): Promise<string> {
    await this.ensureLogin();
    let res = await this.http.postFollow(url, form);
    if (isLoginPage(res.body)) {
      logger.info("portal: session expired, re-authenticating");
      this.loggedIn = false;
      await this.login();
      res = await this.http.postFollow(url, form);
      if (isLoginPage(res.body)) throw new PortalAuthError("Portal keeps returning the login page");
    }
    if (res.status !== 200) throw new PortalHttpError(`HTTP ${res.status} for ${url}`, res.status);
    return res.body;
  }

  /** GET + follow with the same re-login handling. */
  private async authGet(url: string): Promise<string> {
    await this.ensureLogin();
    let res = await this.http.getFollow(url);
    if (isLoginPage(res.body)) {
      this.loggedIn = false;
      await this.login();
      res = await this.http.getFollow(url);
      if (isLoginPage(res.body)) throw new PortalAuthError("Portal keeps returning the login page");
    }
    if (res.status !== 200) throw new PortalHttpError(`HTTP ${res.status} for ${url}`, res.status);
    return res.body;
  }

  /** Откуда в последний раз взялся справочник преподавателей и почему он пуст, если пуст (для /health). */
  directorySource: string | null = null;
  directoryNote: string | null = null;

  /**
   * Справочник преподавателей (только под учёткой: гостя портал уводит на
   * главную). Живёт на /index/techfac; старый адрес /index/tech портал больше
   * не отдаёт, но остаётся запасным. Если страница просит выбрать факультет,
   * пробуем её же с факультетом бота.
   */
  async getAllTeachers(facultyId?: number): Promise<Array<{ id: number; name: string }>> {
    const attempts: Array<{ source: string; load: () => Promise<string> }> = [
      { source: "/index/techfac", load: () => this.authGet(`${PORTAL_BASE}/index/techfac`) },
      ...(facultyId ? [{ source: `/index/techfac (факультет ${facultyId})`, load: () => this.authPost(`${PORTAL_BASE}/index/techfac`, { hfac: String(facultyId), pertt: "1" }) }] : []),
      { source: "/index/tech", load: () => this.authGet(`${PORTAL_BASE}/index/tech`) },
    ];
    const notes: string[] = [];
    for (const a of attempts) {
      let html: string;
      try {
        html = await a.load();
      } catch (err) {
        // Портал всё время возвращает форму входа — дальше пробовать бессмысленно.
        if (err instanceof PortalAuthError) throw err;
        notes.push(`${a.source}: ${String(err).slice(0, 80)}`);
        continue;
      }
      const list = parseTeacherList(html);
      if (list.length) {
        this.directorySource = a.source;
        this.directoryNote = null;
        logger.info({ source: a.source, count: list.length }, "portal: teacher directory loaded");
        return list;
      }
      notes.push(`${a.source}: преподавателей нет${/class=["']?[^"'>]*facbut/.test(html) ? " (на странице выбор факультета)" : ""}`);
    }
    this.directorySource = null;
    this.directoryNote = notes.join("; ");
    logger.warn({ tried: notes }, "portal: teacher directory is empty on every known page");
    return [];
  }

  async searchTeachers(query: string): Promise<Array<{ id: number; name: string }>> {
    const html = await this.authPost(`${PORTAL_BASE}/`, { techname: query, findtech: "найти", hfac: "0", pertt: "1" });
    return parseTeacherButtons(html).map((t) => ({ id: t.id, name: t.name.trim() }));
  }

  async getTeacherPage(teacherId: number, period: Period): Promise<{ days: ParsedScheduleDay[]; info: TeacherInfo | null; weekMarker: WeekMarker | null }> {
    const html = await this.authPost(`${PORTAL_BASE}/index/techtt/tech/${teacherId}`, { htype: String(period) });
    const days = parseTeacherSchedule(html);
    const info = parseTeacherInfo(html);
    // Ни шапки преподавателя, ни пар — это не его страница (главная, техработы):
    // «пустая неделя» закешировалась бы как правда.
    if (!info && !days.length) throw new PortalHttpError(`teacher ${teacherId}: not a teacher page`);
    return { days, info, weekMarker: parseWeekMarker(html) };
  }

  /**
   * Webinars of one day. Unlike teacher pages this works for guests, and each
   * row carries the teacher, the topic and the groups of a distance lesson.
   */
  /**
   * Фото преподавателя. Портал отдаёт его только авторизованным и по
   * относительному адресу из карточки («/index/photo/tech/653/id/653»).
   */
  async getTeacherPhoto(photoUrl: string): Promise<Buffer | null> {
    await this.ensureLogin();
    const url = new URL(photoUrl, PORTAL_BASE).toString();
    // Сессия портала живёт недолго. Расписание умеет перелогиниться (authPost
    // видит страницу входа), а фото — нет: протухшая сессия молча отдавала
    // редирект на вход, и фото не появлялось до перезапуска бота.
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.http.getBytesFollow(url, undefined, new URL(PORTAL_BASE).host);
      if (res && res.bytes.length >= 1024 && /^image\//i.test(res.contentType)) return res.bytes;
      // Перелогиниваемся, только если портал правда вернул форму входа: 404 или
      // заглушка вместо фото — не повод сбрасывать сессию всему боту.
      const loginPage = !!res && /html/i.test(res.contentType) && isLoginPage(res.bytes.toString("utf8"));
      if (attempt === 0 && loginPage) {
        logger.info({ url }, "portal: photo came back without an image, re-authenticating");
        this.loggedIn = false;
        await this.login();
        continue;
      }
      logger.warn({ url, status: res?.status ?? null, contentType: res?.contentType ?? null }, "portal: teacher photo unavailable");
      break;
    }
    return null;
  }

  async getWebinars(date: LocalDate, facultyId: number): Promise<Webinar[]> {
    const html = await this.authPost(`${PORTAL_BASE}/webinar`, { seldate: date, selfac: String(facultyId), pertt: "1" });
    // Не страница вебинаров (главная, техработы) — не «вебинаров нет»: иначе
    // сохранённые пары дня стирались бы вместе с преподавателями и темами.
    if (!/name="seldate"/.test(html)) throw new PortalHttpError(`webinars ${date}: not a webinar page`);
    return parseWebinars(html);
  }

  async getFacultyGroups(facultyId: number): Promise<PortalGroup[]> {
    const html = await this.authPost(`${PORTAL_BASE}/`, { hfac: String(facultyId), pertt: "1" });
    const groups = parseGroupButtons(html).map((g) => ({ id: g.id, name: g.name.trim() }));
    if (groups.length === 0) throw new PortalHttpError("Faculty page contained no groups");
    return groups;
  }

  async getGroupPage(groupId: number, period: Period): Promise<GroupPage> {
    const html = await this.authPost(`${PORTAL_BASE}/index/grouptt/gr/${groupId}`, { htype: String(period) });
    const days = parseGroupSchedule(html);
    const name = parseGroupName(html);
    const pagePeriod = parsePeriod(html);
    // Настоящая страница группы всегда называет период. Без него и без единой
    // пары — это главная или техработы: принять её за расписание значило бы
    // «отменить» все пары группы и разослать это всем подписчикам.
    if (pagePeriod === null && !days.length) throw new PortalHttpError(`group ${groupId}: not a timetable page`);
    if (pagePeriod !== null && pagePeriod !== period) {
      throw new PortalHttpError(`Portal returned period ${pagePeriod} instead of ${period} for group ${groupId}`);
    }
    return {
      groupId,
      period,
      name,
      days,
      academicYear: parseAcademicYear(html),
      pagePeriod,
      weekMarker: parseWeekMarker(html),
      banner: parseBanner(html),
      htmlHash: sha1(html),
      contentHash: sha1(JSON.stringify(days)),
      fetchedAt: new Date(),
    };
  }
}
