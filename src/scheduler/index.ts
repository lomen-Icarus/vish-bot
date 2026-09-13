import { Cron } from "croner";
import type { ScheduleService } from "../schedule/service.js";
import type { Notifier } from "../notify/dispatcher.js";
import type { Repo } from "../db/repo.js";
import type { NewsScanner } from "../news/scanner.js";
import { logger } from "../logger.js";

const TZ = "Europe/Moscow";
const MIN_POLL_GAP_MS = 90_000;

export interface SchedulerHandles {
  stop(): void;
  pollNow(): Promise<void>;
}

export function startScheduler(opts: { service: ScheduleService; notifier: Notifier; repo: Repo; busyCron: string; idleCron: string; newsCron?: string; news?: NewsScanner | null }): SchedulerHandles {
  let lastPollAt = 0;
  let pollInFlight: Promise<void> | null = null;

  const runPoll = async (reason: string): Promise<void> => {
    if (pollInFlight) return pollInFlight;
    if (Date.now() - lastPollAt < MIN_POLL_GAP_MS) return;
    pollInFlight = (async () => {
      try {
        const r = await opts.service.poll();
        lastPollAt = Date.now();
        const delivered = await opts.notifier.dispatchChangeEvents();
        if (r.events.length || delivered) logger.info({ reason, events: r.events.length, delivered }, "change notifications dispatched");
      } catch (err) {
        logger.error({ err, reason }, "poll failed");
      } finally {
        pollInFlight = null;
      }
    })();
    return pollInFlight;
  };

  const jobs: Cron[] = [
    new Cron(opts.busyCron, { timezone: TZ, protect: true, name: "poll-busy" }, () => runPoll("busy")),
    new Cron(opts.idleCron, { timezone: TZ, protect: true, name: "poll-idle" }, () => runPoll("idle")),
    new Cron("* * * * *", { timezone: TZ, protect: true, name: "reminders" }, async () => {
      try {
        const sent = await opts.notifier.tickReminders();
        if (sent) logger.info({ sent }, "reminders sent");
      } catch (err) {
        logger.error({ err }, "reminder tick failed");
      }
    }),
    new Cron("17 4 * * *", { timezone: TZ, name: "housekeeping" }, () => {
      opts.repo.pruneReminders(14);
      logger.info("housekeeping done");
    }),
  ];
  if (opts.news && opts.newsCron) {
    const news = opts.news;
    jobs.push(
      new Cron(opts.newsCron, { timezone: TZ, protect: true, name: "news-scan" }, async () => {
        try {
          await news.scan();
        } catch (err) {
          logger.error({ err }, "news scan failed");
        }
      }),
    );
  }
  logger.info({ busy: opts.busyCron, idle: opts.idleCron }, "scheduler started");

  return {
    stop: () => jobs.forEach((j) => j.stop()),
    pollNow: () => runPoll("startup"),
  };
}
