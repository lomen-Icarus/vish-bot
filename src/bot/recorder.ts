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
  /**
   * remove: чья учётка должна стоять в слоте, чтобы его убрать (номер заявки;
   * 0 — учётка из .env, в том числе подписанная владельцем). Чужую записывалка
   * не трогает и всё равно отвечает «removed».
   */
  expect?: number;
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
  /** requestId — чья учётка в слоте записывалки (0 — из .env); старая записывалка его не шлёт. */
  slots?: { group: string; status: string; lastOkAt?: string | null; requestId?: number }[];
  portal?: string;
  /** Что идёт сейчас (recorder/src/plan.ts → liveSnapshot); старая записывалка его не шлёт. */
  live?: unknown;
}

/** Что с парой сейчас: пишем, ждём места, ждём комнату, записали, без слайдов, не в настройках. */
export type RecLiveStatus = "recording" | "queued" | "waiting" | "done" | "no_slides" | "not_ours";
const LIVE_STATUSES: readonly RecLiveStatus[] = ["recording", "queued", "waiting", "done", "no_slides", "not_ours"];

export interface RecLive {
  at: string;
  maxParallel: number;
  pairs: Array<{ start: string | null; end: string | null; subject: string; groups: string[]; status: RecLiveStatus }>;
}

/** Метка recorder_state с последним снимком «что идёт сейчас». */
export const LIVE_MARK = "live";

/** Снимок от записывалки — только ожидаемой формы и разумного размера; иначе null. */
export function sanitizeLive(raw: unknown): RecLive | null {
  const r = raw as Partial<RecLive> | null;
  if (!r || typeof r !== "object" || typeof r.at !== "string" || !Number.isFinite(Date.parse(r.at)) || !Array.isArray(r.pairs)) return null;
  const time = (v: unknown): string | null => (typeof v === "string" && /^\d{2}:\d{2}$/.test(v) ? v : null);
  const pairs: RecLive["pairs"] = [];
  for (const p of r.pairs.slice(0, 80)) {
    if (!p || typeof p.subject !== "string" || !LIVE_STATUSES.includes(p.status) || !Array.isArray(p.groups)) continue;
    const groups = p.groups.filter((g): g is string => typeof g === "string").slice(0, 20).map((g) => g.slice(0, 60));
    pairs.push({ start: time(p.start), end: time(p.end), subject: p.subject.slice(0, 120), groups, status: p.status });
  }
  const maxParallel = Number.isInteger(r.maxParallel) && r.maxParallel! >= 1 && r.maxParallel! <= 50 ? r.maxParallel! : 1;
  return { at: new Date(Date.parse(r.at)).toISOString(), maxParallel, pairs };
}

