/**
 * Главный цикл записи вебинаров.
 *
 * Раз в минуту смотрим, не пора ли готовиться к ближайшей онлайн-паре ВИШ.
 * За несколько минут до начала начинаем опрашивать страницу вебинаров: как
 * только у нужной строки появляется ссылка «Подключиться», просим у портала
 * адрес комнаты, заходим и снимаем слайды до конца пары. Потом собираем PDF и
 * отдаём боту, а он рассылает его тем, у кого эта пара в расписании.
 */
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { loadConfig, loadDotEnv, type RecorderConfig } from "./config.js";
import { Portal, parseWebinarRows, type WebinarRow } from "./portal.js";
import { captureWebinar } from "./capture.js";
import { buildPdf, deckFileName, deliver, retryPending, savePending, type DeckMeta } from "./deliver.js";
import { deckBaseName, keyOf, mskNow, planRecording, type RecordState } from "./plan.js";
import { log } from "./log.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Через сколько повторять неудачную попытку, пока пара идёт. */
const RETRY_MS = 60_000;
/** Как часто пробовать заново отдать боту непринятые пачки. */
const PENDING_EVERY_MS = 5 * 60_000;

/**
 * done — пару можно забыть (записали, или комнату закрыли); retry — не зашли
 * или не сняли ни одного слайда, а пара ещё идёт: попробуем снова.
 */
type Outcome = "done" | "retry";

async function recordOne(cfg: RecorderConfig, portal: Portal, date: string, row: WebinarRow): Promise<Outcome> {
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
    // Часто это «ведущий ещё не открыл комнату»: пара идёт — пробуем снова.
    log.warn({ subject: row.subject, err: join.error }, "портал не дал ссылку на комнату, попробую ещё");
    return "retry";
  }
  log.info({ subject: row.subject, teacher: row.teacher, groups: row.groups }, "захожу на вебинар");
  // Папка кадров своя у каждой пары (дата + время + предмет) и чистая перед
  // съёмкой: иначе вторая пара дня или повтор дописывали бы кадры в чужую пачку.
  const dir = path.join(cfg.outDir, deckBaseName(date, row.startMinutes, row.subject));
  rmSync(dir, { recursive: true, force: true });
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
  // Ни одного слайда: не зашли (лобби, ошибка комнаты) или страница закрылась.
  // Пока пара идёт — зайдём снова; закрытую ведущим комнату не трогаем.
  if (!result.slides.length) return result.ended ? "done" : "retry";
  const pdfPath = path.join(cfg.outDir, deckFileName(meta));
  const pdf = await buildPdf(result.slides.map((s) => s.file), pdfPath, meta);
  if (!(await deliver({ url: cfg.botUrl, token: cfg.botToken, pdf, meta, slides: result.slides.length }))) {
    // Бот перезапускался или сеть моргнула — PDF не теряем, отправим позже.
    savePending(pdfPath, meta, result.slides.length);
  }
  return "done";
}

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  mkdirSync(cfg.outDir, { recursive: true });
  const portal = new Portal({ proxyUrl: process.env.HTTPS_PROXY });
  await portal.loginAsGuest();
  log.info({ faculty: cfg.facultyId, subjects: cfg.subjects, groups: cfg.groups, lead: cfg.leadMinutes }, "записывалка вебинаров запущена");

  const state: RecordState = { done: new Set(), active: new Set(), retryAt: new Map() };
  const skippedLogged = new Set<string>();
  let pendingAt = 0;
  for (;;) {
    try {
      const now = mskNow();
      // Раз в сутки забываем вчерашнее, чтобы множества не росли.
      for (const k of [...state.done]) if (!k.startsWith(now.date)) state.done.delete(k);
      for (const k of [...state.retryAt.keys()]) if (!k.startsWith(now.date)) state.retryAt.delete(k);
      for (const k of [...skippedLogged]) if (!k.startsWith(now.date)) skippedLogged.delete(k);
      if (Date.now() - pendingAt > PENDING_EVERY_MS) {
        pendingAt = Date.now();
        const resent = await retryPending(cfg.outDir, cfg.botUrl, cfg.botToken);
        if (resent) log.info({ resent }, "непринятые пачки слайдов отданы боту");
      }
      const html = await portal.webinarPage(now.date, cfg.facultyId);
      const plan = planRecording(parseWebinarRows(html), now, cfg, state, Date.now());
      if (plan.waiting.length) log.debug({ waiting: plan.waiting.map((r) => r.subject) }, "пара скоро, но кнопки «Подключиться» ещё нет или ждём повтора");
      for (const r of plan.skipped) {
        const key = keyOf(now.date, r);
        if (skippedLogged.has(key)) continue;
        skippedLogged.add(key);
        log.warn({ subject: r.subject, groups: r.groups, maxParallel: cfg.maxParallel }, "пара ждёт: все места для одновременной записи заняты (MAX_PARALLEL), начну, как освободится");
      }
      for (const row of plan.start) {
        const key = keyOf(now.date, row);
        state.active.add(key);
        void recordOne(cfg, portal, now.date, row)
          .then((outcome) => {
            if (outcome === "done") state.done.add(key);
            else state.retryAt.set(key, Date.now() + RETRY_MS);
          })
          .catch((err: unknown) => {
            log.error({ err: String(err), subject: row.subject }, "запись сорвалась, попробую ещё, пока идёт пара");
            state.retryAt.set(key, Date.now() + RETRY_MS);
          })
          .finally(() => {
            state.active.delete(key);
          });
      }
    } catch (err) {
      log.warn({ err: String(err) }, "цикл ожидания споткнулся");
    }
    // Все места заняты — страницу дёргать часто незачем.
    await sleep(Math.max(10, state.active.size >= cfg.maxParallel ? 60 : cfg.pollSeconds) * 1000);
  }
}

main().catch((err: unknown) => {
  log.error({ err: String(err) }, "записывалка упала");
  process.exit(1);
});
