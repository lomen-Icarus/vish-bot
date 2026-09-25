/**
 * Daily news scan: pull posts from the configured sources, let Claude sort
 * them into the three subscription topics, and deliver the matches.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import type { NewsItem, NewsSource, Repo, User } from "../db/repo.js";
import { fetchSource } from "./fetchers.js";
import { TOPIC_LABELS, TOPICS, type Topic } from "../bot/keyboards.js";
import { esc } from "../schedule/format.js";
import { sleep } from "../time.js";
import { logger } from "../logger.js";
import { isUnreachable } from "../bot/errors.js";

export interface ScanOptions {
  lookbackHours: number;
  maxPerTopic: number;
  vkToken?: string;
  model: string;
}

export interface ScanReport {
  sources: number;
  fetched: number;
  fresh: number;
  classified: Record<string, number>;
  sent: number;
  errors: string[];
  durationMs: number;
}

const Classification = z.object({
  items: z.array(
    z.object({
      id: z.number().describe("id поста из входных данных"),
      topic: z.enum(["contests", "announcements", "events", "none"]),
      title: z.string().describe("Короткий заголовок до 60 символов, по-русски"),
    }),
  ),
});

/** Сколько часов неразложенный пост ждёт повторной классификации. */
const RETRY_HOURS = 72;

const SYSTEM = `Ты сортируешь посты для студентов Высшей инженерной школы (ВИШ) ЧувГУ, Чебоксары.
Категории:
- contests — конкурсы, олимпиады, хакатоны, гранты, стипендии, конференции, стажировки, вакансии и другие возможности для студентов, куда можно подать заявку.
- events — предстоящие события студенческой жизни: праздники, встречи, спортивные и творческие мероприятия, защиты проектов, экскурсии, дни открытых дверей для студентов.
- announcements — срочные организационные объявления, которые влияют на учёбу: дистант, отмены и переносы занятий, дедлайны по документам, справкам, стипендиям, общежитию, сессии.
- none — всё остальное: отчёты о прошедших событиях, поздравления, реклама, общие новости вуза без действия для студента, посты без содержания.
Правила: категория одна на пост. Если событие уже прошло — none. Заголовок короткий, конкретный, без хэштегов и эмодзи.`;

function fresh(items: Array<{ publishedAt: string }>, lookbackHours: number): boolean[] {
  const cutoff = Date.now() - lookbackHours * 3_600_000;
  return items.map((i) => Date.parse(i.publishedAt) >= cutoff);
}

export class NewsScanner {
  private readonly client: Anthropic;
  private running: Promise<ScanReport> | null = null;

