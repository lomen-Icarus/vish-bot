/**
 * Сторона бота в обмене с записывалкой (этап 2 заявок на запись).
 *   GET  /rec/sync   — бот отдаёт задания по состоянию заявок;
 *   POST /rec/report — записывалка шлёт результаты, открытый ключ и слоты.
 * Протокол целиком — docs/RECORDER-ACCOUNTS.md. Здесь только построение
 * заданий из состояния заявок и применение результатов к состоянию.
 */
import type { Repo, RecRequestRow } from "../db/repo.js";
import { logicalKeyFor } from "../schedule/groups.js";

/** Задание записывалке. envelope — шифровка логина и пароля (для verify/install). */
export interface RecTask {
  id: string;
  kind: "verify" | "install" | "remove" | "recheck";
  requestId: number;
  userId: number;
  group: string;
  codes: string[];
  envelope?: unknown;
}

export type RecResultCode = "login_ok" | "login_failed" | "group_mismatch" | "portal_down" | "installed" | "removed" | "bad_envelope";

export interface RecResult {
  id: string;
  requestId: number;
  code: RecResultCode;
  actualGroup?: string | null;
}

export interface RecReport {
  publicKey?: string;
  results?: RecResult[];
  slots?: { group: string; status: string; lastOkAt?: string | null }[];
  portal?: string;
}

/** Код группы для сверки со строками вебинаров: «14-25», «11-23(эиэа)». */
export function groupCode(title: string): string {
  const m = /(\d{1,2}-\d{2}(?:\s*\([^)]*\))?)/.exec(title);
  return (m ? m[1]! : title).toLowerCase().replace(/ё/g, "е").replace(/\s*\(/g, "(").trim();
}

/** Сколько заявка ждёт проверки и решения админа, прежде чем истечь. */
export const REQUEST_TTL_DAYS = 7;
/** Метка «проверить слот заново» в recorder_state; она же — id задания recheck. */
export const RECHECK_PREFIX = "recheck:";

/**
 * Задания из текущего состояния заявок. Идемпотентно: id = requestId:kind.
 * Отзывы — первыми: записывалка выполняет задания по порядку, а слот убирает
 * по группе. Замена учётки группы (старая заявка — на отзыв, новая одобрена)
 * иначе поставила бы новую и тут же её убрала.
 */
export function recorderTasks(repo: Repo): RecTask[] {
  const tasks: RecTask[] = [];
  const envelope = (r: RecRequestRow): unknown => {
    try {
      return r.envelopeJson ? JSON.parse(r.envelopeJson) : undefined;
    } catch {
      return undefined; // битый конверт — задание не шлём, пусть истечёт по сроку
    }
  };
  for (const r of repo.recRequestsByState(["revoking"])) {
    tasks.push({ id: `${r.id}:remove`, kind: "remove", requestId: r.id, userId: r.userId, group: r.groupTitle, codes: [groupCode(r.groupTitle)] });
  }
  for (const r of repo.recRequestsByState(["pending_verify"])) {
    const env = envelope(r);
    if (env) tasks.push({ id: `${r.id}:verify`, kind: "verify", requestId: r.id, userId: r.userId, group: r.groupTitle, codes: [groupCode(r.groupTitle)], envelope: env });
  }
  for (const r of repo.recRequestsByState(["approved"])) {
    const env = envelope(r);
    if (env) tasks.push({ id: `${r.id}:install`, kind: "install", requestId: r.id, userId: r.userId, group: r.groupTitle, codes: [groupCode(r.groupTitle)], envelope: env });
  }
  // «Проверить снова» от админа: слот берём из зеркала — записывалка ищет его по своему названию группы.
  const slots = new Map(repo.recSlots().map((sl) => [sl.groupKey, sl]));
  for (const mark of repo.recorderMarkKeys(RECHECK_PREFIX)) {
    const slot = slots.get(mark.slice(RECHECK_PREFIX.length));
    if (!slot) continue;
    const req = repo.activeRecRequest(slot.groupKey);
    tasks.push({ id: mark, kind: "recheck", requestId: req?.id ?? slot.requestId ?? 0, userId: req?.userId ?? 0, group: slot.groupTitle, codes: [groupCode(slot.groupTitle)] });
  }
  return tasks;
}

/** Смена состояния заявки — с тем, что нужно для уведомления (строка могла уже удалиться). */
export interface RecTransition {
  requestId: number;
  /** Из какого состояния: осечка установки после одобрения и при проверке — разные вести. */
  from: string;
  to: string;
  mismatch?: boolean;
  userId: number;
  username: string | null;
  groupKey: string;
  groupTitle: string;
  actualGroup?: string | null;
}

