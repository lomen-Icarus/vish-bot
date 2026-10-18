/**
 * Пересдачи (ППА): весть о переносе — только тем, кто отметил долг по этому
 * предмету; вопрос «Есть долги?» — раз за волну, днём, тем, кто не выключил
 * уведомления. Остальным группы ППА не мешает: в общий поток изменений
 * пересдачи не попадают.
 */
import { InlineKeyboard } from "grammy";
import type { Repo, User } from "../db/repo.js";
import type { ScheduleService } from "../schedule/service.js";
import type { PpaEvent } from "../schedule/ppa.js";
import { esc } from "../schedule/format.js";
import { lessonTypeLabel } from "../schedule/model.js";
import { ppaItemText, ppaScreen } from "../bot/ppaView.js";
import { todayMsk, wallClock, type WallClock } from "../time.js";
import { logger } from "../logger.js";
import type { PpaItem } from "../portal/ppa.js";

/** Чем бот шлёт: Notifier.send и тихие часы человека. */
export interface PpaSender {
  send(user: User, html: string, opts: { kind: string; silent?: boolean; replyMarkup?: InlineKeyboard }): Promise<boolean>;
  inQuietHours(user: User, now?: WallClock): boolean;
}

/** Вопрос про долги — с 11 до 20 по Москве, не больше стольких за минуту. */
const ASK_FROM = 11 * 60;
const ASK_TO = 20 * 60;
const ASK_PER_TICK = 20;

const what = (i: PpaItem): string => `<b>${esc(i.subject)}</b> (${lessonTypeLabel(i.kind)}${i.attempt ? `, ${i.attempt} ППА` : ""})`;

export function ppaEventText(e: PpaEvent): string {
  if (e.change === "added") return `📋 Назначена пересдача: ${what(e.after!)}\n${ppaItemText(e.after!)}`;
  if (e.change === "removed") return `📋 Пересдача ${what(e.before!)} пропала из расписания ППА на портале. Уточни у преподавателя или в деканате.\nБыло: ${ppaItemText(e.before!)}`;
  return `📋 Пересдача перенесена: ${what(e.after!)}\nбыло: ${ppaItemText(e.before!)}\nстало: ${ppaItemText(e.after!)}`;
}

const openKb = (): InlineKeyboard => new InlineKeyboard().text("📋 Мои пересдачи", "ppa:open");

/** Разослать изменения пересдач тем, кто отметил эти предметы. Возвращает, сколько ушло. */
export async function dispatchPpaEvents(sender: PpaSender, repo: Repo, events: PpaEvent[], now: WallClock = wallClock()): Promise<number> {
  let sent = 0;
  for (const e of events) {
    for (const id of repo.ppaDebtors(e.groupKey, e.subjectKey)) {
      const user = repo.getUser(id);
      if (!user || user.blocked || user.groupKey !== e.groupKey) continue;
      if (await sender.send(user, ppaEventText(e), { kind: "ppa", silent: sender.inQuietHours(user, now), replyMarkup: openKb() })) sent++;
    }
  }
  return sent;
}

/**
 * Вопрос «Есть долги?» по новой волне ППА (метка ppa:ask:<группа> от pollPpa).
 * Только тем, кто получает уведомления, не преподавателям, не в тихие часы;
 * у группы должны быть пересдачи впереди.
 */
export async function tickPpaAsk(sender: PpaSender, repo: Repo, service: ScheduleService, now: WallClock = wallClock()): Promise<number> {
  if (now.minutes < ASK_FROM || now.minutes >= ASK_TO) return 0;
  const today = todayMsk();
  let sent = 0;
  const upcomingOf = new Map<string, PpaItem[]>();
  for (const user of repo.listUsers({ onlyActive: true })) {
    if (sent >= ASK_PER_TICK) break;
    if (!user.groupKey || user.teacherMode || user.blocked || !(user.notifyChanges || user.notifySession)) continue;
    const wave = repo.getMeta(`ppa:ask:${user.groupKey}`);
    if (!wave || repo.ppaAskedWave(user.id, user.groupKey) === wave) continue;
    if (sender.inQuietHours(user, now)) continue;
    const group = service.group(user.groupKey);
    if (!group) continue;
    let upcoming = upcomingOf.get(group.key);
    if (!upcoming) upcomingOf.set(group.key, (upcoming = service.ppaUpcoming(group, today)));
    // Впереди пересдач нет — не спрашиваем и не отмечаем: спросим, как появятся.
    if (!upcoming.length) continue;
    repo.markPpaAsked(user.id, user.groupKey, wave);
    const { text, kb } = ppaScreen(group, upcoming, new Set(repo.ppaDebts(user.id, group.key)), { ask: true });
    if (await sender.send(user, text, { kind: "ppa-ask", replyMarkup: kb })) sent++;
  }
  if (sent) logger.info({ sent }, "вопрос про долги ППА разослан");
  return sent;
}
