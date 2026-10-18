/**
 * Заявки на запись (этап 2C): решения админа и экран студента.
 *
 * Админ: карточка проверенной заявки («✅ Одобрить / ❌ Отклонить»), экран
 * /slots (он же «/admin → 🎥 Слоты записи») — все группы ВИШ со статусом
 * слота, кто дал учётку и когда портал пускал последний раз; у слота —
 * «🔁 Проверить снова» и «🗑 Отозвать» (с подтверждением).
 *
 * Студент: «🗂 Ещё → 🎥 Запись моей группы», пока у него есть заявка в работе
 * или учётка в слоте: статус и «🗑 Отозвать» (с подтверждением). Без заявки
 * та же кнопка открывает форму.
 *
 * Действия над заявками — в recorder.ts; здесь только кнопки и тексты. В
 * логах — номера заявок и id, без ников и групп.
 */
import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { esc } from "../../schedule/format.js";
import { adoptSlot, approveRecRequest, GENERAL_SLOT_TITLE, OWNER_PREFIX, rejectRecRequest, requestRecheck, revokeRecRequest, revokeSlotWithoutRequest, type RecActionResult } from "../recorder.js";
import { mskStamp, requestCard, slotButtons, stateLabel } from "../recNotify.js";
import { REQUEST_LIMIT, studentGroupList } from "../tma.js";
import { FORM_PATH, STATUS_PATH } from "../keyboards.js";
import type { Repo, RecRequestRow } from "../../db/repo.js";
import type { LogicalGroup } from "../../schedule/groups.js";
import { logger } from "../../logger.js";

export const recSlotsHandlers = new Composer<BotContext>();
const adminOnly = recSlotsHandlers.filter((ctx) => ctx.isAdmin);

const who = (r: { username: string | null; userId: number }): string => (r.username ? `@${esc(r.username)}` : `id ${r.userId}`);

const GONE = "Заявка уже не актуальна";

function failText(res: RecActionResult): string {
  if (res.ok) return "";
  return res.reason === "no_envelope" ? "Шифровки нет — студенту придётся подать заново" : GONE;
}

// ---- экран слотов (админ) ----

