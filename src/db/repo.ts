import { randomBytes } from "node:crypto";
import type { Db } from "./index.js";
import { nowIso } from "./index.js";
import type { Occurrence, Period } from "../schedule/model.js";
import { contentHash, positionKey } from "../schedule/model.js";
import type { LocalDate } from "../time.js";

export type ScheduleFormat = "text" | "image" | "both";

export interface NewsSource {
  id: number;
  kind: "tg" | "vk" | "web";
  ref: string;
  title: string | null;
  enabled: boolean;
  lastScannedAt: string | null;
  lastError: string | null;
}
interface NewsSourceRow {
  id: number;
  kind: string;
  ref: string;
  title: string | null;
  enabled: number;
  last_scanned_at: string | null;
  last_error: string | null;
}
function rowToSource(r: NewsSourceRow): NewsSource {
  return { id: r.id, kind: r.kind as NewsSource["kind"], ref: r.ref, title: r.title, enabled: r.enabled === 1, lastScannedAt: r.last_scanned_at, lastError: r.last_error };
}

export interface NewsItem {
  id: number;
  sourceId: number;
  externalId: string;
  url: string | null;
  publishedAt: string;
  text: string;
  photoUrl: string | null;
  topic: string | null;
  title: string | null;
  sentCount: number;
}
interface NewsItemRow {
  id: number;
  source_id: number;
  external_id: string;
  url: string | null;
  published_at: string;
  text: string;
  photo_url: string | null;
  topic: string | null;
  title: string | null;
  sent_count: number;
}
function rowToItem(r: NewsItemRow): NewsItem {
  return { id: r.id, sourceId: r.source_id, externalId: r.external_id, url: r.url, publishedAt: r.published_at, text: r.text, photoUrl: r.photo_url, topic: r.topic, title: r.title, sentCount: r.sent_count };
}

export interface User {
  id: number;
  username: string | null;
  firstName: string | null;
  groupKey: string | null;
  subgroup: number | null;
  format: ScheduleFormat;
  notifyChanges: boolean;
  notifySession: boolean;
  /** Присылать ли PDF со слайдами записанных вебинаров. */
  wantSlides: boolean;
  notifyNotices: boolean;
  remindFirstMin: number | null;
  remindEachMin: number | null;
  /** Minutes before a distance (online) lesson to send the webinar link; null = off. */
  remindDistanceMin: number | null;
  eveningAt: string | null;
  quietFrom: string | null;
  quietTo: string | null;
  topics: string[];
  /** Intake year (two digits) selected in stream mode; null = follow own group. */
  streamIntake: number | null;
  /** Secret token of the personal calendar subscription URL; null until requested. */
  calToken: string | null;
  /** Alarm minutes baked into the subscription feed; null = no alarms. */
  calAlarmMin: number | null;
  /** Poster look; null = the bot's default (POSTER_THEME). */
  posterTheme: string | null;
  blocked: boolean;
  createdAt: string;
  lastSeenAt: string;
}

interface UserRow {
  id: number;
  username: string | null;
  first_name: string | null;
  group_key: string | null;
  subgroup: number | null;
  format: string;
  notify_changes: number;
  notify_session: number;
  want_slides: number | null;
  notify_notices: number;
  remind_first_min: number | null;
  remind_each_min: number | null;
  remind_distance_min: number | null;
  evening_at: string | null;
  quiet_from: string | null;
  quiet_to: string | null;
  topics: string;
  stream_intake: number | null;
  cal_token: string | null;
  cal_alarm_min: number | null;
  poster_theme: string | null;
  blocked: number;
  created_at: string;
  last_seen_at: string;
}

