/**
 * Админка болталки: «/admin → 💬 Болталка» — лимиты на день, чаты (где болтать
 * можно) и сценарий «вопрос → ответ».
 *
 * Сценарий правится двумя путями: файлом на хостинге (CHAT_QA_DB, бот сам его
 * перечитывает) или прямо из бота — /qa_add, /qa_file (скачать), /qa_import
 * (прислать CSV обратно).
 */
import { Composer, InlineKeyboard, InputFile } from "grammy";
import type { BotContext } from "../context.js";
import { clearPending, setPending, takePending } from "../context.js";
import { esc } from "../../schedule/format.js";
import { addChatBonus, CHAT_BONUS_STEP, CHAT_STEPS, chatLimits, resetChatLimits, setChatLimit, type ChatLimitKind } from "../../chat/limits.js";
import { decodeText, qaLine } from "../../chat/qa.js";
import { stepValue } from "../../ai/limits.js";
import { chatEnabled } from "./groupChat.js";
import { todayMsk } from "../../time.js";
import { logger } from "../../logger.js";

export const chatAdminHandlers = new Composer<BotContext>();
const adminOnly = chatAdminHandlers.filter((ctx) => ctx.isAdmin);

/** Больше мегабайта сценария не бывает: это уже не заготовки. */
const QA_MAX_BYTES = 1_000_000;

export const QA_FORMAT_HELP = [
  "<b>Формат файла</b> (CSV, UTF-8 или Windows-1251):",
  "<pre>вопрос;ответ;подсказка",
  "сосал?|ты сосал?;Твой ответ здесь;",
  "как дела;Лучше всех, пока пары не начались;шутливо</pre>",
  "• разделитель «;» (Excel), «,» (Google Таблицы) или табуляция — бот поймёт сам;",
  "• варианты вопроса — через «|»;",
  "• подсказка (3-я колонка) необязательна: как отвечать — «дословно», «с сарказмом»…;",
  "• поле с «;», кавычками или переносом строки — в двойных кавычках;",
  "• строки с «#» в начале — комментарии.",
].join("\n");

function privacyLine(ctx: BotContext): string {
  return ctx.me.can_read_all_group_messages
    ? "👁 Бот видит всю переписку групп (privacy mode выключен): контекст разговора полный."
    : "⚠️ <b>Privacy mode включён</b>: в группах бот получает только ответы на свои сообщения и команды, а «@бот привет» до него не доходит. Выключи: @BotFather → /setprivacy → бот → Disable, затем удали бота из группы и добавь снова (или сделай его админом группы).";
}

