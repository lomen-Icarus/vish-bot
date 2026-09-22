/** Admin management of news sources and the manual scan; user complaints on delivered news. */
import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { parseSourceRef } from "../../news/fetchers.js";
import { clampHtml, esc } from "../../schedule/format.js";
import { TOPIC_LABELS } from "../keyboards.js";
import { logger } from "../../logger.js";

export const sourceHandlers = new Composer<BotContext>();
const adminOnly = sourceHandlers.filter((ctx) => ctx.isAdmin);

/**
 * Подсказка «как добавить источник» — одна на оба места, где она нужна:
 * раньше их было две, и они успели разойтись (одна звала на /news/, другая
 * на корень сайта; это один и тот же фид, но два разных источника, и новости
 * приходили бы дважды).
 *
 * В примерах нарочно нет ссылок-заглушек вроде «t.me/канал»: такую строку
 * копируют целиком, а кириллица в адресе не проходит разбор как Telegram или
 * VK и молча заводит нерабочий веб-источник.
 */
const SOURCE_HELP = [
  "Добавить источник: <code>/source_add</code> и ссылка.",
  "• Telegram — <code>/source_add https://t.me/vish_chuvsu</code> (нужен публичный канал)",
  "• Сайт — <code>/source_add https://vish.chuvsu.ru/</code> (Tilda: бот берёт ленты новостей и анонсов с датами и фото)",
  "• VK — <code>/source_add https://vk.com/vish_chuvsu</code>",
  "Telegram и сайт читаются без ключей.",
];

const VK_HINT = "VK пока не подключён: нужен <code>VK_SERVICE_TOKEN</code> в .env — сервисный ключ приложения из VK ID (id.vk.ru → «Мои приложения»). Без него источники VK падают с ошибкой на каждом скане.";

function sourcesText(ctx: BotContext): { text: string; kb: InlineKeyboard } {
  const list = ctx.deps.repo.listNewsSources(false);
  const kb = new InlineKeyboard();
  const lines = ["<b>📰 Источники новостей</b>", "Бот раз в день читает их, Sonnet 5 раскладывает свежие посты по темам, подписчики получают подходящие.", ""];
  if (!list.length) lines.push("Пока пусто.");
  for (const s of list) {
    const status = s.lastError ? `⚠️ ${esc(s.lastError.slice(0, 60))}` : s.lastScannedAt ? `✅ ${s.lastScannedAt.slice(0, 16).replace("T", " ")}` : "ещё не сканировался";
    lines.push(`#${s.id} <b>${esc(s.title ?? s.ref)}</b> (${s.kind}) — ${status}`);
    kb.text(`🗑 #${s.id} ${(s.title ?? s.ref).slice(0, 24)}`, `src:del:${s.id}`).row();
  }
  lines.push("", ...SOURCE_HELP);
  if (!ctx.deps.config.VK_SERVICE_TOKEN) lines.push(VK_HINT);
  kb.text("🔎 Сканировать сейчас", "src:scan");
  // Список растёт с каждым источником, а лимит сообщения — 4096: без обрезки
  // экран однажды просто перестал бы открываться.
  return { text: clampHtml(lines.join("\n")), kb };
}

adminOnly.command("sources", async (ctx) => {
  const { text, kb } = sourcesText(ctx);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
});

adminOnly.command("source_add", async (ctx) => {
  const parsed = parseSourceRef(ctx.match ?? "");
  if (!parsed) return void (await ctx.reply(["Не понял ссылку.", "", ...SOURCE_HELP].join("\n"), { parse_mode: "HTML" }));
  const s = ctx.deps.repo.addNewsSource(parsed.kind, parsed.ref, parsed.title);
  // Источник VK без ключа гарантированно упадёт на первом же скане: сказать
  // об этом надо здесь, а не только на экране, с которого админ уже ушёл.
  const warn = parsed.kind === "vk" && !ctx.deps.config.VK_SERVICE_TOKEN ? `\n\n⚠️ ${VK_HINT}` : "";
  await ctx.reply(`Добавил источник #${s.id}: ${esc(s.title ?? s.ref)} (${s.kind}). Проверить: /sources → «Сканировать сейчас».${warn}`, { parse_mode: "HTML" });
});

adminOnly.command("source_del", async (ctx) => {
  const id = Number((ctx.match ?? "").trim());
  if (!id) return void (await ctx.reply("Укажи номер: /source_del 3"));
  await ctx.reply(ctx.deps.repo.deleteNewsSource(id) ? `Источник #${id} удалён.` : `Источника #${id} нет.`);
});

adminOnly.callbackQuery(/^src:del:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  ctx.deps.repo.deleteNewsSource(id);
  await ctx.answerCallbackQuery({ text: `Источник #${id} удалён` });
  const { text, kb } = sourcesText(ctx);
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
  } catch {
    /* ignore */
  }
});

async function runScan(ctx: BotContext): Promise<void> {
  const scanner = ctx.deps.news;
  if (!scanner) return void (await ctx.reply("Сканер выключен: нужен ANTHROPIC_API_KEY в .env."));
  await ctx.reply("Сканирую источники…");
  try {
    const r = await scanner.scan();
    const cats = Object.entries(r.classified)
      .map(([k, v]) => `${TOPIC_LABELS[k] ?? k}: ${v}`)
      .join(", ");
    await ctx.reply(
      `Готово за ${Math.round(r.durationMs / 1000)} с.\nИсточников: ${r.sources}, постов получено: ${r.fetched}, новых за ${ctx.deps.config.NEWS_LOOKBACK_HOURS} ч: ${r.fresh}.\nКатегории: ${cats || "—"}.\nДоставлено сообщений: ${r.sent}.${r.errors.length ? `\nОшибки:\n${r.errors.map((e) => `• ${esc(e)}`).join("\n")}` : ""}`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    await ctx.reply(`Ошибка сканирования: ${esc(String(err)).slice(0, 300)}`, { parse_mode: "HTML" });
  }
}

adminOnly.command("news_scan", runScan);
adminOnly.callbackQuery("src:scan", async (ctx) => {
  await ctx.answerCallbackQuery();
  await runScan(ctx);
});

// ---- complaints from readers ----
sourceHandlers.callbackQuery(/^nc:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const item = ctx.deps.repo.newsItem(id);
  if (!item) return void (await ctx.answerCallbackQuery({ text: "Новость не найдена" }));
  const count = ctx.deps.repo.addNewsComplaint(id, ctx.user.id);
  await ctx.answerCallbackQuery({ text: "Спасибо, учтём" });
  try {
    const kb = new InlineKeyboard();
    if (item.url) kb.url("🔗 Открыть", item.url);
    kb.text("✅ Жалоба учтена", "noop");
    await ctx.editMessageReplyMarkup({ reply_markup: kb });
  } catch {
    /* ignore */
  }
  const from = ctx.from;
  const report = `👎 <b>Жалоба «не по теме»</b> (уже ${count}) на новость #${id} · ${TOPIC_LABELS[item.topic ?? ""] ?? item.topic}\n${item.title ? `<b>${esc(item.title)}</b>\n` : ""}${item.url ?? ""}\nот ${from.username ? `@${esc(from.username)}` : esc(from.first_name)}`;
  for (const adminId of ctx.deps.config.ADMIN_IDS) {
    try {
      await ctx.api.sendMessage(adminId, report, { parse_mode: "HTML" });
    } catch (err) {
      logger.warn({ err: String(err), adminId }, "complaint report failed");
    }
  }
});
