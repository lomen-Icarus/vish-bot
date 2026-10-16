/**
 * Обмен заявками с ботом. Бот хранит заявки студентов на запись (шифровку
 * логина и пароля, группу, кто подал) и раздаёт записывалке задания; та их
 * выполняет и отчитывается. Доверие — тот же общий токен, что у слайдов
 * (SLIDES_TOKEN), новый секрет не нужен.
 *
 *   GET  <база>/rec/sync   → { tasks: Task[] }
 *   POST <база>/rec/report ← { publicKey, results, slots, portal }
 *
 * База — это BOT_SLIDES_URL без /slides. Пока бот без этих ручек (этап не
 * задеплоен), в ответ 404 — тихо ждём дальше, без тревог каждую минуту.
 *
 * Задания:
 *   verify  — расшифровать, проверить вход, доложить ok/bad/mismatch. Слот
 *             ещё не ставим: заявку одобряет человек. Расшифрованное тут же
 *             забываем.
 *   install — расшифровать и поставить учётку в слот группы.
 *   remove  — убрать слот (отзыв студентом или админом).
 *   recheck — проверить потерянный слот заново.
 * В логах — только номер заявки, группа и результат.
 */
import { fetch as undiciFetch } from "undici";
import { AccountStore, type Slot } from "./accounts.js";
import { openEnvelope, type Envelope } from "./crypto.js";
import { checkStudentLogin, lkAlive } from "./lk.js";
import { log } from "./log.js";

export interface Task {
  id: string;
  kind: "verify" | "install" | "remove" | "recheck";
  requestId: number;
  userId: number;
  /** Группа, как её назвал студент (бот подставил из его профиля). */
  group: string;
  /** Коды для сверки со строками вебинаров. */
  codes: string[];
  /** Для verify/install. */
  envelope?: Envelope;
}

export type ResultCode = "login_ok" | "login_failed" | "group_mismatch" | "portal_down" | "installed" | "removed" | "bad_envelope";

export interface TaskResult {
  id: string;
  requestId: number;
  code: ResultCode;
  /** Группа по расписанию кабинета (для verify) — бот сверит с заявленной. */
  actualGroup?: string | null;
}

export interface SyncDeps {
  botUrl: string;
  token: string;
  store: AccountStore;
  privatePem: string;
  publicSpki: string;
  proxyUrl?: string;
  /** Для verify нужно знать, к какой логической группе относится номер группы из кабинета. */
  groupName?: (groupId: number) => Promise<string | null>;
}

function base(botUrl: string): string {
  const trimmed = botUrl.replace(/\/+$/, "");
  try {
    const u = new URL(trimmed);
    u.pathname = u.pathname.replace(/\/slides$/, "") || "/";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/slides$/, "");
  }
}

/** Расшифровать конверт и проверить вход. Расшифрованное дальше не живёт. */
async function verifyLogin(task: Task, deps: SyncDeps): Promise<TaskResult> {
  if (!task.envelope) return { id: task.id, requestId: task.requestId, code: "bad_envelope" };
  let creds: { login: string; password: string };
  try {
    creds = await openEnvelope(deps.privatePem, task.envelope, `vish-rec|${task.userId}|${task.group}`);
  } catch {
    return { id: task.id, requestId: task.requestId, code: "bad_envelope" };
  }
  const check = await checkStudentLogin(creds.login, creds.password, { proxyUrl: deps.proxyUrl });
  if (check.verdict === "down") return { id: task.id, requestId: task.requestId, code: "portal_down" };
  if (check.verdict === "bad") return { id: task.id, requestId: task.requestId, code: "login_failed" };
  const actualGroup = check.groupId != null && deps.groupName ? await deps.groupName(check.groupId).catch(() => null) : null;
  return { id: task.id, requestId: task.requestId, code: "login_ok", actualGroup };
}

async function installSlot(task: Task, deps: SyncDeps): Promise<TaskResult> {
  if (!task.envelope) return { id: task.id, requestId: task.requestId, code: "bad_envelope" };
  let creds: { login: string; password: string };
  try {
    creds = await openEnvelope(deps.privatePem, task.envelope, `vish-rec|${task.userId}|${task.group}`);
  } catch {
    return { id: task.id, requestId: task.requestId, code: "bad_envelope" };
  }
  deps.store.install({ group: task.group, codes: task.codes, login: creds.login, password: creds.password, requestId: task.requestId, userId: task.userId });
  return { id: task.id, requestId: task.requestId, code: "installed" };
}

export async function runTask(task: Task, deps: SyncDeps): Promise<TaskResult> {
  switch (task.kind) {
    case "verify":
      return verifyLogin(task, deps);
    case "install":
      return installSlot(task, deps);
    case "remove":
      deps.store.remove(task.group);
      return { id: task.id, requestId: task.requestId, code: "removed" };
    case "recheck": {
      const slot = deps.store.get(task.group);
      if (!slot) return { id: task.id, requestId: task.requestId, code: "removed" };
      const check = await checkStudentLogin(slot.login, slot.password, { proxyUrl: deps.proxyUrl });
      if (check.verdict === "ok") {
        deps.store.update(task.group, { status: "ok", failures: 0, lastOkAt: new Date().toISOString(), nextCheckAt: Date.now() + 6 * 60 * 60 * 1000 });
        return { id: task.id, requestId: task.requestId, code: "login_ok" };
      }
      return { id: task.id, requestId: task.requestId, code: check.verdict === "down" ? "portal_down" : "login_failed" };
    }
  }
}

function slotSummary(s: Slot): { group: string; status: string; lastOkAt: string | null } {
  return { group: s.group, status: s.status, lastOkAt: s.lastOkAt };
}

let missingLogged = false;

/** Один цикл обмена: забрать задания, выполнить, доложить (+ открытый ключ и состояние слотов). */
export async function syncOnce(deps: SyncDeps): Promise<{ done: number } | null> {
  const url = base(deps.botUrl);
  let tasks: Task[] = [];
  try {
    const res = await undiciFetch(`${url}/rec/sync`, { headers: { Authorization: `Bearer ${deps.token}` }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) {
      if (!missingLogged) log.debug({}, "у бота ещё нет ручки /rec/sync — жду следующего обновления бота");
      missingLogged = true;
      await res.text();
      return null;
    }
    missingLogged = false;
    if (res.status < 200 || res.status >= 300) {
      log.warn({ status: res.status }, "бот не отдал заявки");
      await res.text();
      return null;
    }
    tasks = ((await res.json()) as { tasks?: Task[] }).tasks ?? [];
  } catch (err) {
    log.debug({ err: String(err).slice(0, 150) }, "не достучался до бота за заявками");
    return null;
  }
  const results: TaskResult[] = [];
  for (const task of tasks) {
    try {
      results.push(await runTask(task, deps));
    } catch (err) {
      log.warn({ err: String(err).slice(0, 150), request: task.requestId }, "задание по заявке упало");
    }
  }
  const portal = results.some((r) => r.code === "portal_down") ? "down" : "ok";
  try {
    await undiciFetch(`${url}/rec/report`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: deps.publicSpki, results, slots: deps.store.list().map(slotSummary), portal }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    log.debug({ err: String(err).slice(0, 150) }, "не доложил боту результаты заявок");
  }
  if (results.length) log.info({ done: results.length }, "обработаны заявки на запись");
  return { done: results.length };
}