function chatScreen(ctx: BotContext): { text: string; kb: InlineKeyboard } {
  const deps = ctx.deps;
  const day = todayMsk();
  const l = chatLimits(deps.repo, deps.config, day);
  const used = deps.repo.chatUsage({}, day);
  const tokens = deps.repo.chatTokens(day);
  const qa = deps.chat?.qa.stats();
  const groups = deps.repo.chatGroups().filter((g) => g.present || g.enabled);
  const status = deps.chat
    ? `включена · модель <code>${esc(deps.chat.model)}</code>`
    : !deps.config.CHAT_AI
      ? "выключена (CHAT_AI=FALSE)"
      : "выключена: нет ключа (CHAT_ANTHROPIC_API_KEY или ANTHROPIC_API_KEY)";
  const lines = [
    "<b>💬 Болталка в группах</b>",
    `Статус: ${status}`,
    privacyLine(ctx),
    "",
    `На человека в сутки: <b>${l.perUser}</b>${l.bonus.user ? ` (${l.base.user} + ${l.bonus.user} сегодня)` : ""}${l.base.user !== l.env.user ? ` · в .env ${l.env.user}` : ""}`,
    `На чат в сутки: <b>${l.perChat}</b>${l.bonus.chat ? ` (${l.base.chat} + ${l.bonus.chat} сегодня)` : ""}${l.base.chat !== l.env.chat ? ` · в .env ${l.env.chat}` : ""}`,
    `Всем вместе в сутки: <b>${l.global}</b>${l.bonus.global ? ` (${l.base.global} + ${l.bonus.global} сегодня)` : ""}${l.base.global !== l.env.global ? ` · в .env ${l.env.global}` : ""}`,
    `Сегодня ответов: <b>${used}</b> из ${l.global} · токены: ${tokens.input} вх / ${tokens.output} исх`,
    "",
    qa ? `Сценарий: <b>${qa.count}</b> заготовок${qa.skipped ? ` (пропущено строк: ${qa.skipped})` : ""}${qa.error ? ` · ${esc(qa.error)}` : ""} — /qa` : "Сценарий: болталка выключена",
    "",
    groups.length ? "<b>Чаты</b> (кнопка внизу включает/выключает):" : "Чатов пока нет: добавь бота в группу. Если добавишь сам — болталка там включится сразу.",
    ...groups.slice(0, 12).map((g) => `${chatEnabled(deps, g.chatId) ? "✅" : "⛔"} ${esc(g.title ?? String(g.chatId))}${g.present ? "" : " (бота удалили)"} · сегодня ${deps.repo.chatUsage({ chatId: g.chatId }, day)}`),
    "",
    "<i>Админы бота болтают без лимита. Команда: <code>/chatlimit user 30</code>, <code>chat 200</code>, <code>global 500</code>, <code>boost 200</code>, <code>reset</code>.</i>",
  ];
  const kb = new InlineKeyboard();
  const row = (kind: ChatLimitKind, label: string, value: number): void => {
    kb.text(`➖ ${label}`, `chl:${kind}:down`).text(`${value}`, "chl:show").text(`➕ ${label}`, `chl:${kind}:up`).row();
  };
  row("user", "человек", l.perUser);
  row("chat", "чат", l.perChat);
  row("global", "всего", l.global);
  kb.text(`🚀 Сегодня +${CHAT_BONUS_STEP.user} каждому`, "chl:boost:user").text(`🚀 +${CHAT_BONUS_STEP.global} общих`, "chl:boost:global").row();
  kb.text("♻️ Как в .env", "chl:reset").text("🔄 Обновить", "chl:show");
  for (const g of groups.slice(0, 12)) {
    const on = chatEnabled(deps, g.chatId);
    // Чаты из CHAT_GROUP_IDS включены в .env — кнопкой их не выключить.
    if (deps.config.CHAT_GROUP_IDS.includes(g.chatId)) continue;
    kb.row().text(`${on ? "⛔ Выключить" : "✅ Включить"}: ${(g.title ?? String(g.chatId)).slice(0, 36)}`, `chg:${g.chatId}`);
  }
  return { text: lines.filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n"), kb };
}

async function showChat(ctx: BotContext, edit = false): Promise<void> {
  const { text, kb } = chatScreen(ctx);
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

adminOnly.callbackQuery("adm:chat", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showChat(ctx, true);
});

// /chats — так этот экран назывался в первой версии бота в группах.
adminOnly.command("chats", async (ctx) => showChat(ctx));

// Кнопка из сообщения «меня добавили в чат …» (формат — ещё с первой версии).
adminOnly.callbackQuery(/^gch:(on|off):(-?\d{1,20})$/, async (ctx) => {
  const on = ctx.match[1] === "on";
  const chatId = Number(ctx.match[2]);
  ctx.deps.repo.upsertChatGroup(chatId, { enabled: on });
  await ctx.answerCallbackQuery({ text: on ? "Разрешил: болтаю в этом чате" : "Выключил: в этом чате молчу" });
  const title = ctx.deps.repo.chatGroup(chatId)?.title ?? String(chatId);
  await ctx.editMessageText(`${on ? "✅ Болтаю" : "⛔ Молчу"} в чате «${esc(title)}». Все чаты и лимиты: /chats`, { parse_mode: "HTML" }).catch(() => undefined);
  if (on && ctx.deps.chat) await ctx.api.sendMessage(chatId, `Привет! Зовите: «@${ctx.me.username} …» или отвечайте на мои сообщения — поболтаю, подскажу про пары и преподавателей.`).catch(() => undefined);
});

adminOnly.callbackQuery("chl:show", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showChat(ctx, true);
});

