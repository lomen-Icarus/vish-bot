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
 * Задания из текущего состояния заявок. Идемпотентно: id = requestId:kind.
 * Отзывы — первыми: записывалка выполняет задания по порядку, а слот убирает
 * по группе. Замена учётки группы (старая заявка — на отзыв, новая одобрена)
 * иначе поставила бы новую и тут же её убрала.
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
    tasks.push({ id: `${r.id}:remove`, kind: "remove", requestId: r.id, userId: r.userId, group: r.groupTitle, codes: [groupCode(r.groupTitle)] });
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
    // Зеркало — единственное место, где строки слотов появляются и пропадают.
    if (Array.isArray(report.slots)) {
      const before = new Map(repo.recSlots().map((sl) => [sl.groupKey, sl]));
      // Два слота записывалки на одну группу (старая учётка под портальным
      // именем и новая под нашим) — одна строка: «пускает», если пускает хоть
      // один. Иначе строки затирали бы друг друга, и вести «не пускает / снова
      // пускает» шли бы каждую минуту.
      const byKey = new Map<string, { group: string; status: string; lastOkAt: string | null }>();
      for (const s of report.slots) {
        if (!s.group) continue;
        const key = logicalKeyFor(s.group);
        const had = byKey.get(key);
        if (!had) byKey.set(key, { group: s.group, status: s.status, lastOkAt: s.lastOkAt ?? null });
        else byKey.set(key, { group: had.status === "ok" ? had.group : s.group, status: had.status === "ok" || s.status === "ok" ? "ok" : s.status, lastOkAt: [had.lastOkAt, s.lastOkAt ?? null].filter(Boolean).sort().pop() ?? null });
      }
      for (const [key, s] of byKey) {
        const req = repo.activeRecRequest(key);
        const prev = before.get(key)?.status;
        const change: RecSlotChange = { groupKey: key, groupTitle: s.group, requestId: req?.id ?? null, userId: req?.userId ?? null, username: req?.username ?? null };
        if (s.status === "lost" && prev !== "lost") effect.lost.push(change);
        if (s.status === "ok" && prev === "lost") effect.recovered.push(change);
        repo.upsertRecSlot({ groupKey: key, groupTitle: s.group, requestId: req?.id ?? null, status: s.status, lastOkAt: s.lastOkAt });
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
      // Отозвали, пока отчёт об установке был в пути, — учётка всё же встала:
      // теперь её надо убрать (remove уйдёт на следующем обмене).
      if (req.state === "revoked_early") {
        repo.setRecRequestState(req.id, "revoking", { dropEnvelope: true });
        return "revoking";
      }
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
 * Отозвать учётку (студент или админ). Поставленная — на отзыв: записывалка
 * уберёт слот, уже идущая запись пары доснимется (ссылка на комнату у неё уже
 * есть). Одобренная, но ещё не поставленная, и неодобренная — снимаются сразу
 * (immediate): задание remove по группе снесло бы то, что сейчас стоит в
 * слоте, — например, учётку из .env. Если отчёт об установке был уже в пути,
 * его разберёт nextState («installed» у снятой → на отзыв).
 */
export function revokeRecRequest(repo: Repo, id: number, by?: number): RecActionResult {
  const req = repo.recRequest(id);
  if (!req) return { ok: false, reason: "gone" };
  if (req.state === "active") {
    repo.setRecRequestState(id, "revoking", { dropEnvelope: true, ...(by !== undefined ? { decidedBy: by } : {}) });
    return { ok: true };
  }
  if (req.state === "approved" || req.state === "pending_verify" || req.state === "verified") {
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
  const slot = repo.recSlots().find((s) => s.groupKey === groupKey);
  // Общая учётка живёт в .env — кнопкой её не убрать.
  if (!slot || slot.groupTitle === GENERAL_SLOT_TITLE || repo.activeRecRequest(groupKey)) return false;
  if (repo.recRequestsByState(["revoking"]).some((r) => r.groupKey === groupKey)) return true;
  const id = repo.createRecRequest({ userId: 0, username: null, groupKey, groupTitle: slot.groupTitle, envelopeJson: "" });
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
    repo.adoptRecSlot({ userId: user.id, username: user.username ?? nick, groupKey: slot.groupKey, groupTitle: slot.groupTitle, adminId });
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
