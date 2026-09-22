/** Admin management of news sources and the manual scan; user complaints on delivered news. */
import { Composer, InlineKeyboard } from "grammy";
import type { BotContext } from "../context.js";
import { parseSourceRef } from "../../news/fetchers.js";
import { esc } from "../../schedule/format.js";
import { TOPIC_LABELS } from "../keyboards.js";
import { logger } from "../../logger.js";

export const sourceHandlers = new Composer<BotContext>();
const adminOnly = sourceHandlers.filter((ctx) => ctx.isAdmin);

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
  lines.push("", "Добавить: <code>/source_add https://t.me/канал</code>, <code>/source_add https://vish.chuvsu.ru/</code>, <code>/source_add https://vk.com/группа</code>");
  lines.push("Telegram и сайт читаются без ключей. Сайт ВИШ сделан на Tilda — бот берёт оттуда ленту новостей с датами и фото.");
  if (!ctx.deps.config.VK_SERVICE_TOKEN) {
    // VK без ключа не отдаёт даже открытые стены, а ключ теперь выдают только
    // через профиль VK Бизнес ID — честнее сказать это сразу, чем «⚠️ ошибка».
    lines.push("VK пока не подключён: нужен <code>VK_SERVICE_TOKEN</code> в .env — сервисный ключ приложения из VK ID (id.vk.ru, раздел «Мои приложения»). Без него источники VK будут падать с ошибкой.");
  }
  kb.text("🔎 Сканировать сейчас", "src:scan");
  return { text: lines.join("\n"), kb };
}

adminOnly.command("sources", async (ctx) => {
  const { text, kb } = sourcesText(ctx);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
});

adminOnly.command("source_add", async (ctx) => {
  const parsed = parseSourceRef(ctx.match ?? "");
  if (!parsed) return void (await ctx.reply("Не понял ссылку. Примеры: https://t.me/vish_chuvsu, https://vk.com/vish_chuvsu, https://vish.chuvsu.ru/news/"));
  const s = ctx.deps.repo.addNewsSource(parsed.kind, parsed.ref, parsed.title);
  await ctx.reply(`Добавил источник #${s.id}: ${esc(s.title ?? s.ref)} (${s.kind}). Проверить: /sources → «Сканировать сейчас».`, { parse_mode: "HTML" });
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
