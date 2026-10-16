/**
 * «Аккаунт жив?» — раз в 6 часов. Чтобы не плодить ложных тревог и лишних
 * входов в чужие аккаунты:
 *   • заход на пару — уже проверка: аккаунт, который вошёл за последние 6 ч,
 *     не трогаем;
 *   • сначала «контроль» — открывается ли сам кабинет; не открылся — портал
 *     лежит, аккаунты не проверяем и мёртвыми не объявляем;
 *   • «неверный пароль» дважды подряд (второй раз — через 15 минут) —
 *     только тогда «доступ потерян», и об этом сообщается один раз — при
 *     переходе. Потерянный больше не проверяется, пока его не попросят
 *     проверить заново или не отзовут.
 * Проверки идут по одной, с паузой: кабинет не любит частых обращений.
 */
import { CHECK_EVERY_MS, RECHECK_SOON_MS, type SlotStatus } from "./accounts.js";
import type { LoginCheck } from "./lk.js";

/** Когда портал лежит — заглянуть снова через полчаса. */
export const PORTAL_DOWN_RETRY_MS = 30 * 60 * 1000;
const PACE_MS = 2000;

export interface LiveState {
  status: SlotStatus;
  failures: number;
  lastOkAt: string | null;
  nextCheckAt: number;
}

export interface LiveTarget {
  /** «slot:ВИШ-14-25» — для отчёта боту и логов, без логина. */
  key: string;
  login: string;
  password: string;
  state: LiveState;
  save: (patch: Partial<LiveState>) => void;
}

/** Слот сменил состояние — об этом бот сообщает владельцу один раз. */
export interface Transition {
  key: string;
  to: SlotStatus;
}

export interface LivenessDeps {
  check: (login: string, password: string) => Promise<LoginCheck>;
  alive: () => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface LivenessResult {
  /** Проверяли ли вообще (false — портал лежал). */
  ran: boolean;
  transitions: Transition[];
}

/** Отметить удачный заход на пару: обнуляет счётчик осечек и отодвигает проверку. */
export function noteSuccess(target: LiveTarget, now = Date.now()): void {
  target.save({ status: "ok", failures: 0, lastOkAt: new Date(now).toISOString(), nextCheckAt: now + CHECK_EVERY_MS });
}

/** Нужно ли проверять этот слот сейчас: живой и пришло время. */
function due(t: LiveTarget, now: number): boolean {
  return t.state.status === "ok" && t.state.nextCheckAt <= now;
}

/**
 * Пройтись по слотам, которым пора. Возвращает переходы «стало потеряно» —
 * чтобы сообщить о них ровно один раз.
 */
export async function runLiveness(targets: LiveTarget[], deps: LivenessDeps): Promise<LivenessResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dueTargets = targets.filter((t) => due(t, now()));
  if (!dueTargets.length) return { ran: false, transitions: [] };
  // Контроль: жив ли сам портал. Нет — ничего не проверяем, тревог не шлём.
  if (!(await deps.alive())) {
    for (const t of dueTargets) t.save({ nextCheckAt: now() + PORTAL_DOWN_RETRY_MS });
    return { ran: false, transitions: [] };
  }
  const transitions: Transition[] = [];
  let first = true;
  for (const t of dueTargets) {
    if (!first) await sleep(PACE_MS);
    first = false;
    const res = await deps.check(t.login, t.password);
    if (res.verdict === "ok") {
      t.save({ status: "ok", failures: 0, lastOkAt: new Date(now()).toISOString(), nextCheckAt: now() + CHECK_EVERY_MS });
      continue;
    }
    if (res.verdict === "down") {
      // Кабинет перестал отвечать посреди прохода — не осечка пароля.
      t.save({ nextCheckAt: now() + PORTAL_DOWN_RETRY_MS });
      continue;
    }
    // verdict === "bad": неверный логин или пароль.
    const failures = t.state.failures + 1;
    if (failures < 2) {
      t.save({ failures, nextCheckAt: now() + RECHECK_SOON_MS });
      continue;
    }
    t.save({ status: "lost", failures, nextCheckAt: now() + CHECK_EVERY_MS });
    transitions.push({ key: t.key, to: "lost" });
  }
  return { ran: true, transitions };
}