/** Последний снимок «что идёт сейчас» из базы. */
export function readLive(repo: Repo): RecLive | null {
  const raw = repo.recorderMarkValue(LIVE_MARK);
  if (!raw) return null;
  try {
    return sanitizeLive(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Код группы для сверки со строками вебинаров: «14-25», «11-23(эиэа)». */
export function groupCode(title: string): string {
  const m = /(\d{1,2}-\d{2}(?:\s*\([^)]*\))?)/.exec(title);
  return (m ? m[1]! : title).toLowerCase().replace(/ё/g, "е").replace(/\s*\(/g, "(").trim();
}

/** Сколько заявка ждёт проверки и решения админа, прежде чем истечь. */
export const REQUEST_TTL_DAYS = 7;
/** Строка общей учётки (профиль 1 из .env) в отчёте записывалки — не слот студента. */
export const GENERAL_SLOT_TITLE = "Общая учётка (.env)";

/** Подпись владельца у слота без заявки, если он ещё не писал боту: метка «owner:<группа>». */
export const OWNER_PREFIX = "owner:";

/**
 * Кабинет ответил «лежит» на проверку заявки — следующая попытка не раньше,
 * чем через VERIFY_WAIT_MS (метка «vwait:<номер>» = ISO-время). Иначе
 * записывалка входила бы под логином студента каждую минуту, до 1440 раз в
 * сутки, — так недолго получить блокировку учётки или IP сервера.
 */
export const VERIFY_WAIT_PREFIX = "vwait:";
export const VERIFY_WAIT_MS = 30 * 60 * 1000;

/** Метка «проверить слот заново» в recorder_state; она же — id задания recheck. */
export const RECHECK_PREFIX = "recheck:";

/**
 * Чья учётка должна стоять в слоте, чтобы remove её убрал. Отзыв слота без
 * заявки и подписанная владельцем запоминают это из отчёта записывалки
 * (slotHolder): 0 — учётка из .env, N — осиротевшая учётка студента (заявки
 * уже нет, а слот остался). Строки до этого поля: служебная (id 0) и
 * подписанная (дата 1970-го) — учётка из .env. Обычная заявка — свой номер.
 */
function removeExpect(r: RecRequestRow): number {
  if (r.slotHolder !== null) return r.slotHolder;
  return r.userId === 0 || r.createdAt.startsWith("1970-") ? 0 : r.id;
}

/**
 * Задания из текущего состояния заявок. Идемпотентно: id = requestId:kind.
 * Отзывы — первыми (записывалка выполняет задания по порядку), хотя remove и
 * так убирает только слот своей заявки (expect): новую учётку, вставшую на
 * место старой, повторный remove старой не тронет.
 */
export function recorderTasks(repo: Repo, now = Date.now()): RecTask[] {
  const tasks: RecTask[] = [];
  const envelope = (r: RecRequestRow): unknown => {
    try {
      return r.envelopeJson ? JSON.parse(r.envelopeJson) : undefined;
    } catch {
      return undefined; // битый конверт — задание не шлём, пусть истечёт по сроку
    }
  };
  for (const r of repo.recRequestsByState(["revoking"])) {
    tasks.push({ id: `${r.id}:remove`, kind: "remove", requestId: r.id, userId: r.userId, group: r.groupTitle, codes: [groupCode(r.groupTitle)], expect: removeExpect(r) });
  }
  for (const r of repo.recRequestsByState(["pending_verify"])) {
    const wait = repo.recorderMarkValue(`${VERIFY_WAIT_PREFIX}${r.id}`);
    if (wait && Date.parse(wait) > now) continue;
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
  /** Осиротевшие учётки студентов, поставленные на снятие (номера заявок). */
  orphans: number[];
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

/** Заявки, учётки которых в слоте быть не должно. */
const CLOSED_STATES = new Set(["revoked_early", "forgotten", "rejected", "rejected_auth", "rejected_bad_envelope", "expired"]);

/** Применить отчёт записывалки: ключ, результаты заданий, зеркало слотов, истёкшие заявки. */
export function applyRecorderReport(repo: Repo, report: RecReport, now = Date.now()): RecReportEffect {
  const effect: RecReportEffect = { firstConnect: false, keyChanged: false, transitions: [], lost: [], recovered: [], rechecked: [], orphans: [] };
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
    // Зеркало — единственное место, где строки слотов появляются и пропадают.
    if (Array.isArray(report.slots)) {
      const before = new Map(repo.recSlots().map((sl) => [sl.groupKey, sl]));
      // Два слота записывалки на одну группу (старая учётка под портальным
      // именем и новая под нашим) — одна строка: «пускает», если пускает хоть
      // один. Иначе строки затирали бы друг друга, и вести «не пускает / снова
      // пускает» шли бы каждую минуту.
      const byKey = new Map<string, { group: string; status: string; lastOkAt: string | null; holderId: number | null }>();
      for (const s of report.slots) {
        if (!s.group) continue;
        const key = logicalKeyFor(s.group);
        const had = byKey.get(key);
        const holderId = typeof s.requestId === "number" ? s.requestId : null;
        if (!had) byKey.set(key, { group: s.group, status: s.status, lastOkAt: s.lastOkAt ?? null, holderId });
        else {
          const keepHad = had.status === "ok";
          byKey.set(key, { group: keepHad ? had.group : s.group, holderId: keepHad ? had.holderId : holderId, status: had.status === "ok" || s.status === "ok" ? "ok" : s.status, lastOkAt: [had.lastOkAt, s.lastOkAt ?? null].filter(Boolean).sort().pop() ?? null });
        }
      }
      for (const [key, s] of byKey) {
        const req = repo.activeRecRequest(key);
        const prev = before.get(key)?.status;
        const change: RecSlotChange = { groupKey: key, groupTitle: s.group, requestId: req?.id ?? null, userId: req?.userId ?? null, username: req?.username ?? null };
        if (s.status === "lost" && prev !== "lost") effect.lost.push(change);
        if (s.status === "ok" && prev === "lost") effect.recovered.push(change);
        repo.upsertRecSlot({ groupKey: key, groupTitle: s.group, requestId: req?.id ?? null, holderId: s.holderId, status: s.status, lastOkAt: s.lastOkAt });
        // Осиротевшая учётка студента: в слоте его заявка N, а N уже закрыта —
        // отозвана до одобрения в прошлых версиях (revoked_early), забыта (/soon),
        // отклонена. Студенту обещано «логин и пароль удалены» — снимаем сами.
        // Заявки N в базе нет вовсе (база восстановлена из копии или потеряна) —
        // сами не трогаем: решает админ кнопкой «Отозвать» в /slots.
        if (s.holderId && s.holderId > 0) {
          const holder = repo.recRequest(s.holderId);
          const closed = holder !== null && CLOSED_STATES.has(holder.state);
          const removing = repo.recRequestsByState(["revoking"]).some((r) => r.groupKey === key && removeExpect(r) === s.holderId);
          if (closed && !removing) {
            const id = repo.createRecRequest({ userId: 0, username: null, groupKey: key, groupTitle: s.group, envelopeJson: "", slotHolder: s.holderId });
            repo.setRecRequestState(id, "revoking", { dropEnvelope: true });
            effect.orphans.push(s.holderId);
          }
        }
      }
      // Записывалка присылает все слоты: чего нет в отчёте, того нет и у неё.
      // Вместе со строкой уходят её подпись владельца и «проверить снова».
      for (const key of before.keys()) {
        if (byKey.has(key)) continue;
        repo.removeRecSlot(key);
        repo.clearRecorderMark(`${OWNER_PREFIX}${key}`);
        repo.clearRecorderMark(`${RECHECK_PREFIX}${key}`);
      }
    }
    // Заявки, которые неделю не проверились или не решены, — истекают; шифровку стираем.
    const olderThan = new Date(now - REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    for (const req of repo.staleRecRequests(["pending_verify", "verified"], olderThan)) {
      repo.setRecRequestState(req.id, "expired", { dropEnvelope: true });
      effect.transitions.push(transition(req, "expired"));
    }
    // Пауза проверки нужна, только пока заявка ждёт проверки.
    for (const key of repo.recorderMarkKeys(VERIFY_WAIT_PREFIX)) {
      const req = repo.recRequest(Number(key.slice(VERIFY_WAIT_PREFIX.length)));
      if (!req || req.state !== "pending_verify") repo.clearRecorderMark(key);
    }
    // Следы /soon держат месячный лимит — после 30 дней они больше не нужны.
    repo.purgeForgottenRecRequests(new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString());
    if (report.portal) repo.recorderMark("portal", report.portal);
    const live = sanitizeLive(report.live);
    if (live) repo.recorderMark(LIVE_MARK, JSON.stringify(live));
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
      return "rejected_auth";
    case "bad_envelope":
      if (req.state !== "pending_verify" && req.state !== "approved") return null;
      repo.setRecRequestState(req.id, "rejected_bad_envelope", { dropEnvelope: true });
      return "rejected_bad_envelope";
    case "portal_down":
      // Остаёмся pending_verify, но следующую попытку — через полчаса.
      if (req.state === "pending_verify") repo.recorderMark(`${VERIFY_WAIT_PREFIX}${req.id}`, new Date(Date.now() + VERIFY_WAIT_MS).toISOString());
      return null;
    case "installed":
      // Отозвали, пока отчёт об установке был в пути (уже revoking), — remove
      // своей заявки уберёт поставленное на следующем обмене.
      if (req.state !== "approved") return null;
      repo.setRecRequestState(req.id, "active", { dropEnvelope: true });
      return "active";
    case "removed":
      if (req.state !== "revoking") return null;
      // Отзыв завершён — строку удаляем целиком (в т. ч. id и ник забытого
      // человека). Строку слота уберёт зеркало: в этом же отчёте её уже нет.
      repo.deleteRecRequest(req.id);
      return "revoked";
    case "group_mismatch":
      return null;
  }
}

/** Чем закончилось действие над заявкой — для ответа на нажатие кнопки. */
export type RecActionResult =
  | { ok: true; replaced?: RecRequestRow | null; replacedEnv?: boolean; immediate?: boolean }
  | { ok: false; reason: "gone" | "state" | "no_envelope" };

/** В слоте группы стоит учётка без заявки (из .env), не общая. */
export function heldWithoutRequest(repo: Repo, groupKey: string): boolean {
  const slot = repo.recSlots().find((s) => s.groupKey === groupKey);
  return !!slot && slot.groupTitle !== GENERAL_SLOT_TITLE && !repo.activeRecRequest(groupKey);
}

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
    // Слот без заявки (учётка из .env) — тоже занят: убрать его по имени
    // записывалки (оно может отличаться от нашего названия группы), иначе
    // install молча затёр бы учётку или завёл второй слот на ту же группу.
    const envSlot = !prev && heldWithoutRequest(repo, req.groupKey);
    if (envSlot) revokeSlotWithoutRequest(repo, req.groupKey, adminId);
    repo.setRecRequestState(req.id, "approved", { decidedBy: adminId });
    result = { ok: true, replaced: prev && prev.id !== req.id ? prev : null, replacedEnv: envSlot };
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
 * Отозвать учётку (студент или админ). Поставленная и одобренная — на отзыв:
 * записывалка уберёт слот этой заявки, если он есть (remove повторяется каждый
 * обмен до «removed», так что потерянный отчёт об установке не оставит учётку
 * в слоте), уже идущая запись пары доснимется. Неодобренная снимается сразу
 * (immediate): на записывалке её нет.
 */
export function revokeRecRequest(repo: Repo, id: number, by?: number): RecActionResult {
  const req = repo.recRequest(id);
  if (!req) return { ok: false, reason: "gone" };
  if (req.state === "active" || req.state === "approved") {
    repo.setRecRequestState(id, "revoking", { dropEnvelope: true, ...(by !== undefined ? { decidedBy: by } : {}) });
    return { ok: true };
  }
  if (req.state === "pending_verify" || req.state === "verified") {
    repo.setRecRequestState(id, "revoked_early", { dropEnvelope: true, ...(by !== undefined ? { decidedBy: by } : {}) });
    return { ok: true, immediate: true };
  }
  return { ok: false, reason: "state" };
}

/**
 * Отозвать слот, у которого нет заявки (учётка перенесена из .env). Заводим
 * служебную заявку сразу «на отзыв» — дальше тот же путь: задание remove,
 * отчёт removed удаляет строку. Студента у неё нет (id 0) — писать некому.
 */
export function revokeSlotWithoutRequest(repo: Repo, groupKey: string, adminId: number): boolean {
  // Общая учётка живёт в .env — кнопкой её не убрать; слот заявки — отзыв заявки.
  if (!heldWithoutRequest(repo, groupKey)) return false;
  const slot = repo.recSlots().find((s) => s.groupKey === groupKey)!;
  // Уже убираем именно её (а не отзываемую заявку студента той же группы).
  const holder = slot.holderId ?? 0;
  if (repo.recRequestsByState(["revoking"]).some((r) => r.groupKey === groupKey && r.userId === 0 && removeExpect(r) === holder)) return true;
  // Номер учётки в слоте — из отчёта записывалки: так remove уберёт и
  // осиротевшую учётку студента, а не только учётку из .env (номер 0).
  const id = repo.createRecRequest({ userId: 0, username: null, groupKey, groupTitle: slot.groupTitle, envelopeJson: "", slotHolder: holder });
  repo.setRecRequestState(id, "revoking", { dropEnvelope: true, decidedBy: adminId });
  return true;
}

/** Чем закончилась привязка слота к человеку. */
export type AdoptResult = { ok: true; slotTitle: string; linked: boolean } | { ok: false; reason: "no_slot" | "taken" | "ambiguous" };

/**
 * Подписать слот без заявки (учётка из .env) владельцем. Знаком боту —
 * становится обычной «стоящей в слоте» заявкой: вести ему, «Отозвать» сам.
 * Не знаком — только подпись в /slots, пока он не напишет боту.
 */
export function adoptSlot(repo: Repo, groupArg: string, username: string, adminId: number): AdoptResult {
  const slots = repo.recSlots().filter((s) => s.groupTitle !== GENERAL_SLOT_TITLE);
  // Сначала точное совпадение группы («ОЗВИШ-14-25», «ВИШ-11-23 (ЭиЭА)»),
  // потом по номеру («14-25»), но только если он однозначен: иначе подпись
  // досталась бы чужому слоту (ВИШ-14-25 вместо ОЗВИШ-14-25).
  let slot = slots.find((s) => s.groupKey === logicalKeyFor(groupArg));
  if (!slot) {
    const byCode = slots.filter((s) => groupCode(s.groupTitle) === groupCode(groupArg));
    if (byCode.length > 1) return { ok: false, reason: "ambiguous" };
    slot = byCode[0];
  }
  if (!slot) return { ok: false, reason: "no_slot" };
  if (repo.activeRecRequest(slot.groupKey)) return { ok: false, reason: "taken" };
  const nick = username.replace(/^@/, "");
  const user = repo.userByUsername(nick);
  if (user) {
    repo.adoptRecSlot({ userId: user.id, username: user.username ?? nick, groupKey: slot.groupKey, groupTitle: slot.groupTitle, adminId, slotHolder: slot.holderId ?? 0 });
    repo.clearRecorderMark(`${OWNER_PREFIX}${slot.groupKey}`);
    return { ok: true, slotTitle: slot.groupTitle, linked: true };
  }
  repo.recorderMark(`${OWNER_PREFIX}${slot.groupKey}`, nick);
  return { ok: true, slotTitle: slot.groupTitle, linked: false };
}

/** «Проверить снова» потерянный слот: на следующем обмене записывалка зайдёт в кабинет. */
export function requestRecheck(repo: Repo, groupKey: string): boolean {
  if (!repo.recSlots().some((s) => s.groupKey === groupKey)) return false;
  repo.recorderMark(`${RECHECK_PREFIX}${groupKey}`, new Date().toISOString());
  return true;
}
