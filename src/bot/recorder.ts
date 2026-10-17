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

/** Задания из текущего состояния заявок. Идемпотентно: id = requestId:kind. */
export function recorderTasks(repo: Repo): RecTask[] {
  const tasks: RecTask[] = [];
  const envelope = (r: RecRequestRow): unknown => {
    try {
      return r.envelopeJson ? JSON.parse(r.envelopeJson) : undefined;
    } catch {
      return undefined; // битый конверт — задание не шлём, пусть истечёт по сроку
    }
  };
  for (const r of repo.recRequestsByState(["pending_verify"])) {
    const env = envelope(r);
    if (env) tasks.push({ id: `${r.id}:verify`, kind: "verify", requestId: r.id, userId: r.userId, group: r.groupTitle, codes: [groupCode(r.groupTitle)], envelope: env });
  }
  for (const r of repo.recRequestsByState(["approved"])) {
    const env = envelope(r);
    if (env) tasks.push({ id: `${r.id}:install`, kind: "install", requestId: r.id, userId: r.userId, group: r.groupTitle, codes: [groupCode(r.groupTitle)], envelope: env });
  }
  for (const r of repo.recRequestsByState(["revoking"])) {
    tasks.push({ id: `${r.id}:remove`, kind: "remove", requestId: r.id, userId: r.userId, group: r.groupTitle, codes: [groupCode(r.groupTitle)] });
  }
  return tasks;
}

/** Что произошло при применении отчёта — чтобы бот решил, кого уведомить. */
export interface RecReportEffect {
  firstConnect: boolean;
  keyChanged: boolean;
  /** Заявки, по которым сменилось состояние: id → новое состояние. */
  transitions: { requestId: number; to: string; mismatch?: boolean }[];
}

/** Применить отчёт записывалки: ключ, результаты заданий, зеркало слотов. */
export function applyRecorderReport(repo: Repo, report: RecReport): RecReportEffect {
  const effect: RecReportEffect = { firstConnect: false, keyChanged: false, transitions: [] };
  repo.transaction(() => {
    if (report.publicKey) {
      const had = repo.recorderPublicKey() !== null;
      effect.keyChanged = repo.setRecorderPublicKey(report.publicKey);
      effect.firstConnect = !had;
    }
    for (const res of report.results ?? []) {
      const req = repo.recRequest(res.requestId);
      if (!req) continue;
      const to = nextState(repo, req, res);
      if (to && to !== req.state) effect.transitions.push({ requestId: req.id, to, mismatch: to === "verified" && isMismatch(req, res) });
    }
    // Зеркало слотов: статус и когда последний раз пускало. Запись без group пропускаем.
    for (const s of report.slots ?? []) {
      if (!s.group) continue;
      const key = logicalKeyFor(s.group);
      const req = repo.activeRecRequest(key);
      repo.upsertRecSlot({ groupKey: key, groupTitle: s.group, requestId: req?.id ?? null, status: s.status, lastOkAt: s.lastOkAt ?? null });
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
