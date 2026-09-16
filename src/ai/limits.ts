/**
 * Дневные лимиты вопросов к ИИ.
 *
 * Значения из .env — это только значение по умолчанию: админ меняет лимиты
 * прямо из бота (они живут в таблице meta и переживают перезапуск) и может
 * разово поднять квоту на сегодня, если день важный. Админы не ограничены.
 */
import type { Config } from "../config.js";
import type { Repo } from "../db/repo.js";

export interface AiLimits {
  /** Сколько вопросов в сутки одному человеку (с учётом сегодняшнего буста). */
  perUser: number;
  /** Сколько вопросов в сутки всем вместе (с учётом сегодняшнего буста). */
  global: number;
  /** Базовые значения без буста. */
  baseUser: number;
  baseGlobal: number;
  /** Разовая добавка на сегодня. */
  bonusUser: number;
  bonusGlobal: number;
  /** Значения из .env, к которым возвращает «сброс». */
  envUser: number;
  envGlobal: number;
  /** Лимит переопределён админом (а не взят из .env). */
  userOverridden: boolean;
  globalOverridden: boolean;
}

export const USER_STEPS = [0, 3, 5, 10, 15, 20, 30, 50, 100, 200];
export const GLOBAL_STEPS = [0, 50, 100, 200, 300, 500, 800, 1200, 2000, 5000];
/** Шаг разового буста на сегодня. */
export const BONUS_USER_STEP = 5;
export const BONUS_GLOBAL_STEP = 100;

const KEY_USER = "ai:limit:user";
const KEY_GLOBAL = "ai:limit:global";
const bonusUserKey = (day: string): string => `ai:bonus:user:${day}`;
const bonusGlobalKey = (day: string): string => `ai:bonus:global:${day}`;

function num(repo: Repo, key: string, fallback: number): number {
  const raw = repo.getMeta(key);
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function aiLimits(repo: Repo, config: Config, day: string): AiLimits {
  const envUser = config.AI_DAILY_LIMIT_PER_USER;
  const envGlobal = config.AI_DAILY_LIMIT_GLOBAL;
  const baseUser = num(repo, KEY_USER, envUser);
  const baseGlobal = num(repo, KEY_GLOBAL, envGlobal);
  const bonusUser = num(repo, bonusUserKey(day), 0);
  const bonusGlobal = num(repo, bonusGlobalKey(day), 0);
  return {
    perUser: baseUser + bonusUser,
    global: baseGlobal + bonusGlobal,
    baseUser,
    baseGlobal,
    bonusUser,
    bonusGlobal,
    envUser,
    envGlobal,
    userOverridden: baseUser !== envUser,
    globalOverridden: baseGlobal !== envGlobal,
  };
}

export function setAiLimit(repo: Repo, kind: "user" | "global", value: number | null): void {
  repo.setMeta(kind === "user" ? KEY_USER : KEY_GLOBAL, value == null ? "" : String(Math.max(0, Math.floor(value))));
}

export function addAiBonus(repo: Repo, kind: "user" | "global", day: string, delta: number): number {
  const key = kind === "user" ? bonusUserKey(day) : bonusGlobalKey(day);
  const next = Math.max(0, num(repo, key, 0) + Math.floor(delta));
  repo.setMeta(key, String(next));
  return next;
}

export function clearAiBonus(repo: Repo, day: string): void {
  repo.setMeta(bonusUserKey(day), "");
  repo.setMeta(bonusGlobalKey(day), "");
}

/**
 * Следующее/предыдущее значение из лесенки. Текущее значение может быть и вне
 * лесенки (его задали в .env или командой), поэтому «➕» никогда не уменьшает,
 * а «➖» никогда не увеличивает.
 */
export function stepValue(steps: number[], current: number, dir: 1 | -1): number {
  if (dir === 1) return steps.find((s) => s > current) ?? Math.max(current, steps[steps.length - 1]!);
  return [...steps].reverse().find((s) => s < current) ?? Math.min(current, steps[0]!);
}

export type AiVerdict = "ok" | "limit-user" | "limit-global";

/** Можно ли задать вопрос прямо сейчас. Админы — без лимита. */
export function aiAllowance(repo: Repo, config: Config, userId: number, isAdmin: boolean, day: string, inFlight: { user?: number; global?: number } = {}): { verdict: AiVerdict; limits: AiLimits } {
  const limits = aiLimits(repo, config, day);
  if (isAdmin) return { verdict: "ok", limits };
  // Вопросы, на которые бот прямо сейчас отвечает, ещё не попали в базу:
  // без их учёта пара одновременных вопросов проходила бы мимо лимита.
  if (repo.aiUsage(userId, day) + (inFlight.user ?? 0) >= limits.perUser) return { verdict: "limit-user", limits };
  if (repo.aiUsageGlobal(day) + (inFlight.global ?? 0) >= limits.global) return { verdict: "limit-global", limits };
  return { verdict: "ok", limits };
}
