import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { BTN, btnRef, groupPicker, menuFor, MENU_MODE_LABELS, MENU_MODES, settingsKeyboard, TOPIC_HINTS, TOPIC_LABELS, TOPICS, WEBINAR_URL } from "../keyboards.js";
import { THEMES, THEME_LABELS } from "../../render/themes.js";
import { needGroup, subgroupHint } from "../views.js";
import { showGroupPicker } from "./schedule.js";
import type { MenuMode, User } from "../../db/repo.js";
import { esc } from "../../schedule/format.js";
import { todayMsk } from "../../time.js";

export const settingsHandlers = new Composer<BotContext>();

function cycle<T>(list: readonly T[], current: T): T {
  const i = list.indexOf(current);
  return list[(i + 1) % list.length]!;
}

const FIRST_OPTIONS = [null, 30, 60, 120, 180] as const;
const EACH_OPTIONS = [null, 10, 15, 30] as const;
const DISTANCE_OPTIONS = [null, 5, 10, 15] as const;
const EVENING_OPTIONS = [null, "19:00", "20:00", "21:00", "22:00"] as const;
const QUIET_OPTIONS = [null, "22:00-07:00", "23:00-07:00", "00:00-08:00"] as const;
const FORMAT_OPTIONS = ["text", "image", "both"] as const;
const TEACHER_VIEW_OPTIONS = ["bold", "plain", "off"] as const;

function settingsText(ctx: BotContext): string {
  const group = needGroup(ctx);
  const lines = ["<b>⚙️ Настройки</b>"];
  if (!group) lines.push("Группа не выбрана.");
  lines.push("", "Нажимай на пункт, чтобы переключить.");
  lines.push(
    "",
    "<b>👨‍🏫 Преподаватели</b>",
    "Кто ведёт пару — в расписании дня, недели, потока и других групп, и на картинках тоже. «С выделением» — фамилия жирным, её видно с первого взгляда; «без выделения» — тем же шрифтом, что и аудитория; «не показывать» — строка короче.",
    ...(ctx.deps.teachers ? [] : ["<i>Сейчас портал отдаёт фамилии только у дистанционных пар: для очных нужна учётка портала.</i>"]),
    "",
    "<b>Что за уведомления</b>",
    "🔔 Изменения — переносы, замены аудиторий, отмены и новые пары твоей группы.",
    ...(ctx.deps.renderer ? ["🎨 Оформление — как выглядят постеры: тёмная, журнальная, плакатная или лента."] : []),
    "🎓 Сессия — то же самое для расписания зачётов и экзаменов.",
    "⌨️ Нижнее меню — сворачивается значком ▦ в поле ввода; может сворачиваться само после каждого нажатия или быть скрыто совсем (вернуть — /menu).",
    `💻 Дистант — отдельное напоминание перед онлайн-парой со ссылкой на вебинар (${WEBINAR_URL.replace(/^https?:\/\//, "")}).`,
    ...(ctx.deps.config.SLIDES_TOKEN ? ["📎 Слайды — PDF со слайдами записанных онлайн-пар твоей группы в личку. По умолчанию выключено."] : []),
    ...TOPICS.map((t) => `🏷 ${TOPIC_LABELS[t]} — ${TOPIC_HINTS[t]}.`),
    "Темы — это рассылки от ВИШ, включи те, что хочешь получать.",
  );
  if ((ctx.deps.known?.count() ?? 0) > 0) {
    lines.push(
      "",
      "<b>🕶 Усиленная анонимность</b>",
      "Бот может узнать тебя по телеграм-нику из списка старост и поздороваться по имени. ФИО он ни у кого не спрашивает — регистрации тут нет.",
      "Включишь анонимность — бот перестанет связывать этот аккаунт с человеком из списка: ни имени, ни «Привет, Вася». Выключишь обратно — всё вернётся.",
    );
  }
  const watch = ctx.deps.repo.watchGroups(ctx.user.id);
  if (watch.length) lines.push("", `Слежу за: ${watch.map((k) => esc(ctx.deps.service.group(k)?.title ?? k)).join(", ")}`);
  return lines.join("\n");
}

