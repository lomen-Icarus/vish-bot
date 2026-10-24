/**
 * Прямая запись пар в Google Календарь человека (этап 4 реформы календаря).
 *
 * Подписка по ссылке обновляется, когда захочет Google (до суток). Здесь бот
 * сам ставит события в отдельный календарь, созданный им в аккаунте человека,
 * — сразу после проверки портала.
 *
 * Устроено как сверка, а не очередь: на каждом проходе бот считает, какие
 * пары должны стоять (с сегодня до конца семестра), сравнивает с тем, что уже
 * поставил (cal_events: uid пары → id события + отпечаток), и ставит,
 * меняет или убирает только разницу. id события выводится из uid пары, так
 * что повтор после сбоя или перезапуска не плодит дублей. Прошедшие пары не
 * трогаются — история остаётся. За проход на человека — не больше
 * OPS_PER_USER действий: первая загрузка (~300 пар) растягивается на
 * несколько проходов и не упирается в лимиты Google.
 *
 * В логах — только id и числа.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import type { CalLink, Repo, User } from "../db/repo.js";
import type { ScheduleService } from "../schedule/service.js";
import type { LogicalGroup } from "../schedule/groups.js";
import { occTypeLabel, type Occurrence } from "../schedule/model.js";
import { calendarLessons } from "../schedule/calendar.js";
import { icsUid, lessonDetails } from "../schedule/ics.js";
import { todayMsk } from "../time.js";
import { logger } from "../logger.js";
import { GoogleCalendarClient, GoogleError, type GoogleEvent } from "./google.js";
import { seal, tokenKey, unseal } from "./secret.js";

/** Действий с календарём одного человека за проход. */
export const OPS_PER_USER = 100;
/** Действий за проход на всех: остальное — на следующем. */
export const OPS_PER_TICK = 400;

/** Пауза перед следующим проходом, когда за проход успели не всё. */
export const FOLLOW_UP_MS = 15_000;

export type Notify = (userId: number, text: string) => Promise<void>;

const hhmm = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Пара → событие Google. Время — по Москве (timeZone), без сдвигов вручную. */
export function googleEvent(o: Occurrence, calendarName: string, alarmMinutes: number | null): GoogleEvent {
  return {
    summary: `${o.subject} (${occTypeLabel(o)})`,
    ...(o.room && !o.isDistance ? { location: `ауд. ${o.room}, ЧувГУ` } : {}),
    description: lessonDetails(o, calendarName).join("\n"),
    start: { dateTime: `${o.date}T${hhmm(o.start!)}:00`, timeZone: "Europe/Moscow" },
    end: { dateTime: `${o.date}T${hhmm(o.end!)}:00`, timeZone: "Europe/Moscow" },
    reminders: alarmMinutes && alarmMinutes > 0 ? { useDefault: false, overrides: [{ method: "popup", minutes: Math.min(alarmMinutes, 40320) }] } : { useDefault: false },
  };
}

/** id события Google из uid пары: только 0-9 и a-f (они входят в разрешённые a-v, 0-9), всегда один и тот же. */
export function googleEventId(uid: string): string {
  return createHash("sha1").update(uid).digest("hex");
}

const hashOf = (ev: GoogleEvent): string => createHash("sha1").update(JSON.stringify(ev)).digest("hex").slice(0, 16);

export type ConnectResult = { ok: true; calendarName: string; reused: boolean } | { ok: false; reason: "expired" | "no_group" | "denied" | "scope" | "failed" };

