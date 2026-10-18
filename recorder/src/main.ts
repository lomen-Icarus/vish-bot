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
import { totalmem } from "node:os";
import { dirname } from "node:path";
import path from "node:path";
import { loadConfig, loadDotEnv, type RecorderConfig } from "./config.js";
import { joinWithProfiles, Portal, parseWebinarRows, type WebinarRow } from "./portal.js";
import { captureWebinar } from "./capture.js";
import { buildPdf, deckFileName, deliverDeck, earlierSlides, retryPending, type DeckMeta } from "./deliver.js";
import { deckBaseName, keyOf, mskNow, planRecording, profileSummary, type RecordState } from "./plan.js";
import { AccountStore, CHECK_EVERY_MS } from "./accounts.js";
import { loadOrCreateKeys } from "./crypto.js";
import { lkAlive, checkStudentLogin } from "./lk.js";
import { runLiveness, type LiveTarget } from "./liveness.js";
import { syncOnce } from "./sync.js";
import { GeneralWatch } from "./general.js";
import { log } from "./log.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Через сколько повторять неудачную попытку, пока пара идёт. */
const RETRY_MS = 60_000;
/** Как часто пробовать заново отдать боту непринятые пачки. */
const PENDING_EVERY_MS = 5 * 60_000;
/** Как часто спрашивать у бота заявки на запись. */
const SYNC_EVERY_MS = 60_000;

/**
 * done — пару можно забыть (записали, или комнату закрыли); retry — не зашли
 * или не сняли ни одного слайда, а пара ещё идёт: попробуем снова.
 */
type Outcome = "done" | "retry";

const botUrls = (cfg: Pick<RecorderConfig, "botUrl" | "botFallbackUrl">): string[] => [cfg.botUrl, cfg.botFallbackUrl].filter(Boolean);

/**
 * Какую комнату потока пробовать на этом повторе (ключ — пара). Пока ведущий
 * не открыл вебинар, каждая попытка — одна комната, по кругу: перебор всех
 * комнат под всеми учётками каждую минуту умножал входы под учётками студентов
 * в разы. Открылась — номер остаётся: после сбоя съёмки начнём с неё же.
 */
const roomTurn = new Map<string, number>();

/**
 * Ошибка для лога без путей: в тексте ошибки файла — путь к папке пары, а в
 * нём фамилия преподавателя, хвост же лога печатается в публичный лог деплоя.
 */
