/**
 * Дневные лимиты болталки: на человека (во всех чатах вместе), на один чат и
 * общий на всех. Как и у «Спросить?», .env задаёт значения по умолчанию, а
 * админ меняет их из бота («💬 Болталка»): они живут в таблице meta и
 * переживают перезапуск. Разовая добавка «на сегодня» сама исчезает завтра.
 * Админы бота не ограничены.
 */
import type { Config } from "../config.js";
import type { Repo } from "../db/repo.js";

export type ChatLimitKind = "user" | "chat" | "global";

export interface ChatLimits {
  perUser: number;
  perChat: number;
  global: number;
  base: Record<ChatLimitKind, number>;
  bonus: Record<ChatLimitKind, number>;
  env: Record<ChatLimitKind, number>;
}

export const CHAT_STEPS: Record<ChatLimitKind, number[]> = {
  user: [0, 3, 5, 10, 15, 20, 30, 50, 100, 200],
  chat: [0, 20, 50, 100, 150, 200, 300, 500, 1000, 2000],
  global: [0, 50, 100, 200, 400, 600, 1000, 2000, 5000],
};
/** Шаг разовой добавки на сегодня. */
export const CHAT_BONUS_STEP: Record<ChatLimitKind, number> = { user: 10, chat: 50, global: 200 };

const limitKey = (kind: ChatLimitKind): string => `chat:limit:${kind}`;
const bonusKey = (kind: ChatLimitKind, day: string): string => `chat:bonus:${kind}:${day}`;

function num(repo: Repo, key: string, fallback: number): number {
  const raw = repo.getMeta(key);
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function chatLimits(repo: Repo, config: Config, day: string): ChatLimits {
  const env = { user: config.CHAT_DAILY_LIMIT_PER_USER, chat: config.CHAT_DAILY_LIMIT_PER_CHAT, global: config.CHAT_DAILY_LIMIT_GLOBAL };
  const kinds: ChatLimitKind[] = ["user", "chat", "global"];
  const base = Object.fromEntries(kinds.map((k) => [k, num(repo, limitKey(k), env[k])])) as Record<ChatLimitKind, number>;
  const bonus = Object.fromEntries(kinds.map((k) => [k, num(repo, bonusKey(k, day), 0)])) as Record<ChatLimitKind, number>;
  return { perUser: base.user + bonus.user, perChat: base.chat + bonus.chat, global: base.global + bonus.global, base, bonus, env };
}

export function setChatLimit(repo: Repo, kind: ChatLimitKind, value: number | null): void {
  repo.setMeta(limitKey(kind), value == null ? "" : String(Math.max(0, Math.floor(value))));
}

export function addChatBonus(repo: Repo, kind: ChatLimitKind, day: string, delta: number): number {
  const next = Math.max(0, num(repo, bonusKey(kind, day), 0) + Math.floor(delta));
  repo.setMeta(bonusKey(kind, day), String(next));
  return next;
}

export function resetChatLimits(repo: Repo, day: string): void {
  for (const k of ["user", "chat", "global"] as const) {
    setChatLimit(repo, k, null);
    repo.setMeta(bonusKey(k, day), "");
  }
}

export type ChatVerdict = "ok" | "limit-user" | "limit-chat" | "limit-global";

/**
 * Можно ли ответить прямо сейчас. inFlight — ответы, которые бот пишет в эту
 * секунду и которые ещё не попали в базу: без них пара одновременных
 * обращений проскакивала бы мимо лимита.
 */
export function chatAllowance(
  repo: Repo,
  config: Config,
  who: { userId: number; chatId: number; isAdmin: boolean },
  day: string,
  inFlight: { user?: number; chat?: number; global?: number } = {},
): { verdict: ChatVerdict; limits: ChatLimits } {
  const limits = chatLimits(repo, config, day);
  if (who.isAdmin) return { verdict: "ok", limits };
  if (repo.chatUsage({ userId: who.userId }, day) + (inFlight.user ?? 0) >= limits.perUser) return { verdict: "limit-user", limits };
  if (repo.chatUsage({ chatId: who.chatId }, day) + (inFlight.chat ?? 0) >= limits.perChat) return { verdict: "limit-chat", limits };
  if (repo.chatUsage({}, day) + (inFlight.global ?? 0) >= limits.global) return { verdict: "limit-global", limits };
  return { verdict: "ok", limits };
}