/** Текст и кнопки /slots: все учебные группы, слоты со статусом, ждущие заявки. */
export function slotsScreen(repo: Repo, groups: LogicalGroup[]): { text: string; kb: InlineKeyboard } {
  const all = repo.recSlots();
  // Общая учётка (профиль 1 из .env) — отдельной строкой сверху, не слот группы.
  const general = all.find((s) => s.groupTitle === GENERAL_SLOT_TITLE);
  const slots = new Map(all.filter((s) => s !== general).map((s) => [s.groupKey, s]));
  const rechecks = new Set(repo.recorderMarkKeys("recheck:").map((k) => k.slice("recheck:".length)));
  const list = studentGroupList(groups);
  const known = new Set(list.map((g) => g.key));
  const kb = new InlineKeyboard();
  const lines: string[] = [];
  let filled = 0;
  // Заявки, одобренные, но ещё не поставленные, — тоже видно (⏳).
  const approved = new Map(repo.recRequestsByState(["approved"]).map((r) => [r.groupKey, r]));
  const rows: Array<{ key: string; title: string }> = [...list.map((g) => ({ key: g.key, title: g.title })), ...[...slots.values()].filter((s) => !known.has(s.groupKey)).map((s) => ({ key: s.groupKey, title: s.groupTitle }))];
  for (const g of rows) {
    const slot = slots.get(g.key);
    const req = repo.activeRecRequest(g.key);
    if (slot) {
      filled++;
      const label = req ? null : repo.recorderMarkValue(`${OWNER_PREFIX}${g.key}`);
      // holderId > 0 без живой заявки — учётка студента, заявки которой в базе нет (или она закрыта).
      const holder = req ? who(req) : slot.holderId ? `учётка заявки №${slot.holderId} (заявки нет)` : label ? `@${esc(label)} (из .env)` : "учётка из .env";
      const state = rechecks.has(g.key)
        ? "🔁 проверяю заново"
        : slot.status === "lost"
          ? `не пускает (последний вход ${mskStamp(slot.lastOkAt)})`
          : `пускало ${mskStamp(slot.lastOkAt)}`;
      lines.push(`${slot.status === "lost" ? "⚠️" : "✅"} ${esc(g.title)} — ${holder} · ${state}`);
      const b = slotButtons(req?.id ?? null, g.key, g.title);
      if (b) {
        const short = g.title.replace(/^(ОЗ)?ВИШ-/, "");
        if (slot.status === "lost") kb.text(`🔁 ${short}`, b.recheck);
        if (b.revoke) kb.text(`🗑 ${short}`, b.revoke);
        kb.row();
      }
    } else if (approved.has(g.key)) {
      lines.push(`⏳ ${esc(g.title)} — ${who(approved.get(g.key)!)} · ставлю в слот`);
    } else {
      lines.push(`▫️ ${esc(g.title)}`);
    }
  }
  const waiting = repo.recRequestsByState(["verified"]).length;
  const checking = repo.recRequestsByState(["pending_verify"]).length;
  const last = repo.recorderMarkValue("last_report_at");
  const portal = repo.recorderMarkValue("portal");
  const head = [
    `🎥 <b>Слоты записи</b> — ${filled} из ${list.length} групп`,
    `Записывалка: ${last ? `на связи ${mskStamp(last)}` : "ещё не подключалась"}${portal ? ` · портал ${portal === "ok" ? "✅" : "лежит"}` : ""}`,
  ];
  if (general) {
    const state = rechecks.has(general.groupKey) ? "🔁 проверяю заново" : general.status === "lost" ? `не пускает (последний вход ${mskStamp(general.lastOkAt)})` : `пускало ${mskStamp(general.lastOkAt)}`;
    head.push(`🔑 Общая учётка (.env) — для групп без своей: ${general.status === "lost" ? "⚠️ " : "✅ "}${state}`);
    const b = slotButtons(null, general.groupKey, general.groupTitle);
    // Кнопка — после слотов групп, перед «Заявки» и «Обновить».
    if (general.status === "lost" && b) kb.text("🔁 Общая учётка", b.recheck).row();
  }
  const tail: string[] = [];
  if (waiting) tail.push(`Ждут решения: ${waiting}`);
  if (checking) tail.push(`Проверяю вход: ${checking}`);
  if (waiting) kb.text(`📨 Заявки (${waiting})`, "rq:list");
  kb.text("🔄 Обновить", "rq:slots");
  return { text: [...head, "", ...lines, ...(tail.length ? ["", tail.join(" · ")] : []), "", "<i>✅ пускает · ⚠️ не пускает · ⏳ ставлю · ▫️ нет учётки</i>"].join("\n"), kb };
}

async function showSlots(ctx: BotContext, edit: boolean): Promise<void> {
  const { text, kb } = slotsScreen(ctx.deps.repo, ctx.deps.service.groups());
  if (edit) await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => undefined);
  else await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

adminOnly.command("slots", (ctx) => showSlots(ctx, false));

adminOnly.callbackQuery("adm:slots", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showSlots(ctx, false);
});

adminOnly.callbackQuery("rq:slots", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showSlots(ctx, true);
});

/** Ждущие решения заявки — карточками заново (если старые потерялись в чате). */
adminOnly.callbackQuery("rq:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const waiting = ctx.deps.repo.recRequestsByState(["verified"]);
  if (!waiting.length) return void (await ctx.reply("Заявок, ждущих решения, нет."));
  for (const req of waiting) {
    const card = requestCard(ctx.deps.repo, req);
    await ctx.reply(card.text, { parse_mode: "HTML", ...(card.kb ? { reply_markup: card.kb } : {}) });
  }
});

/** Перерисовать карточку заявки по текущему состоянию (после решения или если решать уже нечего). */
async function refreshCard(ctx: BotContext, id: number): Promise<void> {
  const req = ctx.deps.repo.recRequest(id);
  if (!req) return void (await ctx.editMessageText(`🎥 Заявка №${id}: ${GONE.toLowerCase()} (снята или удалена).`).catch(() => undefined));
  const card = requestCard(ctx.deps.repo, req);
  await ctx.editMessageText(card.text, { parse_mode: "HTML", ...(card.kb ? { reply_markup: card.kb } : {}) }).catch(() => undefined);
}