export class CalendarPush {
  readonly google: GoogleCalendarClient | null;
  private readonly key: Buffer;
  private readonly access = new Map<number, { token: string; expiresAt: number }>();
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly deps: { repo: Repo; service: ScheduleService; config: Config; notify: Notify },
    google?: GoogleCalendarClient | null,
  ) {
    const c = deps.config;
    this.google = google !== undefined ? google : c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET ? new GoogleCalendarClient({ clientId: c.GOOGLE_CLIENT_ID, clientSecret: c.GOOGLE_CLIENT_SECRET, redirectUri: googleRedirectUri(c) }) : null;
    this.key = tokenKey(c);
  }

  /** Видна ли человеку кнопка «Google Календарь»: ключи заданы, режим и (для admins) он админ. */
  allowed(userId: number): boolean {
    const mode = this.deps.config.CAL_PUSH;
    if (!this.google || mode === "off") return false;
    return mode === "all" || this.deps.config.ADMIN_IDS.includes(userId);
  }

  /** Ссылка на вход в Google с одноразовой меткой (живёт 30 минут). */
  connectUrl(userId: number): string | null {
    if (!this.google) return null;
    const state = randomBytes(24).toString("base64url");
    this.deps.repo.addOauthState(state, userId, "google");
    return this.google.authUrl(state);
  }

  /** Возврат от Google: метка → человек, код → токены, календарь (прежний, если жив), сохранить, сверить. */
  async finishConnect(state: string, code: string | null, error: string | null): Promise<ConnectResult> {
    const { repo, service } = this.deps;
    const userId = repo.takeOauthState(state, "google");
    if (userId === null || !this.google) return { ok: false, reason: "expired" };
    if (error || !code) return { ok: false, reason: "denied" };
    const user = repo.getUser(userId);
    const group = user?.groupKey ? service.group(user.groupKey) : null;
    if (!user || !group) return { ok: false, reason: "no_group" };
    try {
      const t = await this.google.exchange(code);
      const prev = repo.calLink(userId, "google");
      const reused = Boolean(prev?.calendarId && (await this.google.calendarExists(t.accessToken, prev.calendarId)));
      const calendarId = reused ? prev!.calendarId! : await this.google.createCalendar(t.accessToken, group.title);
      if (!reused) repo.clearCalEvents(userId, "google");
      repo.saveCalLink(userId, "google", { tokenEnc: seal(this.key, t.refreshToken), calendarId, groupKey: group.key });
      this.access.set(userId, { token: t.accessToken, expiresAt: Date.now() + 50 * 60_000 });
      logger.info({ userId, reused }, "google calendar connected");
      this.kick();
      return { ok: true, calendarName: group.title, reused };
    } catch (err) {
      const reason = err instanceof GoogleError ? err.reason : "error";
      logger.warn({ userId, reason }, "google calendar connect failed");
      return { ok: false, reason: reason === "scope_not_granted" ? "scope" : "failed" };
    }
  }

  /** «Отключить»: отозвать доступ у Google, забыть токен. Календарь и соответствия событий остаются — повторное подключение возьмёт тот же календарь без дублей. */
  async disconnect(userId: number): Promise<void> {
    const link = this.deps.repo.calLink(userId, "google");
    if (!link) return;
    const token = this.refreshTokenOf(link);
    this.deps.repo.updateCalLink(userId, "google", { status: "off", tokenEnc: null, error: null });
    this.access.delete(userId);
    if (token && this.google) await this.google.revoke(token);
    logger.info({ userId }, "google calendar disconnected");
  }

  /** Сверить всех поскорее (после опроса портала, после подключения). Идущий проход не прерываем — повторим после него. */
  kick(): void {
    void this.tick();
  }

  private laterTimer: NodeJS.Timeout | null = null;

  /** Ещё проход через FOLLOW_UP_MS (досыпать первую загрузку). */
  private later(): void {
    if (this.laterTimer) return;
    this.laterTimer = setTimeout(() => {
      this.laterTimer = null;
      this.kick();
    }, FOLLOW_UP_MS);
    this.laterTimer.unref();
  }

  /** Один проход по всем подключённым. Параллельно не идёт: второй вызов только просит повтор. */
  tick(): Promise<void> {
    // Ключи Google убрали из .env — писать нечем; подключения ждут, пока ключи вернут.
    if (!this.google) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        let budget = OPS_PER_TICK;
        for (const link of this.deps.repo.calLinks("google", "ok")) {
          if (budget <= 0) break;
          budget -= await this.syncUser(link, Math.min(OPS_PER_USER, budget)).catch((err: unknown) => {
            logger.warn({ userId: link.userId, err: err instanceof GoogleError ? err.reason : String(err).slice(0, 120) }, "google calendar sync failed");
            return 0;
          });
        }
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private refreshTokenOf(link: CalLink): string | null {
    if (!link.tokenEnc) return null;
    try {
      return unseal(this.key, link.tokenEnc);
    } catch {
      return null;
    }
  }

  private async accessToken(link: CalLink): Promise<string> {
    const cached = this.access.get(link.userId);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const refresh = this.refreshTokenOf(link);
    // Не расшифровался (сменили BOT_TOKEN / CAL_TOKEN_KEY) — как отозванный: только подключиться заново.
    if (!refresh) throw new GoogleError("revoked", 0, "token_unreadable");
    const t = await this.google!.refresh(refresh);
    this.access.set(link.userId, { token: t.accessToken, expiresAt: t.expiresAt });
    return t.accessToken;
  }

  /** Что должно стоять в календаре человека: uid → событие и отпечаток. */
  desired(user: User, group: LogicalGroup): Map<string, { date: string; event: GoogleEvent; hash: string }> {
    const { lessons } = calendarLessons(this.deps.service, group, { subgroup: user.subgroup, ppaDebts: this.deps.repo.ppaDebts(user.id, group.key) });
    const out = new Map<string, { date: string; event: GoogleEvent; hash: string }>();
    for (const o of lessons) {
      if (o.status !== "scheduled" || o.start == null || o.end == null) continue;
      const event = googleEvent(o, group.title, user.calAlarmMin);
      out.set(icsUid(o), { date: o.date, event, hash: hashOf(event) });
    }
    return out;
  }

  /** Сверка одного человека; возвращает, сколько действий потратила. */
  async syncUser(link: CalLink, budget: number): Promise<number> {
    const { repo, service } = this.deps;
    const user = repo.getUser(link.userId);
    const group = user?.groupKey && !user.teacherMode ? service.group(user.groupKey) : null;
    if (!user || !group || !link.calendarId) return 0;
    const today = todayMsk();
    const want = this.desired(user, group);
    const have = new Map(repo.calEvents(link.userId, "google").map((e) => [e.uid, e]));
    const puts = [...want].filter(([uid, w]) => {
      const h = have.get(uid)?.hash;
      return h !== w.hash && h !== `fatal:${w.hash}`;
    });
    // Прошедшие не трогаем: пара, что уже была, остаётся в календаре как история.
    const drops = [...have.values()].filter((e) => e.date >= today && !want.has(e.uid));
    const renamed = link.groupKey !== group.key;
    if (!puts.length && !drops.length && !renamed) {
      repo.updateCalLink(link.userId, "google", { syncedAt: new Date().toISOString(), error: null });
      return 0;
    }
    let ops = 0;
    try {
      const access = await this.accessToken(link);
      if (renamed) {
        await this.google!.renameCalendar(access, link.calendarId, group.title);
        repo.updateCalLink(link.userId, "google", { groupKey: group.key });
        ops++;
      }
      for (const e of drops) {
        if (ops >= budget) break;
        await this.google!.deleteEvent(access, link.calendarId, e.eventId);
        repo.dropCalEvent(link.userId, "google", e.uid);
        ops++;
      }
      for (const [uid, w] of puts) {
        if (ops >= budget) break;
        const eventId = have.get(uid)?.eventId ?? googleEventId(uid);
        try {
          await this.google!.putEvent(access, link.calendarId, eventId, w.event);
          repo.putCalEvent(link.userId, "google", { uid, eventId, hash: w.hash, date: w.date });
        } catch (err) {
          // Одна неудобная пара не должна вечно съедать проход: помечаем до изменения её содержимого.
          if (!(err instanceof GoogleError) || err.kind !== "fatal") throw err;
          repo.putCalEvent(link.userId, "google", { uid, eventId, hash: `fatal:${w.hash}`, date: w.date });
          logger.warn({ userId: link.userId, reason: err.reason }, "google rejected one event");
        }
        ops++;
      }
      const left = puts.length + drops.length + (renamed ? 1 : 0) - ops;
      repo.updateCalLink(link.userId, "google", { syncedAt: new Date().toISOString(), error: null });
      logger.info({ userId: link.userId, ops, left }, "google calendar synced");
      // Не успели всё (первая загрузка) — продолжим чуть позже, а не тут же: лимиты Google — в минуту.
      if (left > 0) this.later();
      return ops;
    } catch (err) {
      if (err instanceof GoogleError && (err.kind === "revoked" || err.kind === "gone")) await this.lost(link, err.kind, group.title);
      else repo.updateCalLink(link.userId, "google", { error: err instanceof GoogleError ? err.reason : "error" });
      throw err;
    }
  }

  /** Доступ отозван или календарь удалён: больше не пишем и один раз говорим человеку. */
  private async lost(link: CalLink, kind: "revoked" | "gone", title: string): Promise<void> {
    // Токен больше не нужен ни в том, ни в другом случае: подключение заново выдаст новый.
    this.deps.repo.updateCalLink(link.userId, "google", { status: kind, tokenEnc: null, error: kind });
    this.access.delete(link.userId);
    logger.warn({ userId: link.userId, kind }, "google calendar link lost");
    const why = kind === "revoked" ? "доступ к Google Календарю отозван" : `календарь «${title}» удалён из Google`;
    await this.deps.notify(link.userId, `⚠️ Пары больше не записываются в Google: ${why}.\n\nПодключить заново: 📆 Календарь → ⚡ Google Календарь.`).catch(() => undefined);
  }
}

export function googleRedirectUri(cfg: Pick<Config, "OAUTH_BASE_URL">): string {
  return `${cfg.OAUTH_BASE_URL}/oauth/google`;
}
