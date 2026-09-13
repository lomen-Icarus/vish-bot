import { parseGroupButtons, parseGroupName, parseGroupSchedule, type ParsedScheduleDay } from "chuvsu-js/parsers";
import { PortalHttp, PortalHttpError, type PortalHttpOptions } from "./http.js";
import { isLoginPage, parseAcademicYear, parseBanner, parsePeriod, parseWeekMarker, type WeekMarker } from "./pageMeta.js";
import type { Period } from "../schedule/model.js";
import { sha1 } from "../schedule/model.js";
import { logger } from "../logger.js";

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
export class PortalClient {
  readonly http: PortalHttp;
  private loggedIn = false;
  private loginPromise: Promise<void> | null = null;

  constructor(opts: PortalHttpOptions = {}) {
    this.http = new PortalHttp(opts);
  }

  async loginAsGuest(): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      this.http.clearCookies();
      const res = await this.http.post(`${PORTAL_BASE}/auth`, { guest: "Войти гостем", hfac: "0", pertt: "1" });
      if (res.status !== 302) throw new PortalAuthError(`Guest login failed: HTTP ${res.status}`);
      this.loggedIn = true;
      logger.info("portal: guest session established");
    })();
    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  private async ensureLogin(): Promise<void> {
    if (!this.loggedIn) await this.loginAsGuest();
  }

  /** POST + follow, retrying once after a fresh login if the session expired. */
  private async authPost(url: string, form: Record<string, string>): Promise<string> {
    await this.ensureLogin();
    let res = await this.http.postFollow(url, form);
    if (isLoginPage(res.body)) {
      logger.info("portal: session expired, re-authenticating");
      this.loggedIn = false;
      await this.loginAsGuest();
      res = await this.http.postFollow(url, form);
      if (isLoginPage(res.body)) throw new PortalAuthError("Portal keeps returning the login page");
    }
    if (res.status !== 200) throw new PortalHttpError(`HTTP ${res.status} for ${url}`, res.status);
    return res.body;
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