adminOnly.callbackQuery(/^rq:ok:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const res = approveRecRequest(ctx.deps.repo, id, ctx.from.id);
  logger.info({ request: id, admin: ctx.from.id, ok: res.ok, replaced: res.ok ? (res.replaced?.id ?? null) : null }, "заявка на запись: одобрение");
  await ctx.answerCallbackQuery({ text: res.ok ? (res.replaced || res.replacedEnv ? "Одобрено: прежнюю учётку уберу, новую поставлю" : "Одобрено: поставлю в слот в ближайшую минуту") : failText(res) });
  await refreshCard(ctx, id);
  // Тому, чью учётку заменили, — почему её убирают (иначе «учётка убрана» без объяснений).
  const old = res.ok ? res.replaced : null;
  if (old && ctx.deps.repo.getUser(old.userId)) {
    await ctx.api.sendMessage(old.userId, `🎥 Для записи группы ${esc(old.groupTitle)} подключили другую учётку — твою бот больше не использует, логин и пароль удалятся с сервера записи. Спасибо, что помог(ла)!`, { parse_mode: "HTML" }).catch(() => undefined);
  }
});

// «Отклонить» — с подтверждением, как «Отозвать»: шифровка стирается, студенту
// уходит весть и заявка засчитывается в его лимит, а промахнуться мимо
// «Одобрить» в соседней кнопке легко.
adminOnly.callbackQuery(/^rq:no:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const req = ctx.deps.repo.recRequest(id);
  await ctx.answerCallbackQuery();
  if (!req || req.state !== "verified") return refreshCard(ctx, id);
  const card = requestCard(ctx.deps.repo, req);
  const kb = new InlineKeyboard().text("❌ Да, отклонить", `rq:noy:${id}`).text("◀️ Назад", `rq:card:${id}`);
  await ctx.editMessageText(`${card.text}

Отклонить? Логин и пароль сотрутся, студенту придёт весть, заявка засчитается в его лимит (${REQUEST_LIMIT} в месяц).`, { parse_mode: "HTML", reply_markup: kb }).catch(() => undefined);
});

adminOnly.callbackQuery(/^rq:card:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await refreshCard(ctx, Number(ctx.match[1]));
});

adminOnly.callbackQuery(/^rq:noy:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const req = ctx.deps.repo.recRequest(id);
  const res = rejectRecRequest(ctx.deps.repo, id, ctx.from.id);
  logger.info({ request: id, admin: ctx.from.id, ok: res.ok }, "заявка на запись: отклонена");
  await ctx.answerCallbackQuery({ text: res.ok ? "Отклонено, логин и пароль стёрты" : failText(res) });
  await refreshCard(ctx, id);
  if (res.ok && req && ctx.deps.repo.getUser(req.userId)) {
    await ctx.api.sendMessage(req.userId, `🎥 Заявку на запись группы ${esc(req.groupTitle)} не приняли. Логин и пароль удалены.`, { parse_mode: "HTML" }).catch(() => undefined);
  }
});

adminOnly.callbackQuery(/^rq:rc:(\d+)$/, async (ctx) => {
  const req = ctx.deps.repo.recRequest(Number(ctx.match[1]));
  const ok = !!req && requestRecheck(ctx.deps.repo, req.groupKey);
  await ctx.answerCallbackQuery({ text: ok ? "Проверю вход в ближайшую минуту — результат пришлю сообщением" : "Слота уже нет" });
  if (ok) logger.info({ request: req!.id, admin: ctx.from.id }, "слот записи: проверить снова");
});

adminOnly.callbackQuery(/^rq:rv:(\d+)$/, async (ctx) => {
  const req = ctx.deps.repo.recRequest(Number(ctx.match[1]));
  await ctx.answerCallbackQuery();
  if (!req || (req.state !== "active" && req.state !== "approved")) return void (await ctx.reply(`${GONE}: учётка уже убрана или снята.`));
  const kb = new InlineKeyboard().text("🗑 Да, отозвать", `rq:rvy:${req.id}`).text("◀️ Назад", "rq:slots");
  await ctx.reply(`Отозвать учётку ${who(req)} из записи группы ${esc(req.groupTitle)}?\nБот перестанет заходить под ней на пары (идущая пара доснимется), логин и пароль удалятся с сервера записи. Студенту придёт весть.`, { parse_mode: "HTML", reply_markup: kb });
});

adminOnly.callbackQuery(/^rq:rvy:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const res = revokeRecRequest(ctx.deps.repo, id, ctx.from.id);
  logger.info({ request: id, admin: ctx.from.id, ok: res.ok }, "слот записи: отозван админом");
  await ctx.answerCallbackQuery({ text: res.ok ? "Отзыв принят: уберу в ближайшую минуту" : failText(res) });
  await showSlots(ctx, true);
});

