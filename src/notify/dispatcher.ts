import type { Api, RawApi } from "grammy";
import { GrammyError, InlineKeyboard, InputFile, InputMediaBuilder } from "grammy";
import type { ChangeEventRow, Repo, User } from "../db/repo.js";
import type { ScheduleService } from "../schedule/service.js";
import type { ChangeEvent } from "../schedule/diff.js";
import { captionFits, esc as escapeHtml, formatDay, formatNotice, filterSubgroup, plural } from "../schedule/format.js";
import { isSessionPeriod, lessonTypeLabel, type Occurrence } from "../schedule/model.js";
import { fmtHHMM, parseHHMM, sleep, todayMsk, wallClock, addDays, type LocalDate, type WallClock } from "../time.js";
import { logger } from "../logger.js";
import type { Renderer } from "../render/image.js";
import { WEBINAR_URL } from "../bot/keyboards.js";
import type { WebinarService } from "../portal/webinars.js";
import type { TeacherService } from "../portal/teachers.js";
import { logicalKeyFor, personGroup, type LogicalGroup } from "../schedule/groups.js";
import { parseRefKey } from "../people/ref.js";
import { webinarRowsToLessons } from "../people/profile.js";
import { readFileSync } from "node:fs";
import { isUnreachable } from "../bot/errors.js";
import { sameSubject } from "../chat/social.js";
import { deckFileName } from "./deckName.js";
import { changeDays, changesCaption, changesMessage, changesMessageFit, forSubgroup, MAX_LATER_POSTERS, splitByToday, type ChangesInput } from "./changes.js";
import { ChangePosters, dayLessonsFor } from "./changePosters.js";
import { startLink } from "../bot/deeplink.js";

/**
 * Тормоз массовой рассылки. Столько изменений за раз в живом расписании не
 * бывает — это сбой портала или смена разбора: такую пачку не рассылаем, а
 * спрашиваем админов (кнопки «Разослать» / «Не рассылать»).
 */
export const MASS_CHANGES_TOTAL = 40;
export const MASS_CHANGES_PER_GROUP = 25;
/** Мета-ключи тормоза: «придержано с …» и «админ разрешил разослать». */
export const CHANGES_HELD_KEY = "changes:held";
export const CHANGES_RELEASE_KEY = "changes:release";
/** Пачка изменений подозрительно большая (см. MASS_CHANGES_*). */
export function isMassChange(rows: Array<{ groupKey: string }>): boolean {
  if (rows.length >= MASS_CHANGES_TOTAL) return true;
  const per = new Map<string, number>();
  for (const r of rows) per.set(r.groupKey, (per.get(r.groupKey) ?? 0) + 1);
  return Math.max(0, ...per.values()) >= MASS_CHANGES_PER_GROUP;
}

interface ChangeDelivery {
  now: WallClock;
  /** Своя группа человека (по ней — фильтр подгруппы), а не отслеживаемая. */
  own: boolean;
  kind: string;
  /** Строка перед уведомлением (например, «пока были тихие часы…»). */
  head: string;
  kb: InlineKeyboard;
}

/** За сколько минут до первой пары преподавателя писать подписчикам. */
const TEACHER_LEAD_MIN = 120;
/** Во сколько присылать «завтра у него», если у человека не задан свой вечер. */
const TEACHER_EVENING_AT = "20:00";
/** Раньше этого времени первых пар не бывает, так что до 8:00 − лид ходить на портал незачем. */
const EARLIEST_LESSON_START = 8 * 60;
/** Сколько «холодных» преподавателей за тик разрешено подтянуть с портала. */
const TEACHER_COLD_PER_TICK = 5;
/** Сколько живёт разобранный день преподавателя (неудачный поход — заметно меньше). */
const TEACHER_DAY_TTL_MS = 3 * 60 * 60 * 1000;
const TEACHER_DAY_FAIL_TTL_MS = 15 * 60 * 1000;

/** Окно в пять минут: тик ежеминутный, но пропущенная минута не должна съесть уведомление. */
function withinWindow(nowMinutes: number, dueMinutes: number, width = 5): boolean {
  return nowMinutes >= dueMinutes && nowMinutes < dueMinutes + width;
}

