/**
 * Настройки «записывалки» вебинаров. Всё берётся из окружения: логины и пароли
 * живут только в .env на сервере записи и никогда не попадают в репозиторий.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * .env: повтор ключа — действует последняя строка, но пустая заполненную не
 * перебивает (пустое «SLIDES_TOKEN=» из образца сверху иначе прятало
 * настоящее значение, дописанное в конец). Окружение главнее, если не пустое.
 */
export function parseDotEnv(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (value !== "" || !out.get(key)) out.set(key, value);
  }
  return out;
}

export function loadDotEnv(file = path.resolve(process.cwd(), ".env")): void {
  if (!existsSync(file)) return;
  for (const [key, value] of parseDotEnv(readFileSync(file, "utf8"))) {
    if (process.env[key] === undefined || (process.env[key] === "" && value !== "")) process.env[key] = value;
  }
}

const str = (key: string, fallback = ""): string => (process.env[key] ?? fallback).trim();
/**
 * Число из окружения. Пустое значение («KEY=» в .env) — это «не задано», а не
 * ноль: Number("") даёт 0, и CAPTURE_SECONDS= превращался в съёмку без пауз.
 */
export function envNumber(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
const num = (key: string, fallback: number): number => envNumber(process.env[key], fallback);
const list = (key: string): string[] =>
  str(key)
    .split(/[;,]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** Учётка портала, которой бот заходит в комнату. */
export interface WebinarProfile {
  /** «1», «2», … — номер из имени переменных; в логах только он, без логина. */
  name: string;
  authMode: AuthMode;
  /** Логин/почта для выбранного режима, либо отображаемое имя для режима «слушатель». */
  login: string;
  password: string;
  /** Для каких групп этот профиль (пусто — общий, для любых групп). */
  groups: string[];
}

/** Номер последнего профиля: читаем WEBINAR_LOGIN_2 … WEBINAR_LOGIN_9. */
const MAX_PROFILE = 9;

/** Как заходить на вебинар: 0 — слушатель (имя + пароль вебинара), 1 — обучающийся, 2 — сотрудник, 4 — преподаватель. */
export type AuthMode = "0" | "1" | "2" | "4";

export interface RecorderConfig {
  /**
   * Все профили по порядку: первый — WEBINAR_LOGIN/WEBINAR_PASSWORD, дальше
   * WEBINAR_LOGIN_2/WEBINAR_PASSWORD_2 и т. д. Вебинар одних групп бывает
   * доступен только студенту этих групп — для них и заводят второй профиль.
   */
  profiles: WebinarProfile[];
  /** Настройки, которые выглядят как ошибка, но запуску не мешают: их пишем в лог. */
  warnings: string[];
  /** Имя, под которым бот виден в списке участников (режимы с учёткой берут имя из неё). */
  displayName: string;
  facultyId: number;
  /** Записывать только эти предметы (пусто — все пары ВИШ). */
  subjects: string[];
  /** Записывать только эти группы (пусто — все). */
  groups: string[];
  /** За сколько минут до начала начинать искать комнату. */
  leadMinutes: number;
  /** Как часто опрашивать страницу вебинаров, пока ищем комнату (секунды). */
  pollSeconds: number;
  /** Как часто снимать слайд (секунды). */
  captureSeconds: number;
  /** На сколько пикселей расширять кадр вверх и вниз от области презентации. */
  capturePad: number;
  /** Сколько минут максимум сидеть на одном вебинаре. */
  maxMinutes: number;
  /**
   * Сколько вебинаров записывать одновременно. Каждая запись — отдельный
   * Chromium со своей памятью. По умолчанию 1: у ВИШ онлайн-пар одновременно
   * не бывает больше одной (поток на 5–7 групп — это одна пара).
   */
  maxParallel: number;
  /** Куда отдавать готовую пачку слайдов: <PUBLIC_URL бота>/slides */
  botUrl: string;
  botToken: string;
  /** Куда складывать PDF и кадры. */
  outDir: string;
  headless: boolean;
  /** Путь к Chromium, если он не там, где ожидает playwright. */
  chromiumPath: string;
  logLevel: string;
}

const authOf = (raw: string): AuthMode => (["0", "1", "2", "4"].includes(raw) ? (raw as AuthMode) : "1");

export function loadConfig(): RecorderConfig {
  const login = str("WEBINAR_LOGIN");
  const password = str("WEBINAR_PASSWORD");
  if (!login || !password) throw new Error("WEBINAR_LOGIN и WEBINAR_PASSWORD обязательны: без них портал не отдаст ссылку на комнату");
  const profiles: WebinarProfile[] = [{ name: "1", authMode: authOf(str("WEBINAR_AUTH", "1")), login, password, groups: list("WEBINAR_GROUPS") }];
  const warnings: string[] = [];
  for (let n = 2; n <= MAX_PROFILE; n++) {
    const l = str(`WEBINAR_LOGIN_${n}`);
    const p = str(`WEBINAR_PASSWORD_${n}`);
    if (!l && !p) {
      if (list(`WEBINAR_GROUPS_${n}`).length) warnings.push(`WEBINAR_GROUPS_${n} задан, а WEBINAR_LOGIN_${n}/WEBINAR_PASSWORD_${n} — нет: профиль ${n} не используется`);
      continue;
    }
    if (!l || !p) throw new Error(`Профиль ${n}: нужны оба — WEBINAR_LOGIN_${n} и WEBINAR_PASSWORD_${n}`);
    // Дополнительный профиль — это студент нужных групп: по умолчанию режим
    // «обучающийся», а не режим первого профиля (тот бывает сотрудником).
    profiles.push({ name: String(n), authMode: authOf(str(`WEBINAR_AUTH_${n}`, "1")), login: l, password: p, groups: list(`WEBINAR_GROUPS_${n}`) });
  }
  const cfg: RecorderConfig = {
    profiles,
    warnings,
    displayName: str("WEBINAR_DISPLAY_NAME", "Бот ВИШ (слайды)"),
    facultyId: num("FACULTY_ID", 32),
    subjects: list("RECORD_SUBJECTS"),
    groups: list("RECORD_GROUPS"),
    leadMinutes: num("LEAD_MINUTES", 7),
    pollSeconds: num("POLL_SECONDS", 30),
    captureSeconds: Math.max(1, num("CAPTURE_SECONDS", 5)),
    capturePad: Math.max(0, num("CAPTURE_PAD", 40)),
    maxMinutes: Math.max(5, num("MAX_MINUTES", 110)),
    maxParallel: Math.max(1, Math.floor(num("MAX_PARALLEL", 1))),
    botUrl: str("BOT_SLIDES_URL"),
    botToken: str("SLIDES_TOKEN"),
    outDir: str("OUT_DIR", "./data/slides"),
    headless: str("HEADLESS", "1") !== "0",
    chromiumPath: str("CHROMIUM_PATH"),
    logLevel: str("LOG_LEVEL", "info"),
  };
  return cfg;
}
