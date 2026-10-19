/**
 * «📋 ППА»: пересдачи группы и отметки своих долгов. Вход — /ppa, кнопка в
 * «🗂 Ещё» (пока у группы есть пересдачи впереди) и вопрос «Есть долги?».
 * Отмеченные предметы встают в своё расписание (views.myPpa), напоминания и
 * календарь. В логах — только id и число отметок, без предметов.
 */
import { Composer } from "grammy";
import type { BotContext } from "../context.js";
import { ppaItemText, ppaScreen } from "../ppaView.js";
import { BTN } from "../keyboards.js";
import { groupRequiredText, needGroup } from "../views.js";
import { plural } from "../../schedule/format.js";
import { subjectKey } from "../../schedule/subjects.js";
import { todayMsk } from "../../time.js";
import { logger } from "../../logger.js";

export const ppaHandlers = new Composer<BotContext>();

/**
 * Текст — про пересдачи: «ппа», «пересдача» (и «передсача», «пересача»),
 * «долги», «хвосты». «Передачи данных» — предмет, не пересдача.
 */
export function isPpaQuery(text: string): boolean {
  const t = text.toLowerCase().replace(/ё/g, "е");
  return /(^|[^\p{L}])ппа($|[^\p{L}])/u.test(t) || /пере(сд|дс|с)ач/u.test(t) || /(^|[^\p{L}])(долг|хвост)(и|ов|ам|ы)?($|[^\p{L}])/u.test(t);
}

export async function showPpa(ctx: BotContext, edit: boolean): Promise<void> {
  const group = needGroup(ctx);
  if (!group) return void (await ctx.reply(groupRequiredText()));
  const upcoming = ctx.deps.service.ppaUpcoming(group, todayMsk());
  const { text, kb } = ppaScreen(group, upcoming, new Set(ctx.deps.repo.ppaDebts(ctx.user.id, group.key)));
  if (edit) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
      return;
    } catch (err) {
      if (String(err).includes("message is not modified")) return;
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

ppaHandlers.command("ppa", (ctx) => showPpa(ctx, false));
// Кнопка, вынесенная в нижнее меню из «🗂 Ещё» (⚙️ → 🧩 Кнопки внизу).
ppaHandlers.hears(BTN.ppa, (ctx) => showPpa(ctx, false));
ppaHandlers.callbackQuery(["more:ppa", "ppa:open"], async (ctx) => {
  await ctx.answerCallbackQuery();
  await showPpa(ctx, false);
});

// Переключить отметку: ключ предмета — subjectKey (10 знаков), группа — своя.
ppaHandlers.callbackQuery(/^ppa:t:([\w-]{1,16})$/, async (ctx) => {
  const group = needGroup(ctx);
  if (!group) return void (await ctx.answerCallbackQuery({ text: "Сначала выбери свою группу: /group", show_alert: true }));
  const key = ctx.match[1]!;
  const item = ctx.deps.service.ppaItems(group).find((i) => subjectKey(i.subject) === key);
  if (!item) return void (await ctx.answerCallbackQuery({ text: "Этой пересдачи уже нет в расписании ППА", show_alert: true }));
  const on = !ctx.deps.repo.ppaDebts(ctx.user.id, group.key).includes(key);
  ctx.deps.repo.setPpaDebt(ctx.user.id, group.key, key, on);
  await ctx.answerCallbackQuery({ text: on ? "Отмечено — встанет в твоё расписание" : "Снято" });
  await showPpa(ctx, true);
});

ppaHandlers.callbackQuery("ppa:none", async (ctx) => {
  const group = needGroup(ctx);
  await ctx.answerCallbackQuery();
  if (group) ctx.deps.repo.clearPpaDebts(ctx.user.id, group.key);
  await ctx.editMessageText("👌 Долгов нет — пересдачи в твоё расписание не добавляю. Передумаешь — /ppa.").catch(() => undefined);
});

ppaHandlers.callbackQuery("ppa:done", async (ctx) => {
  const group = needGroup(ctx);
  await ctx.answerCallbackQuery();
  if (!group) return;
  const debts = new Set(ctx.deps.repo.ppaDebts(ctx.user.id, group.key));
  const mine = ctx.deps.service.ppaUpcoming(group, todayMsk()).filter((i) => debts.has(subjectKey(i.subject)));
  logger.info({ userId: ctx.user.id, marked: debts.size }, "долги ППА отмечены");
  const text = mine.length
    ? `👌 В твоём расписании ${mine.length} ${plural(mine.length, "пересдача", "пересдачи", "пересдач")}, ближайшая:\n${ppaItemText(mine[0]!)}\n\nНапомню, как о паре; перенесут — напишу. Изменить — /ppa.`
    : "👌 Впереди отмеченных пересдач нет. Изменить — /ppa.";
  await ctx.editMessageText(text, { parse_mode: "HTML" }).catch(() => undefined);
});
