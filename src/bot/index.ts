import { Bot, GrammyError, HttpError, session } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { BotContext, Deps } from "./context.js";
import { clearPending, takePending, TEXT_PENDING } from "./context.js";
import { scheduleHandlers } from "./handlers/schedule.js";
import { settingsHandlers } from "./handlers/settings.js";
import { adminHandlers } from "./handlers/admin.js";
import { freeTextSearch, miscHandlers } from "./handlers/misc.js";
import { calFeedHandlers } from "./handlers/calFeeds.js";
import { ppaHandlers } from "./handlers/ppa.js";
import { hubHandlers } from "./handlers/hub.js";
import { slidesHandlers } from "./handlers/slides.js";
import { askHandlers } from "./handlers/ask.js";
import { teacherHandlers } from "./handlers/teachers.js";
import { streamHandlers } from "./handlers/stream.js";
import { newsHandlers } from "./handlers/news.js";
import { calendarHandlers } from "./handlers/calendar.js";
import { sourceHandlers } from "./handlers/sources.js";
import { poiskHandlers } from "./handlers/poisk.js";
import { peopleHandlers } from "./people.js";
import { logger } from "../logger.js";
import { currentLabel, isMenuText, menuFor, menuHint } from "./keyboards.js";
import { todayMsk } from "../time.js";
import { menuRefresher } from "./menuRefresh.js";
import { teacherModeHandlers } from "./teacherMode.js";
import { subjectHandlers } from "./handlers/subjects.js";
import { groupChatHandlers } from "./handlers/groupChat.js";
import { chatAdminHandlers } from "./handlers/chatAdmin.js";
import { recSlotsHandlers } from "./handlers/recSlots.js";
import { easterHandlers } from "./easter.js";

/** Колбэки панелей, которые считаются по кнопкам, а не одной строкой на панель. */
const PANEL_PREFIXES = new Set(["hub", "more"]);