adminOnly.callbackQuery(/^chl:(user|chat|global):(up|down)$/, async (ctx) => {
  const kind = ctx.match[1] as ChatLimitKind;
  const l = chatLimits(ctx.deps.repo, ctx.deps.config, todayMsk());
  const next = stepValue(CHAT_STEPS[kind], l.base[kind], ctx.match[2] === "up" ? 1 : -1);
  setChatLimit(ctx.deps.repo, kind, next);
  await ctx.answerCallbackQuery({ text: `${kind === "user" ? "На человека" : kind === "chat" ? "На чат" : "Всего"}: ${next}` });
  await showChat(ctx, true);
});

adminOnly.callbackQuery(/^chl:boost:(user|chat|global)$/, async (ctx) => {
  const kind = ctx.match[1] as ChatLimitKind;
  const value = addChatBonus(ctx.deps.repo, kind, todayMsk(), CHAT_BONUS_STEP[kind]);
  await ctx.answerCallbackQuery({ text: `Сегодня +${value}` });
  await showChat(ctx, true);
});

adminOnly.callbackQuery("chl:reset", async (ctx) => {
  resetChatLimits(ctx.deps.repo, todayMsk());
  await ctx.answerCallbackQuery({ text: "Вернул значения из .env" });
  await showChat(ctx, true);
});

adminOnly.callbackQuery(/^chg:(-?\d{1,20})$/, async (ctx) => {
  const chatId = Number(ctx.match[1]);
  const cur = ctx.deps.repo.chatGroup(chatId);
  const enabled = !(cur?.enabled ?? false);
  ctx.deps.repo.upsertChatGroup(chatId, { enabled });
  await ctx.answerCallbackQuery({ text: enabled ? "Болталка в чате включена" : "Болталка в чате выключена" });
  await showChat(ctx, true);
});

adminOnly.command("chatlimit", async (ctx) => {
  const [what, second, third] = (ctx.match ?? "").trim().split(/\s+/);
  const day = todayMsk();
  if (!what) return showChat(ctx);
  const kinds = ["user", "chat", "global"];
  if (what === "reset") resetChatLimits(ctx.deps.repo, day);
  else if (kinds.includes(what) && Number.isFinite(Number(second)) && Number(second) >= 0) setChatLimit(ctx.deps.repo, what as ChatLimitKind, Number(second));
  else if (what === "boost") {
    // «boost 200» — в общий бюджет на сегодня, «boost user 10» — каждому.
    const kind = (kinds.includes(second ?? "") ? second : "global") as ChatLimitKind;
    const n = Number(kinds.includes(second ?? "") ? third : second);
    if (!Number.isFinite(n)) return void (await ctx.reply("Так: <code>/chatlimit boost 200</code> или <code>/chatlimit boost user 10</code>.", { parse_mode: "HTML" }));
    addChatBonus(ctx.deps.repo, kind, day, n);
  } else {
    return void (await ctx.reply("Так: <code>/chatlimit user 30</code>, <code>/chatlimit chat 200</code>, <code>/chatlimit global 500</code>, <code>/chatlimit boost 200</code>, <code>/chatlimit reset</code>.", { parse_mode: "HTML" }));
  }
  await showChat(ctx);
});

