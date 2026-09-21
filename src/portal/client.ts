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

export class PortalClient {
  readonly http: PortalHttp;
  private loggedIn = false;
  private loginPromise: Promise<void> | null = null;
  private readonly credentials: PortalCredentials | undefined;

  constructor(opts: PortalHttpOptions & { credentials?: PortalCredentials } = {}) {
    this.http = new PortalHttp(opts);
    this.credentials = opts.credentials;
  }

  get authenticated(): boolean {
    return !!this.credentials;
  }

  /** Guest session, or the configured account when credentials were given. */
  async login(): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      this.http.clearCookies();
      const form: Record<string, string> = this.credentials
        ? { wname: this.credentials.login, wpass: this.credentials.password, wauto: "1", auth: "Войти", hfac: "0", pertt: "1" }
        : { guest: "Войти гостем", hfac: "0", pertt: "1" };
      const res = await this.http.post(`${PORTAL_BASE}/auth`, form);
      if (res.status !== 302) throw new PortalAuthError(`${this.credentials ? "Account" : "Guest"} login failed: HTTP ${res.status}`);
      this.loggedIn = true;
      logger.info({ mode: this.credentials ? "account" : "guest" }, "portal: session established");
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
    const res = await this.http.getBytes(url);
    if (!res || res.bytes.length < 1024) return null;
    // Портал вместо картинки может отдать html-страницу входа.
    if (!/^image\//i.test(res.contentType)) return null;
    return res.bytes;
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
