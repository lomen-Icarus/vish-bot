/**
 * Мост в мессенджер МАКС: тот же бот, те же обработчики и та же база — люди из
 * МАКС для бота выглядят как люди в Telegram с особыми id (см. store.ts).
 * Входящие события МАКС переводятся в обновления Telegram (updates.ts), ответы
 * бота уходят в МАКС через транспорт grammY (outgoing.ts). Включается
 * переменной MAX_BOT_TOKEN; без неё ничего этого нет.
 *
 * События пока забираются long polling: МАКС советует его только для
 * разработки (скорость и срок хранения событий ограничены), для работы —
 * вебхук по HTTPS с доверенным сертификатом. Это следующий шаг.
 */
import type { Bot, Middleware, Transformer } from "grammy";
import type { BotContext } from "../bot/context.js";
import type { Repo, User } from "../db/repo.js";
import { logger } from "../logger.js";
import { sleep } from "../time.js";
import { MaxApi, MaxApiError, type MaxApiOptions, type MaxBotInfo, type MaxUpdate } from "./api.js";
import { entitiesToHtml } from "./format.js";
import { maxTransformer } from "./outgoing.js";
import { MAX_UID_BASE, MaxMessageStore, TgSnapshotStore } from "./store.js";
import { stoppedUid, toTelegramUpdate } from "./updates.js";

/** Где МАКС хранит, с какого события продолжать после перезапуска. */
export const MAX_MARKER_KEY = "max:marker";
const UPDATE_TYPES = ["message_created", "message_callback", "bot_started", "bot_stopped"];

/** Команды в меню «/» у поля ввода МАКС — запасной путь, основное — кнопки под сообщениями. */
const MAX_COMMANDS = [
  { name: "today", description: "Пары на сегодня" },
  { name: "tomorrow", description: "Пары на завтра" },
  { name: "week", description: "Расписание на неделю" },
  { name: "changes", description: "Последние изменения" },
  { name: "group", description: "Выбрать группу" },
  { name: "settings", description: "Уведомления и напоминания" },
  { name: "help", description: "Что умеет бот" },
  { name: "support", description: "Написать админу" },
];

export interface MaxBridgeOptions {
  token: string;
  proxyUrl?: string;
  repo: Repo;
  /** Токен Telegram: файлы, известные боту только по file_id, скачиваются у Telegram. */
  botToken: string;
  /** Чаты-источники новостей (их посты копируются подписчикам). */
  newsChatIds: number[];
  /** Нижнее меню человека — под сообщением без своих кнопок. */
  menuFor: (user: User) => unknown;
  /** Для тестов: подменить сеть МАКС. */
  fetch?: MaxApiOptions["fetch"];
}

export class MaxBridge {
  readonly api: MaxApi;
  readonly messages = new MaxMessageStore();
  readonly snapshots = new TgSnapshotStore();
  private info: MaxBotInfo | null = null;
  private tgUsername: string | null = null;
  private readonly abort = new AbortController();
  private readonly chains = new Map<number, Promise<void>>();
  private updateId = 0;

  constructor(private readonly opts: MaxBridgeOptions) {
    this.api = new MaxApi({ token: opts.token, proxyUrl: opts.proxyUrl, fetch: opts.fetch });
  }

  uid(maxId: number): number {
    return this.opts.repo.maxUid(maxId, MAX_UID_BASE);
  }

  /** Транспорт grammY: ставится первым, чтобы autoRetry повторял и вызовы МАКС. */
  transformer(): Transformer {
    return maxTransformer({
      api: this.api,
      messages: this.messages,
      snapshots: this.snapshots,
      maxIdOf: (uid) => this.opts.repo.maxIdOf(uid),
      menuFor: (uid) => {
        const user = this.opts.repo.getUser(uid);
        return user ? this.opts.menuFor(user) : null;
      },
      tgUsername: () => this.tgUsername,
      maxUsername: () => this.info?.username ?? null,
      botToken: this.opts.botToken,
    });
  }

