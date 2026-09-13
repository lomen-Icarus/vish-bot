import type { Api, RawApi } from "grammy";
import { GrammyError, InputFile } from "grammy";
import type { Repo, User } from "../db/repo.js";
import type { ScheduleService } from "../schedule/service.js";
import type { ChangeEvent } from "../schedule/diff.js";
import { formatChanges, formatDay, formatNotice, filterSubgroup } from "../schedule/format.js";
import { isSessionPeriod, type Occurrence } from "../schedule/model.js";
import { fmtHHMM, parseHHMM, sleep, todayMsk, wallClock, addDays, type LocalDate, type WallClock } from "../time.js";
import { logger } from "../logger.js";
import type { Renderer } from "../render/image.js";

export class Notifier {
  constructor(
    private readonly api: Api<RawApi>,
    private readonly repo: Repo,
    private readonly service: ScheduleService,
    private readonly renderer: Renderer | null,
    private readonly adminIds: number[] = [],
  ) {}

  async send(user: User, html: string, opts: { photo?: Buffer; kind: string; silent?: boolean }): Promise<boolean> {
    try {
      if (opts.photo) {
        await this.api.sendPhoto(user.id, new InputFile(opts.photo, "schedule.png"), { caption: html.length <= 1000 ? html : undefined, parse_mode: "HTML", disable_notification: opts.silent });
        if (html.length > 1000) await this.api.sendMessage(user.id, html, { parse_mode: "HTML", disable_notification: true });
      } else {
        await this.api.sendMessage(user.id, html, { parse_mode: "HTML", disable_notification: opts.silent });
      }
      this.repo.logNotification(user.id, opts.kind, true);
      await sleep(35);
      return true;
    } catch (err) {
      const msg = err instanceof GrammyError ? err.description : String(err);
      this.repo.logNotification(user.id, opts.kind, false, msg.slice(0, 200));
      if (err instanceof GrammyError && (err.error_code === 403 || /chat not found|deactivated/i.test(err.description))) {
        this.repo.updateUser(user.id, { blocked: true });
        logger.info({ userId: user.id }, "user unreachable, marked blocked");
      } else {
        logger.warn({ err: msg, userId: user.id }, "notification failed");
      }
      return false;
    }
  }

