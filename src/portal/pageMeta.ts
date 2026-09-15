import { parseAcademicYearFromPage, parsePeriodFromPage } from "chuvsu-js/parsers";
import type { Period } from "../schedule/model.js";

export interface WeekMarker {
  week: number;
  parity: "odd" | "even" | null;
  /** 1 = осенний, 3 = весенний (as written on the page). */
  semester: 1 | 3 | null;
}

/** "идет 2 ** неделя осеннего семестра" -> { week: 2, parity: "even", semester: 1 } */
export function parseWeekMarker(html: string): WeekMarker | null {
  const text = html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const m = /идет\s+(\d{1,2})\s*(\*{1,2})?\s*неделя\s+(осеннего|весеннего)?/iu.exec(text);
  if (!m) return null;
  const week = Number(m[1]);
  const parity = m[2] === "**" ? "even" : m[2] === "*" ? "odd" : null;
  const semester = m[3]?.toLowerCase() === "весеннего" ? 3 : m[3]?.toLowerCase() === "осеннего" ? 1 : null;
  return { week, parity, semester };
}

/** Text of the red portal banner (e.g. distance-learning notices), or null. */
export function parseBanner(html: string): string | null {
  const m = /<div[^>]*id="banner"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (!m) return null;
  const text = m[1]!
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
  return text || null;
}

export function parseAcademicYear(html: string): number | null {
  return parseAcademicYearFromPage(html);
}

export function parsePeriod(html: string): Period | null {
  const p = parsePeriodFromPage(html);
  return p === 1 || p === 2 || p === 3 || p === 4 ? p : null;
}

/**
 * True only for the portal's own sign-in page. The login inputs (`wname` /
 * `wpass`) also appear in the "join a webinar" dialog of /webinar, so the
 * submit buttons of the login form are what actually identify it.
 */
export function isLoginPage(html: string): boolean {
  if (!html.includes('name="wname"')) return false;
  return html.includes('name="auth"') || html.includes('name="guest"');
}
