import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { clearPending, setPending, takePending } from "../context.js";
import { esc } from "../../schedule/format.js";
import { TOPIC_LABELS, TOPICS } from "../keyboards.js";
import { lastPoll } from "../views.js";
import type { User } from "../../db/repo.js";
import { logger } from "../../logger.js";
import { sleep } from "../../time.js";

export const adminHandlers = new Composer<BotContext>();

const adminOnly = adminHandlers.filter((ctx) => ctx.isAdmin);

function adminMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📊 Статистика", "adm:stats")
    .text("🩺 Здоровье", "adm:health")
    .row()
    .text("🔄 Опросить портал", "adm:poll")
    .text("📣 Рассылка", "adm:broadcast")
    .row()
    .text("👥 Группы", "adm:groups");
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

function healthText(ctx: BotContext): string {
  const deps = ctx.deps;
  const p = deps.repo.lastPollRun();
  const mem = process.memoryUsage();
  const up = Math.round((Date.now() - deps.startedAt.getTime()) / 60_000);
  const anchor1 = deps.service.weekOneMonday(1);
  const anchor3 = deps.service.weekOneMonday(3);
  return [
    "<b>🩺 Здоровье</b>",
    `Аптайм: ${up} мин · RSS ${Math.round(mem.rss / 1048576)} МБ · Node ${process.version}`,
    `Последний опрос: ${lastPoll(deps)}${p ? ` · страниц/групп: ${p.groupsTotal ?? "?"} · изменений: ${p.groupsChanged ?? 0} · событий: ${p.events ?? 0}` : ""}`,
    p?.error ? `Ошибка: <code>${esc(p.error).slice(0, 300)}</code>` : "",
    `Учебный год: ${deps.service.academicYear}/${deps.service.academicYear + 1}`,
    `Неделя 1 осень: ${anchor1 ?? "не калибрована"} · весна: ${anchor3 ?? "не калибрована"}`,
    `Групп: ${deps.service.groups().length} · рендер картинок: ${deps.renderer ? "да" : "нет"} · ИИ: ${deps.ask ? deps.config.AI_MODEL : "выкл"} · преподаватели: ${deps.teachers ? "да" : "нет учётки"} · каналы новостей: ${deps.config.NEWS_CHANNEL_IDS.length}`,
    `Баннер портала: ${deps.repo.getMeta("banner") ? esc(deps.repo.getMeta("banner")!.slice(0, 120)) : "нет"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

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
    case "broadcast":
      await ctx.answerCallbackQuery();
      setPending(ctx.deps, ctx.user.id, { kind: "broadcast" });
      await ctx.reply("Пришли сообщение для рассылки (текст, фото с подписью, документ — что угодно). Для отмены: /cancel");
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
adminOnly.command("broadcast", async (ctx) => {
  setPending(ctx.deps, ctx.user.id, { kind: "broadcast" });
  await ctx.reply("Пришли сообщение для рассылки. Для отмены: /cancel");
});
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

/** Captures the message to broadcast (must run before generic text handlers). */
adminOnly.on("message", async (ctx, next) => {
  const pending = takePending(ctx.deps, ctx.user.id);
  if (!pending || pending.kind !== "broadcast") return next();
  setPending(ctx.deps, ctx.user.id, { kind: "broadcast-target", chatId: ctx.chat.id, messageId: ctx.msg.message_id }, 15 * 60_000);
  await ctx.reply("Кому отправить?", { reply_markup: targetKeyboard() });
});

adminOnly.callbackQuery(/^bc:(all|cancel|course|topic:\w+|c\d)$/, async (ctx) => {
  const action = ctx.match[1]!;
  const pending = takePending(ctx.deps, ctx.user.id);
  if (action === "cancel") {
    clearPending(ctx.deps, ctx.user.id);
    await ctx.answerCallbackQuery({ text: "Отменено" });
    await ctx.editMessageText("Рассылка отменена.");
    return;
  }
  if (!pending || pending.kind !== "broadcast-target" || !pending.chatId || !pending.messageId) {
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
  let users: User[];
  let label: string;
  if (action === "all") {
    users = ctx.deps.repo.listUsers({ onlyActive: true });
    label = "всем";
  } else if (action.startsWith("topic:")) {
    const topic = action.slice(6);
    users = ctx.deps.repo.usersForTopic(topic);
    label = `подписчикам темы «${TOPIC_LABELS[topic] ?? topic}»`;
  } else {
    const course = Number(action.slice(1));
    const keys = new Set(ctx.deps.service.groups().filter((g) => g.course === course).map((g) => g.key));
    users = ctx.deps.repo.listUsers({ onlyActive: true }).filter((u) => u.groupKey && keys.has(u.groupKey));
    label = `${course} курсу`;
  }
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
  await ctx.reply(`Рассылка ${label} завершена: доставлено ${ok}, не доставлено ${failed}.`);
});