const errName = (err: unknown): string => {
  const e = err as NodeJS.ErrnoException;
  const text = String(e?.message ?? err).replace(/(['"]?)\/[^'"\s]*\1/g, "<путь>").slice(0, 200);
  return `${e?.code ?? e?.name ?? "Error"}: ${text}`;
};

async function recordOne(cfg: RecorderConfig, store: AccountStore, general: GeneralWatch | null, portal: Portal, date: string, row: WebinarRow): Promise<Outcome> {
  const meta: DeckMeta = {
    date,
    subject: row.subject,
    teacher: row.teacher,
    groups: row.groups,
    title: row.title,
    startMinutes: row.startMinutes,
    endMinutes: row.endMinutes,
  };
  // Профиль для групп этой пары — первым; не пустили — общий. Не пустила
  // комната потока — на следующем повторе следующая (roomTurn).
  const profiles = [...cfg.profiles, ...store.profiles()];
  // Какая учётка стояла в слоте, когда снимали профили: заход под ней не
  // должен отметить «пустило» учётку, которую успели поставить вместо неё.
  const installedAt = new Map(store.list().map((s) => [s.group, s.installedAt]));
  const rooms = [row, ...(row.alts ?? [])];
  const key = keyOf(date, row);
  const turn = roomTurn.get(key) ?? 0;
  const join = await joinWithProfiles(portal, rooms[turn % rooms.length]!, profiles);
  if (!join.url) {
    roomTurn.set(key, turn + 1);
    // Часто это «ведущий ещё не открыл комнату»: пара идёт — пробуем снова.
    log.warn({ subject: row.subject, groups: row.groups, err: join.errors }, "портал не дал ссылку на комнату, попробую ещё");
    return "retry";
  }
  // Без имени преподавателя: хвост лога попадает в публичный лог деплоя (Actions).
  log.info({ subject: row.subject, groups: row.groups, profile: join.profile }, "захожу на вебинар");
  // Заход под учёткой студента — уже проверка «аккаунт жив»: отодвигаем плановую.
  if (join.profile?.startsWith("slot:")) {
    const group = join.profile.slice(5);
    store.update(group, { status: "ok", failures: 0, lastOkAt: new Date().toISOString(), nextCheckAt: Date.now() + CHECK_EVERY_MS }, installedAt.get(group));
  }
  if (join.profile === "1") general?.noteJoin();
  // Папка кадров своя у каждой пары (дата + время + предмет). Если съёмку
  // этой пары прервали (перезапуск, повторный заход), снятое до этого
  // остаётся и съёмка продолжается с того же номера; уже собранную пачку
  // заново не начинаем — см. earlierSlides.
  const dir = path.join(cfg.outDir, deckBaseName(date, row.startMinutes, row.subject, row.teacher));
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
  await deliverDeck({ urls: botUrls(cfg), token: cfg.botToken, pdfPath, pdf, meta, slides: files.length });
  return "done";
}

/** Проверить слоты, которым пора; о «доступ потерян» сообщить боту (он уведомит владельца). */
async function checkSlotLiveness(store: AccountStore, general: GeneralWatch | null, proxyUrl?: string): Promise<void> {
  const targets: LiveTarget[] = store
    .list()
    .filter((s) => s.status === "ok")
    .map((s) => ({
      key: `slot:${s.group}`,
      login: s.login,
      password: s.password,
      state: { status: s.status, failures: s.failures, lastOkAt: s.lastOkAt, nextCheckAt: s.nextCheckAt },
      // Итог — только в тот же слот: заменили его за время проверки — не трогаем новый.
      save: (patch) => store.update(s.group, patch, s.installedAt),
      fresh: () => {
        const c = store.get(s.group);
        return c && c.installedAt === s.installedAt ? { status: c.status, failures: c.failures, lastOkAt: c.lastOkAt, nextCheckAt: c.nextCheckAt } : null;
      },
    }));
  // Общая учётка — тем же порядком (на пары она пробуется и «потерянной», см. general.ts).
  if (general) targets.push(general.target());
  if (!targets.length) return;
  const res = await runLiveness(targets, { check: (l, p) => checkStudentLogin(l, p, { proxyUrl }), alive: () => lkAlive({ proxyUrl }) });
  for (const t of res.transitions) log.warn({ slot: t.key }, "учётка слота перестала пускать — доступ потерян");
}

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  mkdirSync(cfg.outDir, { recursive: true });
  const portal = new Portal({ proxyUrl: process.env.HTTPS_PROXY });
  await portal.loginAsGuest();
  // Слоты студентов и ключ шифрования — рядом со слайдами, в data/.
  const dataDir = dirname(cfg.outDir);
  const keys = loadOrCreateKeys(`${dataDir}/keys`);
  const store = AccountStore.inDir(dataDir);
  // Общая учётка (профиль 1) — под присмотром «жива ли», видна в /slots.
  const general = GeneralWatch.forProfile(dataDir, cfg.profiles[0]!);
  log.info({ keys: `${dataDir}/keys/accounts.key`, accounts: `${dataDir}/accounts.json`, slots: store.list().length }, "слоты студентов и ключ шифрования");
  // Профили — только номер и группы: логины и пароли в лог не попадают.
  // Каждая запись — свой Chromium, ~0,5–1 ГБ: честно предупреждаем, если места на столько не хватит.
  const needMb = cfg.maxParallel * 700;
  const haveMb = Math.round(totalmem() / 1024 / 1024);
  if (needMb > haveMb) log.warn({ maxParallel: cfg.maxParallel, needMb, haveMb }, "MAX_PARALLEL больше, чем потянет память: при стольких парах сразу браузеры будут падать");
  log.info({ faculty: cfg.facultyId, subjects: cfg.subjects, skip: cfg.skipSubjects, groups: cfg.groups, maxParallel: cfg.maxParallel, lead: cfg.leadMinutes, profiles: profileSummary([...cfg.profiles, ...store.profiles()]) }, "записывалка вебинаров запущена");
  for (const w of cfg.warnings) log.warn(w);

  const state: RecordState = { done: new Set(), active: new Set(), retryAt: new Map() };
  const skippedLogged = new Set<string>();
  let pendingAt = 0;
  let syncAt = 0;
  let syncing = false;
  let checking = false;
  for (;;) {
    try {
      const now = mskNow();
      // Раз в сутки забываем вчерашнее, чтобы множества не росли.
      for (const k of [...state.done]) if (!k.startsWith(now.date)) state.done.delete(k);
      for (const k of [...state.retryAt.keys()]) if (!k.startsWith(now.date)) state.retryAt.delete(k);
      for (const k of [...skippedLogged]) if (!k.startsWith(now.date)) skippedLogged.delete(k);
      if (Date.now() - pendingAt > PENDING_EVERY_MS) {
        pendingAt = Date.now();
        const resent = await retryPending(cfg.outDir, botUrls(cfg), cfg.botToken);
        if (resent) log.info({ resent }, "непринятые пачки слайдов отданы боту");
      }
      // Заявки на запись и проверка «аккаунт жив» — параллельно записи, не мешая
      // ей; каждая со своим «уже идёт», чтобы долгий проход не наложился на новый.
      if (Date.now() - syncAt > SYNC_EVERY_MS && !syncing) {
        syncAt = Date.now();
        syncing = true;
        void syncOnce({ botUrls: botUrls(cfg), token: cfg.botToken, store, privatePem: keys.privatePem, publicSpki: keys.publicSpki, proxyUrl: process.env.HTTPS_PROXY, groupName: (id) => portal.groupName(id), general })
          .catch((err: unknown) => log.debug({ err: String(err).slice(0, 150) }, "обмен заявками споткнулся"))
          .finally(() => (syncing = false));
      }
      if (!checking) {
        checking = true;
        void checkSlotLiveness(store, general, process.env.HTTPS_PROXY)
          .catch((err: unknown) => log.debug({ err: String(err).slice(0, 150) }, "проверка аккаунтов споткнулась"))
          .finally(() => (checking = false));
      }
      const html = await portal.webinarPage(now.date, cfg.facultyId);
      const plan = planRecording(parseWebinarRows(html), now, { ...cfg, profiles: [...cfg.profiles, ...store.profiles()] }, state, Date.now());
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
        void recordOne(cfg, store, general, portal, now.date, row)
          .then((outcome) => {
            if (outcome === "done") {
              state.done.add(key);
              roomTurn.delete(key);
            }
            else state.retryAt.set(key, Date.now() + RETRY_MS);
          })
          .catch((err: unknown) => {
            log.error({ err: errName(err), subject: row.subject }, "запись сорвалась, попробую ещё, пока идёт пара");
            state.retryAt.set(key, Date.now() + RETRY_MS);
          })
          .finally(() => {
            state.active.delete(key);
          });
      }
    } catch (err) {
      log.warn({ err: errName(err) }, "цикл ожидания споткнулся");
    }
    // Все места заняты — страницу дёргать часто незачем.
    await sleep(Math.max(10, state.active.size >= cfg.maxParallel ? 60 : cfg.pollSeconds) * 1000);
  }
}

main().catch((err: unknown) => {
  log.error({ err: errName(err) }, "записывалка упала");
  process.exit(1);
});
