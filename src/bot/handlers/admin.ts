import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { clearPending, setPending, takePending } from "../context.js";
import { esc, plural } from "../../schedule/format.js";
import { pruneFalseChangeEvents } from "../../db/cleanup.js";
import { isMenuText, TOPIC_LABELS, TOPICS } from "../keyboards.js";
import { lastPoll } from "../views.js";
import { addAiBonus, aiLimits, BONUS_GLOBAL_STEP, BONUS_USER_STEP, clearAiBonus, GLOBAL_STEPS, setAiLimit, stepValue, USER_STEPS } from "../../ai/limits.js";
import { todayMsk } from "../../time.js";
import type { User } from "../../db/repo.js";
import { logger } from "../../logger.js";
import { sleep } from "../../time.js";
import { isUnreachable } from "../errors.js";

export const adminHandlers = new Composer<BotContext>();

const adminOnly = adminHandlers.filter((ctx) => ctx.isAdmin);

/** How long a broadcast stays on the "Объявления" board inside «Изменения». */
export const BOARD_HOURS = 24;

function adminMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📊 Статистика", "adm:stats")
    .text("🩺 Здоровье", "adm:health")
    .row()
    .text("🔄 Опросить портал", "adm:poll")
    .text("📣 Рассылка", "adm:broadcast")
    .row()
    .text("📌 Доска объявлений", "adm:board")
    .text("👥 Группы", "adm:groups")
    .row()
    .text("🤖 Лимиты «Спросить»", "adm:ai")
    .text("📰 Источники", "adm:sources")
    .row()
    .text("💬 Болталка в группах", "adm:chat");
}

adminOnly.command("admin", async (ctx) => {
  await ctx.reply("<b>Админка</b>", { parse_mode: "HTML", reply_markup: adminMenu() });
});

function statsText(ctx: BotContext): string {
  const repo = ctx.deps.repo;
  const c = repo.countUsers();
  const pop = repo.groupPopulation();
  const lines = [
    "<b>📊 Статистика</b>",
    `Пользователей: ${c.total}, активных: ${c.active}, с группой: ${c.withGroup}`,
    "",
    ...pop.slice(0, 30).map((p) => `${esc(ctx.deps.service.group(p.groupKey)?.title ?? p.groupKey)} — ${p.users}`),
  ];
  return lines.join("\n");
}

function teacherState(ctx: BotContext, count: number): string {
  const t = ctx.deps.teachers;
  if (!t) return "учётка портала не задана (PORTAL_LOGIN / PORTAL_PASSWORD) — работают только преподаватели дистанта";
  const ok = t.loginOk();
  if (ok === true) return `учётка вошла, в справочнике ${count}`;
  if (ok === false) return "учётка НЕ вошла в портал";
  return "учётка задана, вход ещё не проверялся";
}

function webinarStats(ctx: BotContext): string {
  if (!ctx.deps.webinars) return "выкл";
  const s = ctx.deps.webinars.stats();
  return `${s.rows} пар за ${s.days} дн. (по ${s.until ?? "—"}), преподавателей ${s.teachers}`;
}

/** Состояние глобального поиска студентов для /health. */
function poiskState(ctx: BotContext): string {
  if (!ctx.deps.config.POISK) return "выключен (POISK=FALSE)";
  const dir = ctx.deps.students;
  if (!dir) return "включён, но справочник не создан";
  const s = dir.stats();
  const used = ctx.deps.repo.poiskStats(todayMsk());
  return `${s.count} чел. из ${esc(s.file)}${s.error ? ` · ошибка: ${esc(s.error)}` : ""} · сегодня ${used.searches} поисков от ${used.users} чел.`;
}

/**
 * «Бот узнаёт своих» для /health: сколько ников в файле и сколько человек
 * попросили их не узнавать. Сами ники и имена нигде не печатаются.
 */
function knownState(ctx: BotContext): string {
  const k = ctx.deps.known;
  if (!k) return "выключено";
  const s = k.stats();
  if (!s.count) return `файл не прочитан (${esc(s.file)})${s.error ? `: ${esc(s.error)}` : ""}`;
  return `${s.count} чел. из ${esc(s.file)} · анонимность включили ${ctx.deps.repo.anonCount()} чел.`;
}

