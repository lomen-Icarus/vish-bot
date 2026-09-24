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
import { calendarHandlers } from "./handlers/calendar.js";
import { sourceHandlers } from "./handlers/sources.js";
import { poiskHandlers } from "./handlers/poisk.js";
import { peopleHandlers } from "./people.js";
import { logger } from "../logger.js";
import { menuFor } from "./keyboards.js";
import { teacherModeHandlers } from "./teacherMode.js";
import { subjectHandlers } from "./handlers/subjects.js";

export function createBot(deps: Deps): Bot<BotContext> {
  const bot = new Bot<BotContext>(deps.config.BOT_TOKEN);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

  // A Telegram reply keyboard lives in the chat until a message replaces it, so
  // after an update everyone would keep the previous menu. The first reply each
  // chat gets carries the current one.
  const menuRefreshed = new Set<number>();
  bot.api.config.use(async (prev, method, payload, signal) => {
    const p = payload as { chat_id?: number | string; reply_markup?: unknown };
    if ((method === "sendMessage" || method === "sendPhoto" || method === "sendDocument") && !p.reply_markup && typeof p.chat_id === "number" && p.chat_id > 0 && !menuRefreshed.has(p.chat_id)) {
      menuRefreshed.add(p.chat_id);
      // В режиме преподавателя меню своё: третья кнопка — «Студенты».
      return prev(method, { ...payload, reply_markup: menuFor(deps.repo.getUser(p.chat_id)) } as typeof payload, signal);
    }
    return prev(method, payload, signal);
  });

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
    // Пользователем бот считает того, кто пишет ему в личку (или жмёт кнопки
    // там). Inline-запрос и реплика в группе — ещё не знакомство.
    const privateChat = ctx.chat?.type === "private";
    ctx.user = privateChat ? deps.repo.touchUser(from.id, from.username ?? null, from.first_name ?? null) : deps.repo.peekUser(from.id, from.username ?? null, from.first_name ?? null);
    ctx.isAdmin = deps.config.ADMIN_IDS.includes(from.id);
    await next();
  });

  // News sources (channels / chats) are handled before the private-chat guard.
  bot.use(newsHandlers);

  // Private chats only for the interactive UI; groups can still use inline mode.
  bot.on("message", async (ctx, next) => {
    if (ctx.chat.type !== "private") {
      if (ctx.msg.text?.startsWith("/")) {
        const uname = bot.botInfo?.username ?? "bot";
        // Про inline пишем только когда он реально включён в BotFather.
        const hint = deps.inline ? `\n\nВ этом чате работает inline: набери <code>@${uname} 12-23 завтра</code> и выбери подсказку — расписание вставится сообщением.` : "";
        await ctx.reply(`Я работаю в личных сообщениях: напиши мне напрямую @${uname}.${hint}`, { parse_mode: "HTML" });
      }
      return;
    }
    await next();
  });

  bot.use(adminHandlers);
  // Режим преподавателя: только команда /prepod, кнопок нет.
  bot.use(teacherModeHandlers);
  bot.use(sourceHandlers);
  bot.use(miscHandlers);
  bot.use(askHandlers);
  // Карточка человека, кнопки под ней и ввод фамилии — общие для преподавателей
  // и студентов; студенческие ссылки работают только при POISK=TRUE.
  bot.use(peopleHandlers);
  bot.use(teacherHandlers);
  // Глобальный поиск студентов подключается только при POISK=TRUE: иначе в боте
  // нет ни кнопок, ни команд, ни колбэков этого раздела.
  if (deps.config.POISK) bot.use(poiskHandlers);
  bot.use(streamHandlers);
  // Панель предметов — тестово, только командой /subjects.
  bot.use(subjectHandlers);
  bot.use(calendarHandlers);
  bot.use(settingsHandlers);
  bot.use(scheduleHandlers);

  bot.on("message:text", async (ctx) => {
    await ctx.reply("Не понял. Нажми кнопку ниже или посмотри /help", {
      reply_markup: menuFor(ctx.user),
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
    { command: "groups", description: "Расписание другой группы" },
    { command: "teachers", description: "Расписание преподавателя" },
    { command: "search", description: "Найти предмет, группу или преподавателя" },
    { command: "calendar", description: "Пары в календарь телефона (.ics)" },
    { command: "stream", description: "Режим потока: все группы курса" },
    { command: "settings", description: "Уведомления и напоминания" },
    { command: "features", description: "Что умеет бот" },
    { command: "help", description: "Что умеет бот" },
  ];
  if (deps.ask) common.push({ command: "ask", description: "Спросить про расписание своими словами" });
  common.push({ command: "suggest", description: "Отправить новость медиа-ВИШ" });
  common.push({ command: "soon", description: "Удалить мои данные и начать заново" });
  if (deps.config.POISK) common.push({ command: "poisk", description: "Где студент: глобальный поиск по ФИО" });
  await bot.api.setMyCommands(common);
  const admin = [
    ...common,
    { command: "admin", description: "Админка" },
    { command: "broadcast", description: "Рассылка" },
    { command: "announcements", description: "Доска объявлений" },
    { command: "sources", description: "Источники новостей" },
    { command: "news_scan", description: "Сканировать новости сейчас" },
    { command: "poll", description: "Опросить портал сейчас" },
    { command: "health", description: "Состояние бота" },
    { command: "ailimit", description: "Лимиты вопросов к ИИ" },
    { command: "slides", description: "Слайды записанных вебинаров" },
    { command: "whois", description: "Кто из списка ФИО уже пользуется ботом" },
    { command: "cleanchanges", description: "Убрать ложные изменения из раздела" },
    // Только в меню админов: для остальных режим преподавателя пока без кнопок.
    { command: "prepod", description: "Режим преподавателя (проверка: /prepod Фамилия)" },
    { command: "subjects", description: "Предметы: сколько и когда пар (тест)" },
  ];
  for (const id of deps.config.ADMIN_IDS) {
    try {
      await bot.api.setMyCommands(admin, { scope: { type: "chat", chat_id: id } });
    } catch (err) {
      logger.debug({ err, id }, "admin command scope not set (no chat yet?)");
    }
  }
}
