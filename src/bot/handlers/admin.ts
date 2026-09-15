import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { clearPending, setPending, takePending } from "../context.js";
import { esc } from "../../schedule/format.js";
import { isMenuText, TOPIC_LABELS, TOPICS } from "../keyboards.js";
import { lastPoll } from "../views.js";
import type { User } from "../../db/repo.js";
import { logger } from "../../logger.js";
import { sleep } from "../../time.js";

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
    .text("📰 Источники", "adm:sources");
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

function webinarStats(ctx: BotContext): string {
  if (!ctx.deps.webinars) return "выкл";
  const s = ctx.deps.webinars.stats();
  return `${s.rows} пар за ${s.days} дн. (по ${s.until ?? "—"}), преподавателей ${s.teachers}`;
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
    `Преподаватели: ${deps.teachers ? `учётка есть · в справочнике ${teacherCount}` : "нет учётки (PORTAL_LOGIN/PORTAL_PASSWORD)"}${teacherErr ? ` · последняя ошибка: <code>${esc(teacherErr).slice(0, 200)}</code>` : ""}`,
    `Вебинары (преподаватели дистанта): ${webinarStats(ctx)}`,
    `Доска объявлений: ${deps.repo.activeAnnouncements().length} активных`,
    `Баннер портала: ${deps.repo.getMeta("banner") ? esc(deps.repo.getMeta("banner")!.slice(0, 120)) : "нет"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

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
    `Пришли сообщение для рассылки: текст, фото с подписью, документ. Перед отправкой я покажу, кому и сколько людям, и попрошу подтвердить.\n\nРассылка «Всем» или в тему «Объявления» ещё и повиснет на ${BOARD_HOURS} ч на доске в «🔔 Изменения»; убрать раньше можно кнопкой или через /announcements.`,
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

function resolveTarget(ctx: BotContext, action: string): { users: User[]; label: string; board: boolean } {
  if (action === "all") return { users: ctx.deps.repo.listUsers({ onlyActive: true }), label: "всем", board: true };
  if (action.startsWith("topic:")) {
    const topic = action.slice(6);
    return { users: ctx.deps.repo.usersForTopic(topic), label: `подписчикам темы «${TOPIC_LABELS[topic] ?? topic}»`, board: topic === "announcements" };
  }
  const course = Number(action.slice(1));
  const keys = new Set(ctx.deps.service.groups().filter((g) => g.course === course).map((g) => g.key));
  return { users: ctx.deps.repo.listUsers({ onlyActive: true }).filter((u) => u.groupKey && keys.has(u.groupKey)), label: `${course} курсу`, board: false };
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
    const { users, label, board } = resolveTarget(ctx, action);
    setPending(ctx.deps, ctx.user.id, { kind: "broadcast-confirm", chatId: pending.chatId, messageId: pending.messageId, text: pending.text, target: action }, 15 * 60_000);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`Отправить ${label}: <b>${users.length}</b> чел.?${board && pending.text ? `\nТекст повиснет на доске объявлений на ${BOARD_HOURS} ч.` : ""}\n\nЭто нельзя отменить после нажатия.`, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text(`✅ Отправить ${users.length} чел.`, "bc:go").row().text("◀️ Другая аудитория", "bc:back").text("✖️ Отмена", "bc:cancel"),
    });
    return;
  }
  if (pending.kind !== "broadcast-confirm" || !pending.target) {
    await ctx.answerCallbackQuery({ text: "Сначала выбери аудиторию", show_alert: true });
    return;
  }
  const { users, label, board } = resolveTarget(ctx, pending.target);
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
      const msg = String(err);
      if (msg.includes("blocked") || msg.includes("deactivated") || msg.includes("chat not found")) ctx.deps.repo.updateUser(u.id, { blocked: true });
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

adminOnly.callbackQuery("bc:back", async (ctx) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (!pending || !pending.chatId || !pending.messageId) return void (await ctx.answerCallbackQuery({ text: "Начни заново: /broadcast", show_alert: true }));
  setPending(ctx.deps, ctx.user.id, { kind: "broadcast-target", chatId: pending.chatId, messageId: pending.messageId, text: pending.text }, 15 * 60_000);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("Кому отправить?", { reply_markup: targetKeyboard() });
});
