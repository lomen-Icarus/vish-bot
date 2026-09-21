/**
 * Главный цикл записи вебинаров.
 *
 * Раз в минуту смотрим, не пора ли готовиться к ближайшей онлайн-паре ВИШ.
 * За несколько минут до начала начинаем опрашивать страницу вебинаров: как
 * только у нужной строки появляется ссылка «Подключиться», просим у портала
 * адрес комнаты, заходим и снимаем слайды до конца пары. Потом собираем PDF и
 * отдаём боту, а он рассылает его тем, у кого эта пара в расписании.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { loadConfig, loadDotEnv, type RecorderConfig } from "./config.js";
import { Portal, parseWebinarRows, type WebinarRow } from "./portal.js";
import { captureWebinar } from "./capture.js";
import { buildPdf, deckFileName, deliver, type DeckMeta } from "./deliver.js";
import { keyOf, mskNow, norm, wanted } from "./plan.js";
import { log } from "./log.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function recordOne(cfg: RecorderConfig, portal: Portal, date: string, row: WebinarRow): Promise<boolean> {
  const meta: DeckMeta = {
    date,
    subject: row.subject,
    teacher: row.teacher,
    groups: row.groups,
    title: row.title,
    startMinutes: row.startMinutes,
    endMinutes: row.endMinutes,
  };
  const join = await portal.getJoinUrl(row, { name: cfg.login, pass: cfg.password, mode: cfg.authMode });
  if (!join.url) {
    log.error({ subject: row.subject, err: join.error }, "портал не дал ссылку на комнату");
    return false;
  }
  log.info({ subject: row.subject, teacher: row.teacher, groups: row.groups }, "захожу на вебинар");
  const dir = path.join(cfg.outDir, `${date}-${norm(row.subject).replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 40)}`);
  // Сидим до конца пары плюс небольшой запас, но не дольше общего предела.
  const now = mskNow();
  const untilEnd = row.endMinutes != null ? row.endMinutes + 5 - now.minutes : cfg.maxMinutes;
  const minutes = Math.max(5, Math.min(cfg.maxMinutes, untilEnd));
  const result = await captureWebinar({
    url: join.url,
    outDir: dir,
    intervalSeconds: cfg.captureSeconds,
    maxMinutes: minutes,
    headless: cfg.headless,
    chromiumPath: cfg.chromiumPath || undefined,
    displayName: cfg.displayName,
  });
  log.info({ slides: result.slides.length, selector: result.usedSelector, notes: result.notes }, "съёмка закончена");
  if (!result.slides.length) return true;
  const pdfPath = path.join(cfg.outDir, deckFileName(meta));
  const pdf = await buildPdf(result.slides.map((s) => s.file), pdfPath, meta);
  await deliver({ url: cfg.botUrl, token: cfg.botToken, pdf, meta, slides: result.slides.length });
  return true;
}

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  mkdirSync(cfg.outDir, { recursive: true });
  const portal = new Portal({ proxyUrl: process.env.HTTPS_PROXY });
  await portal.loginAsGuest();
  log.info({ faculty: cfg.facultyId, subjects: cfg.subjects, groups: cfg.groups, lead: cfg.leadMinutes }, "записывалка вебинаров запущена");

  const done = new Set<string>();
  const attempts = new Map<string, number>();
  let busy = false;
  for (;;) {
    try {
      const now = mskNow();
      // Раз в сутки забываем вчерашнее, чтобы множество не росло.
      for (const k of [...done]) if (!k.startsWith(now.date)) done.delete(k);
      for (const k of [...attempts.keys()]) if (!k.startsWith(now.date)) attempts.delete(k);
      if (!busy) {
        const html = await portal.webinarPage(now.date, cfg.facultyId);
        const rows = parseWebinarRows(html).filter((r) => wanted(r, cfg));
        const soon = rows.filter((r) => r.startMinutes != null && now.minutes >= r.startMinutes - cfg.leadMinutes && (r.endMinutes == null || now.minutes < r.endMinutes) && !done.has(keyOf(now.date, r)));
        const ready = soon.find((r) => r.joinId);
        if (soon.length && !ready) {
          log.debug({ waiting: soon.map((r) => r.subject) }, "пара скоро, но кнопка «Подключиться» ещё не появилась");
        }
        if (ready) {
          const key = keyOf(now.date, ready);
          busy = true;
          void recordOne(cfg, portal, now.date, ready)
            .then((ok) => {
              // Не зашли (портал не дал ссылку) — попробуем ещё пару раз, пока
              // пара идёт: иначе одна осечка теряет всю лекцию.
              const tries = (attempts.get(key) ?? 0) + 1;
              attempts.set(key, tries);
              if (ok || tries >= 3) done.add(key);
            })
            .catch((err: unknown) => {
              log.error({ err: String(err) }, "запись сорвалась");
              const tries = (attempts.get(key) ?? 0) + 1;
              attempts.set(key, tries);
              if (tries >= 3) done.add(key);
            })
            .finally(() => {
              busy = false;
            });
        }
      }
    } catch (err) {
      log.warn({ err: String(err) }, "цикл ожидания споткнулся");
    }
    // Пока идёт запись, страницу дёргать незачем: смотрим реже.
    await sleep(Math.max(10, busy ? 60 : cfg.pollSeconds) * 1000);
  }
}

main().catch((err: unknown) => {
  log.error({ err: String(err) }, "записывалка упала");
  process.exit(1);
});
