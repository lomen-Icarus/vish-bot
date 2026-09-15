import type { Api, RawApi } from "grammy";
import { GrammyError, InlineKeyboard, InputFile } from "grammy";
import type { Repo, User } from "../db/repo.js";
import type { ScheduleService } from "../schedule/service.js";
import type { ChangeEvent } from "../schedule/diff.js";
import { clampHtml, formatChanges, formatDay, formatNotice, filterSubgroup } from "../schedule/format.js";
import { isSessionPeriod, lessonTypeLabel, type Occurrence } from "../schedule/model.js";
import { fmtHHMM, parseHHMM, sleep, todayMsk, wallClock, addDays, type LocalDate, type WallClock } from "../time.js";
import { logger } from "../logger.js";
import type { Renderer } from "../render/image.js";
import { WEBINAR_URL } from "../bot/keyboards.js";
import type { WebinarService } from "../portal/webinars.js";

export interface SendOptions {
  photo?: Buffer;
  kind: string;
  silent?: boolean;
  replyMarkup?: InlineKeyboard;
}

export class Notifier {
  constructor(
    private readonly api: Api<RawApi>,
    private readonly repo: Repo,
    private readonly service: ScheduleService,
    private readonly renderer: Renderer | null,
    private readonly adminIds: number[] = [],
    private readonly webinars: WebinarService | null = null,
  ) {}

  async send(user: User, html: string, opts: SendOptions): Promise<boolean> {
    try {
      if (opts.photo) {
        const short = html.length <= 1000;
        await this.api.sendPhoto(user.id, new InputFile(opts.photo, "schedule.png"), { caption: short ? html : undefined, parse_mode: "HTML", disable_notification: opts.silent, reply_markup: short ? opts.replyMarkup : undefined });
        if (!short) await this.api.sendMessage(user.id, html, { parse_mode: "HTML", disable_notification: true, reply_markup: opts.replyMarkup });
      } else {
        await this.api.sendMessage(user.id, html, { parse_mode: "HTML", disable_notification: opts.silent, reply_markup: opts.replyMarkup });
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
  async dispatchChangeEvents(now: WallClock = wallClock()): Promise<number> {
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
      const idByEvent = new Map<ChangeEvent, number>();
      list.forEach((r, i) => idByEvent.set(events[i]!, r.id));
      for (const { user, events: evs } of recipients.values()) {
        const own = user.groupKey === groupKey;
        const mine = own
          ? evs.filter((e) => {
              const sg = e.after?.subgroup ?? e.before?.subgroup ?? null;
              return !user.subgroup || sg == null || sg === user.subgroup;
            })
          : evs;
        // The once-a-minute backlog pass may have taken an event first.
        const fresh = mine.filter((e) => {
          const id = idByEvent.get(e);
          return id == null || !this.repo.reminderSent(user.id, "event", String(id));
        });
        if (!fresh.length) continue;
        // Quiet hours only postpone: the backlog below delivers them when the quiet window ends.
        if (this.inQuietHours(user, now)) continue;
        for (const e of fresh) {
          const id = idByEvent.get(e);
          if (id != null) this.repo.markReminderSent(user.id, "event", String(id));
        }
        const text = formatChanges(group, fresh);
        // Own group: one tap re-imports just the changed lessons into the phone calendar.
        // Watched group: one tap stops these notifications.
        const kb = own ? new InlineKeyboard().text("📆 Обновить в календаре", `cics:${groupKey}`) : new InlineKeyboard().text("👁 Не следить за группой", `unwatch:${groupKey}`);
        if (await this.send(user, clampHtml(text), { kind: "changes", replyMarkup: kb })) delivered++;
      }
      this.repo.markEventsNotified(list.map((r) => r.id));
    }
    return delivered;
  }

  /**
   * Change events that were not delivered because the user was in quiet hours.
   * They stay in `change_events` for two weeks, so once the quiet window ends
   * every event the user has not been marked for is sent in one message.
   */
  async flushQuietBacklog(now: WallClock = wallClock()): Promise<number> {
    // Only events created after the first run are eligible, so enabling this
    // never re-sends what was already delivered before the update.
    const since = this.repo.getMeta("backlog:since");
    if (!since) {
      this.repo.setMeta("backlog:since", new Date().toISOString());
      return 0;
    }
    let sent = 0;
    for (const user of this.repo.listUsers({ onlyActive: true })) {
      if (!user.groupKey || !user.notifyChanges) continue;
      // Only users with quiet hours can have a backlog, and only right after
      // the window ends: otherwise this would scan every user every minute.
      if (!user.quietFrom || !user.quietTo) continue;
      if (this.inQuietHours(user, now)) continue;
      const to = parseHHMM(user.quietTo);
      if (to == null) continue;
      const sinceEnd = (now.minutes - to + 1440) % 1440;
      if (sinceEnd > 120) continue;
      const group = this.service.group(user.groupKey);
      if (!group) continue;
      // Only events the normal pass has already gone through: anything newer is
      // still on its way there, and sending it here would duplicate it.
      // The limit is applied in SQL, so it has to be wider than what one night can produce.
      const rows = this.repo.activeEvents(user.groupKey, now.date, 200).filter((r) => r.notified && r.createdAt >= since && !this.repo.reminderSent(user.id, "event", String(r.id)));
      if (!rows.length) continue;
      const events: ChangeEvent[] = rows.map((r) => {
        const p = r.payload as { before?: Occurrence; after?: Occurrence; fields?: string[] };
        return { kind: r.kind as ChangeEvent["kind"], groupKey: r.groupKey, date: r.date, period: r.period, before: p.before, after: p.after, fields: p.fields };
      });
      const mine = events.filter((e) => {
        if (isSessionPeriod(e.period) && !user.notifySession) return false;
        const sg = e.after?.subgroup ?? e.before?.subgroup ?? null;
        return !user.subgroup || sg == null || sg === user.subgroup;
      });
      for (const r of rows) this.repo.markReminderSent(user.id, "event", String(r.id));
      if (!mine.length) continue;
      const kb = new InlineKeyboard().text("📆 Обновить в календаре", `cics:${user.groupKey}`);
      const text = `🌙 <i>Пока у тебя были тихие часы, расписание изменилось.</i>\n\n${formatChanges(group, mine)}`;
      if (await this.send(user, clampHtml(text), { kind: "changes-backlog", replyMarkup: kb })) sent++;
    }
    return sent;
  }

  inQuietHours(user: User, now: WallClock = wallClock()): boolean {
    if (!user.quietFrom || !user.quietTo) return false;
    const from = parseHHMM(user.quietFrom);
    const to = parseHHMM(user.quietTo);
    if (from == null || to == null) return false;
    if (from <= to) return now.minutes >= from && now.minutes < to;
    return now.minutes >= from || now.minutes < to;
  }

  /** Runs every minute: first-lesson, per-lesson, distance-link and evening reminders. */
  async tickReminders(now: WallClock = wallClock()): Promise<number> {
    const users = this.repo.listUsers({ onlyActive: true }).filter((u) => u.groupKey && (u.remindFirstMin != null || u.remindEachMin != null || u.remindDistanceMin != null || u.eveningAt));
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
            const text = `⏱ Через ${humanMinutes(left)} — <b>${escapeHtml(o.subject)}</b> (${escapeHtml(lessonTypeLabel(o.type))})${where ? `, ${escapeHtml(where)}` : ""} · ${fmtHHMM(o.start!)}${o.end != null ? `–${fmtHHMM(o.end)}` : ""}`;
            const kb = o.isDistance ? new InlineKeyboard().url("💻 Вебинары портала", WEBINAR_URL) : undefined;
            if (await this.send(user, text, { kind: "remind-each", replyMarkup: kb })) sent++;
          }
        }
      }

