import { parseGroupButtons, parseGroupName, parseGroupSchedule, parseTeacherButtons, parseTeacherInfo, parseTeacherSchedule, parseWebinars, type ParsedScheduleDay } from "chuvsu-js/parsers";
import type { TeacherInfo, Webinar } from "chuvsu-js";
import { PortalHttp, PortalHttpError, type PortalHttpOptions } from "./http.js";
import { isLoginPage, parseAcademicYear, parseBanner, parsePeriod, parseWeekMarker, type WeekMarker } from "./pageMeta.js";
import type { Period } from "../schedule/model.js";
import { sha1 } from "../schedule/model.js";
import { logger } from "../logger.js";
import type { LocalDate } from "../time.js";

export const PORTAL_BASE = "https://tt.chuvsu.ru";

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
    if (!this.loggedIn) await this.login();
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

  /** Full teacher directory (account only; guests are redirected away). */
  async getAllTeachers(): Promise<Array<{ id: number; name: string }>> {
    const html = await this.authGet(`${PORTAL_BASE}/index/tech`);
    return parseTeacherButtons(html).map((t) => ({ id: t.id, name: t.name.trim() }));
  }

  async searchTeachers(query: string): Promise<Array<{ id: number; name: string }>> {
    const html = await this.authPost(`${PORTAL_BASE}/`, { techname: query, findtech: "найти", hfac: "0", pertt: "1" });
    return parseTeacherButtons(html).map((t) => ({ id: t.id, name: t.name.trim() }));
  }

  async getTeacherPage(teacherId: number, period: Period): Promise<{ days: ParsedScheduleDay[]; info: TeacherInfo | null; weekMarker: WeekMarker | null }> {
    const html = await this.authPost(`${PORTAL_BASE}/index/techtt/tech/${teacherId}`, { htype: String(period) });
    return { days: parseTeacherSchedule(html), info: parseTeacherInfo(html), weekMarker: parseWeekMarker(html) };
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
      const res = await this.http.getBytesFollow(url);
      if (res && res.bytes.length >= 1024 && /^image\//i.test(res.contentType)) return res.bytes;
      if (attempt === 0) {
        logger.info({ url }, "portal: photo came back without an image, re-authenticating");
        this.loggedIn = false;
        await this.login();
        continue;
      }
      logger.warn({ url, status: res?.status ?? null, contentType: res?.contentType ?? null }, "portal: teacher photo unavailable");
    }
    return null;
  }

  async getWebinars(date: LocalDate, facultyId: number): Promise<Webinar[]> {
    const html = await this.authPost(`${PORTAL_BASE}/webinar`, { seldate: date, selfac: String(facultyId), pertt: "1" });
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
