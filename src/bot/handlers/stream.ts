import { Composer, InputFile } from "grammy";
import type { BotContext } from "../context.js";
import type { LogicalGroup } from "../../schedule/groups.js";
import { BTN, intakePicker, mainKeyboard, streamDayNav, streamKeyboard } from "../keyboards.js";
import { editPhoto, isPhotoMessage, needGroup } from "../views.js";
import { commonLessons, formatCommonLessons, formatStreamDay, formatStreamWeek, mergeStream, shortGroupLabel, type StreamRow } from "../../schedule/stream.js";
import type { Occurrence } from "../../schedule/model.js";
import { captionFits, filterSubgroup } from "../../schedule/format.js";
import { addDays, mondayOf, todayMsk, wallClock, type LocalDate } from "../../time.js";
import { logger } from "../../logger.js";

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

async function sendStreamDay(ctx: BotContext, intake: number, date: LocalDate, opts: { edit?: boolean; keyboard?: boolean; forceImage?: boolean } = {}): Promise<void> {
  const rows = rowsFor(ctx, intake, date, date);
  const ownKey = ownKeyIn(ctx, intake);
  const text = formatStreamDay(intake, date, rows, ctx.deps.service.weekInfo(date), todayMsk(), ownKey, ctx.user.teacherView);
  const renderer = ctx.deps.renderer;
  // Navigating from a poster keeps the poster: the image is replaced in place.
  const photoMsg = !!opts.edit && isPhotoMessage(ctx);
  const editingText = !!opts.edit && !!ctx.callbackQuery?.message && !photoMsg;
  // «И так, и так» — это одно сообщение: постер с расписанием в подписи.
  const withText = ctx.user.format === "both" && !opts.forceImage;
  const wantImage = !!renderer && !editingText && (opts.forceImage || photoMsg || ctx.user.format === "image" || withText);
  let textSent = false;
  if (opts.keyboard) {
    // A reply keyboard and an inline keyboard cannot share one message: send the mode keyboard first.
    await ctx.reply("Поток открыт. Вернуться: «◀️ В меню».", { reply_markup: streamKeyboard({ poisk: ctx.deps.config.POISK && !!ctx.deps.students }) });
  }
  if (wantImage && renderer) {
    try {
      const png = await renderer.renderStreamDay({
        intake,
        date,
        rows: rows.filter((r) => r.date === date).map((r) => ({ ...r, mine: ownKey !== null && r.groupKeys.includes(ownKey) })),
        weekInfo: ctx.deps.service.weekInfo(date),
        teacherView: ctx.user.teacherView,
        today: todayMsk(),
        now: wallClock(),
        theme: ctx.user.posterTheme ?? undefined,
      });
      const kb = streamDayNav(date, todayMsk(), { image: false, groups: ctx.deps.service.stream(intake) });
      const fileName = `stream-${intake}-${date}.png`;
      const caption = withText && captionFits(text) ? text : undefined;
      if (photoMsg && (await editPhoto(ctx, png, fileName, caption, kb))) return;
      // Не влезло в подпись — текст идёт первым и молча, постер остаётся последним.
      if (withText && !caption) {
        await ctx.reply(text, { parse_mode: "HTML", disable_notification: true });
        textSent = true;
      }
      await ctx.replyWithPhoto(new InputFile(png, fileName), { caption, parse_mode: "HTML", reply_markup: kb });
      return;
    } catch (err) {
      logger.warn({ err: String(err) }, "stream poster failed");
      // Текст уже ушёл перед постером — второй раз его слать нельзя.
      if (textSent) return;
    }
  }
  if (editingText && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: streamDayNav(date, todayMsk(), { image: !!renderer, groups: ctx.deps.service.stream(intake) }) });
      return;
    } catch (err) {
      if (String(err).includes("message is not modified")) return;
    }
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: streamDayNav(date, todayMsk(), { image: !!renderer && !wantImage, groups: ctx.deps.service.stream(intake) }) });
}

streamHandlers.callbackQuery(/^simg:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Рисую…" });
  const intake = currentIntake(ctx);
  if (intake === null) return;
  await sendStreamDay(ctx, intake, ctx.match[1]!, { forceImage: true });
});

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
  for (const chunk of formatStreamWeek(intake, monday, rows, ctx.deps.service.weekInfo(monday), todayMsk(), ownKeyIn(ctx, intake), ctx.user.teacherView)) {
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
  const text = formatCommonLessons(intake, monday, rows, ownInStream, ctx.user.teacherView);
  const shared = commonLessons(rows, ownInStream?.key ?? null);
  const wantImage = !!ctx.deps.renderer && shared.length > 0 && ctx.user.format !== "text";
  let textSent = false;
  if (wantImage) {
    try {
      const png = await renderCommonWeek(ctx, intake, monday, shared, ownInStream);
      const caption = ctx.user.format !== "image" && captionFits(text) ? text : undefined;
      if (!caption && ctx.user.format !== "image") {
        await ctx.reply(text, { parse_mode: "HTML", disable_notification: true });
        textSent = true;
      }
      await ctx.replyWithPhoto(new InputFile(png, `common-${intake}-${monday}.png`), { caption, parse_mode: "HTML" });
      return;
    } catch (err) {
      logger.warn({ err: String(err) }, "common lessons poster failed");
      if (textSent) return;
    }
  }
  await ctx.reply(shared.length ? text : `${text}\n\n<i>Общей считается пара с одинаковым временем, предметом и аудиторией у двух и более групп потока.</i>`, { parse_mode: "HTML" });
});

/**
 * Poster for "общие пары": the week renderer over a pseudo group. Week posters
 * print the subject and the room, so the groups sitting together ride in the
 * subject line, which every theme renders.
 */
async function renderCommonWeek(ctx: BotContext, intake: number, monday: LocalDate, shared: StreamRow[], own: LogicalGroup | null): Promise<Buffer> {
  const byDate = new Map<LocalDate, Occurrence[]>();
  for (const r of shared) {
    const others = own ? r.groups.filter((_, i) => r.groupKeys[i] !== own.key) : r.groups;
    const lesson: Occurrence = {
      groupKey: `stream:${intake}`,
      period: 1,
      date: r.date,
      slot: r.slot,
      start: r.start,
      end: r.end,
      subject: others.length ? `${r.subject} · с ${others.join(", ")}` : r.subject,
      type: r.type,
      room: r.room,
      teacher: null,
      subgroup: r.subgroup,
      isDistance: r.isDistance,
      status: r.status,
      sources: [],
    };
    byDate.set(r.date, [...(byDate.get(r.date) ?? []), lesson]);
  }
  // A full group title with a qualifier would run off the edge of the widest theme.
  const pseudo: LogicalGroup = { key: `stream:${intake}`, title: own ? `Общие · ${shortGroupLabel(own)}` : `Общие · поток 20${intake}`, prefix: "ВИШ", number: 0, intake, course: 0, portalIds: [], portalNames: [] };
  return ctx.deps.renderer!.renderWeek({ group: pseudo, monday, byDate, weekInfo: ctx.deps.service.weekInfo(monday), today: todayMsk(), subgroup: null, theme: ctx.user.posterTheme ?? undefined, teacherView: ctx.user.teacherView });
}

streamHandlers.hears(BTN.backToMenu, async (ctx) => {
  await ctx.reply("Главное меню.", { reply_markup: mainKeyboard() });
});
