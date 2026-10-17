/**
 * Уведомления по заявкам на запись (этап 2C): кому и что сказать после отчёта
 * записывалки. Админу — карточка проверенной заявки с «Одобрить/Отклонить»,
 * потеря доступа слота; студенту — нейтрально, что с его заявкой. Тексты и
 * карточки собраны здесь, чтобы ими пользовались и обработчики кнопок.
 *
 * Тому, кто сделал /soon (строки users уже нет), не пишем: он просил забыть.
 */
import { InlineKeyboard } from "grammy";
import type { Repo, RecRequestRow } from "../db/repo.js";
import { GENERAL_SLOT_TITLE, heldWithoutRequest, OWNER_PREFIX, type RecReportEffect, type RecSlotChange, type RecTransition } from "./recorder.js";
import { requestsLeft } from "./tma.js";
import { esc } from "../schedule/format.js";
import { fmtDDMM, fmtHHMM, wallClock } from "../time.js";
import { logicalKeyFor } from "../schedule/groups.js";
import { logger } from "../logger.js";

/** Сколько нужно от Bot API: только отправка. В тестах — подделка. */
export interface SendApi {
  sendMessage(chatId: number, text: string, other?: { parse_mode?: "HTML"; reply_markup?: InlineKeyboard }): Promise<unknown>;
}

import { FORM_PATH } from "./keyboards.js";
export { FORM_PATH };

const who = (username: string | null, userId: number | null): string => (username ? `@${esc(username)}` : userId ? `id ${userId}` : "учётка из .env");

/** «17.10 12:58» по Москве. */
export function mskStamp(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const wc = wallClock(new Date(ms));
  return `${fmtDDMM(wc.date)} ${fmtHHMM(wc.minutes)}`;
}

/** Карточка проверенной заявки для админа. Состояние перечитывается при каждом показе. */
export function requestCard(repo: Repo, req: RecRequestRow): { text: string; kb?: InlineKeyboard } {
  const lines = [`🎥 <b>Заявка на запись №${req.id}</b>`, `Группа: ${esc(req.groupTitle)}`];
  if (req.actualGroup) {
    const same = logicalKeyFor(req.actualGroup) === req.groupKey;
    lines.push(`По кабинету: ${esc(req.actualGroup)} ${same ? "✅" : "⚠️ не совпадает с заявленной"}`);
  }
  lines.push(`От: ${who(req.username, req.userId)} (id ${req.userId})`, "Вход на портал: ✅ проверен");
  const holder = repo.activeRecRequest(req.groupKey);
  if (holder && holder.id !== req.id) lines.push(`Слот группы занят ${who(holder.username, holder.userId)} — одобрение заменит учётку.`);
  else if (!holder && heldWithoutRequest(repo, req.groupKey)) {
    const label = repo.recorderMarkValue(`${OWNER_PREFIX}${req.groupKey}`);
    lines.push(`Слот группы занят учёткой из .env${label ? ` (@${esc(label)})` : ""} — одобрение заменит её.`);
  } else lines.push("Слот группы свободен.");
  if (req.state !== "verified") return { text: `${lines.join("\n")}\n\n<i>${stateLabel(req.state)}</i>` };
  const kb = new InlineKeyboard().text("✅ Одобрить", `rq:ok:${req.id}`).text("❌ Отклонить", `rq:no:${req.id}`);
  return { text: lines.join("\n"), kb };
}

/** Состояние заявки словами — для карточки, когда решать уже нечего. */
export function stateLabel(state: string): string {
  switch (state) {
    case "pending_verify":
      return "⏳ Проверяю вход на портал";
    case "verified":
      return "⏳ Ждёт решения админа";
    case "approved":
      return "✅ Одобрена — ставлю в слот";
    case "active":
      return "✅ Стоит в слоте, пары записываются";
    case "revoking":
      return "🗑 Убираю учётку из записи";
    case "rejected":
      return "❌ Отклонена";
    case "rejected_auth":
      return "❌ Вход на портал не прошёл";
    case "rejected_bad_envelope":
      return "❌ Шифровку не удалось прочитать";
    case "expired":
      return "⌛ Истекла";
    case "revoked_early":
      return "🗑 Отозвана до решения";
    default:
      return state;
  }
}