// ---- сценарий «вопрос → ответ» ----
// /replies и /reply_add, /reply_del — имена из первой версии бота в группах.
adminOnly.command(["qa", "replies"], async (ctx) => {
  const chat = ctx.deps.chat;
  if (!chat) return void (await ctx.reply("Болталка выключена (CHAT_AI=FALSE или нет ключа), сценарий не загружен."));
  const st = chat.qa.stats();
  const sample = chat.qa
    .entries()
    .slice(0, 30)
    .map((e, i) => `${i + 1}. ${esc(e.questions.join(" | ").slice(0, 60))} → ${esc(e.answer.length > 70 ? `${e.answer.slice(0, 70)}…` : e.answer)}`);
  await ctx.reply(
    [
      "<b>🗂 Сценарий болталки</b>",
      `Файл: <code>${esc(st.file)}</code> · заготовок: <b>${st.count}</b>${st.skipped ? ` · пропущено строк: ${st.skipped}` : ""}${st.error ? ` · ${esc(st.error)}` : ""}`,
      ...(sample.length ? ["", ...sample, st.count > 30 ? `…и ещё ${st.count - 30} — весь файл: /qa_file` : ""] : []),
      "",
      "Ответ всё равно пишет ИИ: на похожий вопрос он отвечает заготовкой — дословно или близко к тексту.",
      "",
      "<code>/qa_add вопрос | вариант = ответ</code> — добавить (можно <code>= подсказка</code> третьей частью; если в ответе есть «=», пиши <code>вопрос =&gt; ответ</code>)",
      "<code>/qa_del 3</code> или <code>/qa_del вопрос</code> — удалить",
      "<code>/qa_test текст</code> — какие заготовки подойдут к реплике",
      "<code>/qa_file</code> — скачать файл, <code>/qa_import</code> — прислать исправленный",
      "",
      QA_FORMAT_HELP,
    ]
      .filter((x) => x !== "")
      .join("\n"),
    { parse_mode: "HTML" },
  );
});

/**
 * «вопрос | вариант = ответ = подсказка» или «вопрос => ответ» (так было в
 * /reply_add; ответ после «=>» берётся целиком, со всеми «=» и переносами).
 */
export function parseQaAdd(raw: string): { questions: string[]; answer: string; hint: string | null } | null {
  let q: string;
  let a: string;
  let hint: string | null = null;
  const arrow = raw.indexOf("=>");
  if (arrow >= 0) {
    q = raw.slice(0, arrow);
    a = raw.slice(arrow + 2).trim();
  } else {
    const parts = raw.split("=").map((x) => x.trim());
    q = parts[0] ?? "";
    a = parts[1] ?? "";
    hint = parts[2] || null;
  }
  const questions = q
    .split("|")
    .map((x) => x.trim())
    .filter(Boolean);
  return questions.length && a ? { questions, answer: a, hint } : null;
}

adminOnly.command(["qa_add", "reply_add"], async (ctx) => {
  const chat = ctx.deps.chat;
  if (!chat) return void (await ctx.reply("Болталка выключена — добавлять некуда."));
  const parsed = parseQaAdd(ctx.match ?? "");
  if (!parsed) return void (await ctx.reply("Так: <code>/qa_add как дела | как ты = Лучше всех!</code>\nТретьей частью можно дать подсказку: <code>= шутливо</code>. Если в ответе есть «=»: <code>/qa_add вопрос =&gt; ответ</code>.", { parse_mode: "HTML" }));
  const { questions, answer, hint } = parsed;
  try {
    chat.qa.append(questions, answer, hint);
  } catch (err) {
    logger.warn({ err: String(err) }, "qa_add failed");
    return void (await ctx.reply(`Не смог записать файл: ${esc(String(err).slice(0, 200))}`, { parse_mode: "HTML" }));
  }
  await ctx.reply(`Добавил. Заготовок теперь: ${chat.qa.stats().count}.\n<code>${esc(qaLine(questions, answer, hint))}</code>`, { parse_mode: "HTML" });
});