// Слот без заявки (учётка перенесена из .env) — те же действия, но по группе.
adminOnly.callbackQuery(/^rq:rcg:(.+)$/, async (ctx) => {
  const ok = requestRecheck(ctx.deps.repo, ctx.match[1]!);
  await ctx.answerCallbackQuery({ text: ok ? "Проверю вход в ближайшую минуту — результат пришлю сообщением" : "Слота уже нет" });
});

adminOnly.callbackQuery(/^rq:rvg:(.+)$/, async (ctx) => {
  const key = ctx.match[1]!;
  const slot = ctx.deps.repo.recSlots().find((s) => s.groupKey === key);
  await ctx.answerCallbackQuery();
  if (!slot) return void (await ctx.reply("Слота уже нет."));
  const kb = new InlineKeyboard().text("🗑 Да, отозвать", `rq:rvgy:${key}`).text("◀️ Назад", "rq:slots");
  await ctx.reply(`Отозвать ${slot.holderId ? `учётку заявки №${slot.holderId}` : "учётку из .env"} у группы ${esc(slot.groupTitle)}?\nБот перестанет заходить под ней на пары (идущая пара доснимется), логин и пароль удалятся с сервера записи.`, { parse_mode: "HTML", reply_markup: kb });
});

adminOnly.callbackQuery(/^rq:rvgy:(.+)$/, async (ctx) => {
  const ok = revokeSlotWithoutRequest(ctx.deps.repo, ctx.match[1]!, ctx.from.id);
  logger.info({ admin: ctx.from.id, ok }, "слот записи без заявки: отозван админом");
  await ctx.answerCallbackQuery({ text: ok ? "Отзыв принят: уберу в ближайшую минуту" : "Слота уже нет" });
  await showSlots(ctx, true);
});

/** «/slot_owner 14-25 @ник» — подписать слот из .env владельцем. */
adminOnly.command("slot_owner", async (ctx) => {
  // Ник — последнее слово, группа — всё до него («ВИШ-11-23 (ЭиЭА) @ник»).
  const words = String(ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  const nick = words.length >= 2 ? words.pop()! : "";
  const group = words.join(" ");
  if (!group || !nick) return void (await ctx.reply("Подписать слот из .env владельцем: <code>/slot_owner 14-25 @ник</code>", { parse_mode: "HTML" }));
  const res = adoptSlot(ctx.deps.repo, group, nick, ctx.from!.id);
  if (!res.ok) {
    const why = res.reason === "taken" ? "У этого слота уже есть владелец — смотри /slots." : res.reason === "ambiguous" ? `Под «${esc(group)}» подходит несколько слотов — напиши группу полностью, например ОЗВИШ-14-25.` : `Слота группы ${esc(group)} из .env нет — смотри /slots.`;
    return void (await ctx.reply(why, { parse_mode: "HTML" }));
  }
  logger.info({ admin: ctx.from!.id, linked: res.linked }, "слот записи: подписан владелец");
  const name = `@${esc(nick.replace(/^@/, ""))}`;
  if (!res.linked) return void (await ctx.reply(`Подписал ${esc(res.slotTitle)} — ${name}. Боту он ещё не писал, поэтому вести ему не придут. Когда нажмёт /start, повтори команду — тогда сможет и сам отозвать.`, { parse_mode: "HTML" }));
  await ctx.reply(`✅ ${esc(res.slotTitle)} теперь за ${name}: ему будут приходить вести о записи, отозвать он может сам (${STATUS_PATH}).`, { parse_mode: "HTML" });
  const user = ctx.deps.repo.userByUsername(nick);
  if (user) await ctx.api.sendMessage(user.id, `🎥 Твоя учётка записывает пары группы ${esc(res.slotTitle)}: бот заходит под ней на онлайн-пары и присылает слайды всем в группе. Спасибо!\nСтатус и отзыв: ${STATUS_PATH}.`, { parse_mode: "HTML" }).catch(() => undefined);
});

// ---- экран студента ----

/** Экран «Запись моей группы» по текущей заявке студента. */
export function myRecordingScreen(repo: Repo, req: RecRequestRow): { text: string; kb?: InlineKeyboard } {
  const slot = repo.recSlots().find((s) => s.groupKey === req.groupKey);
  const lines = ["🎥 <b>Запись пар моей группы</b>", `Группа: ${esc(req.groupTitle)}`, `Статус: ${stateLabel(req.state)}`];
  if (req.state === "active" && slot) lines.push(slot.status === "lost" ? "⚠️ Портал перестал пускать под учёткой — на пары не захожу. Если менял пароль, отзови и подай заново." : `Портал пускал: ${mskStamp(slot.lastOkAt)}`);
  if (req.state === "revoking") return { text: lines.join("\n") };
  const label = req.state === "active" || req.state === "approved" ? "🗑 Отозвать учётку" : "🗑 Снять заявку";
  return { text: lines.join("\n"), kb: new InlineKeyboard().text(label, "rqme:rv") };
}

recSlotsHandlers.callbackQuery("rqme", async (ctx) => {
  await ctx.answerCallbackQuery();
  const req = ctx.deps.repo.liveRecRequest(ctx.user.id);
  if (!req) return void (await ctx.reply(`Заявки на запись сейчас нет. Подать: ${FORM_PATH}.`));
  const s = myRecordingScreen(ctx.deps.repo, req);
  await ctx.reply(s.text, { parse_mode: "HTML", ...(s.kb ? { reply_markup: s.kb } : {}) });
});

recSlotsHandlers.callbackQuery("rqme:rv", async (ctx) => {
  await ctx.answerCallbackQuery();
  const req = ctx.deps.repo.liveRecRequest(ctx.user.id);
  if (!req || req.state === "revoking") return void (await ctx.editMessageReplyMarkup().catch(() => undefined));
  const placed = req.state === "active" || req.state === "approved";
  const text = placed
    ? `Отозвать учётку из записи группы ${esc(req.groupTitle)}?\nБот перестанет заходить под ней на пары — идущая пара доснимется. Логин и пароль удалятся с сервера записи.`
    : `Снять заявку на запись группы ${esc(req.groupTitle)}?\nЛогин и пароль удалятся сразу. В лимит месяца заявка засчитается.`;
  const kb = new InlineKeyboard().text(placed ? "🗑 Да, отозвать" : "🗑 Да, снять", "rqme:rvy").text("◀️ Назад", "rqme:back");
  await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb }).catch(() => undefined);
});

