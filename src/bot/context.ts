import type { Context, SessionFlavor } from "grammy";
import type { Config } from "../config.js";
import type { Repo, User } from "../db/repo.js";
import type { ScheduleService } from "../schedule/service.js";
import type { Renderer } from "../render/image.js";
import type { AskService } from "../ai/ask.js";
import type { TeacherService } from "../portal/teachers.js";
import type { NewsScanner } from "../news/scanner.js";
import type { WebinarService } from "../portal/webinars.js";
import type { StudentDirectory } from "../students/directory.js";
import type { KnownPeople } from "../students/known.js";
import type { Server } from "node:http";

/** Short-lived per-user conversational state (single process, in memory). */
export interface PendingState {
  kind: "suggest" | "broadcast" | "broadcast-target" | "broadcast-confirm" | "ask" | "teacher" | "search" | "poisk" | "people";
  /** For broadcast: captured message to forward. */
  chatId?: number;
  messageId?: number;
  /** For broadcast: chosen audience (all | topic:<t> | c<course>). */
  target?: string;
  /** For broadcast: plain text of the captured message (for the announcements board). */
  text?: string;
  /** For broadcast: whether the admin asked to pin it to the board. */
  board?: boolean;
  expiresAt: number;
}

export interface Deps {
  config: Config;
  repo: Repo;
  service: ScheduleService;
  renderer: Renderer | null;
  ask: AskService | null;
  teachers: TeacherService | null;
  news: NewsScanner | null;
  webinars: WebinarService | null;
  /** Справочник студентов для «сыска»; null, когда POISK=FALSE. */
  students: StudentDirectory | null;
  /**
   * «Бот узнаёт своих»: ник → имя, только для приветствия. Ники никуда не
   * показываются и в поиск студентов не попадают.
   */
  known: KnownPeople | null;
  /**
   * Реестр преподавателей «ФИО;ник» для режима преподавателя (TEACHERS_DB).
   * Нет файла — режим включают только админы для проверки: /prepod Фамилия.
   */
  teacherRegistry?: KnownPeople | null;
  /** Calendar-feed server; subscription links are offered only while it listens. */
  http: Server | null;
  /**
   * Включён ли inline-режим у бота (BotFather → /setinline). Telegram сообщает
   * это в getMe; без него подсказка «@бот 12-23» в чатах просто не появляется,
   * поэтому обещать её нельзя.
   */
  inline: boolean;
  /** @username бота: подставляется в подсказки про inline. */
  botUsername: string | null;
  pending: Map<number, PendingState>;
  startedAt: Date;
}

export interface BotContextFlavor {
  deps: Deps;
  user: User;
  isAdmin: boolean;
}

export type BotContext = Context & BotContextFlavor & SessionFlavor<Record<string, never>>;

export function setPending(deps: Deps, userId: number, state: Omit<PendingState, "expiresAt">, ttlMs = 5 * 60_000): void {
  deps.pending.set(userId, { ...state, expiresAt: Date.now() + ttlMs });
}

export function takePending(deps: Deps, userId: number): PendingState | null {
  const s = deps.pending.get(userId);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    deps.pending.delete(userId);
    return null;
  }
  return s;
}

export function clearPending(deps: Deps, userId: number): void {
  deps.pending.delete(userId);
}
