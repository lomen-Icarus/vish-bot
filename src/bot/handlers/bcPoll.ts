/**
 * Опрос в рассылке админа. Копия чужого опроса у каждого своя, и голоса в ней
 * админ не видит, поэтому бот шлёт опрос сам: в Telegram — анонимный sendPoll
 * (о голосах бот узнаёт из обновлений poll — без имён, только какой вариант
 * выбран в этой копии), в МАКС, где опросов нет, — кнопками. Админу — итоги
 * цифрами по «📊 Итоги опроса».
 */
import { Composer, InlineKeyboard } from "grammy";
import type { Api } from "grammy";
import type { BotContext } from "../context.js";
import type { BcPoll, Repo } from "../../db/repo.js";
import { esc } from "../../schedule/format.js";
import { isMaxChat } from "../../max/store.js";

export const bcPollHandlers = new Composer<BotContext>();

/** Кнопки опроса в МАКС: выбранное — с галочкой. */
export function voteKeyboard(poll: BcPoll, chosen: number[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  poll.options.forEach((o, i) => kb.text(`${chosen.includes(i) ? "✅ " : ""}${o}`, `bpv:${poll.id}:${i}`).row());
  return kb;
}

/** Отправить опрос рассылки одному человеку. */
export async function sendBcPoll(api: Api, repo: Repo, poll: BcPoll, chatId: number): Promise<void> {
  if (isMaxChat(chatId)) {
    const hint = poll.multiple ? "можно выбрать несколько вариантов, повторное нажатие снимает выбор" : "передумаешь — нажми другой вариант";
    await api.sendMessage(chatId, `📊 <b>${esc(poll.question)}</b>\n\n<i>Опрос анонимный: ${hint}.</i>`, { parse_mode: "HTML", reply_markup: voteKeyboard(poll, []) });
    return;
  }
  const msg = await api.sendPoll(chatId, poll.question, poll.options.map((text) => ({ text })), { is_anonymous: true, allows_multiple_answers: poll.multiple });
  repo.addBcPollCopy(msg.poll.id, poll.id);
}

/** Итоги для админа: полоска, процент от проголосовавших, число голосов. */
export function tallyText(repo: Repo, poll: BcPoll): string {
  const { counts, voters } = repo.bcPollTally(poll.id, poll.options.length);
  const lines = poll.options.map((o, i) => {
    const n = counts[i] ?? 0;
    const pct = voters ? Math.round((n * 100) / voters) : 0;
    const filled = Math.round(pct / 10);
    return `${"▓".repeat(filled)}${"░".repeat(10 - filled)} ${pct}% · <b>${n}</b> — ${esc(o)}`;
  });
  const multiple = poll.multiple ? "\nМожно было выбрать несколько вариантов: проценты — от проголосовавших." : "";
  return `📊 <b>Итоги опроса</b>\n${esc(poll.question)}\n\n${lines.join("\n")}\n\nПроголосовали: <b>${voters}</b> из ${poll.sent}.${multiple}`;
}

function tallyKeyboard(pollId: number): InlineKeyboard {
  return new InlineKeyboard().text("🔄 Обновить", `bpr:${pollId}:u`);
}

/** Голос в Telegram: новое состояние копии опроса, отправленной ботом. */
bcPollHandlers.on("poll", async (ctx) => {
  const p = ctx.poll;
  const pollId = ctx.deps.repo.bcPollOfCopy(p.id);
  // Дальше не пускаем: у обновления poll нет человека, а остальные обработчики его ждут.
  if (pollId == null) return;
  const chosen = p.options.flatMap((o, i) => (o.voter_count > 0 ? [i] : []));
  ctx.deps.repo.setBcPollVote(pollId, `tg:${p.id}`, chosen);
});

/** Голос в МАКС: кнопка под опросом. */
bcPollHandlers.callbackQuery(/^bpv:(\d+):(\d+)$/, async (ctx) => {
  const repo = ctx.deps.repo;
  const poll = repo.bcPoll(Number(ctx.match[1]));
  const i = Number(ctx.match[2]);
  if (!poll || i >= poll.options.length) return void (await ctx.answerCallbackQuery({ text: "Этого опроса больше нет" }));
  const voter = `u:${ctx.from.id}`;
  const before = repo.bcPollVote(poll.id, voter);
  const chosen = poll.multiple ? (before.includes(i) ? before.filter((x) => x !== i) : [...before, i].sort((a, b) => a - b)) : [i];
  repo.setBcPollVote(poll.id, voter, chosen);
  await ctx.answerCallbackQuery({ text: chosen.length ? "Голос учтён" : "Выбор снят" });
  if (JSON.stringify(before) === JSON.stringify(chosen)) return;
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: voteKeyboard(poll, chosen) });
  } catch {
    /* голос уже записан — галочка не главное */
  }
});

/** «📊 Итоги опроса» под отчётом рассылки — новым сообщением; «🔄 Обновить» — на месте. */
bcPollHandlers.filter((ctx) => ctx.isAdmin).callbackQuery(/^bpr:(\d+)(:u)?$/, async (ctx) => {
  const poll = ctx.deps.repo.bcPoll(Number(ctx.match[1]));
  if (!poll) return void (await ctx.answerCallbackQuery({ text: "Опрос не найден", show_alert: true }));
  await ctx.answerCallbackQuery();
  const text = tallyText(ctx.deps.repo, poll);
  if (!ctx.match[2]) return void (await ctx.reply(text, { parse_mode: "HTML", reply_markup: tallyKeyboard(poll.id) }));
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: tallyKeyboard(poll.id) });
  } catch {
    /* ничего не изменилось — Telegram не правит сообщение тем же текстом */
  }
});