async function renderSettings(ctx: BotContext, edit: boolean): Promise<void> {
  const user = ctx.deps.repo.getUser(ctx.user.id) ?? ctx.user;
  const group = user.groupKey ? ctx.deps.service.group(user.groupKey) : null;
  const kb = settingsKeyboard(user, group, {
    topics: [...TOPICS],
    hasImages: !!ctx.deps.renderer,
    watchCount: ctx.deps.repo.watchGroups(user.id).length,
    defaultTheme: ctx.deps.config.POSTER_THEME,
    teacherCount: ctx.deps.repo.watchedTeachers(user.id).length,
    slides: !!ctx.deps.config.SLIDES_TOKEN,
    known: (ctx.deps.known?.count() ?? 0) > 0,
  });
  const text = settingsText({ ...ctx, user } as BotContext);
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

settingsHandlers.command("settings", (ctx) => renderSettings(ctx, false));
settingsHandlers.hears(BTN.settings, (ctx) => renderSettings(ctx, false));

/** Group picker for the watch list with watched groups marked, plus "clear all" and "done". */
function watchKeyboard(ctx: BotContext): InlineKeyboard {
  const watching = new Set(ctx.deps.repo.watchGroups(ctx.user.id));
  const kb = groupPicker(ctx.deps.service.groups(), { prefix: "wt" });
  for (const row of kb.inline_keyboard) for (const btn of row) if ("callback_data" in btn && btn.callback_data?.startsWith("wt:") && watching.has(btn.callback_data.slice(3))) btn.text = `👀 ${btn.text}`;
  kb.row();
  if (watching.size) kb.text("◻️ Убрать все слежения", "wt:clear");
  kb.text("Готово", "wt:done");
  return kb;
}

settingsHandlers.callbackQuery(/^s:(\w+)(?::(.+))?$/, async (ctx) => {
  const field = ctx.match[1]!;
  const arg = ctx.match[2];
  const repo = ctx.deps.repo;
  const user = repo.getUser(ctx.user.id) ?? ctx.user;
  const patch: Partial<User> = {};
  let toast: string | undefined;

  switch (field) {
    case "close":
      await ctx.answerCallbackQuery();
      try {
        await ctx.deleteMessage();
      } catch {
        /* ignore */
      }
      return;
    case "group":
      await ctx.answerCallbackQuery();
      if (user.teacherMode) {
        await ctx.reply("Сейчас включён режим преподавателя: «Сегодня», «Неделя» и напоминания — по твоим парам, «👥 Студенты» — расписание любой группы. Выключить: /prepod");
        return;
      }
      await showGroupPicker(ctx);
      return;
    case "subgroup": {
      const next = cycle([null, 1, 2] as const, user.subgroup as null | 1 | 2);
      patch.subgroup = next;
      toast = next ? `Подгруппа ${next}` : "Показываю обе подгруппы";
      break;
    }
    case "format":
      patch.format = cycle(FORMAT_OPTIONS, user.format);
      break;
    case "theme": {
      const current = (user.posterTheme ?? ctx.deps.config.POSTER_THEME) as (typeof THEMES)[number];
      const next = cycle(THEMES, THEMES.includes(current) ? current : "midnight");
      patch.posterTheme = next;
      toast = `Оформление: ${THEME_LABELS[next] ?? next}`;
      break;
    }
    case "changes":
      patch.notifyChanges = !user.notifyChanges;
      // Включил обратно — старые изменения своей группы уже не новость.
      if (patch.notifyChanges && user.groupKey) ctx.deps.repo.markGroupEventsSeen(user.id, user.groupKey, todayMsk());
      break;
    case "teacher": {
      const next = cycle(TEACHER_VIEW_OPTIONS, user.teacherView);
      patch.teacherView = next;
      toast = { bold: "Преподаватель — жирным", plain: "Преподаватель — обычным текстом", off: "Преподавателей не показываю" }[next];
      break;
    }
    case "anon":
      patch.anon = !user.anon;
      toast = patch.anon ? "Готово: больше не здороваюсь по имени и не связываю аккаунт с человеком из списка" : "Снова узнаю тебя по имени";
      break;
    case "slides":
      patch.wantSlides = !user.wantSlides;
      toast = patch.wantSlides ? "Буду присылать слайды записанных пар" : "Слайды присылать не буду";
      break;
    case "session":
      patch.notifySession = !user.notifySession;
      toast = patch.notifySession ? "Буду присылать изменения расписания сессии" : "Сессию не отслеживаю";
      break;
    case "notices":
      patch.notifyNotices = !user.notifyNotices;
      break;
    case "first":
      patch.remindFirstMin = cycle(FIRST_OPTIONS, user.remindFirstMin as (typeof FIRST_OPTIONS)[number]);
      break;
    case "each":
      patch.remindEachMin = cycle(EACH_OPTIONS, user.remindEachMin as (typeof EACH_OPTIONS)[number]);
      break;
    case "distance":
      patch.remindDistanceMin = cycle(DISTANCE_OPTIONS, user.remindDistanceMin as (typeof DISTANCE_OPTIONS)[number]);
      toast = patch.remindDistanceMin ? `Перед дистантом напомню за ${patch.remindDistanceMin} мин со ссылкой` : "Отдельных напоминаний о дистанте не будет";
      break;
    case "evening":
      patch.eveningAt = cycle(EVENING_OPTIONS, user.eveningAt as (typeof EVENING_OPTIONS)[number]);
      break;
    case "quiet": {
      const current = user.quietFrom ? `${user.quietFrom}-${user.quietTo}` : null;
      const next = cycle(QUIET_OPTIONS, current as (typeof QUIET_OPTIONS)[number]);
      if (next) {
        const [from, to] = next.split("-") as [string, string];
        patch.quietFrom = from;
        patch.quietTo = to;
      } else {
        patch.quietFrom = null;
        patch.quietTo = null;
      }
      break;
    }
    case "topic": {
      if (!arg) break;
      const topics = user.topics.includes(arg) ? user.topics.filter((t) => t !== arg) : [...user.topics, arg];
      patch.topics = topics;
      break;
    }
    case "watch": {
      await ctx.answerCallbackQuery();
      await ctx.reply("Изменения каких ещё групп присылать? Нажми, чтобы включить или выключить.", { reply_markup: watchKeyboard(ctx) });
      return;
    }
    case "menu": {
      // Выбор — в том же сообщении настроек: после него оно вернётся с новой подписью.
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(menuChoiceText(user.menuMode), { parse_mode: "HTML", reply_markup: menuChoiceKeyboard(user.menuMode) }).catch(() => undefined);
      return;
    }
    case "teachers": {
      await ctx.answerCallbackQuery();
      const list = ctx.deps.repo.watchedTeachers(ctx.user.id);
      if (!list.length) return void (await ctx.reply(`Ты пока ни за кем не следишь. Открой ${btnRef(user, BTN.teachers, "/teachers")}, найди человека и нажми «Следить за преподом».`));
      const kb = new InlineKeyboard();
      for (const t of list) kb.text(`🔕 ${t.name}`, `twx:${t.teacherId}`).row();
      await ctx.reply(
        `👨‍🏫 <b>Слежу за преподавателями</b>\n\nВечером пришлю их завтрашний день, и ещё раз за 2 часа до первой пары. Нажми, чтобы перестать следить.`,
        { parse_mode: "HTML", reply_markup: kb },
      );
      return;
    }
    default:
      await ctx.answerCallbackQuery();
      return;
  }
  if (Object.keys(patch).length) repo.updateUser(user.id, patch);
  await ctx.answerCallbackQuery(toast ? { text: toast } : undefined);
  if (field === "subgroup" && patch.subgroup === 1 && !user.subgroup) {
    await ctx.reply(subgroupHint());
  }
  await renderSettings(ctx, true);
});

settingsHandlers.callbackQuery(/^wt:(.+)$/, async (ctx) => {
  const key = ctx.match[1]!;
  if (key === "done") {
    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch {
      /* ignore */
    }
    await renderSettings(ctx, false);
    return;
  }
  if (key === "clear") {
    const n = ctx.deps.repo.clearWatchGroups(ctx.user.id);
    await ctx.answerCallbackQuery({ text: n ? `Убрал слежение за ${n} гр.` : "Слежений и не было" });
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: watchKeyboard(ctx) });
    } catch {
      /* ignore */
    }
    return;
  }
  const group = ctx.deps.service.group(key);
  if (!group) return void (await ctx.answerCallbackQuery({ text: "Группа не найдена" }));
  const on = ctx.deps.repo.toggleWatchGroup(ctx.user.id, key);
  // Прошлые изменения группы — не новость для того, кто только начал следить:
  // иначе утренний добор после тихих часов вывалил бы их все разом.
  if (on) ctx.deps.repo.markGroupEventsSeen(ctx.user.id, key, todayMsk());
  await ctx.answerCallbackQuery({ text: on ? `Слежу за ${group.title}` : `Больше не слежу за ${group.title}` });
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: watchKeyboard(ctx) });
  } catch {
    /* ignore */
  }
});

