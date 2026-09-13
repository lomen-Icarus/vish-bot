import { Bot, GrammyError, HttpError, session } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { BotContext, Deps } from "./context.js";
import { scheduleHandlers } from "./handlers/schedule.js";
import { settingsHandlers } from "./handlers/settings.js";
import { adminHandlers } from "./handlers/admin.js";
import { miscHandlers } from "./handlers/misc.js";
import { askHandlers } from "./handlers/ask.js";
import { teacherHandlers } from "./handlers/teachers.js";
import { streamHandlers } from "./handlers/stream.js";
import { newsHandlers } from "./handlers/news.js";
import { logger } from "../logger.js";
import { mainKeyboard } from "./keyboards.js";

export function createBot(deps: Deps): Bot<BotContext> {
  const bot = new Bot<BotContext>(deps.config.BOT_TOKEN);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

  bot.use(session({ initial: () => ({}) }));

  // Attach deps and the user record to every update.
  bot.use(async (ctx, next) => {
    ctx.deps = deps;
    const from = ctx.from;
    if (ctx.channelPost) {
      // Channel posts carry no sender; only the news relay handles them.
      ctx.isAdmin = false;
      await next();
      return;
    }
    if (!from || from.is_bot) return;
    ctx.user = deps.repo.touchUser(from.id, from.username ?? null, from.first_name ?? null);
    ctx.isAdmin = deps.config.ADMIN_IDS.includes(from.id);
    await next();
  });

  // News sources (channels / chats) are handled before the private-chat guard.
  bot.use(newsHandlers);

  // Private chats only for the interactive UI; groups can still use inline mode.
  bot.on("message", async (ctx, next) => {
    if (ctx.chat.type !== "private") {
      if (ctx.msg.text?.startsWith("/")) await ctx.reply("Я работаю в личных сообщениях. Напиши мне напрямую или используй inline: @" + (bot.botInfo?.username ?? "bot") + " 12-23");
      return;
    }
    await next();
  });

  bot.use(adminHandlers);
  bot.use(miscHandlers);
  bot.use(askHandlers);
  bot.use(teacherHandlers);
  bot.use(streamHandlers);
  bot.use(settingsHandlers);
  bot.use(scheduleHandlers);

  bot.on("message:text", async (ctx) => {
    await ctx.reply("Не понял. Нажми кнопку ниже или посмотри /help", {
      reply_markup: mainKeyboard({ ask: !!deps.ask }),
    });
  });

  bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;
    if (e instanceof GrammyError) {
      if (e.error_code === 403 && ctx.from) {
        deps.repo.updateUser(ctx.from.id, { blocked: true });
        logger.info({ userId: ctx.from.id }, "user blocked the bot");
        return;
      }
      logger.error({ err: e.description, method: e.method, update: ctx.update.update_id }, "telegram API error");
    } else if (e instanceof HttpError) {
      logger.error({ err: e }, "could not contact Telegram");
    } else {
      logger.error({ err: e, update: ctx.update.update_id }, "unhandled error in update");
    }
  });

  return bot;
}

export async function registerCommands(bot: Bot<BotContext>, deps: Deps): Promise<void> {
  const common = [
    { command: "today", description: "Пары на сегодня" },
    { command: "tomorrow", description: "Пары на завтра" },
    { command: "week", description: "Расписание на неделю" },
    { command: "date", description: "Расписание на дату: /date 14.09" },
    { command: "changes", description: "Последние изменения" },
    { command: "group", description: "Выбрать группу" },
    { command: "teachers", description: "Расписание преподавателя" },
    { command: "stream", description: "Режим потока: все группы курса" },
    { command: "settings", description: "Уведомления и напоминания" },
    { command: "help", description: "Что умеет бот" },
  ];
  if (deps.ask) common.push({ command: "ask", description: "Спросить про расписание своими словами" });
  common.push({ command: "suggest", description: "Отправить новость медиа-ВИШ" });
  await bot.api.setMyCommands(common);
  const admin = [...common, { command: "admin", description: "Админка" }, { command: "poll", description: "Опросить портал сейчас" }, { command: "broadcast", description: "Рассылка" }, { command: "health", description: "Состояние бота" }];
  for (const id of deps.config.ADMIN_IDS) {
    try {
      await bot.api.setMyCommands(admin, { scope: { type: "chat", chat_id: id } });
    } catch (err) {
      logger.debug({ err, id }, "admin command scope not set (no chat yet?)");
    }
  }
}
