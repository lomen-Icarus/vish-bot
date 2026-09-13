import type { Context, SessionFlavor } from "grammy";
import type { Config } from "../config.js";
import type { Repo, User } from "../db/repo.js";
import type { ScheduleService } from "../schedule/service.js";
import type { Renderer } from "../render/image.js";
import type { AskService } from "../ai/ask.js";

/** Short-lived per-user conversational state (single process, in memory). */
export interface PendingState {
  kind: "suggest" | "broadcast" | "broadcast-target" | "ask";
  /** For broadcast: captured message to forward. */
  chatId?: number;
  messageId?: number;
  expiresAt: number;
}

export interface Deps {
  config: Config;
  repo: Repo;
  service: ScheduleService;
  renderer: Renderer | null;
  ask: AskService | null;
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