      // Distance lessons: a separate short ping with the webinar link, independent of the per-lesson reminder.
      if (user.remindDistanceMin != null) {
        for (const o of today) {
          if (!o.isDistance) continue;
          const due = o.start! - user.remindDistanceMin;
          const ref = `distance|${o.date}|${o.slot ?? o.start}|${o.subgroup ?? ""}`;
          if (now.minutes >= due && now.minutes < o.start! && !this.repo.reminderSent(user.id, "distance", ref)) {
            this.repo.markReminderSent(user.id, "distance", ref);
            const left = o.start! - now.minutes;
            // The webinar page names the teacher and the topic of the session; add them when known.
            const w = this.webinars?.forLesson(o, [group.title, ...group.portalNames]) ?? null;
            const extra = [w?.teacher ? escapeHtml(w.teacher) : "", w?.title ? `📝 ${escapeHtml(w.title.length > 120 ? w.title.slice(0, 117).trimEnd() + "…" : w.title)}` : ""].filter(Boolean);
            const text = `💻 ${left <= 1 ? "Сейчас начинается" : `Через ${humanMinutes(left)}`} дистант — <b>${escapeHtml(o.subject)}</b> (${escapeHtml(lessonTypeLabel(o.type))}) · ${fmtHHMM(o.start!)}${o.end != null ? `–${fmtHHMM(o.end)}` : ""}${extra.length ? `\n${extra.join("\n")}` : ""}\nВебинар: ${WEBINAR_URL}`;
            if (await this.send(user, text, { kind: "remind-distance", replyMarkup: new InlineKeyboard().url("💻 Вебинары портала", WEBINAR_URL) })) sent++;
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
      return await this.renderer.renderDay({ group, date, lessons, weekInfo: this.service.weekInfo(date), today: todayMsk(), now, theme: user.posterTheme ?? undefined });
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