/** Что сказать студенту при смене состояния его заявки; null — ничего. */
function studentText(repo: Repo, t: RecTransition): { text: string; kb?: InlineKeyboard } | null {
  const g = esc(t.groupTitle);
  switch (t.to) {
    case "rejected_auth":
      if (t.from === "approved") return { text: `🎥 Учётку для записи группы ${g} поставить не удалось: портал не пустил под ней. Проверь логин и пароль и подай заявку снова: ${FORM_PATH}.` };
      return { text: `🎥 Не получилось войти на портал с этим логином и паролем — заявка на запись группы ${g} не принята.\nПроверь их и подай снова: ${FORM_PATH}. Заявок в этом месяце осталось: ${requestsLeft(repo, t.userId)}.` };
    case "rejected_bad_envelope":
      return { text: `🎥 Заявку на запись группы ${g} не удалось прочитать на сервере записи. Подай её заново: ${FORM_PATH}. В лимит она не засчитана.` };
    case "active":
      return {
        text: `✅ Запись пар группы ${g} подключена: бот будет заходить на онлайн-пары под твоей учёткой и присылать слайды всем в группе.\nОтозвать можно в любой момент — идущая пара при этом доснимется.`,
        kb: new InlineKeyboard().text("🗑 Отозвать", "rqme:rv"),
      };
    case "expired": {
      const why = t.from === "pending_verify" ? "за неделю не удалось проверить вход — портал не отвечал" : "за неделю её не успели рассмотреть";
      return { text: `⌛ Заявка на запись группы ${g} истекла: ${why}. Логин и пароль удалены. Можно подать заново (${FORM_PATH}), в лимит она не засчитана.` };
    }
    case "revoked":
      return { text: `🗑 Твоя учётка убрана из записи группы ${g}: логин и пароль удалены с сервера записи.` };
    default:
      return null;
  }
}

/** Что сказать админам при смене состояния заявки; null — ничего. */
function adminText(repo: Repo, t: RecTransition): { text: string; kb?: InlineKeyboard } | null {
  const g = esc(t.groupTitle);
  switch (t.to) {
    case "verified": {
      const req = repo.recRequest(t.requestId);
      return req ? requestCard(repo, req) : null;
    }
    case "active":
      return { text: `✅ Слот ${g} поставлен (${who(t.username, t.userId)}).` };
    case "rejected_auth":
    case "rejected_bad_envelope":
      // Осечка при проверке — дело студента; при установке после одобрения — админу стоит знать.
      return t.from === "approved" ? { text: `⚠️ Слот ${g} не поставлен: ${t.to === "rejected_auth" ? "портал не пустил" : "шифровку не прочитать"} (${who(t.username, t.userId)}). Студенту написал.` } : null;
    default:
      return null;
  }
}

/**
 * Кнопки слота: по заявке, а у слота без заявки (учётка из .env) — по группе.
 * У общей учётки — только «Проверить снова»: она в .env, отзывать нечего.
 */
export function slotButtons(requestId: number | null, groupKey: string, groupTitle = ""): { recheck: string; revoke?: string } | null {
  if (requestId !== null) return { recheck: `rq:rc:${requestId}`, revoke: `rq:rv:${requestId}` };
  // callback_data — не больше 64 байт; ключ группы кириллицей, с запасом на «rq:rvgy:».
  if (Buffer.byteLength(`rq:rvgy:${groupKey}`) > 64) return null;
  if (groupTitle === GENERAL_SLOT_TITLE) return { recheck: `rq:rcg:${groupKey}` };
  return { recheck: `rq:rcg:${groupKey}`, revoke: `rq:rvg:${groupKey}` };
}