  constructor(
    apiKey: string,
    private readonly repo: Repo,
    private readonly api: Api<RawApi>,
    private readonly opts: ScanOptions,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 300_000 });
  }

  scan(): Promise<ScanReport> {
    if (this.running) return this.running;
    this.running = this.doScan().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doScan(): Promise<ScanReport> {
    const started = Date.now();
    const report: ScanReport = { sources: 0, fetched: 0, fresh: 0, classified: {}, sent: 0, errors: [], durationMs: 0 };
    const sources = this.repo.listNewsSources(true);
    report.sources = sources.length;
    // Новые посты этого скана и те, что прошлые сканы не смогли разложить.
    const newItems: Array<{ id: number; source: NewsSource; text: string }> = [];

    for (const source of sources) {
      try {
        const posts = await fetchSource(source.kind, source.ref, { vkToken: this.opts.vkToken });
        report.fetched += posts.length;
        const isFresh = fresh(posts, this.opts.lookbackHours);
        posts.forEach((p, i) => {
          if (!isFresh[i] || !p.text.trim()) return;
          const id = this.repo.insertNewsItem({ sourceId: source.id, externalId: p.externalId, url: p.url, publishedAt: p.publishedAt, text: p.text, photoUrl: p.photoUrl });
          if (id !== null) {
            report.fresh++;
            newItems.push({ id, source, text: p.text });
          }
        });
        this.repo.markSourceScanned(source.id, null);
      } catch (err) {
        const msg = String(err).slice(0, 200);
        report.errors.push(`${source.title ?? source.ref}: ${msg}`);
        this.repo.markSourceScanned(source.id, msg);
        logger.warn({ err: msg, source: source.ref }, "news source failed");
      }
    }

    // Посты, которые прошлый скан сохранил, но не разложил (классификатор упал):
    // даём им ещё шанс, пока они не старше трёх суток.
    const retrySince = new Date(Date.now() - Math.max(this.opts.lookbackHours, RETRY_HOURS) * 3_600_000).toISOString();
    for (const item of this.repo.unclassifiedNewsItems(retrySince)) {
      if (newItems.some((i) => i.id === item.id)) continue;
      const source = this.repo.newsSource(item.sourceId);
      if (!source?.enabled) continue;
      newItems.push({ id: item.id, source, text: item.text });
    }

    if (newItems.length) {
      const verdicts = await this.classify(newItems.map((i) => ({ id: i.id, text: i.text.slice(0, 900) })));
      const perTopic = new Map<Topic, number>();
      for (const v of verdicts) {
        report.classified[v.topic] = (report.classified[v.topic] ?? 0) + 1;
        this.repo.setNewsTopic(v.id, v.topic, v.title);
        if (v.topic === "none") continue;
        if (!TOPICS.includes(v.topic)) continue;
        const used = perTopic.get(v.topic) ?? 0;
        if (used >= this.opts.maxPerTopic) continue;
        perTopic.set(v.topic, used + 1);
        const item = this.repo.newsItem(v.id);
        const source = newItems.find((i) => i.id === v.id)?.source;
        if (!item || !source) continue;
        report.sent += await this.deliver(item, source, v.topic);
      }
    }

    report.durationMs = Date.now() - started;
    logger.info({ ...report }, "news scan finished");
    return report;
  }

  private async classify(items: Array<{ id: number; text: string }>): Promise<Array<{ id: number; topic: Topic | "none"; title: string }>> {
    const out: Array<{ id: number; topic: Topic | "none"; title: string }> = [];
    for (let i = 0; i < items.length; i += 30) {
      const batch = items.slice(i, i + 30);
      const payload = batch.map((b) => `### id=${b.id}\n${b.text}`).join("\n\n");
      try {
        const res = await this.client.messages.parse({
          model: this.opts.model,
          // max_tokens ограничивает и размышление модели, и сам JSON: с запасом,
          // иначе на пачке из 30 постов ответ обрезается и пачка теряется.
          max_tokens: 16000,
          system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
          output_config: { effort: "low", format: zodOutputFormat(Classification) },
          messages: [{ role: "user", content: `Посты за последние сутки:\n\n${payload}\n\nВерни категорию и заголовок для каждого id.` }],
        });
        if (res.stop_reason === "max_tokens") throw new Error("classifier hit max_tokens");
        const parsed = res.parsed_output;
        if (!parsed) throw new Error("classifier returned no JSON");
        const known = new Set(batch.map((b) => b.id));
        // delete, а не has: повтор одного id в ответе модели иначе дважды разослал бы пост.
        for (const v of parsed.items) if (known.delete(v.id)) out.push({ id: v.id, topic: v.topic, title: v.title.slice(0, 80) });
      } catch (err) {
        // Посты пачки остаются неразложенными (topic IS NULL) и попадут в следующий скан.
        logger.error({ err: String(err) }, "news classification failed; batch will be retried on the next scan");
      }
    }
    return out;
  }

  private async deliver(item: NewsItem, source: NewsSource, topic: Topic): Promise<number> {
    const users = this.repo.usersForTopic(topic);
    if (!users.length) return 0;
    const head = `🏷 <b>${TOPIC_LABELS[topic]}</b> · ${esc(source.title ?? source.ref)}`;
    const title = item.title ? `\n<b>${esc(item.title)}</b>` : "";
    const body = esc(item.text.length > 900 ? item.text.slice(0, 890).trimEnd() + "…" : item.text);
    const text = `${head}${title}\n\n${body}`;
    const kb = new InlineKeyboard();
    if (item.url) kb.url("🔗 Открыть", item.url);
    kb.text("👎 Не по теме", `nc:${item.id}`);
    let sent = 0;
    for (const u of users) {
      if (await this.sendOne(u, item, text, kb)) sent++;
      await sleep(40);
    }
    this.repo.bumpNewsSent(item.id, sent);
    return sent;
  }

  private async sendOne(u: User, item: NewsItem, text: string, kb: InlineKeyboard): Promise<boolean> {
    try {
      if (item.photoUrl && text.length <= 1000) {
        try {
          await this.api.sendPhoto(u.id, item.photoUrl, { caption: text, parse_mode: "HTML", reply_markup: kb });
          return true;
        } catch (err) {
          logger.debug({ err: String(err) }, "photo delivery failed, sending text");
        }
      }
      await this.api.sendMessage(u.id, text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: !item.url } });
      return true;
    } catch (err) {
      if (isUnreachable(err)) this.repo.updateUser(u.id, { blocked: true });
      else logger.warn({ err: String(err), userId: u.id }, "news delivery failed");
      return false;
    }
  }
}