function rowToUser(r: UserRow): User {
  let topics: string[] = [];
  try {
    topics = JSON.parse(r.topics) as string[];
  } catch {
    topics = [];
  }
  return {
    id: r.id,
    username: r.username,
    firstName: r.first_name,
    groupKey: r.group_key,
    subgroup: r.subgroup,
    format: (r.format as ScheduleFormat) ?? "both",
    notifyChanges: r.notify_changes === 1,
    notifySession: r.notify_session === 1,
    wantSlides: r.want_slides == null ? true : r.want_slides === 1,
    notifyNotices: r.notify_notices === 1,
    remindFirstMin: r.remind_first_min,
    remindEachMin: r.remind_each_min,
    remindDistanceMin: r.remind_distance_min ?? null,
    eveningAt: r.evening_at,
    quietFrom: r.quiet_from,
    quietTo: r.quiet_to,
    topics,
    streamIntake: r.stream_intake ?? null,
    calToken: r.cal_token ?? null,
    calAlarmMin: r.cal_alarm_min ?? null,
    posterTheme: r.poster_theme ?? null,
    blocked: r.blocked === 1,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

/** One online lesson from the portal's webinar page (guest-readable, carries the teacher). */
export interface WebinarRow {
  date: LocalDate;
  slot: number | null;
  start: number | null;
  end: number | null;
  subject: string;
  type: string;
  teacher: string;
  position: string | null;
  degree: string | null;
  subgroup: number | null;
  title: string | null;
  groups: string[];
  /** True for "вебинары по расписанию"; ad-hoc events are not lessons. */
  scheduled: boolean;
}

function rowToWebinar(r: Record<string, unknown>): WebinarRow {
  let groups: string[] = [];
  try {
    groups = JSON.parse(String(r.groups_json)) as string[];
  } catch {
    groups = [];
  }
  return {
    date: String(r.date),
    slot: r.slot == null ? null : Number(r.slot),
    start: r.start == null ? null : Number(r.start),
    end: r.end == null ? null : Number(r.end),
    subject: String(r.subject),
    type: String(r.type),
    teacher: String(r.teacher),
    position: r.position == null ? null : String(r.position),
    degree: r.degree == null ? null : String(r.degree),
    subgroup: r.subgroup == null ? null : Number(r.subgroup),
    title: r.title == null ? null : String(r.title),
    groups,
    scheduled: r.scheduled == null ? true : Number(r.scheduled) === 1,
  };
}

export interface TeacherMapRow {
  key: string;
  teacherId: number | null;
  name: string;
  /** Ведёт ли пары у групп ВИШ. */
  vish: boolean;
  groups: string[];
  subjects: string[];
  department: string | null;
  degree: string | null;
  photoUrl: string | null;
  photoFileId: string | null;
  source: "portal" | "webinar";
  checkedAt: string | null;
}

function rowToTeacherMap(r: Record<string, unknown>): TeacherMapRow {
  const list = (v: unknown): string[] => {
    try {
      const parsed = JSON.parse(String(v ?? "[]")) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  };
  return {
    key: String(r.key),
    teacherId: r.teacher_id == null ? null : Number(r.teacher_id),
    name: String(r.name),
    vish: Number(r.vish) === 1,
    groups: list(r.groups_json),
    subjects: list(r.subjects_json),
    department: r.department == null ? null : String(r.department),
    degree: r.degree == null ? null : String(r.degree),
    photoUrl: r.photo_url == null ? null : String(r.photo_url),
    photoFileId: r.photo_file_id == null ? null : String(r.photo_file_id),
    source: r.source === "portal" ? "portal" : "webinar",
    checkedAt: r.checked_at == null ? null : String(r.checked_at),
  };
}

export interface PortalGroupRow {
  id: number;
  name: string;
  groupKey: string;
  active: boolean;
}

export interface ChangeEventRow {
  id: number;
  groupKey: string;
  date: LocalDate;
  period: Period;
  kind: string;
  payload: unknown;
  createdAt: string;
  /** True once the change has gone through the normal dispatch pass. */
  notified: boolean;
}

interface OccurrenceRow {
  group_key: string;
  date: string;
  position_key: string;
  period: number;
  slot: number | null;
  start: number | null;
  end: number | null;
  subject: string;
  type: string;
  room: string | null;
  teacher: string | null;
  subgroup: number | null;
  is_distance: number;
  status: string;
  extra_json: string;
  hash: string;
}

function rowToOccurrence(r: OccurrenceRow): Occurrence {
  const extra = JSON.parse(r.extra_json) as Partial<Occurrence>;
  return {
    groupKey: r.group_key,
    period: r.period as Period,
    date: r.date,
    slot: r.slot,
    start: r.start,
    end: r.end,
    subject: r.subject,
    type: r.type,
    room: r.room,
    teacher: r.teacher,
    subgroup: r.subgroup,
    isDistance: r.is_distance === 1,
    status: r.status as Occurrence["status"],
    movedTo: extra.movedTo,
    movedFrom: extra.movedFrom,
    substituted: extra.substituted,
    sources: extra.sources ?? [],
    weeksHint: extra.weeksHint,
  };
}

export class Repo {
  constructor(readonly db: Db) {}

  // ---------- meta ----------
  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---------- users ----------
  getUser(id: number): User | null {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }

  userByCalToken(token: string): User | null {
    if (!token) return null;
    const row = this.db.prepare("SELECT * FROM users WHERE cal_token = ?").get(token) as UserRow | undefined;
    return row ? rowToUser(row) : null;
  }
  /** Returns the user's calendar token, minting one on first use. */
  ensureCalToken(id: number): string {
    const u = this.getUser(id);
    if (u?.calToken) return u.calToken;
    const token = randomBytes(18).toString("base64url");
    this.updateUser(id, { calToken: token });
    return token;
  }
  touchUser(id: number, username: string | null, firstName: string | null): User {
    const ts = nowIso();
    this.db
      .prepare(
        // Тема «Объявления» включена сразу: туда идёт только важное — дистант,
        // отмены, дедлайны. Конкурсы и события остаются по подписке.
        `INSERT INTO users (id, username, first_name, notify_notices, topics, created_at, updated_at, last_seen_at)
         VALUES (?, ?, ?, 0, '["announcements"]', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name,
           last_seen_at = excluded.last_seen_at, blocked = 0`,
      )
      .run(id, username, firstName, ts, ts, ts);
    return this.getUser(id)!;
  }

  updateUser(id: number, patch: Partial<Omit<User, "id" | "createdAt" | "lastSeenAt">>): void {
    const map: Record<string, unknown> = {};
    if (patch.groupKey !== undefined) map.group_key = patch.groupKey;
    if (patch.subgroup !== undefined) map.subgroup = patch.subgroup;
    if (patch.format !== undefined) map.format = patch.format;
    if (patch.notifyChanges !== undefined) map.notify_changes = patch.notifyChanges ? 1 : 0;
    if (patch.notifySession !== undefined) map.notify_session = patch.notifySession ? 1 : 0;
    if (patch.notifyNotices !== undefined) map.notify_notices = patch.notifyNotices ? 1 : 0;
    if (patch.remindFirstMin !== undefined) map.remind_first_min = patch.remindFirstMin;
    if (patch.remindEachMin !== undefined) map.remind_each_min = patch.remindEachMin;
    if (patch.remindDistanceMin !== undefined) map.remind_distance_min = patch.remindDistanceMin;
    if (patch.eveningAt !== undefined) map.evening_at = patch.eveningAt;
    if (patch.quietFrom !== undefined) map.quiet_from = patch.quietFrom;
    if (patch.quietTo !== undefined) map.quiet_to = patch.quietTo;
    if (patch.topics !== undefined) map.topics = JSON.stringify(patch.topics);
    if (patch.wantSlides !== undefined) map.want_slides = patch.wantSlides ? 1 : 0;
    if (patch.streamIntake !== undefined) map.stream_intake = patch.streamIntake;
    if (patch.calToken !== undefined) map.cal_token = patch.calToken;
    if (patch.calAlarmMin !== undefined) map.cal_alarm_min = patch.calAlarmMin;
    if (patch.posterTheme !== undefined) map.poster_theme = patch.posterTheme;
    if (patch.blocked !== undefined) map.blocked = patch.blocked ? 1 : 0;
    const keys = Object.keys(map);
    if (keys.length === 0) return;
    map.updated_at = nowIso();
    const sets = Object.keys(map)
      .map((k) => `${k} = @${k}`)
      .join(", ");
    this.db.prepare(`UPDATE users SET ${sets} WHERE id = @id`).run({ ...map, id });
  }

  listUsers(opts: { onlyActive?: boolean } = {}): User[] {
    const rows = this.db
      .prepare(`SELECT * FROM users ${opts.onlyActive ? "WHERE blocked = 0" : ""} ORDER BY id`)
      .all() as UserRow[];
    return rows.map(rowToUser);
  }

  countUsers(): { total: number; active: number; withGroup: number } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(CASE WHEN blocked = 0 THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN group_key IS NOT NULL AND blocked = 0 THEN 1 ELSE 0 END) AS withGroup FROM users`,
      )
      .get() as { total: number; active: number | null; withGroup: number | null };
    return { total: r.total, active: r.active ?? 0, withGroup: r.withGroup ?? 0 };
  }

  groupPopulation(): Array<{ groupKey: string; users: number }> {
    return this.db
      .prepare(`SELECT group_key AS groupKey, COUNT(*) AS users FROM users WHERE group_key IS NOT NULL AND blocked = 0 GROUP BY group_key ORDER BY users DESC`)
      .all() as Array<{ groupKey: string; users: number }>;
  }

  /** Users that want change notifications for a logical group (primary group or watch list). */
  usersForGroupChanges(groupKey: string, session: boolean): User[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT u.* FROM users u
         LEFT JOIN watch_groups w ON w.user_id = u.id
         WHERE u.blocked = 0
           AND ((u.group_key = @g AND u.notify_changes = 1) OR w.group_key = @g)
           ${session ? "AND u.notify_session = 1" : ""}`,
      )
      .all({ g: groupKey }) as UserRow[];
    return rows.map(rowToUser);
  }

  usersForTopic(topic: string): User[] {
    const rows = this.db.prepare(`SELECT * FROM users WHERE blocked = 0`).all() as UserRow[];
    return rows.map(rowToUser).filter((u) => u.topics.includes(topic));
  }

  watchGroups(userId: number): string[] {
    return (this.db.prepare("SELECT group_key FROM watch_groups WHERE user_id = ? ORDER BY group_key").all(userId) as Array<{ group_key: string }>).map(
      (r) => r.group_key,
    );
  }

  toggleWatchGroup(userId: number, groupKey: string): boolean {
    const exists = this.db.prepare("SELECT 1 FROM watch_groups WHERE user_id = ? AND group_key = ?").get(userId, groupKey);
    if (exists) {
      this.db.prepare("DELETE FROM watch_groups WHERE user_id = ? AND group_key = ?").run(userId, groupKey);
      return false;
    }
    this.db.prepare("INSERT INTO watch_groups (user_id, group_key) VALUES (?, ?)").run(userId, groupKey);
    return true;
  }

  // ---------- portal groups ----------
  upsertPortalGroups(groups: Array<{ id: number; name: string; groupKey: string }>): void {
    const ts = nowIso();
    const upsert = this.db.prepare(
      `INSERT INTO portal_groups (id, name, group_key, active, first_seen_at, last_seen_at) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, group_key = excluded.group_key, active = 1, last_seen_at = excluded.last_seen_at`,
    );
    const seen = new Set(groups.map((g) => g.id));
    this.db.transaction(() => {
      for (const g of groups) upsert.run(g.id, g.name, g.groupKey, ts, ts);
      const all = this.db.prepare("SELECT id FROM portal_groups").all() as Array<{ id: number }>;
      const deactivate = this.db.prepare("UPDATE portal_groups SET active = 0 WHERE id = ?");
      for (const { id } of all) if (!seen.has(id)) deactivate.run(id);
    })();
  }

  listPortalGroups(onlyActive = true): PortalGroupRow[] {
    const rows = this.db
      .prepare(`SELECT id, name, group_key, active FROM portal_groups ${onlyActive ? "WHERE active = 1" : ""} ORDER BY id`)
      .all() as Array<{ id: number; name: string; group_key: string; active: number }>;
    return rows.map((r) => ({ id: r.id, name: r.name, groupKey: r.group_key, active: r.active === 1 }));
  }

  // ---------- pages ----------
  getPage(portalGroupId: number, period: Period): { htmlHash: string; parsed: unknown; fetchedAt: string; changedAt: string } | null {
    const r = this.db.prepare("SELECT html_hash, parsed_json, fetched_at, changed_at FROM pages WHERE portal_group_id = ? AND period = ?").get(portalGroupId, period) as
      | { html_hash: string; parsed_json: string; fetched_at: string; changed_at: string }
      | undefined;
    if (!r) return null;
    return { htmlHash: r.html_hash, parsed: JSON.parse(r.parsed_json), fetchedAt: r.fetched_at, changedAt: r.changed_at };
  }

  savePage(portalGroupId: number, period: Period, htmlHash: string, parsed: unknown, changed: boolean): void {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO pages (portal_group_id, period, html_hash, parsed_json, fetched_at, changed_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(portal_group_id, period) DO UPDATE SET html_hash = excluded.html_hash, parsed_json = excluded.parsed_json,
           fetched_at = excluded.fetched_at, changed_at = CASE WHEN ${changed ? 1 : 0} = 1 THEN excluded.changed_at ELSE pages.changed_at END`,
      )
      .run(portalGroupId, period, htmlHash, JSON.stringify(parsed), ts, ts);
  }

  pagesForGroup(portalGroupIds: number[], period: Period): Array<{ portalGroupId: number; parsed: unknown }> {
    if (portalGroupIds.length === 0) return [];
    const placeholders = portalGroupIds.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT portal_group_id, parsed_json FROM pages WHERE period = ? AND portal_group_id IN (${placeholders})`).all(period, ...portalGroupIds) as Array<{
      portal_group_id: number;
      parsed_json: string;
    }>;
    return rows.map((r) => ({ portalGroupId: r.portal_group_id, parsed: JSON.parse(r.parsed_json) }));
  }

  // ---------- occurrences ----------
  occurrences(groupKey: string, from: LocalDate, to: LocalDate): Occurrence[] {
    const rows = this.db
      .prepare(`SELECT * FROM occurrences WHERE group_key = ? AND date >= ? AND date <= ? ORDER BY date, COALESCE(start, 0), slot, subgroup`)
      .all(groupKey, from, to) as OccurrenceRow[];
    return rows.map(rowToOccurrence);
  }

  occurrencesOn(groupKey: string, date: LocalDate): Occurrence[] {
    return this.occurrences(groupKey, date, date);
  }

  /** Replace the stored occurrences of a group within [from, to]. */
  replaceOccurrences(groupKey: string, from: LocalDate, to: LocalDate, list: Occurrence[]): void {
    const del = this.db.prepare("DELETE FROM occurrences WHERE group_key = ? AND date >= ? AND date <= ?");
    const ins = this.db.prepare(
      `INSERT OR REPLACE INTO occurrences (group_key, date, position_key, period, slot, start, "end", subject, type, room, teacher, subgroup, is_distance, status, extra_json, hash)
       VALUES (@group_key, @date, @position_key, @period, @slot, @start, @end, @subject, @type, @room, @teacher, @subgroup, @is_distance, @status, @extra_json, @hash)`,
    );
    this.db.transaction(() => {
      del.run(groupKey, from, to);
      for (const o of list) {
        if (o.date < from || o.date > to) continue;
        ins.run({
          group_key: o.groupKey,
          date: o.date,
          position_key: positionKey(o),
          period: o.period,
          slot: o.slot,
          start: o.start,
          end: o.end,
          subject: o.subject,
          type: o.type,
          room: o.room,
          teacher: o.teacher,
          subgroup: o.subgroup,
          is_distance: o.isDistance ? 1 : 0,
          status: o.status,
          extra_json: JSON.stringify({ movedTo: o.movedTo, movedFrom: o.movedFrom, substituted: o.substituted, sources: o.sources, weeksHint: o.weeksHint }),
          hash: contentHash(o),
        });
      }
    })();
  }

  hasOccurrences(groupKey: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM occurrences WHERE group_key = ? LIMIT 1").get(groupKey);
  }

  // ---------- change events ----------
  insertChangeEvents(events: Array<{ groupKey: string; date: LocalDate; period: Period; kind: string; payload: unknown }>): number[] {
    const ins = this.db.prepare(
      "INSERT INTO change_events (group_key, date, period, kind, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const ids: number[] = [];
    this.db.transaction(() => {
      for (const e of events) {
        const r = ins.run(e.groupKey, e.date, e.period, e.kind, JSON.stringify(e.payload), nowIso());
        ids.push(Number(r.lastInsertRowid));
      }
    })();
    return ids;
  }

  unnotifiedEvents(): ChangeEventRow[] {
    const rows = this.db.prepare("SELECT * FROM change_events WHERE notified = 0 ORDER BY group_key, date, id").all() as Array<{
      id: number;
      group_key: string;
      date: string;
      period: number;
      kind: string;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((r) => ({ id: r.id, groupKey: r.group_key, date: r.date, period: r.period as Period, kind: r.kind, payload: JSON.parse(r.payload_json), createdAt: r.created_at, notified: Number((r as { notified?: number }).notified ?? 0) === 1 }));
  }

  markEventsNotified(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare("UPDATE change_events SET notified = 1 WHERE id = ?");
    this.db.transaction(() => ids.forEach((id) => stmt.run(id)))();
  }

  /** Events still worth showing: lesson date not in the past, noticed within the last two weeks. */
  activeEvents(groupKey: string, today: LocalDate, limit = 30): ChangeEventRow[] {
    const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
    const rows = this.db
      .prepare("SELECT * FROM change_events WHERE group_key = ? AND date >= ? AND created_at >= ? ORDER BY date, id LIMIT ?")
      .all(groupKey, today, since, limit) as Array<{ id: number; group_key: string; date: string; period: number; kind: string; payload_json: string; created_at: string }>;
    return rows.map((r) => ({ id: r.id, groupKey: r.group_key, date: r.date, period: r.period as Period, kind: r.kind, payload: JSON.parse(r.payload_json), createdAt: r.created_at, notified: Number((r as { notified?: number }).notified ?? 0) === 1 }));
  }

  // ---------- announcements board ----------
  addAnnouncement(text: string, adminId: number | null, hours: number): number {
    const r = this.db
      .prepare("INSERT INTO announcements (text, admin_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(text, adminId, nowIso(), new Date(Date.now() + hours * 3_600_000).toISOString());
    return r.lastInsertRowid;
  }

  activeAnnouncements(): Array<{ id: number; text: string; createdAt: string; expiresAt: string }> {
    const rows = this.db.prepare("SELECT id, text, created_at, expires_at FROM announcements WHERE deleted = 0 AND expires_at > ? ORDER BY id DESC").all(nowIso()) as Array<{
      id: number;
      text: string;
      created_at: string;
      expires_at: string;
    }>;
    return rows.map((r) => ({ id: r.id, text: r.text, createdAt: r.created_at, expiresAt: r.expires_at }));
  }

  deleteAnnouncement(id: number): boolean {
    return this.db.prepare("UPDATE announcements SET deleted = 1 WHERE id = ? AND deleted = 0").run(id).changes > 0;
  }

  clearWatchGroups(userId: number): number {
    return this.db.prepare("DELETE FROM watch_groups WHERE user_id = ?").run(userId).changes;
  }

  recentEvents(groupKey: string, limit = 20): ChangeEventRow[] {
    const rows = this.db.prepare("SELECT * FROM change_events WHERE group_key = ? ORDER BY id DESC LIMIT ?").all(groupKey, limit) as Array<{
      id: number;
      group_key: string;
      date: string;
      period: number;
      kind: string;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((r) => ({ id: r.id, groupKey: r.group_key, date: r.date, period: r.period as Period, kind: r.kind, payload: JSON.parse(r.payload_json), createdAt: r.created_at, notified: Number((r as { notified?: number }).notified ?? 0) === 1 }));
  }

  // ---------- reminders ----------
  reminderSent(userId: number, kind: string, ref: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM reminders_sent WHERE user_id = ? AND kind = ? AND ref = ?").get(userId, kind, ref);
  }

  markReminderSent(userId: number, kind: string, ref: string): void {
    this.db.prepare("INSERT OR IGNORE INTO reminders_sent (user_id, kind, ref, sent_at) VALUES (?, ?, ?, ?)").run(userId, kind, ref, nowIso());
  }

  // ---- webinars (online lessons; the only guest-readable source of teacher names) ----
  replaceWebinars(date: LocalDate, rows: WebinarRow[]): void {
    const ts = nowIso();
    const insert = this.db.prepare(
      `INSERT INTO webinars (date, slot, start, "end", subject, type, teacher, position, degree, subgroup, title, groups_json, scheduled, fetched_at)
       VALUES (@date, @slot, @start, @end, @subject, @type, @teacher, @position, @degree, @subgroup, @title, @groups, @scheduled, @ts)`,
    );
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM webinars WHERE date = ?").run(date);
      for (const r of rows) {
        insert.run({
          date: r.date,
          slot: r.slot,
          start: r.start,
          end: r.end,
          subject: r.subject,
          type: r.type,
          teacher: r.teacher,
          position: r.position,
          degree: r.degree,
          subgroup: r.subgroup,
          title: r.title,
          groups: JSON.stringify(r.groups),
          scheduled: r.scheduled ? 1 : 0,
          ts,
        });
      }
    })();
  }

  webinarsBetween(from: LocalDate, to: LocalDate): WebinarRow[] {
    const rows = this.db.prepare('SELECT * FROM webinars WHERE date >= ? AND date <= ? ORDER BY date, slot, subject').all(from, to) as Array<Record<string, unknown>>;
    return rows.map(rowToWebinar);
  }

  webinarDates(): LocalDate[] {
    return (this.db.prepare("SELECT DISTINCT date FROM webinars ORDER BY date").all() as Array<{ date: string }>).map((r) => r.date);
  }

  pruneWebinars(olderThanDays = 60): void {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString().slice(0, 10);
    this.db.prepare("DELETE FROM webinars WHERE date < ?").run(cutoff);
  }

  /**
   * Treat every change of a group as already delivered to this user. Called
   * when someone picks that group, so they do not receive a pile of changes
   * that happened before the group was theirs.
   */
  markGroupEventsSeen(userId: number, groupKey: string, today: LocalDate): void {
    const rows = this.activeEvents(groupKey, today, 200);
    if (!rows.length) return;
    const stmt = this.db.prepare("INSERT OR IGNORE INTO reminders_sent (user_id, kind, ref, sent_at) VALUES (?, 'event', ?, ?)");
    const ts = nowIso();
    this.db.transaction(() => {
      for (const r of rows) stmt.run(userId, String(r.id), ts);
    })();
  }

  /** Erase everything the bot knows about a person; /start then starts over. */
  forgetUser(userId: number): void {
    this.db.transaction(() => {
      for (const sql of [
        "DELETE FROM watch_groups WHERE user_id = ?",
        "DELETE FROM reminders_sent WHERE user_id = ?",
        "DELETE FROM notifications_log WHERE user_id = ?",
        // ai_usage stays: it is spend accounting and also backs the global daily
        // budget, so a wipe must not hand anyone a fresh quota.
        "DELETE FROM ai_log WHERE user_id = ?",
        "DELETE FROM news_complaints WHERE user_id = ?",
        "DELETE FROM users WHERE id = ?",
      ]) {
        this.db.prepare(sql).run(userId);
      }
    })();
  }

  pruneChangeEvents(olderThanDays = 30): void {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    this.db.prepare("DELETE FROM change_events WHERE created_at < ? AND notified = 1").run(cutoff);
  }

  pruneReminders(olderThanDays = 14): void {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    this.db.prepare("DELETE FROM reminders_sent WHERE sent_at < ?").run(cutoff);
  }

  logNotification(userId: number, kind: string, ok: boolean, error?: string): void {
    this.db.prepare("INSERT INTO notifications_log (user_id, kind, ok, error, sent_at) VALUES (?, ?, ?, ?, ?)").run(userId, kind, ok ? 1 : 0, error ?? null, nowIso());
  }

  // ---------- AI usage ----------
  // ---- слайды записанных вебинаров ----
  addSlideDeck(row: { date: string; subject: string; teacher: string | null; title: string | null; groups: string[]; slides: number; file: string; bytes: number }): number {
    const r = this.db
      .prepare("INSERT INTO slide_decks (date, subject, teacher, title, groups_json, slides, file, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(row.date, row.subject, row.teacher, row.title, JSON.stringify(row.groups), row.slides, row.file, row.bytes, nowIso());
    return r.lastInsertRowid;
  }

  markDeckSent(id: number, fileId: string | null, sent: number): void {
    this.db.prepare("UPDATE slide_decks SET sent = ?, file_id = COALESCE(?, file_id) WHERE id = ?").run(sent, fileId, id);
  }

  recentSlideDecks(limit = 10): Array<{ id: number; date: string; subject: string; teacher: string | null; groups: string[]; slides: number; file: string; bytes: number; fileId: string | null; sent: number; createdAt: string }> {
    const rows = this.db.prepare("SELECT * FROM slide_decks ORDER BY id DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: Number(r.id),
      date: String(r.date),
      subject: String(r.subject),
      teacher: r.teacher == null ? null : String(r.teacher),
      groups: (() => {
        try {
          const parsed = JSON.parse(String(r.groups_json ?? "[]")) as unknown;
          return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
          return [];
        }
      })(),
      slides: Number(r.slides),
      file: String(r.file),
      bytes: Number(r.bytes ?? 0),
      fileId: r.file_id == null ? null : String(r.file_id),
      sent: Number(r.sent),
      createdAt: String(r.created_at),
    }));
  }

  // ---- карта преподавателей: кто из них ведёт у ВИШ ----
  upsertTeacherMap(row: TeacherMapRow): void {
    this.db
      .prepare(
        `INSERT INTO teacher_map (key, teacher_id, name, vish, groups_json, subjects_json, department, degree, photo_url, photo_file_id, source, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           teacher_id = COALESCE(excluded.teacher_id, teacher_map.teacher_id),
           name = excluded.name,
           vish = MAX(excluded.vish, teacher_map.vish),
           groups_json = excluded.groups_json,
           subjects_json = excluded.subjects_json,
           department = COALESCE(excluded.department, teacher_map.department),
           degree = COALESCE(excluded.degree, teacher_map.degree),
           photo_url = COALESCE(excluded.photo_url, teacher_map.photo_url),
           source = excluded.source,
           checked_at = excluded.checked_at`,
      )
      .run(
        row.key,
        row.teacherId ?? null,
        row.name,
        row.vish ? 1 : 0,
        JSON.stringify(row.groups ?? []),
        JSON.stringify(row.subjects ?? []),
        row.department ?? null,
        row.degree ?? null,
        row.photoUrl ?? null,
        row.photoFileId ?? null,
        row.source,
        row.checkedAt ?? nowIso(),
      );
  }

  /** Добавить в карту, не трогая уже собранное (для обхода справочника). */
  seedTeacherMap(key: string, teacherId: number | null, name: string): void {
    this.db.prepare("INSERT OR IGNORE INTO teacher_map (key, teacher_id, name, vish, source) VALUES (?, ?, ?, 0, 'portal')").run(key, teacherId, name);
  }

  teacherMapByKey(key: string): TeacherMapRow | null {
    const r = this.db.prepare("SELECT * FROM teacher_map WHERE key = ?").get(key) as Record<string, unknown> | undefined;
    return r ? rowToTeacherMap(r) : null;
  }

  teacherMapById(teacherId: number): TeacherMapRow | null {
    const r = this.db.prepare("SELECT * FROM teacher_map WHERE teacher_id = ?").get(teacherId) as Record<string, unknown> | undefined;
    return r ? rowToTeacherMap(r) : null;
  }

  teacherMapAll(onlyVish = false): TeacherMapRow[] {
    const rows = this.db.prepare(`SELECT * FROM teacher_map${onlyVish ? " WHERE vish = 1" : ""} ORDER BY name`).all() as Array<Record<string, unknown>>;
    return rows.map(rowToTeacherMap);
  }

  teacherMapStats(): { total: number; vish: number; checked: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(vish), 0) AS vish, COUNT(checked_at) AS checked FROM teacher_map").get() as { total: number; vish: number; checked: number };
    return { total: r.total, vish: r.vish, checked: r.checked };
  }

  /** Кого ещё не проверяли (или проверяли давно) — для фонового обхода справочника. */
  teacherMapStale(limit: number, olderThanDays = 30): number[] {
    const rows = this.db
      .prepare("SELECT teacher_id FROM teacher_map WHERE teacher_id IS NOT NULL AND (checked_at IS NULL OR checked_at < datetime('now', ?)) ORDER BY checked_at IS NOT NULL, checked_at LIMIT ?")
      .all(`-${olderThanDays} days`, limit) as Array<{ teacher_id: number }>;
    return rows.map((r) => r.teacher_id);
  }

  setTeacherPhotoFileId(key: string, fileId: string): void {
    this.db.prepare("UPDATE teacher_map SET photo_file_id = ? WHERE key = ?").run(fileId, key);
  }

  // ---- слежение за преподавателем ----
  toggleWatchTeacher(userId: number, teacherId: number, name: string): boolean {
    const existing = this.db.prepare("SELECT 1 FROM watch_teachers WHERE user_id = ? AND teacher_id = ?").get(userId, teacherId);
    if (existing) {
      this.db.prepare("DELETE FROM watch_teachers WHERE user_id = ? AND teacher_id = ?").run(userId, teacherId);
      return false;
    }
    this.db.prepare("INSERT INTO watch_teachers (user_id, teacher_id, name, created_at) VALUES (?, ?, ?, ?)").run(userId, teacherId, name, nowIso());
    return true;
  }

  watchedTeachers(userId: number): Array<{ teacherId: number; name: string }> {
    const rows = this.db.prepare("SELECT teacher_id, name FROM watch_teachers WHERE user_id = ? ORDER BY name").all(userId) as Array<{ teacher_id: number; name: string }>;
    return rows.map((r) => ({ teacherId: r.teacher_id, name: r.name }));
  }

  watchesTeacher(userId: number, teacherId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM watch_teachers WHERE user_id = ? AND teacher_id = ?").get(userId, teacherId);
  }

  /** Все, за кем кто-нибудь следит: по одному преподавателю на строку. */
  teacherWatchers(): Array<{ teacherId: number; name: string; userIds: number[] }> {
    const rows = this.db.prepare("SELECT teacher_id, name, user_id FROM watch_teachers ORDER BY teacher_id").all() as Array<{ teacher_id: number; name: string; user_id: number }>;
    const byTeacher = new Map<number, { teacherId: number; name: string; userIds: number[] }>();
    for (const r of rows) {
      const entry = byTeacher.get(r.teacher_id) ?? { teacherId: r.teacher_id, name: r.name, userIds: [] };
      entry.userIds.push(r.user_id);
      byTeacher.set(r.teacher_id, entry);
    }
    return [...byTeacher.values()];
  }

  /**
   * Журнал глобального поиска людей: и аудит (кто кого искал), и счётчик против
   * выкачивания базы. Как и ai_usage, переживает /soon — иначе лимит сбрасывался
   * бы одной командой.
   */
  logPoisk(userId: number, day: string, query: string, student: string | null): void {
    this.db.prepare("INSERT INTO poisk_log (user_id, day, query, student, created_at) VALUES (?, ?, ?, ?, ?)").run(userId, day, query.slice(0, 200), student, nowIso());
  }
  /** Человек выбрал из списка кандидатов: уточняем последнюю запись журнала, не тратя лимит. */
  markPoiskChoice(userId: number, day: string, student: string): void {
    this.db
      .prepare("UPDATE poisk_log SET student = ? WHERE id = (SELECT id FROM poisk_log WHERE user_id = ? AND day = ? ORDER BY id DESC LIMIT 1)")
      .run(student, userId, day);
  }
  poiskUsage(userId: number, day: string): number {
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM poisk_log WHERE user_id = ? AND day = ?").get(userId, day) as { c: number };
    return r.c;
  }
  poiskStats(day: string): { searches: number; users: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS c, COUNT(DISTINCT user_id) AS u FROM poisk_log WHERE day = ?").get(day) as { c: number; u: number };
    return { searches: r.c, users: r.u };
  }
  prunePoiskLog(olderThanDays = 180): void {
    this.db.prepare("DELETE FROM poisk_log WHERE created_at < datetime('now', ?)").run(`-${olderThanDays} days`);
  }

  aiUsage(userId: number, day: string): number {
    const r = this.db.prepare("SELECT count FROM ai_usage WHERE user_id = ? AND day = ?").get(userId, day) as { count: number } | undefined;
    return r?.count ?? 0;
  }

  aiUsageGlobal(day: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(count), 0) AS c FROM ai_usage WHERE day = ?").get(day) as { c: number };
    return r.c;
  }

  bumpAiUsage(userId: number, day: string, inputTokens: number, outputTokens: number): void {
    this.db
      .prepare(
        `INSERT INTO ai_usage (user_id, day, count, input_tokens, output_tokens) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1, input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run(userId, day, inputTokens, outputTokens);
  }

  // ---------- AI log ----------
  logAi(userId: number, question: string, answer: string): number {
    const r = this.db.prepare("INSERT INTO ai_log (user_id, question, answer, created_at) VALUES (?, ?, ?, ?)").run(userId, question, answer, nowIso());
    return r.lastInsertRowid;
  }

  aiLogEntry(id: number): { id: number; userId: number; question: string; answer: string; reported: boolean } | null {
    const r = this.db.prepare("SELECT * FROM ai_log WHERE id = ?").get(id) as { id: number; user_id: number; question: string; answer: string; reported: number } | undefined;
    return r ? { id: r.id, userId: r.user_id, question: r.question, answer: r.answer, reported: r.reported === 1 } : null;
  }

  markAiReported(id: number): void {
    this.db.prepare("UPDATE ai_log SET reported = 1 WHERE id = ?").run(id);
  }

  // ---------- news sources / items ----------
  listNewsSources(onlyEnabled = false): NewsSource[] {
    const rows = this.db.prepare(`SELECT * FROM news_sources ${onlyEnabled ? "WHERE enabled = 1" : ""} ORDER BY id`).all() as NewsSourceRow[];
    return rows.map(rowToSource);
  }

  addNewsSource(kind: NewsSource["kind"], ref: string, title: string | null): NewsSource {
    this.db
      .prepare("INSERT INTO news_sources (kind, ref, title, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(ref) DO UPDATE SET enabled = 1, title = COALESCE(excluded.title, news_sources.title)")
      .run(kind, ref, title, nowIso());
    const row = this.db.prepare("SELECT * FROM news_sources WHERE ref = ?").get(ref) as NewsSourceRow;
    return rowToSource(row);
  }

  deleteNewsSource(id: number): boolean {
    return this.db.prepare("DELETE FROM news_sources WHERE id = ?").run(id).changes > 0;
  }

  markSourceScanned(id: number, error: string | null): void {
    this.db.prepare("UPDATE news_sources SET last_scanned_at = ?, last_error = ? WHERE id = ?").run(nowIso(), error, id);
  }

  /** Insert an item unless the same external id was seen before; returns the new id or null. */
  insertNewsItem(item: { sourceId: number; externalId: string; url: string | null; publishedAt: string; text: string; photoUrl: string | null }): number | null {
    const exists = this.db.prepare("SELECT id FROM news_items WHERE source_id = ? AND external_id = ?").get(item.sourceId, item.externalId);
    if (exists) return null;
    const r = this.db
      .prepare("INSERT INTO news_items (source_id, external_id, url, published_at, text, photo_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(item.sourceId, item.externalId, item.url, item.publishedAt, item.text, item.photoUrl, nowIso());
    return r.lastInsertRowid;
  }

  setNewsTopic(id: number, topic: string | null, title: string | null): void {
    this.db.prepare("UPDATE news_items SET topic = ?, title = ? WHERE id = ?").run(topic, title, id);
  }

  bumpNewsSent(id: number, count: number): void {
    this.db.prepare("UPDATE news_items SET sent_count = sent_count + ? WHERE id = ?").run(count, id);
  }

  newsItem(id: number): NewsItem | null {
    const r = this.db.prepare("SELECT * FROM news_items WHERE id = ?").get(id) as NewsItemRow | undefined;
    return r ? rowToItem(r) : null;
  }

  addNewsComplaint(itemId: number, userId: number): number {
    this.db.prepare("INSERT OR IGNORE INTO news_complaints (item_id, user_id, created_at) VALUES (?, ?, ?)").run(itemId, userId, nowIso());
    const r = this.db.prepare("SELECT COUNT(*) AS c FROM news_complaints WHERE item_id = ?").get(itemId) as { c: number };
    return r.c;
  }

  newsStats(sinceIso: string): { items: number; sent: number; complaints: number } {
    const a = this.db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(sent_count), 0) AS s FROM news_items WHERE created_at >= ?").get(sinceIso) as { c: number; s: number };
    const b = this.db.prepare("SELECT COUNT(*) AS c FROM news_complaints WHERE created_at >= ?").get(sinceIso) as { c: number };
    return { items: a.c, sent: a.s, complaints: b.c };
  }

  // ---------- poll runs ----------
  startPollRun(): number {
    const r = this.db.prepare("INSERT INTO poll_runs (started_at) VALUES (?)").run(nowIso());
    return Number(r.lastInsertRowid);
  }

  finishPollRun(id: number, result: { ok: boolean; groupsTotal: number; groupsChanged: number; events: number; error?: string }): void {
    this.db
      .prepare("UPDATE poll_runs SET finished_at = ?, ok = ?, groups_total = ?, groups_changed = ?, events = ?, error = ? WHERE id = ?")
      .run(nowIso(), result.ok ? 1 : 0, result.groupsTotal, result.groupsChanged, result.events, result.error ?? null, id);
  }

  lastPollRun(): { startedAt: string; finishedAt: string | null; ok: boolean | null; groupsTotal: number | null; groupsChanged: number | null; events: number | null; error: string | null } | null {
    const r = this.db.prepare("SELECT * FROM poll_runs ORDER BY id DESC LIMIT 1").get() as
      | { started_at: string; finished_at: string | null; ok: number | null; groups_total: number | null; groups_changed: number | null; events: number | null; error: string | null }
      | undefined;
    if (!r) return null;
    return { startedAt: r.started_at, finishedAt: r.finished_at, ok: r.ok === null ? null : r.ok === 1, groupsTotal: r.groups_total, groupsChanged: r.groups_changed, events: r.events, error: r.error };
  }
}