adminOnly.command(["qa_del", "reply_del"], async (ctx) => {
  const chat = ctx.deps.chat;
  if (!chat) return void (await ctx.reply("Болталка выключена."));
  const arg = (ctx.match ?? "").trim().replace(/^#/, "");
  if (!arg) return void (await ctx.reply("Так: <code>/qa_del 3</code> (номер из /qa) или <code>/qa_del как дела</code>.", { parse_mode: "HTML" }));
  const removed = /^\d+$/.test(arg) ? chat.qa.removeAt(Number(arg)) : chat.qa.remove(arg);
  await ctx.reply(removed ? `Удалил (${removed}). Заготовок теперь: ${chat.qa.stats().count}. Старая версия файла — рядом, .bak.` : "Такой заготовки нет. Список с номерами: /qa");
});

adminOnly.command("qa_test", async (ctx) => {
  const chat = ctx.deps.chat;
  if (!chat) return void (await ctx.reply("Болталка выключена."));
  const text = (ctx.match ?? "").trim();
  if (!text) return void (await ctx.reply("Так: <code>/qa_test сосал?</code>", { parse_mode: "HTML" }));
  const hits = chat.qa.match(text, 5);
  const how = { exact: "точно", phrase: "фраза внутри", typo: "с опечаткой" } as const;
  await ctx.reply(
    hits.length
      ? `Подойдут:\n${hits.map((h) => `• «${esc(h.question)}» (${how[h.how]}) → ${esc(h.entry.answer.slice(0, 120))}`).join("\n")}\n\n<i>Даже без точного совпадения модель видит весь сценарий и может узнать вопрос по смыслу.</i>`
      : "Ни одна заготовка не совпала по словам. Модель всё равно видит весь сценарий и может узнать вопрос по смыслу — но надёжнее добавить вариант через «|».",
    { parse_mode: "HTML" },
  );
});

adminOnly.command("qa_file", async (ctx) => {
  const chat = ctx.deps.chat;
  const raw = chat?.qa.raw();
  if (!chat || raw == null) return void (await ctx.reply("Файла сценария пока нет. Добавь первую заготовку: /qa_add, или пришли CSV: /qa_import."));
  await ctx.replyWithDocument(new InputFile(Buffer.from(raw, "utf8"), "chat-qa.csv"), { caption: `Сценарий: ${chat.qa.stats().count} заготовок. Поправь и пришли обратно через /qa_import.` });
});

adminOnly.command("qa_import", async (ctx) => {
  if (!ctx.deps.chat) return void (await ctx.reply("Болталка выключена — загружать некуда."));
  setPending(ctx.deps, ctx.user.id, { kind: "qa-import" }, 10 * 60_000);
  await ctx.reply(`Пришли CSV-файл документом — он заменит сценарий целиком (старый останется рядом как .bak).\n\n${QA_FORMAT_HELP}`, { parse_mode: "HTML" });
});

adminOnly.on("message:document", async (ctx, next) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  const byCaption = /^\/qa_import(?:@\w+)?\b/.test(ctx.msg.caption ?? "");
  if (!byCaption && pending?.kind !== "qa-import") return next();
  clearPending(ctx.deps, ctx.user.id);
  const chat = ctx.deps.chat;
  if (!chat) return void (await ctx.reply("Болталка выключена — загружать некуда."));
  const doc = ctx.msg.document;
  if (doc.file_size && doc.file_size > QA_MAX_BYTES) return void (await ctx.reply("Файл больше мегабайта — это не похоже на сценарий."));
  let text: string;
  try {
    const file = await ctx.getFile();
    if (!file.file_path) throw new Error("Telegram не отдал путь к файлу");
    const res = await fetch(`https://api.telegram.org/file/bot${ctx.deps.config.BOT_TOKEN}/${file.file_path}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > QA_MAX_BYTES) throw new Error("файл больше мегабайта");
    text = decodeText(buf);
  } catch (err) {
    // В адресе запроса — токен бота: в лог и в ответ идёт только суть ошибки.
    const why = err instanceof Error && !err.message.includes("api.telegram.org") ? err.message : "не скачался";
    logger.warn({ err: why }, "qa_import: download failed");
    return void (await ctx.reply(`Не смог скачать файл: ${esc(why)}. Попробуй ещё раз.`, { parse_mode: "HTML" }));
  }
  const parsed = chat.qa.replace(text);
  if (!parsed.entries.length) return void (await ctx.reply(`В файле не нашлось ни одной пары «вопрос;ответ» — старый сценарий оставил как был.\n\n${QA_FORMAT_HELP}`, { parse_mode: "HTML" }));
  await ctx.reply(`Готово: ${parsed.entries.length} заготовок${parsed.skipped ? `, пропущено строк без вопроса или ответа: ${parsed.skipped}` : ""}. Старый файл — рядом, .bak.`);
});