  /**
   * Снимки сообщений Telegram, которые бот потом копирует людям (рассылка
   * админа, ответ поддержки, новость из канала): в МАКС их не переслать, мост
   * пересоздаёт их по тексту и картинке. Берём только эти чаты.
   */
  snapshotMiddleware(): Middleware<BotContext> {
    return async (ctx, next) => {
      const msg = ctx.msg;
      const chatId = ctx.chat?.id;
      if (msg && chatId != null && ((ctx.chat?.type === "private" && ctx.isAdmin) || this.opts.newsChatIds.includes(chatId))) {
        const text = msg.text ?? msg.caption;
        const photo = msg.photo?.[msg.photo.length - 1]?.file_id;
        const doc = msg.document;
        if (text || photo || doc) {
          this.snapshots.put(chatId, msg.message_id, {
            html: text ? entitiesToHtml(text, msg.entities ?? msg.caption_entities) : null,
            ...(photo ? { photoFileId: photo } : {}),
            ...(doc ? { documentFileId: doc.file_id, ...(doc.file_name ? { documentName: doc.file_name } : {}) } : {}),
          });
        }
      }
      await next();
    };
  }

  /** Проверить токен, выставить команды и начать забирать события. */
  async start(bot: Bot<BotContext>): Promise<void> {
    this.info = await this.api.me();
    this.tgUsername = bot.botInfo.username ?? null;
    logger.info({ botId: this.info.user_id, username: this.info.username ?? null }, "MAX bot authorised");
    await this.api.setCommands(MAX_COMMANDS).catch((err: unknown) => logger.warn({ err: err instanceof MaxApiError ? `${err.status} ${err.code}` : String(err).slice(0, 120) }, "MAX commands not set"));
    void this.loop(bot);
  }

  stop(): void {
    this.abort.abort();
  }

  /** Событие из МАКС — сразу в бота (тесты и, позже, вебхук). */
  async handle(bot: Bot<BotContext>, u: MaxUpdate): Promise<void> {
    this.dispatch(bot, u);
    await Promise.all([...this.chains.values()]);
  }

  private async loop(bot: Bot<BotContext>): Promise<void> {
    const saved = this.opts.repo.getMeta(MAX_MARKER_KEY);
    let marker: number | null = saved ? Number(saved) : null;
    let delay = 5_000;
    logger.info({ resume: marker != null }, "polling MAX for updates");
    while (!this.abort.signal.aborted) {
      try {
        const res = await this.api.updates({ marker, types: UPDATE_TYPES });
        delay = 5_000;
        for (const u of res.updates ?? []) this.dispatch(bot, u);
        if (res.marker != null && res.marker !== marker) {
          marker = res.marker;
          this.opts.repo.setMeta(MAX_MARKER_KEY, String(marker));
        }
      } catch (err) {
        if (this.abort.signal.aborted) return;
        if (err instanceof MaxApiError && err.status === 401) {
          logger.error("MAX_BOT_TOKEN не подходит (401): мост в МАКС остановлен");
          return;
        }
        logger.warn({ err: err instanceof MaxApiError ? `${err.status} ${err.code}` : String(err).slice(0, 120), retryInMs: delay }, "MAX polling failed");
        await sleep(delay);
        delay = Math.min(delay * 2, 60_000);
      }
    }
  }

  /** Одно событие. События одного человека — по очереди, разных людей — параллельно. */
  private dispatch(bot: Bot<BotContext>, u: MaxUpdate): void {
    let update: ReturnType<typeof toTelegramUpdate>;
    try {
      const uid = stoppedUid(u, (id) => this.uid(id));
      if (uid != null) {
        // Остановил бота — как «заблокировал» в Telegram: рассылки его пропускают, /start снимет пометку.
        if (this.opts.repo.getUser(uid)) this.opts.repo.updateUser(uid, { blocked: true });
        return;
      }
      update = toTelegramUpdate(u, ++this.updateId, { uid: (id) => this.uid(id), messages: this.messages, bot: bot.botInfo });
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 200), type: u.update_type }, "MAX update not understood");
      return;
    }
    if (!update) return;
    const chatUid = update.message?.chat.id ?? update.callback_query?.from.id ?? 0;
    const prev = this.chains.get(chatUid) ?? Promise.resolve();
    const next = prev
      .then(() => bot.handleUpdate(update))
      .catch((err: unknown) => logger.warn({ err: String(err).slice(0, 200) }, "MAX update failed"))
      .finally(() => {
        if (this.chains.get(chatUid) === next) this.chains.delete(chatUid);
      });
    this.chains.set(chatUid, next);
  }
}
