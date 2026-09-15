import { Cron } from "croner";
import type { ScheduleService } from "../schedule/service.js";
import type { Notifier } from "../notify/dispatcher.js";
import type { Repo } from "../db/repo.js";
import type { NewsScanner } from "../news/scanner.js";
import type { TeacherService } from "../portal/teachers.js";
import type { WebinarService } from "../portal/webinars.js";
import { logger } from "../logger.js";

const TZ = "Europe/Moscow";
const MIN_POLL_GAP_MS = 90_000;

export interface SchedulerHandles {
  stop(): void;
  pollNow(): Promise<void>;
}

export function startScheduler(opts: { service: ScheduleService; notifier: Notifier; repo: Repo; busyCron: string; idleCron: string; newsCron?: string; news?: NewsScanner | null; teachers?: TeacherService | null; webinars?: WebinarService | null }): SchedulerHandles {
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
        const backlog = await opts.notifier.flushQuietBacklog();
        if (backlog) logger.info({ backlog }, "quiet-hours change backlog delivered");
      } catch (err) {
        logger.error({ err }, "reminder tick failed");
      }
    }),
    new Cron("17 4 * * *", { timezone: TZ, name: "housekeeping" }, () => {
      opts.repo.pruneReminders(14);
      opts.repo.pruneWebinars(60);
      logger.info("housekeeping done");
    }),
  ];
  if (opts.webinars) {
    const webinars = opts.webinars;
    // Online lessons (teacher, topic) for today and the next two days; one page per day.
    const refresh = (reason: string) =>
      void webinars
        .refreshUpcoming(2)
        .then((n) => (n ? logger.info({ reason, rows: n }, "webinars refreshed") : undefined))
        .catch((err: unknown) => logger.warn({ err: String(err), reason }, "webinar refresh failed"));
    jobs.push(new Cron("7 * * * *", { timezone: TZ, protect: true, name: "webinars" }, () => refresh("cron")));
    setTimeout(() => refresh("startup"), 12_000).unref();
  }
  if (opts.teachers) {
    const teachers = opts.teachers;
    // The directory is what the teacher search looks at; refresh it daily and once at startup
    // so a failing portal account shows up in the log and in /health, not on a student's first search.
    const refresh = async (reason: string): Promise<void> => {
      try {
        const list = await teachers.directory();
        logger.info({ reason, count: list.length }, "teacher directory ready");
      } catch (err) {
        logger.warn({ err: String(err), reason }, "teacher directory refresh failed");
      }
    };
    jobs.push(new Cron("41 4 * * *", { timezone: TZ, protect: true, name: "teacher-directory" }, () => refresh("cron")));
    setTimeout(() => void refresh("startup"), 20_000).unref();
  }
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
