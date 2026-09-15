import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { BTN, groupPicker, settingsKeyboard, TOPIC_HINTS, TOPIC_LABELS, TOPICS, WEBINAR_URL } from "../keyboards.js";
import { THEMES, THEME_LABELS } from "../../render/themes.js";
import { needGroup, subgroupHint } from "../views.js";
import { showGroupPicker } from "./schedule.js";
import type { User } from "../../db/repo.js";
import { esc } from "../../schedule/format.js";

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

function settingsText(ctx: BotContext): string {
  const group = needGroup(ctx);
  const lines = ["<b>⚙️ Настройки</b>"];
  if (!group) lines.push("Группа не выбрана.");
  lines.push("", "Нажимай на пункт, чтобы переключить.");
  lines.push(
    "",
    "<b>Что за уведомления</b>",
    "🔔 Изменения — переносы, замены аудиторий, отмены и новые пары твоей группы.",
    ...(ctx.deps.renderer ? ["🎨 Оформление — как выглядят постеры: тёмная, журнальная, плакатная или лента."] : []),
    "🎓 Сессия — то же самое для расписания зачётов и экзаменов.",
    `💻 Дистант — отдельное напоминание перед онлайн-парой со ссылкой на вебинар (${WEBINAR_URL.replace(/^https?:\/\//, "")}).`,
    ...TOPICS.map((t) => `🏷 ${TOPIC_LABELS[t]} — ${TOPIC_HINTS[t]}.`),
    "Темы — это рассылки от ВИШ, включи те, что хочешь получать.",
  );
  const watch = ctx.deps.repo.watchGroups(ctx.user.id);
  if (watch.length) lines.push("", `Слежу за: ${watch.map((k) => esc(ctx.deps.service.group(k)?.title ?? k)).join(", ")}`);
  return lines.join("\n");
}

async function renderSettings(ctx: BotContext, edit: boolean): Promise<void> {
  const user = ctx.deps.repo.getUser(ctx.user.id) ?? ctx.user;
  const group = user.groupKey ? ctx.deps.service.group(user.groupKey) : null;
  const kb = settingsKeyboard(user, group, { topics: [...TOPICS], hasImages: !!ctx.deps.renderer, watchCount: ctx.deps.repo.watchGroups(user.id).length, defaultTheme: ctx.deps.config.POSTER_THEME });
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
  await ctx.answerCallbackQuery({ text: on ? `Слежу за ${group.title}` : `Больше не слежу за ${group.title}` });
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: watchKeyboard(ctx) });
  } catch {
    /* ignore */
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
