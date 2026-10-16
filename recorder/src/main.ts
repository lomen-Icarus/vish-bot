/**
 * Главный цикл записи вебинаров.
 *
 * Раз в минуту смотрим, не пора ли готовиться к ближайшей онлайн-паре ВИШ.
 * За несколько минут до начала начинаем опрашивать страницу вебинаров: как
 * только у нужной строки появляется ссылка «Подключиться», просим у портала
 * адрес комнаты, заходим и снимаем слайды до конца пары. Потом собираем PDF и
 * отдаём боту, а он рассылает его тем, у кого эта пара в расписании.
 */
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig, loadDotEnv, type RecorderConfig } from "./config.js";
import { joinWithProfiles, Portal, parseWebinarRows, type WebinarRow } from "./portal.js";
import { captureWebinar } from "./capture.js";
import { buildPdf, deckFileName, deliverDeck, earlierSlides, retryPending, type DeckMeta } from "./deliver.js";
import { deckBaseName, keyOf, mskNow, planRecording, profileSummary, type RecordState } from "./plan.js";
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
  // Профиль для групп этой пары — первым; не пустили — общий.
  const join = await joinWithProfiles(portal, row, cfg.profiles);
  if (!join.url) {
    // Часто это «ведущий ещё не открыл комнату»: пара идёт — пробуем снова.
    log.warn({ subject: row.subject, groups: row.groups, err: join.errors }, "портал не дал ссылку на комнату, попробую ещё");
    return "retry";
  }
  log.info({ subject: row.subject, teacher: row.teacher, groups: row.groups, profile: join.profile }, "захожу на вебинар");
  // Папка кадров своя у каждой пары (дата + время + предмет). Если съёмку
  // этой пары прервали (перезапуск, повторный заход), снятое до этого
  // остаётся и съёмка продолжается с того же номера; уже собранную пачку
  // заново не начинаем — см. earlierSlides.
  const dir = path.join(cfg.outDir, deckBaseName(date, row.startMinutes, row.subject));
  const pdfPath = path.join(cfg.outDir, deckFileName(meta));
  const earlier = earlierSlides(dir, pdfPath);
  if (earlier.length) log.info({ slides: earlier.length }, "продолжаю прерванную съёмку этой пары: снятое раньше остаётся");
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
    padPx: cfg.capturePad,
    startIndex: earlier.length ? Number(path.basename(earlier[earlier.length - 1]!).match(/\d+/)![0]) : 0,
    lastFrame: earlier.length ? readFileSync(earlier[earlier.length - 1]!) : undefined,
  });
  log.info({ slides: result.slides.length, selector: result.usedSelector, notes: result.notes }, "съёмка закончена");
  // Ни одного нового слайда: не зашли (лобби, ошибка комнаты) или страница
  // закрылась. Пока пара идёт — зайдём снова; закрытую ведущим комнату не
  // трогаем. Но если снятое раньше есть, а пара кончилась (или комнату
  // закрыли) — собираем пачку из него, иначе оно так и не дошло бы до бота.
  const files = [...earlier, ...result.slides.map((s) => s.file)];
  const over = row.endMinutes != null && mskNow().minutes >= row.endMinutes;
  if (!result.slides.length && !(earlier.length && (result.ended || over))) return result.ended ? "done" : "retry";
  const pdf = await buildPdf(files, pdfPath, meta);
  // Бот перезапускался или сеть моргнула — непринятое остаётся в очереди, отправим позже.
  await deliverDeck({ url: cfg.botUrl, token: cfg.botToken, pdfPath, pdf, meta, slides: files.length });
  return "done";
}

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  mkdirSync(cfg.outDir, { recursive: true });
  const portal = new Portal({ proxyUrl: process.env.HTTPS_PROXY });
  await portal.loginAsGuest();
  // Профили — только номер и группы: логины и пароли в лог не попадают.
  log.info({ faculty: cfg.facultyId, subjects: cfg.subjects, skip: cfg.skipSubjects, groups: cfg.groups, maxParallel: cfg.maxParallel, lead: cfg.leadMinutes, profiles: profileSummary(cfg.profiles) }, "записывалка вебинаров запущена");
  for (const w of cfg.warnings) log.warn(w);

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