function healthText(ctx: BotContext): string {
  const deps = ctx.deps;
  const p = deps.repo.lastPollRun();
  const mem = process.memoryUsage();
  const up = Math.round((Date.now() - deps.startedAt.getTime()) / 60_000);
  const anchor1 = deps.service.weekOneMonday(1);
  const anchor3 = deps.service.weekOneMonday(3);
  const teacherDir = deps.repo.getMeta("teachers:list");
  const teacherCount = teacherDir ? (JSON.parse(teacherDir) as unknown[]).length : 0;
  const teacherErr = deps.repo.getMeta("teachers:lastError");
  return [
    "<b>🩺 Здоровье</b>",
    `Аптайм: ${up} мин · RSS ${Math.round(mem.rss / 1048576)} МБ · Node ${process.version}`,
    `Последний опрос: ${lastPoll(deps)}${p ? ` · страниц/групп: ${p.groupsTotal ?? "?"} · изменений: ${p.groupsChanged ?? 0} · событий: ${p.events ?? 0}` : ""}`,
    p?.error ? `Ошибка: <code>${esc(p.error).slice(0, 300)}</code>` : "",
    `Учебный год: ${deps.service.academicYear}/${deps.service.academicYear + 1}`,
    `Неделя 1 осень: ${anchor1 ?? "не калибрована"} · весна: ${anchor3 ?? "не калибрована"}`,
    `Групп: ${deps.service.groups().length} · рендер картинок: ${deps.renderer ? "да" : "нет"} · ИИ: ${deps.ask ? deps.config.AI_MODEL : "выкл"} · каналы новостей: ${deps.config.NEWS_CHANNEL_IDS.length} · ИИ-сканер: ${deps.news ? `${deps.repo.listNewsSources(true).length} источн.` : "выкл"}`,
    `Преподаватели: ${teacherState(ctx, teacherCount)}${teacherErr ? ` · <code>${esc(teacherErr).slice(0, 200)}</code>` : ""}`,
    `Вебинары (преподаватели дистанта): ${webinarStats(ctx)}`,
    `Доска объявлений: ${deps.repo.activeAnnouncements().length} активных`,
    `Лимиты ИИ: ${aiLimits(deps.repo, deps.config, todayMsk()).perUser}/чел, ${aiLimits(deps.repo, deps.config, todayMsk()).global} общих · потрачено сегодня ${deps.repo.aiUsageGlobal(todayMsk())}`,
    `Inline-режим: ${deps.inline ? "включён" : "ВЫКЛЮЧЕН — включи в @BotFather: /setinline, затем /setinlinefeedback"}`,
    `Болталка в группах: ${deps.chat ? `${esc(deps.chat.model)} · чатов включено ${deps.repo.chatGroups().filter((g) => g.enabled).length + deps.config.CHAT_GROUP_IDS.length} · сценарий ${deps.chat.qa.stats().count} · сегодня ответов ${deps.repo.chatUsage({}, todayMsk())} · privacy mode ${ctx.me.can_read_all_group_messages ? "выключен" : "ВКЛЮЧЁН — «@бот …» может не доходить, ответы на сообщения бота работают (/chats)"}` : deps.config.CHAT_AI ? "нет ключа Anthropic" : "выключена (CHAT_AI=FALSE)"}`,
    `Сыск (поиск студентов): ${poiskState(ctx)}`,
    `Узнавание по нику: ${knownState(ctx)}`,
    `Режим преподавателя: ${deps.teacherRegistry?.count() ? `в реестре ${deps.teacherRegistry.count()} чел.` : "реестр пуст (TEACHERS_DB) — включают только админы"} · в режиме сейчас ${deps.repo.teacherModeCount()}`,
    `Карта преподавателей: ${(() => {
      const m = deps.repo.teacherMapStats();
      return `${m.vish} из ${m.total} помечены как ВИШ, проверено ${m.checked}`;
    })()}`,
    `Слайды вебинаров: ${deps.config.SLIDES_TOKEN ? `приём включён, записей ${deps.repo.recentSlideDecks(1).length ? deps.repo.recentSlideDecks(1)[0]!.date : "нет"}` : "выключен (нет SLIDES_TOKEN)"}`,
    `Баннер портала: ${deps.repo.getMeta("banner") ? esc(deps.repo.getMeta("banner")!.slice(0, 120)) : "нет"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- AI daily limits ----
/** Экран лимитов ИИ: что стоит сейчас, сколько потрачено и чем это поменять. */
function aiLimitsScreen(ctx: BotContext): { text: string; kb: InlineKeyboard } {
  const day = todayMsk();
  const l = aiLimits(ctx.deps.repo, ctx.deps.config, day);
  const usedGlobal = ctx.deps.repo.aiUsageGlobal(day);
  const kb = new InlineKeyboard()
    .text("➖ на человека", "ail:user:down")
    .text(`👤 ${l.perUser}`, "ail:show")
    .text("➕ на человека", "ail:user:up")
    .row()
    .text("➖ общий", "ail:global:down")
    .text(`🌍 ${l.global}`, "ail:show")
    .text("➕ общий", "ail:global:up")
    .row()
    .text(`🚀 Сегодня +${BONUS_USER_STEP} каждому`, "ail:boost:user")
    .text(`🚀 Сегодня +${BONUS_GLOBAL_STEP} общих`, "ail:boost:global")
    .row()
    .text("♻️ Как в .env", "ail:reset")
    .text("🔄 Обновить", "ail:show");
  const text = [
    "<b>🤖 Лимиты «Спросить?»</b>",
    "Кнопка «💬 Спросить?» в приветствии /start, «🔍 Поиск» и /ask — это один ИИ-поиск с общим лимитом.",
    ctx.deps.ask ? `Модель: <code>${esc(ctx.deps.config.AI_MODEL)}</code>` : "ИИ выключен: не задан ANTHROPIC_API_KEY.",
    "",
    `На человека в сутки: <b>${l.perUser}</b>${l.bonusUser ? ` (${l.baseUser} + ${l.bonusUser} на сегодня)` : ""}${l.userOverridden ? ` · в .env ${l.envUser}` : ""}`,
    `Всем вместе в сутки: <b>${l.global}</b>${l.bonusGlobal ? ` (${l.baseGlobal} + ${l.bonusGlobal} на сегодня)` : ""}${l.globalOverridden ? ` · в .env ${l.envGlobal}` : ""}`,
    `Сегодня потрачено: <b>${usedGlobal}</b> из ${l.global}.`,
    "",
    "Кнопки меняют лимит навсегда (переживает перезапуск), «🚀 Сегодня» — разовая добавка только на этот день, она сама исчезнет завтра.",
    "Админы спрашивают без лимита. Команда: <code>/ailimit user 25</code>, <code>/ailimit global 1000</code>, <code>/ailimit boost 200</code> (общий на сегодня), <code>/ailimit boost user 5</code>, <code>/ailimit reset</code>.",
  ].join("\n");
  return { text, kb };
}

async function showAiLimits(ctx: BotContext, edit = false): Promise<void> {
  const { text, kb } = aiLimitsScreen(ctx);
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

/** Сколько ФИО проверяем за один раз: больше — это уже выгрузка, а не список. */
const WHOIS_LIMIT = 100;

/** Режет готовые строки на сообщения Telegram, не разрывая строку пополам. */
function chunkLines(lines: string[], limit: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of lines) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > limit && cur) {
      out.push(cur);
      cur = line;
    } else {
      cur = next;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * «Кто из этих людей уже пользуется ботом» — сверка списка ФИО (актив, кружок,
 * группа) с теми, кто боту писал. Считается на сервере по файлу узнавания;
 * телеграм-ники в ответ не печатаются, только ФИО и вердикт.
 *
 * Честно разделяет «не пользуется» и «сказать нечего»: если телеграма человека
 * в списке старост не было, бот про него не знает ничего.
 */
/**
 * Ручная уборка ложных «изменений» — на случай, если после очередной правки
 * правил в разделе снова осело то, чего по нынешним правилам не бывает.
 * Считает заново каждую сохранённую правку и удаляет пустые.
 */
adminOnly.command("cleanchanges", async (ctx) => {
  const removed = pruneFalseChangeEvents(ctx.deps.repo, { force: true });
  await ctx.reply(
    removed
      ? `Убрал ${removed} ${plural(removed, "ложное изменение", "ложных изменения", "ложных изменений")}. Настоящие (аудитория, время, дистант, отмена, перенос, замена преподавателя) на месте.`
      : "Ложных изменений не нашлось: всё, что лежит в разделе, по нынешним правилам — настоящие изменения.",
  );
});

adminOnly.command("whois", async (ctx) => {
  const known = ctx.deps.known;
  if (!known?.count()) {
    // Файла может не быть, а может он быть и не прочитаться: это разные беды,
    // и гонять админа проверять переменную, когда дело в кодировке, незачем.
    const why = known?.stats().error;
    return void (await ctx.reply(why ? `Файл узнавания не прочитан: ${esc(why)}` : "Файл узнавания не загружен (KNOWN_DB) — сверять не с чем.", { parse_mode: "HTML" }));
  }
  const all = (ctx.match ?? "")
    .split(/[\n;,]+/)
    // Нумерация, маркеры списка и хвост таблицы после «|» — не часть ФИО.
    .map((x) => x.replace(/^[\s\d.)|•-]+/, "").replace(/\|.*$/, "").trim().slice(0, 80))
    // Группы и прочие строки с цифрами («ВИШ-11-23 (ЭиЭА)») — это не люди.
    .filter((x) => /\p{L}/u.test(x) && !/\d/.test(x) && x.split(/\s+/).length >= 2);
  if (!all.length) {
    return void (await ctx.reply("Пришли список ФИО после команды, по одному в строке:\n<code>/whois\nИванов Иван Иванович\nПетрова Анна Сергеевна</code>\n\nМожно вставлять строки таблицы целиком: номера, группы и хвост после «|» бот отбросит сам.", { parse_mode: "HTML" }));
  }
  const names = all.slice(0, WHOIS_LIMIT);
  const usernames = ctx.deps.repo.botUsernames();
  const marks = { uses: "✅", "not-seen": "▫️", "no-handle": "❔", ambiguous: "⚠️" } as const;
  const tally = { uses: 0, "not-seen": 0, "no-handle": 0, ambiguous: 0 };
  const lines: string[] = [];
  for (const name of names) {
    const status = known.status(name, usernames);
    tally[status]++;
    lines.push(`${marks[status]} ${esc(name)}`);
  }
  const head = [
    "<b>👥 Кто из списка пользуется ботом</b>",
    `Проверено ${names.length} чел. · ✅ пользуются: <b>${tally.uses}</b> · ▫️ ник не встречался: ${tally["not-seen"]} · ❔ нет в списке старост: ${tally["no-handle"]}${tally.ambiguous ? ` · ⚠️ тёзки: ${tally.ambiguous}` : ""}`,
    ...(all.length > names.length ? [`⚠️ Проверены первые ${WHOIS_LIMIT} из ${all.length}: остальные ${all.length - names.length} не смотрел, пришли их отдельно.`] : []),
  ];
  const foot = [
    "<i>▫️ — ник из списка боту не встречался: человек мог сменить ник, забанить бота или включить «усиленную анонимность».",
    "❔ — такого ФИО в списке старост нет (либо опечатка в фамилии).",
    "⚠️ — в списке несколько подходящих людей (полные тёзки или спросили без отчества): угадывать бот не станет.</i>",
  ];
  // Сотня строк не влезает в одно сообщение Telegram, а резать список
  // молча нельзя: пусть лучше придёт несколько сообщений.
  for (const chunk of chunkLines([...head, "", ...lines, "", ...foot], 3500)) {
    await ctx.reply(chunk, { parse_mode: "HTML" });
  }
});

adminOnly.callbackQuery(/^ail:(user|global):(up|down)$/, async (ctx) => {
  const kind = ctx.match[1] as "user" | "global";
  const dir = ctx.match[2] === "up" ? 1 : -1;
  const day = todayMsk();
  const l = aiLimits(ctx.deps.repo, ctx.deps.config, day);
  const steps = kind === "user" ? USER_STEPS : GLOBAL_STEPS;
  const next = stepValue(steps, kind === "user" ? l.baseUser : l.baseGlobal, dir as 1 | -1);
  setAiLimit(ctx.deps.repo, kind, next);
  await ctx.answerCallbackQuery({ text: `${kind === "user" ? "На человека" : "Общий"}: ${next}` });
  await showAiLimits(ctx, true);
});

adminOnly.callbackQuery(/^ail:boost:(user|global)$/, async (ctx) => {
  const kind = ctx.match[1] as "user" | "global";
  const day = todayMsk();
  const value = addAiBonus(ctx.deps.repo, kind, day, kind === "user" ? BONUS_USER_STEP : BONUS_GLOBAL_STEP);
  await ctx.answerCallbackQuery({ text: `Сегодня +${value} ${kind === "user" ? "каждому" : "общих"}` });
  await showAiLimits(ctx, true);
});

adminOnly.callbackQuery("ail:reset", async (ctx) => {
  setAiLimit(ctx.deps.repo, "user", null);
  setAiLimit(ctx.deps.repo, "global", null);
  clearAiBonus(ctx.deps.repo, todayMsk());
  await ctx.answerCallbackQuery({ text: "Вернул значения из .env" });
  await showAiLimits(ctx, true);
});

adminOnly.callbackQuery("ail:show", async (ctx) => {
  await ctx.answerCallbackQuery();
  await showAiLimits(ctx, true);
});

adminOnly.command("ailimit", async (ctx) => {
  const [what, second, third] = (ctx.match ?? "").trim().split(/\s+/);
  const value = what === "boost" && (second === "user" || second === "global") ? third : second;
  const day = todayMsk();
  if (!what) return showAiLimits(ctx);
  const n = Number(value);
  if (what === "reset") {
    setAiLimit(ctx.deps.repo, "user", null);
    setAiLimit(ctx.deps.repo, "global", null);
    clearAiBonus(ctx.deps.repo, day);
  } else if ((what === "user" || what === "global") && Number.isFinite(n) && n >= 0) {
    setAiLimit(ctx.deps.repo, what, n);
  } else if (what === "boost" && Number.isFinite(n)) {
    // «boost user 5» — каждому, «boost 200» и «boost global 200» — в общий бюджет.
    addAiBonus(ctx.deps.repo, second === "user" ? "user" : "global", day, n);
  } else {
    return void (await ctx.reply("Так: <code>/ailimit user 25</code>, <code>/ailimit global 1000</code>, <code>/ailimit boost 200</code> (в общий бюджет на сегодня), <code>/ailimit boost user 5</code> (каждому на сегодня), <code>/ailimit reset</code>.", { parse_mode: "HTML" }));
  }
  await showAiLimits(ctx);
});

// ---- announcements board ----
function boardText(ctx: BotContext): { text: string; kb: InlineKeyboard } {
  const items = ctx.deps.repo.activeAnnouncements();
  const kb = new InlineKeyboard();
  if (!items.length) return { text: `<b>📌 Доска объявлений</b>\n\nПусто. Рассылка «Всем» или в тему «Объявления» автоматически попадает сюда на ${BOARD_HOURS} ч и видна всем в «${esc("🔔 Изменения")}».`, kb };
  const lines = items.map((a, i) => {
    const left = Math.max(0, Math.round((Date.parse(a.expiresAt) - Date.now()) / 3_600_000));
    kb.text(`🗑 Убрать #${a.id}`, `ann:del:${a.id}`);
    if (i % 2 === 1) kb.row();
    return `<b>#${a.id}</b> · ещё ${left} ч\n${esc(a.text.length > 300 ? a.text.slice(0, 290).trimEnd() + "…" : a.text)}`;
  });
  kb.row();
  return { text: `<b>📌 Доска объявлений</b> (${items.length})\n\n${lines.join("\n\n")}`, kb };
}