  /** Deliver every stored, not-yet-notified change event. */
  async dispatchChangeEvents(): Promise<number> {
    const rows = this.repo.unnotifiedEvents();
    if (rows.length === 0) return 0;
    let delivered = 0;
    const byGroup = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byGroup.get(r.groupKey) ?? [];
      list.push(r);
      byGroup.set(r.groupKey, list);
    }
    for (const [groupKey, list] of byGroup) {
      if (groupKey === "*") {
        // Portal banner changes go to admins (who can broadcast them) and to users who opted in.
        const notice = list[list.length - 1]!;
        const text = formatNotice((notice.payload as { text: string }).text);
        const targets = new Map<number, User>();
        for (const id of this.adminIds) {
          const u = this.repo.getUser(id);
          if (u) targets.set(u.id, u);
        }
        for (const u of this.repo.listUsers({ onlyActive: true })) if (u.notifyNotices) targets.set(u.id, u);
        for (const u of targets.values()) if (await this.send(u, text, { kind: "notice" })) delivered++;
        this.repo.markEventsNotified(list.map((r) => r.id));
        continue;
      }
      const group = this.service.group(groupKey);
      if (!group) {
        this.repo.markEventsNotified(list.map((r) => r.id));
        continue;
      }
      const events: ChangeEvent[] = list.map((r) => {
        const p = r.payload as { before?: Occurrence; after?: Occurrence; fields?: string[] };
        return { kind: r.kind as ChangeEvent["kind"], groupKey: r.groupKey, date: r.date, period: r.period, before: p.before, after: p.after, fields: p.fields };
      });
      const semesterEvents = events.filter((e) => !isSessionPeriod(e.period));
      const sessionEvents = events.filter((e) => isSessionPeriod(e.period));
      const recipients = new Map<number, { user: User; events: ChangeEvent[] }>();
      if (semesterEvents.length) for (const u of this.repo.usersForGroupChanges(groupKey, false)) recipients.set(u.id, { user: u, events: [...semesterEvents] });
      if (sessionEvents.length)
        for (const u of this.repo.usersForGroupChanges(groupKey, true)) {
          const r = recipients.get(u.id);
          if (r) r.events.push(...sessionEvents);
          else recipients.set(u.id, { user: u, events: [...sessionEvents] });
        }
      for (const { user, events: evs } of recipients.values()) {
        const mine = evs.filter((e) => {
          const sg = e.after?.subgroup ?? e.before?.subgroup ?? null;
          return !user.subgroup || sg == null || sg === user.subgroup;
        });
        if (!mine.length) continue;
        if (this.inQuietHours(user)) continue; // silently skipped; the /changes view still shows them
        const text = formatChanges(group, mine);
        if (await this.send(user, text.length > 4000 ? text.slice(0, 3990) + "…" : text, { kind: "changes" })) delivered++;
      }
      this.repo.markEventsNotified(list.map((r) => r.id));
    }
    return delivered;
  }

  inQuietHours(user: User, now: WallClock = wallClock()): boolean {
    if (!user.quietFrom || !user.quietTo) return false;
    const from = parseHHMM(user.quietFrom);
    const to = parseHHMM(user.quietTo);
    if (from == null || to == null) return false;
    if (from <= to) return now.minutes >= from && now.minutes < to;
    return now.minutes >= from || now.minutes < to;
  }

  /** Runs every minute: first-lesson, per-lesson and evening reminders. */
  async tickReminders(now: WallClock = wallClock()): Promise<number> {
    const users = this.repo.listUsers({ onlyActive: true }).filter((u) => u.groupKey && (u.remindFirstMin != null || u.remindEachMin != null || u.eveningAt));
    if (users.length === 0) return 0;
    const cache = new Map<string, Occurrence[]>();
    const lessonsFor = (groupKey: string, date: LocalDate): Occurrence[] => {
      const k = `${groupKey}|${date}`;
      let list = cache.get(k);
      if (!list) {
        const g = this.service.group(groupKey);
        list = g ? this.service.lessonsOn(g, date).filter((o) => o.status === "scheduled" && o.start != null) : [];
        cache.set(k, list);
      }
      return list;
    };
    let sent = 0;
    for (const user of users) {
      const group = this.service.group(user.groupKey!);
      if (!group) continue;
      if (this.inQuietHours(user, now)) continue;
      const today = filterSubgroup(lessonsFor(group.key, now.date), user.subgroup);

      if (user.remindFirstMin != null && today.length) {
        const first = Math.min(...today.map((o) => o.start!));
        const due = first - user.remindFirstMin;
        if (now.minutes >= due && now.minutes < first && !this.repo.reminderSent(user.id, "first", now.date)) {
          const left = first - now.minutes;
          const head = `⏰ ${left <= 1 ? "Сейчас начинается" : `Через ${humanMinutes(left)}`} первая пара`;
          const body = formatDay(group, now.date, lessonsFor(group.key, now.date), this.service.weekInfo(now.date), now.date, { subgroup: user.subgroup, now });
          this.repo.markReminderSent(user.id, "first", now.date);
          const photo = await this.maybeRenderDay(user, group, now.date, today, now);
          if (await this.send(user, `${head}\n\n${body}`, { kind: "remind-first", photo })) sent++;
        }
      }

      if (user.remindEachMin != null) {
        for (const o of today) {
          const due = o.start! - user.remindEachMin;
          const ref = `${o.date}|${o.slot ?? o.start}|${o.subgroup ?? ""}`;
          if (now.minutes >= due && now.minutes < o.start! && !this.repo.reminderSent(user.id, "each", ref)) {
            this.repo.markReminderSent(user.id, "each", ref);
            const left = o.start! - now.minutes;
            const where = o.isDistance ? "💻 дистанционно" : o.room ? `ауд. ${o.room}` : "";
            const text = `⏱ Через ${humanMinutes(left)} — <b>${escapeHtml(o.subject)}</b> (${o.type})${where ? `, ${escapeHtml(where)}` : ""} · ${fmtHHMM(o.start!)}${o.end != null ? `–${fmtHHMM(o.end)}` : ""}`;
            if (await this.send(user, text, { kind: "remind-each" })) sent++;
          }
        }
      }

      if (user.eveningAt) {
        const at = parseHHMM(user.eveningAt);
        if (at != null && now.minutes >= at && now.minutes < at + 15 && !this.repo.reminderSent(user.id, "evening", now.date)) {
          const tomorrow = addDays(now.date, 1);
          const list = filterSubgroup(lessonsFor(group.key, tomorrow), user.subgroup);
          this.repo.markReminderSent(user.id, "evening", now.date);
          if (list.length) {
            const body = formatDay(group, tomorrow, lessonsFor(group.key, tomorrow), this.service.weekInfo(tomorrow), now.date, { subgroup: user.subgroup });
            const photo = await this.maybeRenderDay(user, group, tomorrow, list, now);
            if (await this.send(user, `🌙 Завтра:\n\n${body}`, { kind: "remind-evening", photo })) sent++;
          }
        }
      }
    }
    return sent;
  }

  private async maybeRenderDay(user: User, group: ReturnType<ScheduleService["group"]>, date: LocalDate, lessons: Occurrence[], now: WallClock): Promise<Buffer | undefined> {
    if (!this.renderer || !group || user.format === "text") return undefined;
    try {
      return await this.renderer.renderDay({ group, date, lessons, weekInfo: this.service.weekInfo(date), today: todayMsk(), now });
    } catch (err) {
      logger.warn({ err }, "reminder image render failed");
      return undefined;
    }
  }
}

function humanMinutes(min: number): string {
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  const hw = h === 1 ? "час" : h < 5 ? "часа" : "часов";
  return m ? `${h} ${hw} ${m} мин` : `${h} ${hw}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