/**
 * Отписка из списка слежений. Отдельный колбэк, потому что здесь надо
 * перерисовать весь список, а не менять надпись на одной кнопке (иначе все
 * строки списка превратились бы в «Следить за преподом»).
 */
settingsHandlers.callbackQuery(/^twx:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const watched = ctx.deps.repo.watchedTeachers(ctx.user.id).find((w) => w.teacherId === id);
  // Только отписка: повторное или устаревшее нажатие не должно подписать
  // снова (да ещё под именем «#123»).
  if (watched) ctx.deps.repo.toggleWatchTeacher(ctx.user.id, id, watched.name);
  await ctx.answerCallbackQuery({ text: watched ? `Больше не слежу за ${watched.name}` : "Уже не слежу" });
  const list = ctx.deps.repo.watchedTeachers(ctx.user.id);
  const kb = new InlineKeyboard();
  for (const t of list) kb.text(`🔕 ${t.name}`, `twx:${t.teacherId}`).row();
  try {
    await ctx.editMessageText(list.length ? "👨‍🏫 <b>Слежу за преподавателями</b>\n\nВечером пришлю их завтрашний день, и ещё раз за 2 часа до первой пары. Нажми, чтобы перестать следить." : "👨‍🏫 Слежений больше нет.", {
      parse_mode: "HTML",
      reply_markup: list.length ? kb : undefined,
    });
  } catch {
    /* сообщение могло устареть */
  }
});

