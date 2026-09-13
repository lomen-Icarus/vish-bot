import { Composer } from "grammy";
import type { BotContext } from "../context.js";
import { BTN, intakePicker, mainKeyboard, streamDayNav, streamKeyboard } from "../keyboards.js";
import { needGroup } from "../views.js";
import { commonLessons, formatCommonLessons, formatStreamDay, formatStreamWeek, mergeStream, type StreamRow } from "../../schedule/stream.js";
import type { Occurrence } from "../../schedule/model.js";
import { filterSubgroup } from "../../schedule/format.js";
import { addDays, mondayOf, todayMsk, type LocalDate } from "../../time.js";

export const streamHandlers = new Composer<BotContext>();

function currentIntake(ctx: BotContext): number | null {
  const intakes = ctx.deps.service.intakes();
  if (!intakes.length) return null;
  if (ctx.user.streamIntake && intakes.includes(ctx.user.streamIntake)) return ctx.user.streamIntake;
  const own = needGroup(ctx);
  if (own && intakes.includes(own.intake)) return own.intake;
  return intakes[0]!;
}

function rowsFor(ctx: BotContext, intake: number, from: LocalDate, to: LocalDate): StreamRow[] {
  const groups = ctx.deps.service.stream(intake);
  const byGroup = new Map<string, Occurrence[]>();
  const own = needGroup(ctx);
  for (const g of groups) {
    const list = ctx.deps.service.materialize(g, from, to);
    byGroup.set(g.key, own && g.key === own.key ? filterSubgroup(list, ctx.user.subgroup) : list);
  }
  return mergeStream(groups, byGroup);
}

function ownKeyIn(ctx: BotContext, intake: number): string | null {
  const own = needGroup(ctx);
  return own && own.intake === intake ? own.key : null;
}

async function enterStream(ctx: BotContext): Promise<void> {
  const intake = currentIntake(ctx);
  if (intake === null) return void (await ctx.reply("Группы ещё не загружены с портала, попробуй через минуту."));
  const groups = ctx.deps.service.stream(intake);
  await ctx.reply(
    `🎓 <b>Режим потока</b>\nПоток 20${intake}: ${groups.map((g) => g.title.replace(/^ВИШ-/, "")).join(", ")}.\n\nКнопки внизу показывают весь поток сразу. «Общие пары» — лекции, где твоя группа сидит вместе с другими. Сменить поток можно здесь:`,
    { parse_mode: "HTML", reply_markup: intakePicker(ctx.deps.service.intakes(), intake) },
  );
  await sendStreamDay(ctx, intake, todayMsk(), { keyboard: true });
}

async function sendStreamDay(ctx: BotContext, intake: number, date: LocalDate, opts: { edit?: boolean; keyboard?: boolean } = {}): Promise<void> {
  const rows = rowsFor(ctx, intake, date, date);
  const text = formatStreamDay(intake, date, rows, ctx.deps.service.weekInfo(date), todayMsk(), ownKeyIn(ctx, intake));
  if (opts.edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: streamDayNav(date, todayMsk()) });
      return;
    } catch (err) {
      if (String(err).includes("message is not modified")) return;
    }
  }
  if (opts.keyboard) {
    // A reply keyboard and an inline keyboard cannot share one message: send the mode keyboard first.
    await ctx.reply("Поток открыт. Вернуться: «◀️ В меню».", { reply_markup: streamKeyboard() });
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: streamDayNav(date, todayMsk()) });
}

streamHandlers.command("stream", enterStream);
streamHandlers.hears(BTN.stream, enterStream);

streamHandlers.callbackQuery(/^si:(\d{2})$/, async (ctx) => {
  const intake = Number(ctx.match[1]);
  if (!ctx.deps.service.intakes().includes(intake)) return void (await ctx.answerCallbackQuery({ text: "Такого потока нет" }));
  ctx.deps.repo.updateUser(ctx.user.id, { streamIntake: intake });
  ctx.user.streamIntake = intake;
  await ctx.answerCallbackQuery({ text: `Поток 20${intake}` });
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: intakePicker(ctx.deps.service.intakes(), intake) });
  } catch {
    /* ignore */
  }
  await sendStreamDay(ctx, intake, todayMsk());
});

streamHandlers.callbackQuery(/^sd:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const intake = currentIntake(ctx);
  if (intake === null) return;
  await sendStreamDay(ctx, intake, ctx.match[1]!, { edit: true });
});

for (const [label, offset] of [
  [BTN.streamYesterday, -1],
  [BTN.streamToday, 0],
  [BTN.streamTomorrow, 1],
] as const) {
  streamHandlers.hears(label, async (ctx) => {
    const intake = currentIntake(ctx);
    if (intake === null) return;
    await sendStreamDay(ctx, intake, addDays(todayMsk(), offset));
  });
}

streamHandlers.hears(BTN.streamWeek, async (ctx) => {
  const intake = currentIntake(ctx);
  if (intake === null) return;
  const monday = mondayOf(todayMsk());
  const rows = rowsFor(ctx, intake, monday, addDays(monday, 6));
  for (const chunk of formatStreamWeek(intake, monday, rows, ctx.deps.service.weekInfo(monday), todayMsk(), ownKeyIn(ctx, intake))) {
    await ctx.reply(chunk, { parse_mode: "HTML" });
  }
});

streamHandlers.hears(BTN.streamCommon, async (ctx) => {
  const intake = currentIntake(ctx);
  if (intake === null) return;
  const monday = mondayOf(todayMsk());
  const rows = rowsFor(ctx, intake, monday, addDays(monday, 6));
  const own = needGroup(ctx);
  const ownInStream = own && own.intake === intake ? own : null;
  const text = formatCommonLessons(intake, monday, rows, ownInStream);
  const shared = commonLessons(rows, ownInStream?.key ?? null);
  await ctx.reply(shared.length ? text : `${text}\n\n<i>Общей считается пара с одинаковым временем, предметом и аудиторией у двух и более групп потока.</i>`, { parse_mode: "HTML" });
});

streamHandlers.hears(BTN.backToMenu, async (ctx) => {
  await ctx.reply("Главное меню.", { reply_markup: mainKeyboard({ ask: !!ctx.deps.ask }) });
});