recSlotsHandlers.callbackQuery("rqme:back", async (ctx) => {
  await ctx.answerCallbackQuery();
  const req = ctx.deps.repo.liveRecRequest(ctx.user.id);
  if (!req) return void (await ctx.editMessageText("Заявки на запись сейчас нет.").catch(() => undefined));
  const s = myRecordingScreen(ctx.deps.repo, req);
  await ctx.editMessageText(s.text, { parse_mode: "HTML", ...(s.kb ? { reply_markup: s.kb } : {}) }).catch(() => undefined);
});

recSlotsHandlers.callbackQuery("rqme:rvy", async (ctx) => {
  const req = ctx.deps.repo.liveRecRequest(ctx.user.id);
  if (!req) {
    await ctx.answerCallbackQuery();
    return void (await ctx.editMessageText("Заявки на запись сейчас нет.").catch(() => undefined));
  }
  const placed = req.state === "active" || req.state === "approved";
  const res = revokeRecRequest(ctx.deps.repo, req.id);
  logger.info({ request: req.id, user: ctx.user.id, ok: res.ok }, "заявка на запись: отозвана студентом");
  await ctx.answerCallbackQuery();
  if (!res.ok) return void (await ctx.editMessageText("Уже убираю учётку — подожди минуту.").catch(() => undefined));
  const text = res.immediate ? "🗑 Заявка снята, логин и пароль удалены." : "🗑 Отзыв принят: учётку уберу в ближайшую минуту, идущая пара доснимется. Когда уберу — напишу.";
  await ctx.editMessageText(text).catch(() => undefined);
  const note = placed ? `🗑 ${who(req)} отозвал(а) учётку из записи группы ${esc(req.groupTitle)}.` : `🗑 ${who(req)} снял(а) заявку №${req.id} (${esc(req.groupTitle)}).`;
  for (const id of ctx.deps.config.ADMIN_IDS) await ctx.api.sendMessage(id, note, { parse_mode: "HTML" }).catch(() => undefined);
});