/** "Не следить" button under a change notification of a watched group. */
settingsHandlers.callbackQuery(/^unwatch:(.+)$/, async (ctx) => {
  const key = ctx.match[1]!;
  const group = ctx.deps.service.group(key);
  const watching = ctx.deps.repo.watchGroups(ctx.user.id).includes(key);
  if (watching) ctx.deps.repo.toggleWatchGroup(ctx.user.id, key);
  await ctx.answerCallbackQuery({ text: watching ? `Больше не слежу за ${group?.title ?? key}` : "Слежение уже выключено" });
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard().text(`✅ Не слежу за ${group?.title ?? key}`, "noop") });
  } catch {
    /* ignore */
  }
});

export function closeKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✖️ Закрыть", "s:close");
}

// ---- нижнее меню: сворачивается / сворачивается после нажатия / скрыто ----
const MENU_MODE_HINTS: Record<MenuMode, string> = {
  collapsible: "кнопки внизу, а значком ▦ в поле ввода их можно свернуть и развернуть",
  once: "нажал кнопку — меню само свернулось; вернуть его — тем же значком ▦",
  hidden: "кнопок внизу нет; всё есть в кнопке «Меню» слева от поля ввода (/today, /week, /settings…), вернуть кнопки — /menu",
};

const MENU_MODE_DONE: Record<MenuMode, string> = {
  collapsible: "Готово: меню внизу, свернуть и развернуть его можно значком ▦ в поле ввода.",
  once: "Готово: после каждого нажатия меню будет сворачиваться само, вернуть его — значком ▦ в поле ввода.",
  hidden: "Готово: меню скрыто. Всё есть в кнопке «Меню» слева от поля ввода, вернуть кнопки — /menu.",
};

function menuChoiceText(current: MenuMode): string {
  return ["<b>⌨️ Нижнее меню</b>", "", ...MENU_MODES.map((m) => `${m === current ? "✅" : "▫️"} <b>${MENU_MODE_LABELS[m]}</b> — ${MENU_MODE_HINTS[m]}`)].join("\n");
}

function menuChoiceKeyboard(current: MenuMode): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const m of MENU_MODES) kb.text(`${m === current ? "✅ " : ""}${MENU_MODE_LABELS[m].charAt(0).toUpperCase()}${MENU_MODE_LABELS[m].slice(1)}`, `menu:${m}`).row();
  return kb.text("◀️ К настройкам", "menu:back");
}

/** Кнопки в чате меняются только новым сообщением: шлём его сразу, с новым меню (или с «убрать»). */
async function applyMenu(ctx: BotContext, mode: MenuMode, text: string): Promise<void> {
  const repo = ctx.deps.repo;
  repo.updateUser(ctx.user.id, { menuMode: mode });
  ctx.user.menuMode = mode;
  await ctx.reply(text, { reply_markup: menuFor(ctx.user) });
  // Два быстрых нажатия разными режимами: сообщения могли дойти не по порядку,
  // и в чате осталось не то меню, что записано. Тогда забываем, что меню стоит, —
  // правильное придёт со следующим сообщением (menuRefresh.ts).
  if (repo.getUser(ctx.user.id)?.menuMode !== mode) repo.updateUser(ctx.user.id, { menuSent: null });
}

settingsHandlers.callbackQuery(/^menu:(collapsible|once|hidden|back)$/, async (ctx) => {
  const choice = ctx.match[1]!;
  const current = (ctx.deps.repo.getUser(ctx.user.id) ?? ctx.user).menuMode;
  if (choice === "back" || choice === current) {
    // Тот же режим (или двойное нажатие) — ничего не шлём: меню не раскрывается зря.
    await ctx.answerCallbackQuery(choice === "back" ? undefined : { text: "Уже так" });
    return renderSettings(ctx, true);
  }
  const mode = choice as MenuMode;
  await ctx.answerCallbackQuery({ text: `Нижнее меню: ${MENU_MODE_LABELS[mode]}` });
  await applyMenu(ctx, mode, MENU_MODE_DONE[mode]);
  await renderSettings(ctx, true);
});

/** /menu — вернуть кнопки: скрытое меню снова становится «сворачивается». */
settingsHandlers.command("menu", async (ctx) => {
  if (ctx.user.menuMode === "hidden") return applyMenu(ctx, "collapsible", "Меню снова внизу 👇 Свернуть — значком ▦ в поле ввода, скрыть насовсем — ⚙️ Настройки → «Нижнее меню».");
  await ctx.reply("Меню внизу 👇", { reply_markup: menuFor(ctx.user) });
});