/** Слот перестал пускать или снова пускает. */
export interface RecSlotChange {
  groupKey: string;
  groupTitle: string;
  requestId: number | null;
  userId: number | null;
  username: string | null;
}

/** Что произошло при применении отчёта — чтобы бот решил, кого уведомить. */
export interface RecReportEffect {
  firstConnect: boolean;
  keyChanged: boolean;
  /** Заявки, по которым сменилось состояние (в том числе истёкшие). */
  transitions: RecTransition[];
  /** Слоты ok → lost и lost → ok: уведомляем один раз, на самом переходе. */
  lost: RecSlotChange[];
  recovered: RecSlotChange[];
  /** Ответы на «Проверить снова». Успех виден и в recovered (lost → ok). */
  rechecked: { groupKey: string; groupTitle: string; code: RecResultCode }[];
}

const transition = (req: RecRequestRow, to: string, extra: Partial<RecTransition> = {}): RecTransition => ({
  requestId: req.id,
  from: req.state,
  to,
  userId: req.userId,
  username: req.username,
  groupKey: req.groupKey,
  groupTitle: req.groupTitle,
  ...extra,
});

/** Применить отчёт записывалки: ключ, результаты заданий, зеркало слотов, истёкшие заявки. */
export function applyRecorderReport(repo: Repo, report: RecReport, now = Date.now()): RecReportEffect {
  const effect: RecReportEffect = { firstConnect: false, keyChanged: false, transitions: [], lost: [], recovered: [], rechecked: [] };
  repo.transaction(() => {
    if (report.publicKey) {
      const had = repo.recorderPublicKey() !== null;
      effect.keyChanged = repo.setRecorderPublicKey(report.publicKey);
      effect.firstConnect = !had;
    }
    for (const res of report.results ?? []) {
      // Повторная проверка выполнена (или кабинет лежит) — метку снимаем при
      // любом ответе, иначе на мёртвый портал ходили бы каждый обмен. Статус
      // слота придёт в зеркале ниже.
      if (typeof res.id === "string" && res.id.startsWith(RECHECK_PREFIX)) {
        repo.clearRecorderMark(res.id);
        const key = res.id.slice(RECHECK_PREFIX.length);
        const slot = repo.recSlots().find((sl) => sl.groupKey === key);
        effect.rechecked.push({ groupKey: key, groupTitle: slot?.groupTitle ?? key, code: res.code });
        continue;
      }
      const req = repo.recRequest(res.requestId);
      if (!req) continue;
      const to = nextState(repo, req, res);
      if (to && to !== req.state) effect.transitions.push(transition(req, to, to === "verified" ? { mismatch: isMismatch(req, res), actualGroup: res.actualGroup ?? null } : {}));
    }
    // Зеркало слотов: статус и когда последний раз пускало. Сверяем с прежним,
    // чтобы о потере и возврате доступа сказать один раз. Запись без group пропускаем.
    if (Array.isArray(report.slots)) {
      const before = new Map(repo.recSlots().map((sl) => [sl.groupKey, sl]));
      const seen = new Set<string>();
      for (const s of report.slots) {
        if (!s.group) continue;
        const key = logicalKeyFor(s.group);
        seen.add(key);
        const req = repo.activeRecRequest(key);
        const prev = before.get(key)?.status;
        const change: RecSlotChange = { groupKey: key, groupTitle: s.group, requestId: req?.id ?? null, userId: req?.userId ?? null, username: req?.username ?? null };
        if (s.status === "lost" && prev !== "lost") effect.lost.push(change);
        if (s.status === "ok" && prev === "lost") effect.recovered.push(change);
        repo.upsertRecSlot({ groupKey: key, groupTitle: s.group, requestId: req?.id ?? null, status: s.status, lastOkAt: s.lastOkAt ?? null });
      }
      // Записывалка присылает все слоты: чего нет в отчёте, того нет и у неё.
      for (const key of before.keys()) if (!seen.has(key)) repo.removeRecSlot(key);
    }
    // Заявки, которые неделю не проверились или не решены, — истекают; шифровку стираем.
    const olderThan = new Date(now - REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    for (const req of repo.staleRecRequests(["pending_verify", "verified"], olderThan)) {
      repo.setRecRequestState(req.id, "expired", { dropEnvelope: true });
      effect.transitions.push(transition(req, "expired"));
    }
    if (report.portal) repo.recorderMark("portal", report.portal);
    repo.recorderMark("last_report_at", new Date().toISOString());
  });
  return effect;
}

function isMismatch(req: RecRequestRow, res: RecResult): boolean {
  return !!res.actualGroup && logicalKeyFor(res.actualGroup) !== req.groupKey;
}

/** Новое состояние заявки по результату, с нужными побочными записями. null — не трогаем. */
function nextState(repo: Repo, req: RecRequestRow, res: RecResult): string | null {
  switch (res.code) {
    case "login_ok":
      if (req.state !== "pending_verify") return null;
      // Вход прошёл — ждёт решения человека; шифровку бережём для install.
      repo.setRecRequestState(req.id, "verified", { actualGroup: res.actualGroup ?? null });
      return "verified";
    case "login_failed":
      // Осечка как при проверке, так и при установке (напр. сменился ключ/пароль).
      if (req.state !== "pending_verify" && req.state !== "approved") return null;
      repo.setRecRequestState(req.id, "rejected_auth", { dropEnvelope: true });
      if (req.state === "approved") repo.removeRecSlot(req.groupKey);
      return "rejected_auth";
    case "bad_envelope":
      if (req.state !== "pending_verify" && req.state !== "approved") return null;
      repo.setRecRequestState(req.id, "rejected_bad_envelope", { dropEnvelope: true });
      if (req.state === "approved") repo.removeRecSlot(req.groupKey);
      return "rejected_bad_envelope";
    case "portal_down":
      return null; // остаёмся pending_verify, повторим на следующем sync
    case "installed":
      if (req.state !== "approved") return null;
      repo.setRecRequestState(req.id, "active", { dropEnvelope: true });
      return "active";
    case "removed":
      if (req.state !== "revoking") return null;
      // Отзыв завершён — строку удаляем целиком (в т. ч. id и ник забытого человека).
      repo.deleteRecRequest(req.id);
      repo.removeRecSlot(req.groupKey);
      return "revoked";
    case "group_mismatch":
      return null;
  }
}

/** Чем закончилось действие над заявкой — для ответа на нажатие кнопки. */
export type RecActionResult =
  | { ok: true; replaced?: RecRequestRow | null }
  | { ok: false; reason: "gone" | "state" | "no_envelope" };

/**
 * Одобрить проверенную заявку. Занятый слот группы освобождается: прежняя
 * учётка уходит на отзыв (задание remove выполнится раньше install — см.
 * recorderTasks), и новая встаёт на её место.
 */
export function approveRecRequest(repo: Repo, id: number, adminId: number): RecActionResult {
  let result: RecActionResult = { ok: false, reason: "gone" };
  repo.transaction(() => {
    const req = repo.recRequest(id);
    if (!req) return;
    if (req.state !== "verified") return void (result = { ok: false, reason: "state" });
    // Без шифровки install не уйдёт, и заявка застрянет в «одобрена» навсегда.
    if (!req.envelopeJson) return void (result = { ok: false, reason: "no_envelope" });
    const prev = repo.activeRecRequest(req.groupKey);
    if (prev && prev.id !== req.id) repo.setRecRequestState(prev.id, "revoking", { dropEnvelope: true, decidedBy: adminId });
    repo.setRecRequestState(req.id, "approved", { decidedBy: adminId });
    result = { ok: true, replaced: prev && prev.id !== req.id ? prev : null };
  });
  return result;
}

/** Отклонить заявку (до одобрения). Шифровка стирается сразу. */
export function rejectRecRequest(repo: Repo, id: number, adminId: number): RecActionResult {
  const req = repo.recRequest(id);
  if (!req) return { ok: false, reason: "gone" };
  if (req.state !== "verified" && req.state !== "pending_verify") return { ok: false, reason: "state" };
  repo.setRecRequestState(id, "rejected", { dropEnvelope: true, decidedBy: adminId });
  return { ok: true };
}

/**
 * Отозвать учётку (студент или админ). Поставленная или одобренная — на
 * отзыв: записывалка уберёт слот, уже идущая запись пары доснимется (ссылка на
 * комнату у неё уже есть). Ещё не одобренная — просто снимается.
 */
export function revokeRecRequest(repo: Repo, id: number, by?: number): RecActionResult {
  const req = repo.recRequest(id);
  if (!req) return { ok: false, reason: "gone" };
  if (req.state === "active" || req.state === "approved") {
    repo.setRecRequestState(id, "revoking", { dropEnvelope: true, ...(by !== undefined ? { decidedBy: by } : {}) });
    return { ok: true };
  }
  if (req.state === "pending_verify" || req.state === "verified") {
    repo.setRecRequestState(id, "revoked_early", { dropEnvelope: true });
    return { ok: true };
  }
  return { ok: false, reason: "state" };
}

/** «Проверить снова» потерянный слот: на следующем обмене записывалка зайдёт в кабинет. */
export function requestRecheck(repo: Repo, groupKey: string): boolean {
  if (!repo.recSlots().some((s) => s.groupKey === groupKey)) return false;
  repo.recorderMark(`${RECHECK_PREFIX}${groupKey}`, new Date().toISOString());
  return true;
}