export function createBot(deps: Deps): Bot<BotContext> {
  const bot = new Bot<BotContext>(deps.config.BOT_TOKEN);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

  // Меню человека — с первым его сообщением, если поменялось (menuRefresh.ts).
  bot.api.config.use(menuRefresher(deps.repo));

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
    // Анонимный админ группы пишет от @GroupAnonymousBot (is_bot): такие
    // сообщения пропускаем только в чатах-источниках новостей — там пост
    // «#всем» от имени чата законный.
    const anonymousAdminNews = !!from?.is_bot && !!ctx.msg?.sender_chat && ctx.chat?.type !== "private" && deps.config.NEWS_CHANNEL_IDS.includes(ctx.chat?.id ?? 0);
    if (!from || (from.is_bot && !anonymousAdminNews)) return;
    // Пользователем бот считает того, кто пишет ему в личку (или жмёт кнопки
    // там). Inline-запрос и реплика в группе — ещё не знакомство.
    const privateChat = ctx.chat?.type === "private";
    ctx.user = privateChat ? deps.repo.touchUser(from.id, from.username ?? null, from.first_name ?? null) : deps.repo.peekUser(from.id, from.username ?? null, from.first_name ?? null);
    ctx.isAdmin = deps.config.ADMIN_IDS.includes(from.id);
    await next();
  });

  // News sources (channels / chats) are handled before the private-chat guard.
  bot.use(newsHandlers);
  // Болталка: «@бот привет» в группе (CHAT_AI=TRUE); остальное в группах — как раньше.
  bot.use(groupChatHandlers);

  // Private chats only for the interactive UI; groups can still use inline mode.
  bot.on("message", async (ctx, next) => {
    if (ctx.chat.type !== "private") {
      const cmd = ctx.msg.text?.startsWith("/") ? ctx.msg.text.split(/\s/)[0]! : null;
      const uname = bot.botInfo?.username ?? "bot";
      // С выключенным privacy mode бот видит все команды чата, в том числе
      // чужим ботам: отвечаем только на адресованные ему (/cmd@бот), а голые —
      // лишь когда их присылает сам Telegram, то есть в privacy mode.
      const mine = cmd ? (cmd.includes("@") ? cmd.toLowerCase().endsWith(`@${uname.toLowerCase()}`) : !ctx.me.can_read_all_group_messages) : false;
      if (mine) {
        // Про inline пишем только когда он реально включён в BotFather.
        const hint = deps.inline ? `\n\nВ этом чате работает inline: набери <code>@${uname} 12-23 завтра</code> и выбери подсказку — расписание вставится сообщением.` : "";
        await ctx.reply(`Я работаю в личных сообщениях: напиши мне напрямую @${uname}.${hint}`, { parse_mode: "HTML" });
      }
      return;
    }
    await next();
  });

  // Счётчики нажатий: кнопка меню, команда или кнопка под сообщением — по
  // одной строке на день, без id людей. По ним видно, что реально нужно.
  bot.use(async (ctx, next) => {
    try {
      // Кнопки панелей «Найти» и «Ещё» — каждая своей строкой (hub:groups,
      // more:help), иначе эффект перестановок в панели не измерить; старая
      // подпись кнопки меню считается вместе с нынешней.
      const data = ctx.callbackQuery?.data;
      const key = data
        ? `cb:${PANEL_PREFIXES.has(data.split(":")[0]!) ? data.split(":").slice(0, 2).join(":") : data.split(":")[0]}`
        : ctx.msg?.text?.startsWith("/")
          ? `cmd:${ctx.msg.text.split(/[\s@]/)[0]}`
          : isMenuText(ctx.msg?.text)
            ? `btn:${currentLabel(ctx.msg!.text!.trim())}`
            : null;
      if (key && ctx.chat?.type === "private") deps.repo.bumpCounter(todayMsk(), key);
    } catch (err) {
      logger.debug({ err: String(err) }, "counter not saved");
    }
    await next();
  });

  // Кнопка нижнего меню или команда — человек передумал: ожидание текста
  // (обращение, фамилия, вопрос ИИ, своё время календаря) снимаем здесь, один
  // раз для всех, а не в каждом обработчике — «🔍 Найти» и «🗂 Ещё» стоят
  // раньше них. Команда — для тех, у кого меню скрыто: кнопок у них нет, и
  // «14-24» после /today иначе ушло бы вопросом ИИ. Ожидания кнопок под
  // сообщением (рассылка админа) не трогаем — см. TEXT_PENDING. Собранное
  // обращение не стираем: только перестаём дописывать в него — «✅ Отправить»
  // под ним работает и после «📅 Сегодня».
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.msg.text;
    if (isMenuText(text) || text.startsWith("/")) {
      const pending = takePending(deps, ctx.user.id);
      if (pending?.kind === "support" && pending.messageIds?.length) pending.parked = true;
      else if (pending && TEXT_PENDING.has(pending.kind)) clearPending(deps, ctx.user.id);
    }
    await next();
  });

  bot.use(adminHandlers);
  // Календари групп без привязки к человеку: /calfeeds (только админ).
  bot.use(calFeedHandlers);
  bot.use(chatAdminHandlers);
  bot.use(recSlotsHandlers);
  // Режим преподавателя: только команда /prepod, кнопок нет.
  bot.use(teacherModeHandlers);
  // Пасхалка: секретная /ershov (ни в одном меню её нет).
  bot.use(easterHandlers);
  bot.use(sourceHandlers);
  // «🔍 Найти», «🗂 Ещё», «🙋 Поддержка»: до misc — обращение в Министерство
  // Жалоб может быть фото или документом, не только текстом.
  bot.use(hubHandlers);
  bot.use(ppaHandlers);
  // «слайды история» в личке и кнопка «📎 Слайды» под днём: до misc, где любой текст — поиск.
  bot.use(slidesHandlers);
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
    // Незнакомая команда — подсказка; любой другой текст — поиск по своей базе
    // (группа, преподаватель, предмет), без ИИ: см. freeTextSearch.
    if (!ctx.msg.text.startsWith("/")) return freeTextSearch(ctx, ctx.msg.text);
    await ctx.reply(`Не знаю такой команды. ${ctx.user.menuMode === "hidden" ? `${menuHint(ctx.user)}.` : "Нажми кнопку ниже."} Подсказки — /help`, {
      reply_markup: menuFor(ctx.user),
    });
  });

  bot.catch((err) => {
    const ctx = err.ctx;
    const e = err.error;
    if (e instanceof GrammyError) {
      // «Заблокировал бота» — только если отказ пришёл из его же лички; 403 из
      // группы (бота выгнали, нет прав писать) не повод глушить ему уведомления.
      if (e.error_code === 403 && ctx.from && ctx.chat?.type === "private") {
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
    { command: "ppa", description: "Пересдачи (ППА) и мои долги" },
    { command: "stream", description: "Режим потока: все группы курса" },
    { command: "settings", description: "Уведомления и напоминания" },
    { command: "menu", description: "Показать кнопки меню внизу" },
    { command: "features", description: "Что умеет бот" },
    { command: "help", description: "Что умеет бот" },
  ];
  if (deps.ask) common.push({ command: "ask", description: "Спросить про расписание своими словами" });
  common.push({ command: "support", description: "Министерство Жалоб: написать админу" });
  common.push({ command: "suggest", description: "Отправить новость медиа-ВИШ" });
  common.push({ command: "soon", description: "Удалить мои данные и начать заново" });
  if (deps.config.POISK) common.push({ command: "poisk", description: "Где студент: глобальный поиск по ФИО" });
  await bot.api.setMyCommands(common);
  const admin = [
    ...common,
    { command: "admin", description: "Админка" },
    { command: "broadcast", description: "Рассылка" },
    { command: "menu_refresh", description: "Обновить нижнее меню у всех" },
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
    { command: "chats", description: "Болталка в группах: чаты и лимиты" },
    { command: "slots", description: "Слоты записи: учётки студентов и заявки" },
    { command: "slot_owner", description: "Подписать слот из .env: /slot_owner 14-25 @ник" },
    { command: "qa", description: "Сценарий болталки: вопрос → ответ" },
    { command: "reply_add", description: "Добавить в сценарий: вопрос => ответ" },
    { command: "chatlimit", description: "Лимиты болталки в группах" },
  ];
  for (const id of deps.config.ADMIN_IDS) {
    try {
      await bot.api.setMyCommands(admin, { scope: { type: "chat", chat_id: id } });
    } catch (err) {
      logger.debug({ err, id }, "admin command scope not set (no chat yet?)");
    }
  }
}