function slotKb(c: RecSlotChange): InlineKeyboard | undefined {
  const b = slotButtons(c.requestId, c.groupKey, c.groupTitle);
  if (!b) return undefined;
  const kb = new InlineKeyboard().text("🔁 Проверить снова", b.recheck);
  return b.revoke ? kb.text("🗑 Отозвать", b.revoke) : kb;
}

/** Разослать уведомления по итогам отчёта записывалки. Ошибки отправки — только в лог (id и цифры). */
export async function notifyRecorderEffect(api: SendApi, repo: Repo, adminIds: number[], effect: RecReportEffect): Promise<void> {
  const out: Array<{ to: number; text: string; kb?: InlineKeyboard }> = [];
  const admins = (text: string, kb?: InlineKeyboard): void => adminIds.forEach((id) => out.push({ to: id, text, kb }));
  // Студенту — только если он ещё с ботом (после /soon не пишем).
  const student = (userId: number | null, text: string, kb?: InlineKeyboard): void => {
    if (userId && repo.getUser(userId)) out.push({ to: userId, text, kb });
  };

  if (effect.firstConnect) admins("🎥 Записывалка подключилась к заявкам на запись.");
  if (effect.keyChanged) admins("⚠️ Ключ записывалки сменился. Заявки, поданные до этого и ещё не одобренные, придётся подать заново.");
  for (const t of effect.transitions) {
    const a = adminText(repo, t);
    if (a) admins(a.text, a.kb);
    const s = studentText(repo, t);
    if (s) student(t.userId, s.text, s.kb);
  }
  for (const c of effect.lost) {
    if (c.groupTitle === GENERAL_SLOT_TITLE) {
      admins("⚠️ Общая учётка (.env, профиль 1) перестала пускать в кабинет — похоже, сменился пароль. Поправь WEBINAR_PASSWORD в .env и пересоздай контейнер (vps-update.sh --recreate). На пары пробую её как раньше.", slotKb(c));
      continue;
    }
    const label = c.requestId === null ? repo.recorderMarkValue(`${OWNER_PREFIX}${c.groupKey}`) : null;
    admins(`⚠️ Слот ${esc(c.groupTitle)} (${label ? `@${esc(label)}, из .env` : who(c.username, c.userId)}): портал перестал пускать — на пары под этой учёткой не захожу.`, slotKb(c));
    student(c.userId, `⏸ Запись пар группы ${esc(c.groupTitle)} приостановлена: портал перестал пускать под твоей учёткой (например, сменился пароль).\nЕсли менял пароль — отзови старую учётку и подай заявку заново: ${FORM_PATH}.`);
  }
  for (const c of effect.recovered) {
    if (c.groupTitle === GENERAL_SLOT_TITLE) {
      admins("✅ Общая учётка (.env) снова пускает.");
      continue;
    }
    admins(`✅ Слот ${esc(c.groupTitle)} снова пускает.`);
    student(c.userId, `▶️ Запись пар группы ${esc(c.groupTitle)} снова работает.`);
  }
  // «Проверить снова»: успех уже сказан выше (снова пускает), здесь — остальные исходы.
  for (const r of effect.rechecked) {
    const g = esc(r.groupTitle);
    if (r.code === "login_failed") admins(`🔁 Слот ${g}: проверил — портал всё ещё не пускает.`);
    else if (r.code === "portal_down") admins(`🔁 Слот ${g}: портал сейчас не отвечает — проверить не удалось, нажми «Проверить снова» позже.`);
    else if (r.code === "removed") admins(`🔁 Слота ${g} на сервере записи уже нет.`);
    else if (r.code === "login_ok" && !effect.recovered.some((c) => c.groupKey === r.groupKey)) admins(`🔁 Слот ${g}: вход прошёл.`);
  }

  for (const m of out) {
    try {
      await api.sendMessage(m.to, m.text, { parse_mode: "HTML", ...(m.kb ? { reply_markup: m.kb } : {}) });
    } catch (err) {
      logger.debug({ to: m.to, err: (err as Error).name }, "уведомление по заявке на запись не ушло");
    }
  }
}