async function showBoard(ctx: BotContext): Promise<void> {
  const { text, kb } = boardText(ctx);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

adminOnly.command("announcements", showBoard);

// "ann:del" sits on the board and re-renders it; "ann:rm" sits under a broadcast
// report and must leave that report alone.
adminOnly.callbackQuery(/^ann:(del|rm):(\d+)$/, async (ctx) => {
  const onBoard = ctx.match[1] === "del";
  const id = Number(ctx.match[2]);
  const ok = ctx.deps.repo.deleteAnnouncement(id);
  await ctx.answerCallbackQuery({ text: ok ? `Объявление #${id} убрано с доски` : "Уже убрано" });
  try {
    if (onBoard) {
      const { text, kb } = boardText(ctx);
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    } else {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text("✅ Убрано с доски", "noop") });
    }
  } catch {
    /* the message may be gone or unchanged */
  }
});

adminOnly.callbackQuery(/^adm:(\w+)$/, async (ctx) => {
  const action = ctx.match[1];
  switch (action) {
    case "stats":
      await ctx.answerCallbackQuery();
      await ctx.reply(statsText(ctx), { parse_mode: "HTML" });
      return;
    case "health":
      await ctx.answerCallbackQuery();
      await ctx.reply(healthText(ctx), { parse_mode: "HTML" });
      return;
    case "board":
      await ctx.answerCallbackQuery();
      await showBoard(ctx);
      return;
    case "ai":
      await ctx.answerCallbackQuery();
      await showAiLimits(ctx);
      return;
    case "groups": {
      await ctx.answerCallbackQuery();
      const lines = ctx.deps.service.groups().map((g) => `${esc(g.title)} ← ${g.portalNames.map((n, i) => `${esc(n)} (#${g.portalIds[i]})`).join(", ")}`);
      await ctx.reply(`<b>Логические группы (${lines.length})</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
      return;
    }
    case "poll": {
      await ctx.answerCallbackQuery({ text: "Опрашиваю…" });
      try {
        const r = await ctx.deps.service.poll({ force: false });
        await ctx.reply(`Готово за ${Math.round(r.durationMs / 1000)} с: страниц ${r.pagesFetched}, групп с изменениями ${r.groupsChanged.length}, событий ${r.events.length}.`);
      } catch (err) {
        await ctx.reply(`Ошибка опроса: <code>${esc(String(err)).slice(0, 500)}</code>`, { parse_mode: "HTML" });
      }
      return;
    }
    case "sources":
      await ctx.answerCallbackQuery();
      await ctx.reply("Список и управление: /sources");
      return;
    case "broadcast":
      await ctx.answerCallbackQuery();
      await startBroadcast(ctx);
      return;
    default:
      await ctx.answerCallbackQuery();
  }
});

adminOnly.command("slides", async (ctx) => {
  const decks = ctx.deps.repo.recentSlideDecks(10);
  if (!decks.length) {
    const on = ctx.deps.config.SLIDES_TOKEN ? "приём включён, но записей пока нет" : "приём выключен: не задан SLIDES_TOKEN";
    return void (await ctx.reply(`📎 <b>Слайды вебинаров</b>\n\n${on}.`, { parse_mode: "HTML" }));
  }
  const lines = decks.map((d) => `• ${d.date} · <b>${esc(d.subject)}</b>${d.teacher ? ` · ${esc(d.teacher)}` : ""} — ${d.slides} слайд(ов), ${Math.round(d.bytes / 1024)} КБ, отправлено ${d.sent} чел.`);
  await ctx.reply(`📎 <b>Слайды вебинаров</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
});

adminOnly.command("stats", (ctx) => ctx.reply(statsText(ctx), { parse_mode: "HTML" }));
adminOnly.command("health", (ctx) => ctx.reply(healthText(ctx), { parse_mode: "HTML" }));
adminOnly.command("poll", async (ctx) => {
  await ctx.reply("Опрашиваю портал…");
  try {
    const r = await ctx.deps.service.poll({ force: ctx.match?.trim() === "force" });
    await ctx.reply(`Готово за ${Math.round(r.durationMs / 1000)} с: страниц ${r.pagesFetched}, групп с изменениями ${r.groupsChanged.length}, событий ${r.events.length}.`);
  } catch (err) {
    await ctx.reply(`Ошибка: ${String(err).slice(0, 500)}`);
  }
});

async function startBroadcast(ctx: BotContext): Promise<void> {
  setPending(ctx.deps, ctx.user.id, { kind: "broadcast" });
  await ctx.reply(
    `Пришли сообщение для рассылки: текст, фото с подписью, документ. Перед отправкой покажу, кому и скольким людям, и попрошу подтвердить.\n\nТам же можно повесить текст на доску объявлений в «🔔 Изменения» на ${BOARD_HOURS} ч. По умолчанию не вешаю: доска только для важного.`,
    { reply_markup: cancelKeyboard() },
  );
}
adminOnly.command("broadcast", startBroadcast);

function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✖️ Отмена", "bc:cancel");
}
adminHandlers.command("cancel", async (ctx) => {
  clearPending(ctx.deps, ctx.user.id);
  await ctx.reply("Отменено.");
});

function targetKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard().text("👥 Всем", "bc:all").row();
  for (const t of TOPICS) kb.text(`🏷 ${TOPIC_LABELS[t]}`, `bc:topic:${t}`).row();
  kb.text("🎓 По курсу…", "bc:course").row().text("✖️ Отмена", "bc:cancel");
  return kb;
}

function resolveTarget(ctx: BotContext, action: string): { users: User[]; label: string } {
  if (action === "all") return { users: ctx.deps.repo.listUsers({ onlyActive: true }), label: "всем" };
  if (action.startsWith("topic:")) {
    const topic = action.slice(6);
    return { users: ctx.deps.repo.usersForTopic(topic), label: `подписчикам темы «${TOPIC_LABELS[topic] ?? topic}»` };
  }
  const course = Number(action.slice(1));
  const keys = new Set(ctx.deps.service.groups().filter((g) => g.course === course).map((g) => g.key));
  return { users: ctx.deps.repo.listUsers({ onlyActive: true }).filter((u) => u.groupKey && keys.has(u.groupKey)), label: `${course} курсу` };
}

/** Captures the message to broadcast (must run before generic text handlers). */
adminOnly.on("message", async (ctx, next) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (!pending || pending.kind !== "broadcast") return next();
  if (isMenuText(ctx.msg.text)) {
    clearPending(ctx.deps, ctx.user.id);
    return next();
  }
  const text = (ctx.msg.text ?? ctx.msg.caption ?? "").trim();
  setPending(ctx.deps, ctx.user.id, { kind: "broadcast-target", chatId: ctx.chat.id, messageId: ctx.msg.message_id, text }, 15 * 60_000);
  await ctx.reply("Кому отправить?", { reply_markup: targetKeyboard() });
});

adminOnly.callbackQuery(/^bc:(all|cancel|course|go|topic:\w+|c\d)$/, async (ctx) => {
  const action = ctx.match[1]!;
  const pending = takePending(ctx.deps, ctx.user.id);
  if (action === "cancel") {
    clearPending(ctx.deps, ctx.user.id);
    await ctx.answerCallbackQuery({ text: "Отменено" });
    try {
      await ctx.editMessageText("Рассылка отменена.");
    } catch {
      /* ignore */
    }
    return;
  }
  if (!pending || !pending.chatId || !pending.messageId || (pending.kind !== "broadcast-target" && pending.kind !== "broadcast-confirm")) {
    await ctx.answerCallbackQuery({ text: "Сообщение для рассылки не найдено, начни заново: /broadcast", show_alert: true });
    return;
  }
  if (action === "course") {
    const kb = new InlineKeyboard();
    for (const c of [1, 2, 3, 4, 5]) kb.text(`${c} курс`, `bc:c${c}`);
    kb.row().text("✖️ Отмена", "bc:cancel");
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
    return;
  }
  if (action !== "go") {
    // Target chosen: ask for confirmation.
    setPending(ctx.deps, ctx.user.id, { kind: "broadcast-confirm", chatId: pending.chatId, messageId: pending.messageId, text: pending.text, target: action, board: false }, 15 * 60_000);
    await ctx.answerCallbackQuery();
    await showConfirm(ctx, action, false, !!pending.text);
    return;
  }
  if (pending.kind !== "broadcast-confirm" || !pending.target) {
    await ctx.answerCallbackQuery({ text: "Сначала выбери аудиторию", show_alert: true });
    return;
  }
  const { users, label } = resolveTarget(ctx, pending.target);
  const board = pending.board === true;
  clearPending(ctx.deps, ctx.user.id);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(`Отправляю ${label}: ${users.length} чел…`);
  let ok = 0;
  let failed = 0;
  for (const u of users) {
    try {
      await ctx.api.copyMessage(u.id, pending.chatId, pending.messageId);
      ok++;
    } catch (err) {
      failed++;
      if (isUnreachable(err)) ctx.deps.repo.updateUser(u.id, { blocked: true });
      logger.warn({ err, userId: u.id }, "broadcast delivery failed");
    }
    await sleep(40);
  }
  let boardNote = "";
  let kb: InlineKeyboard | undefined;
  if (board && pending.text) {
    const id = ctx.deps.repo.addAnnouncement(pending.text.slice(0, 2000), ctx.user.id, BOARD_HOURS);
    boardNote = `\nНа доске объявлений ${BOARD_HOURS} ч как #${id}.`;
    kb = new InlineKeyboard().text("🗑 Убрать с доски", `ann:rm:${id}`);
  }
  await ctx.reply(`Рассылка ${label} завершена: доставлено ${ok}, не доставлено ${failed}.${boardNote}`, { reply_markup: kb });
});

/** The confirmation screen, with the board toggle. */
async function showConfirm(ctx: BotContext, target: string, board: boolean, hasText: boolean): Promise<void> {
  const { users, label } = resolveTarget(ctx, target);
  const kb = new InlineKeyboard().text(`✅ Отправить ${users.length} чел.`, "bc:go").row();
  if (hasText) kb.text(`📌 На доску объявлений: ${board ? `да, ${BOARD_HOURS} ч` : "нет"}`, "bc:board").row();
  kb.text("◀️ Другая аудитория", "bc:back").text("✖️ Отмена", "bc:cancel");
  const note = hasText ? "\n\nДоска объявлений висит в «🔔 Изменения» и видна всем, кто откроет этот экран. Вешай туда только важное." : "";
  await ctx.editMessageText(`Отправить ${label}: <b>${users.length}</b> чел.?${note}\n\nЭто нельзя отменить после нажатия.`, { parse_mode: "HTML", reply_markup: kb });
}

adminOnly.callbackQuery("bc:board", async (ctx) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (!pending || pending.kind !== "broadcast-confirm" || !pending.target) return void (await ctx.answerCallbackQuery({ text: "Начни заново: /broadcast", show_alert: true }));
  const board = !pending.board;
  setPending(ctx.deps, ctx.user.id, { ...pending, board }, 15 * 60_000);
  await ctx.answerCallbackQuery({ text: board ? `Повешу на доску на ${BOARD_HOURS} ч` : "На доску не вешаю" });
  try {
    await showConfirm(ctx, pending.target, board, !!pending.text);
  } catch {
    /* ignore */
  }
});

adminOnly.callbackQuery("bc:back", async (ctx) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (!pending || !pending.chatId || !pending.messageId) return void (await ctx.answerCallbackQuery({ text: "Начни заново: /broadcast", show_alert: true }));
  setPending(ctx.deps, ctx.user.id, { kind: "broadcast-target", chatId: pending.chatId, messageId: pending.messageId, text: pending.text }, 15 * 60_000);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Кому отправить?", { reply_markup: targetKeyboard() });
});