/** Расписание преподавателя печатается тем же форматтером, что и группа. */
function teacherPseudoGroup(name: string): LogicalGroup {
  return { key: `teacher:${name}`, title: name, prefix: "", number: 0, intake: 0, course: 0, portalIds: [], portalNames: [] };
}

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
    private readonly teachers: TeacherService | null = null,
    /** Для ссылок «t.me/бот?start=…» в подписи к альбому (у альбома нет кнопок). */
    private readonly botUsername: string | null = null,
  ) {}

  /**
   * Слайды записанного вебинара: PDF уходит тем, у кого эта пара в расписании
   * и кто включил слайды в настройках, и в темы групповых чатов, подписанные
   * на этот предмет («@бот сюда слайды по физике»). Первому получателю файл
   * загружается, остальным — по file_id, чтобы не гонять один и тот же PDF
   * через сеть десятки раз.
   */
  async sendSlideDeck(deck: { deckId: number; date: string; subject: string; teacher: string | null; title: string | null; groups: string[]; slides: number; file: string }, now: WallClock = wallClock()): Promise<number> {
    const keys = new Set(deck.groups.map((g) => logicalKeyFor(g)));
    const users = this.repo.listUsers({ onlyActive: true }).filter((u) => u.wantSlides && u.groupKey && keys.has(u.groupKey));
    // Подписки чатов: тот же предмет (с поправкой на «Физика» / «Физика лекция»:
    // подписку могли сделать по названию из расписания, а слайды подписаны по
    // странице вебинаров) и либо любая группа, либо одна из групп пары.
    const seen = new Set<string>();
    const chats = this.repo.slideSubs().filter((s) => {
      const key = `${s.chatId}|${s.threadId ?? 0}`;
      if (!sameSubject(s.subject, deck.subject) || (s.groupKey && !keys.has(s.groupKey)) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!users.length && !chats.length) {
      logger.info({ deckId: deck.deckId, groups: deck.groups }, "слайды никому не нужны: ни людей из этих групп, ни подписанных чатов");
      this.repo.markDeckSent(deck.deckId, null, 0);
      return 0;
    }
    const bytes = (() => {
      try {
        return readFileSync(deck.file);
      } catch (err) {
        logger.warn({ err: String(err), file: deck.file }, "файл слайдов не читается");
        return null;
      }
    })();
    if (!bytes) {
      this.repo.markDeckSent(deck.deckId, null, 0);
      return 0;
    }
    const caption = [
      `📎 <b>Слайды пары</b>`,
      `${escapeHtml(deck.subject)}${deck.teacher ? ` · ${escapeHtml(deck.teacher)}` : ""}`,
      `${escapeHtml(deck.date)}${deck.title ? ` · ${escapeHtml(deck.title.slice(0, 80))}` : ""} · ${deck.slides} ${plural(deck.slides, "слайд", "слайда", "слайдов")}`,
      "",
      "<i>Снято ботом прямо с вебинара. Если препод показывал не всё — значит, не всё и записалось.</i>",
    ]
      .join("\n")
      // Подпись к документу у Telegram ограничена 1024 символами, а предмет и
      // тема приезжают снаружи и бывают длинными.
      .slice(0, 1000);
    const name = deckFileName(deck);
    let fileId: string | null = null;
    let sent = 0;
    for (const sub of chats) {
      try {
        const msg = await this.api.sendDocument(sub.chatId, fileId ?? new InputFile(bytes, name), {
          caption,
          parse_mode: "HTML",
          ...(sub.threadId ? { message_thread_id: sub.threadId } : {}),
        });
        fileId ??= msg.document?.file_id ?? null;
        sent++;
        await sleep(45);
      } catch (err) {
        const text = err instanceof GrammyError ? err.description : String(err);
        logger.warn({ err: text.slice(0, 200), chat: sub.chatId, thread: sub.threadId }, "слайды в чат не ушли");
        // Тему удалили — подписка этой темы больше не нужна (закрытую тему
        // могут открыть снова — её не трогаем); бота выгнали или группа стала
        // супергруппой с новым id — все подписки чата: старого id больше нет.
        if (/thread not found|topic_deleted/i.test(text)) this.repo.removeSlideSubs(sub.chatId, sub.threadId);
        else if (isUnreachable(err) || /upgraded to a supergroup/i.test(text)) this.repo.removeSlideSubs(sub.chatId);
      }
    }
    for (const user of users) {
      try {
        const quiet = this.inQuietHours(user, now);
        const msg = await this.api.sendDocument(user.id, fileId ?? new InputFile(bytes, name), {
          caption,
          parse_mode: "HTML",
          disable_notification: quiet,
        });
        fileId ??= msg.document?.file_id ?? null;
        this.repo.logNotification(user.id, "slides", true);
        sent++;
        await sleep(45);
      } catch (err) {
        const msg = err instanceof GrammyError ? err.description : String(err);
        this.repo.logNotification(user.id, "slides", false, msg.slice(0, 200));
        // Telegram отдаёт «удалённый аккаунт» и «чат не найден» кодом 400,
        // а не 403 — считаем их такой же недоступностью, как и блокировку.
        if (isUnreachable(err)) this.repo.updateUser(user.id, { blocked: true });
      }
    }
    this.repo.markDeckSent(deck.deckId, fileId, sent);
    logger.info({ deckId: deck.deckId, sent, of: users.length + chats.length, chats: chats.length }, "слайды разосланы");
    return sent;
  }

  /** Расписание преподавателя на день, с кешем: портал медленный, а тик — ежеминутный. */
  private readonly teacherDayCache = new Map<string, { at: number; lessons: Occurrence[]; fullName: string | null; ok: boolean }>();

  /** Свежий ли кеш — тот же вопрос, что и в teacherDay, но без похода на портал. */
  private teacherDayFresh(teacherId: number, date: LocalDate): boolean {
    const hit = this.teacherDayCache.get(`${teacherId}|${date}`);
    return !!hit && Date.now() - hit.at < (hit.ok ? TEACHER_DAY_TTL_MS : TEACHER_DAY_FAIL_TTL_MS);
  }

  /** null — портал не ответил: это не «пар нет», такое напоминание слать нельзя. */
  private async teacherDay(teacherId: number, name: string, date: LocalDate): Promise<{ lessons: Occurrence[]; fullName: string | null } | null> {
    const key = `${teacherId}|${date}`;
    const hit = this.teacherDayCache.get(key);
    // Неудачу кешируем тоже, только ненадолго. Без этого каждый минутный тик
    // заново идёт в портал по всем отслеживаемым преподавателям, а один поход
    // при 403 тянется до минуты (три попытки с паузами) — тик не успевает
    // закончиться, protect:true глотает следующие, и встают все напоминания.
    if (this.teacherDayFresh(teacherId, date)) return hit!.ok ? hit! : null;
    if (!this.teachers) return null;
    let entry: { at: number; lessons: Occurrence[]; fullName: string | null; ok: boolean };
    try {
      const res = await this.teachers.lessons({ id: teacherId, name }, date, date);
      entry = { at: Date.now(), lessons: res.lessons.filter((o) => o.status === "scheduled" && o.start != null), fullName: res.fullName, ok: true };
    } catch (err) {
      logger.warn({ err: String(err), teacherId }, "teacher day for watchers failed");
      entry = { at: Date.now(), lessons: [], fullName: null, ok: false };
    }
    this.teacherDayCache.set(key, entry);
    // Кеш живёт в памяти процесса: чистим вчерашнее, чтобы не рос вечно.
    for (const k of [...this.teacherDayCache.keys()]) if (k.split("|")[1]! < addDays(date, -1)) this.teacherDayCache.delete(k);
    return entry.ok ? entry : null;
  }

  /**
   * Слежение за преподавателем: вечером — его завтрашний день, и ещё раз за два
   * часа до его первой пары. Портал дёргаем один раз на преподавателя, а не на
   * каждого подписчика.
   */
  async tickTeacherWatches(now: WallClock = wallClock()): Promise<number> {
    if (!this.teachers) return 0;
    const watched = this.repo.teacherWatchers();
    if (!watched.length) return 0;
    const tomorrow = addDays(now.date, 1);
    // Утреннее напоминание живёт в окне [первая пара − лид, первая пара), а первых пар
    // раньше 8:00 не бывает: ночью расписание на сегодня не нужно никому.
    const mayBeMorning = now.minutes >= EARLIEST_LESSON_START - TEACHER_LEAD_MIN;
    let cold = TEACHER_COLD_PER_TICK;
    let sent = 0;
    for (const w of watched) {
      const users = w.userIds.map((id) => this.repo.getUser(id)).filter((u): u is User => !!u && !u.blocked);
      if (!users.length) continue;
      const eveningDue = users.some((u) => withinWindow(now.minutes, parseHHMM(u.eveningAt ?? TEACHER_EVENING_AT) ?? 20 * 60));
      if (!eveningDue && !mayBeMorning) continue;
      // В ключе кеша есть дата, поэтому в полночь (и при рестарте) он холодный сразу у
      // всех. Один поход — две страницы портала, между запросами 900 мс, так что
      // холодные растягиваем по тикам: окно утреннего напоминания широкое, успеем.
      // Вечернее окно узкое (пять минут) — его не откладываем никогда.
      if (!eveningDue && !this.teacherDayFresh(w.teacherId, now.date)) {
        if (cold <= 0) continue;
        cold--;
      }
      const dayLessons = mayBeMorning ? await this.teacherDay(w.teacherId, w.name, now.date) : null;
      const today = dayLessons?.lessons ?? [];
      const first = today.length ? Math.min(...today.map((o) => o.start!)) : null;
      const morningDue = first != null && now.minutes >= first - TEACHER_LEAD_MIN && now.minutes < first;
      if (!eveningDue && !morningDue) continue;
      const evening = eveningDue ? await this.teacherDay(w.teacherId, w.name, tomorrow) : null;
      for (const user of users) {
        if (this.inQuietHours(user, now)) continue;
        const name = dayLessons?.fullName ?? evening?.fullName ?? w.name;
        if (morningDue && !this.repo.reminderSent(user.id, "teacher-first", `${w.teacherId}:${now.date}`)) {
          this.repo.markReminderSent(user.id, "teacher-first", `${w.teacherId}:${now.date}`);
          const body = formatDay(teacherPseudoGroup(name), now.date, today, this.service.weekInfo(now.date), now.date, { now });
          const left = first! - now.minutes;
          if (await this.send(user, `👨‍🏫 ${left <= 1 ? "Сейчас начинается" : `Через ${humanMinutes(left)}`} первая пара у <b>${escapeHtml(name)}</b>\n\n${body}`, { kind: "teacher-first" })) sent++;
        }
        const userEvening = withinWindow(now.minutes, parseHHMM(user.eveningAt ?? TEACHER_EVENING_AT) ?? 20 * 60);
        // Пустой день не шлём вовсе: у преподавателя он может быть и просто свободным,
        // а ещё так «пар нет» не запишется в дедуп вместо неполученного расписания.
        if (userEvening && evening?.lessons.length && !this.repo.reminderSent(user.id, "teacher-evening", `${w.teacherId}:${tomorrow}`)) {
          this.repo.markReminderSent(user.id, "teacher-evening", `${w.teacherId}:${tomorrow}`);
          const body = formatDay(teacherPseudoGroup(name), tomorrow, evening.lessons, this.service.weekInfo(tomorrow), now.date, {});
          if (await this.send(user, `👨‍🏫 <b>${escapeHtml(name)}</b> завтра:\n\n${body}`, { kind: "teacher-evening", silent: true })) sent++;
        }
      }
    }
    return sent;
  }

  async send(user: User, html: string, opts: SendOptions): Promise<boolean> {
    try {
      if (opts.photo) {
        // Лимит подписи Telegram считает по видимому тексту, без разметки.
        const short = captionFits(html);
        await this.api.sendPhoto(user.id, new InputFile(opts.photo, "schedule.png"), { caption: short ? html : undefined, parse_mode: "HTML", disable_notification: opts.silent, reply_markup: short ? opts.replyMarkup : undefined });
        if (!short) await this.api.sendMessage(user.id, html, { parse_mode: "HTML", disable_notification: true, reply_markup: opts.replyMarkup });
      } else {
        await this.api.sendMessage(user.id, html, { parse_mode: "HTML", disable_notification: opts.silent, reply_markup: opts.replyMarkup });
      }
      this.repo.logNotification(user.id, opts.kind, true);
      await sleep(35);
      return true;
    } catch (err) {
      this.sendFailed(user, opts.kind, err);
      return false;
    }
  }

  /** Неудачная отправка: в журнал, а недоступного (заблокировал бота) — пометить. */
  private sendFailed(user: User, kind: string, err: unknown): void {
    const msg = err instanceof GrammyError ? err.description : String(err);
    this.repo.logNotification(user.id, kind, false, msg.slice(0, 200));
    if (isUnreachable(err)) {
      this.repo.updateUser(user.id, { blocked: true });
      logger.info({ userId: user.id }, "user unreachable, marked blocked");
    } else {
      logger.warn({ err: msg, userId: user.id }, "notification failed");
    }
  }

  /** Идёт ли рассылка изменений прямо сейчас (два прохода разом разослали бы дважды). */
  private dispatching = false;

  /** Deliver every stored, not-yet-notified change event. */
  async dispatchChangeEvents(now: WallClock = wallClock()): Promise<number> {
    if (this.dispatching) return 0;
    this.dispatching = true;
    try {
      return await this.dispatchChangeEventsOnce(now);
    } finally {
      this.dispatching = false;
    }
  }

  private async dispatchChangeEventsOnce(now: WallClock): Promise<number> {
    this.posters.clear();
    let rows = this.repo.unnotifiedEvents();
    if (rows.length === 0) return 0;
    // Подозрительно большая пачка — не рассылаем, пока админ не решит.
    const released = this.repo.getMeta(CHANGES_RELEASE_KEY) === "1";
    const lessonRows = rows.filter((r) => r.groupKey !== "*");
    if (lessonRows.length && !released && isMassChange(lessonRows)) {
      await this.holdMassChange(lessonRows);
      rows = rows.filter((r) => r.groupKey === "*");
      if (!rows.length) return 0;
    }
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
        // Объявления портала меняются и ночью (опрос идёт круглосуточно): в тихие часы — без звука.
        for (const u of targets.values()) if (await this.send(u, text, { kind: "notice", silent: this.inQuietHours(u, now) })) delivered++;
        this.repo.markEventsNotified(list.map((r) => r.id));
        continue;
      }
      const group = this.service.group(groupKey);
      if (!group) {
        this.repo.markEventsNotified(list.map((r) => r.id));
        continue;
      }
      // По порядку появления: у одной пары последнее изменение главнее (markDay).
      list.sort((a, b) => a.id - b.id);
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
        const mine = own ? forSubgroup(evs, user.subgroup) : evs;
        // The once-a-minute backlog pass may have taken an event first.
        const fresh = mine.filter((e) => {
          const id = idByEvent.get(e);
          return id == null || !this.repo.reminderSent(user.id, "event", String(id));
        });
        if (!fresh.length) continue;
        // Quiet hours only postpone: the backlog below delivers them when the quiet window ends.
        if (this.inQuietHours(user, now)) continue;
        // Файл с изменениями предлагаем сразу в уведомлении — и по своей группе,
        // и по той, за которой человек просто следит: одно нажатие, и в календаре
        // телефона обновлены ровно изменившиеся пары.
        const kb = new InlineKeyboard().text("📆 Файл изменений в календарь", `cics:${groupKey}`);
        if (!own) kb.row().text("👁 Не следить за группой", `unwatch:${groupKey}`);
        // Пометку ставим только после успешной отправки: иначе одна сетевая
        // осечка навсегда прячет изменение и от основного прохода, и от добора.
        const done = await this.deliverChanges(user, group, fresh, { now, own, kind: "changes", head: "", kb });
        if (done.length) {
          delivered++;
          for (const e of done) {
            const id = idByEvent.get(e);
            if (id != null) this.repo.markReminderSent(user.id, "event", String(id));
          }
        }
      }
      this.repo.markEventsNotified(list.map((r) => r.id));
    }
    if (released) {
      this.repo.setMeta(CHANGES_RELEASE_KEY, "");
      this.repo.setMeta(CHANGES_HELD_KEY, "");
    }
    return delivered;
  }

  /**
   * Придержать подозрительно большую пачку: админам — один раз вопрос с
   * кнопками, событиям — оставаться неразосланными (добор после тихих часов
   * берёт только разосланные, так что и он их не тронет).
   */
  private async holdMassChange(rows: ChangeEventRow[]): Promise<void> {
    if (this.repo.getMeta(CHANGES_HELD_KEY)) return;
    this.repo.setMeta(CHANGES_HELD_KEY, new Date().toISOString());
    const per = new Map<string, number>();
    for (const r of rows) per.set(r.groupKey, (per.get(r.groupKey) ?? 0) + 1);
    const top = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const title = (key: string): string => this.service.group(key)?.title ?? key;
    logger.warn({ events: rows.length, groups: per.size }, "mass schedule change held for admin decision");
    const text = [
      "⚠️ <b>Подозрительно много изменений расписания</b>",
      "",
      `За раз набралось ${rows.length} ${plural(rows.length, "изменение", "изменения", "изменений")} в ${per.size} ${plural(per.size, "группе", "группах", "группах")}. Так бывает при сбое портала, поэтому рассылку я придержал.`,
      "",
      ...top.map(([key, n]) => `• ${escapeHtml(title(key))}: ${n}`),
      "",
      "Проверь расписание на портале и реши:",
    ].join("\n");
    const kb = new InlineKeyboard().text("✅ Разослать", "chg:release").text("🗑 Не рассылать", "chg:drop");
    for (const id of this.adminIds) {
      await this.api.sendMessage(id, text, { parse_mode: "HTML", reply_markup: kb }).catch((err: unknown) => logger.warn({ err: String(err), adminId: id }, "mass change notice failed"));
    }
  }

  /**
   * Изменения одному человеку — всегда одним сообщением, чтобы оно не
   * потерялось в чате: сверху «на сегодня» (весь день с пометками), следом —
   * на будущее. Текстом — один текст с кнопками; картинкой — постер с
   * подписью, а если дней несколько — альбом постеров с подписью (у альбома
   * кнопок не бывает, поэтому календарь в подписи — ссылкой). Возвращает
   * изменения, которые дошли (их и помечаем как доставленные).
   */
  private async deliverChanges(user: User, group: LogicalGroup, events: ChangeEvent[], opts: ChangeDelivery): Promise<ChangeEvent[]> {
    const today = opts.now.date;
    const { today: todayEvents, later } = splitByToday(events, today);
    const renderer = user.format !== "text" ? this.renderer : null;
    const days = changeDays(events, today, dayLessonsFor(this.service, group, opts.own ? user.subgroup : null), renderer ? MAX_LATER_POSTERS : 0);
    const todayDay = todayEvents.length ? (days.find((d) => d.date === today) ?? null) : null;
    const input: ChangesInput = { group, todayMarked: todayDay?.lessons ?? null, later, now: opts.now, info: this.service.weekInfo(today), teacherView: user.teacherView, own: opts.own, head: opts.head };
    const asText = async (): Promise<ChangeEvent[]> => ((await this.send(user, changesMessageFit(input), { kind: opts.kind, replyMarkup: opts.kb })) ? events : []);
    if (!renderer) return asText();
    const drawn = await Promise.all(days.map(async (day) => ({ day, png: await this.posters.render(renderer, this.service, { group, day, now: opts.now, theme: user.posterTheme, teacherView: user.teacherView }) })));
    const photos = drawn.flatMap((d) => (d.png ? [d.png] : []));
    // Сегодняшний день не нарисовался — без него картинка неполная, а в подписи
    // только изменившиеся пары: шлём текстом, где день целиком.
    if (!photos.length || (todayDay && !drawn.find((d) => d.day === todayDay)?.png)) return asText();
    const album = photos.length > 1;
    const caption = changesCaption({ ...input, full: user.format === "both" ? changesMessage(input) : null, tail: album ? this.albumLinks(group.key, opts.own) : "" });
    if (!album) return (await this.send(user, caption, { kind: opts.kind, replyMarkup: opts.kb, photo: photos[0] })) ? events : [];
    return (await this.sendAlbum(user, photos, caption, { kind: opts.kind, fallback: () => changesMessageFit(input), kb: opts.kb })) ? events : [];
  }

  /** Кнопки уведомления ссылками — для подписи к альбому. */
  private albumLinks(groupKey: string, own: boolean): string {
    const ics = startLink(this.botUsername, "ics", groupKey);
    const unwatch = own ? null : startLink(this.botUsername, "unwatch", groupKey);
    const links = [ics ? `<a href="${ics}">📆 Файл изменений в календарь</a>` : "", unwatch ? `<a href="${unwatch}">👁 Не следить за группой</a>` : ""].filter(Boolean);
    return links.length ? `\n\n${links.join("\n")}` : "";
  }

  /**
   * Альбом картинок с подписью — одно сообщение. Telegram его отверг — шлём
   * то же текстом с кнопками. Сеть оборвалась (альбом мог и дойти) или человек
   * заблокировал бота — второго сообщения сейчас не шлём: недошедшее повторит
   * добор, а дубль был бы хуже.
   */
  private async sendAlbum(user: User, photos: Buffer[], caption: string, opts: { kind: string; fallback: () => string; kb: InlineKeyboard }): Promise<boolean> {
    try {
      await this.api.sendMediaGroup(
        user.id,
        photos.map((p, i) => InputMediaBuilder.photo(new InputFile(p, `changes-${i + 1}.png`), i === 0 ? { caption, parse_mode: "HTML" } : {})),
      );
      this.repo.logNotification(user.id, opts.kind, true);
      await sleep(35);
      return true;
    } catch (err) {
      if (err instanceof GrammyError && !isUnreachable(err)) {
        logger.warn({ err: err.description.slice(0, 200), userId: user.id }, "changes album rejected, sending text only");
        return this.send(user, opts.fallback(), { kind: opts.kind, replyMarkup: opts.kb });
      }
      this.sendFailed(user, opts.kind, err);
      return false;
    }
  }

  /** Одинаковые постеры за одну рассылку рисуем один раз (кеш чистится в начале прохода). */
  private readonly posters = new ChangePosters();

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
    // Событий за ночь немного, а пользователей может быть много: читаем группу
    // один раз за тик и дальше раздаём из памяти.
    const byGroup = new Map<string, ChangeEventRow[]>();
    const rowsFor = (key: string): ChangeEventRow[] => {
      let rows = byGroup.get(key);
      if (!rows) {
        rows = this.repo.activeEvents(key, now.date, 200).filter((r) => r.notified && r.createdAt >= since);
        byGroup.set(key, rows);
      }
      return rows;
    };
    let sent = 0;
    this.posters.clear();
    for (const user of this.repo.listUsers({ onlyActive: true })) {
      if (this.inQuietHours(user, now)) continue;
      const quiet = !!user.quietFrom && !!user.quietTo;
      if (quiet) {
        // Утренняя выдача: только сразу после окончания тихих часов, иначе это
        // превратилось бы в ежеминутный обход всех подряд.
        const to = parseHHMM(user.quietTo!);
        if (to == null) continue;
        if ((now.minutes - to + 1440) % 1440 > 120) continue;
      }
      // Изменения приходят и по своей группе, и по тем, за которыми следят:
      // раньше добор смотрел только свою, и «ночные» чужие пропадали совсем.
      // В режиме преподавателя «своя группа» — он сам: старая группа студента
      // изменений не шлёт (за чужими группами можно следить отдельно).
      const keys = [...(user.notifyChanges && user.groupKey && !user.teacherMode ? [user.groupKey] : []), ...this.repo.watchGroups(user.id)];
      for (const key of [...new Set(keys)]) {
        const group = this.service.group(key);
        if (!group) continue;
        const own = user.groupKey === key;
        // Человеку без тихих часов добор нужен только как повтор недавней
        // неудачной отправки, а не как пересказ всего дня. Отсев по времени —
        // до поиска отметок: он дешёвый, а отметки — запрос на каждую правку.
        const recent = quiet ? rowsFor(key) : rowsFor(key).filter((r) => Date.now() - Date.parse(r.createdAt) < 2 * 60 * 60 * 1000);
        const fresh = recent.filter((r) => !this.repo.reminderSent(user.id, "event", String(r.id))).sort((a, b) => a.id - b.id);
        if (!fresh.length) continue;
        const idByEvent = new Map<ChangeEvent, number>();
        const events: ChangeEvent[] = fresh.map((r) => {
          const p = r.payload as { before?: Occurrence; after?: Occurrence; fields?: string[] };
          const e: ChangeEvent = { kind: r.kind as ChangeEvent["kind"], groupKey: r.groupKey, date: r.date, period: r.period, before: p.before, after: p.after, fields: p.fields };
          idByEvent.set(e, r.id);
          return e;
        });
        const mine = forSubgroup(
          events.filter((e) => !isSessionPeriod(e.period) || user.notifySession),
          own ? user.subgroup : null,
        );
        if (!mine.length) {
          // Чужая подгруппа или сессия без подписки: это не «не доставлено».
          for (const r of fresh) this.repo.markReminderSent(user.id, "event", String(r.id));
          continue;
        }
        const kb = new InlineKeyboard().text("📆 Файл изменений в календарь", `cics:${key}`);
        if (!own) kb.row().text("👁 Не следить за группой", `unwatch:${key}`);
        const head = quiet ? "🌙 <i>Пока у тебя были тихие часы, расписание изменилось.</i>\n\n" : "";
        const done = await this.deliverChanges(user, group, mine, { now, own, kind: "changes-backlog", head, kb });
        if (done.length) sent++;
        // Чужая подгруппа и сессия без подписки — не «не доставлено»: помечаем
        // их вместе с дошедшими; не дошедшее попробуем на следующем круге.
        const delivered = new Set(done);
        for (const e of events) if (delivered.has(e) || !mine.includes(e)) this.repo.markReminderSent(user.id, "event", String(idByEvent.get(e)));
      }
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

  /**
   * «Своё» расписание человека на дату: пары его группы, а в режиме
   * преподавателя — его собственные (портал с кешем на 3 часа или страница
   * вебинаров). `lessons` — только идущие пары со временем, уже по подгруппе;
   * `all` — для текста напоминания.
   */
  private async ownDay(user: User, date: LocalDate, cache: Map<string, Occurrence[]>): Promise<{ group: LogicalGroup; lessons: Occurrence[]; all: Occurrence[]; subgroup: number | null; teacher: boolean } | null> {
    if (user.teacherMode) {
      const ref = user.teacherRef ? parseRefKey(user.teacherRef) : null;
      if (!ref || ref.kind === "student") return null;
      const name = user.teacherName ?? "Преподаватель";
      let lessons: Occurrence[] = [];
      if (ref.kind === "teacher") {
        const day = await this.teacherDay(ref.id, name, date);
        // Портал не ответил — напоминание не шлём: «пар нет» было бы неправдой.
        if (!day) return null;
        lessons = day.lessons;
      } else {
        lessons = webinarRowsToLessons(this.repo.webinarsBetween(date, date), name).filter((o) => o.start != null);
      }
      return { group: personGroup(name, `teacher:${user.teacherRef}`), lessons, all: lessons, subgroup: null, teacher: true };
    }
    const group = user.groupKey ? this.service.group(user.groupKey) : null;
    if (!group) return null;
    const k = `${group.key}|${date}`;
    let all = cache.get(k);
    if (!all) {
      all = this.service.lessonsOn(group, date).filter((o) => o.status === "scheduled" && o.start != null);
      cache.set(k, all);
    }
    return { group, lessons: filterSubgroup(all, user.subgroup), all, subgroup: user.subgroup, teacher: false };
  }

  /** Runs every minute: first-lesson, per-lesson, distance-link and evening reminders. */
  async tickReminders(now: WallClock = wallClock()): Promise<number> {
    const users = this.repo
      .listUsers({ onlyActive: true })
      .filter((u) => (u.groupKey || (u.teacherMode && u.teacherRef)) && (u.remindFirstMin != null || u.remindEachMin != null || u.remindDistanceMin != null || u.eveningAt));
    if (users.length === 0) return 0;
    const cache = new Map<string, Occurrence[]>();
    let sent = 0;
    for (const user of users) {
      if (this.inQuietHours(user, now)) continue;
      if (user.teacherMode) {
        // Расписание преподавателя тянется с портала: ночью, когда ни одно
        // напоминание не может наступить, ходить туда незачем.
        const at = user.eveningAt ? parseHHMM(user.eveningAt) : null;
        const eveningSoon = at != null && now.minutes >= at && now.minutes < at + 15;
        if (!eveningSoon && now.minutes < EARLIEST_LESSON_START - 180) continue;
      }
      const own = await this.ownDay(user, now.date, cache);
      if (!own) continue;
      const { group } = own;
      const today = own.lessons;
      // У преподавателя его же фамилия в напоминании не нужна — это он сам.
      const view = own.teacher ? ("off" as const) : user.teacherView;

      if (user.remindFirstMin != null && today.length) {
        const first = Math.min(...today.map((o) => o.start!));
        const due = first - user.remindFirstMin;
        if (now.minutes >= due && now.minutes < first && !this.repo.reminderSent(user.id, "first", now.date)) {
          const left = first - now.minutes;
          const head = `⏰ ${left <= 1 ? "Сейчас начинается" : `Через ${humanMinutes(left)}`} первая пара`;
          const body = formatDay(group, now.date, own.all, this.service.weekInfo(now.date), now.date, { subgroup: own.subgroup, now, teacherView: view });
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
            const groups = own.teacher && o.groups?.length ? ` · ${o.groups.join(", ")}` : "";
            const text = `⏱ Через ${humanMinutes(left)} — <b>${escapeHtml(o.subject)}</b> (${escapeHtml(lessonTypeLabel(o.type))})${where ? `, ${escapeHtml(where)}` : ""} · ${fmtHHMM(o.start!)}${o.end != null ? `–${fmtHHMM(o.end)}` : ""}${escapeHtml(groups)}`;
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
            const w = own.teacher ? null : (this.webinars?.forLesson(o, [group.title, ...group.portalNames]) ?? null);
            const extra = [w?.teacher ? escapeHtml(w.teacher) : "", w?.title ? `📝 ${escapeHtml(w.title.length > 120 ? w.title.slice(0, 117).trimEnd() + "…" : w.title)}` : "", own.teacher && o.groups?.length ? escapeHtml(o.groups.join(", ")) : "", own.teacher && o.topic ? `📝 ${escapeHtml(o.topic.slice(0, 120))}` : ""].filter(Boolean);
            const text = `💻 ${left <= 1 ? "Сейчас начинается" : `Через ${humanMinutes(left)}`} дистант — <b>${escapeHtml(o.subject)}</b> (${escapeHtml(lessonTypeLabel(o.type))}) · ${fmtHHMM(o.start!)}${o.end != null ? `–${fmtHHMM(o.end)}` : ""}${extra.length ? `\n${extra.join("\n")}` : ""}\nВебинар: ${WEBINAR_URL}`;
            if (await this.send(user, text, { kind: "remind-distance", replyMarkup: new InlineKeyboard().url("💻 Вебинары портала", WEBINAR_URL) })) sent++;
          }
        }
      }

      if (user.eveningAt) {
        const at = parseHHMM(user.eveningAt);
        if (at != null && now.minutes >= at && now.minutes < at + 15 && !this.repo.reminderSent(user.id, "evening", now.date)) {
          const tomorrow = addDays(now.date, 1);
          const next = await this.ownDay(user, tomorrow, cache);
          // Портал не ответил про завтра (режим преподавателя) — попробуем на следующем тике.
          if (!next) continue;
          this.repo.markReminderSent(user.id, "evening", now.date);
          if (next.lessons.length) {
            const body = formatDay(next.group, tomorrow, next.all, this.service.weekInfo(tomorrow), now.date, { subgroup: next.subgroup, teacherView: view });
            const photo = await this.maybeRenderDay(user, next.group, tomorrow, next.lessons, now);
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
      // В режиме преподавателя в строке пары — группы: фамилия там его же.
      return await this.renderer.renderDay({ group, date, lessons, weekInfo: this.service.weekInfo(date), today: todayMsk(), now, theme: user.posterTheme ?? undefined, teacherView: user.teacherView, ...(user.teacherMode ? { labels: "groups" as const } : {}) });
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


