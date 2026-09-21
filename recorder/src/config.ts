/**
 * Настройки «записывалки» вебинаров. Всё берётся из окружения: логины и пароли
 * живут только в .env на сервере записи и никогда не попадают в репозиторий.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function loadDotEnv(file = path.resolve(process.cwd(), ".env")): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const str = (key: string, fallback = ""): string => (process.env[key] ?? fallback).trim();
const num = (key: string, fallback: number): number => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
};
const list = (key: string): string[] =>
  str(key)
    .split(/[;,]/)
    .map((x) => x.trim())
    .filter(Boolean);

export interface RecorderConfig {
  /** Как заходить на вебинар: 0 — слушатель (имя + пароль вебинара), 1 — обучающийся, 2 — сотрудник, 4 — преподаватель. */
  authMode: "0" | "1" | "2" | "4";
  /** Логин/почта для выбранного режима, либо отображаемое имя для режима «слушатель». */
  login: string;
  password: string;
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
  /** Сколько минут максимум сидеть на одном вебинаре. */
  maxMinutes: number;
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

export function loadConfig(): RecorderConfig {
  const authMode = (["0", "1", "2", "4"].includes(str("WEBINAR_AUTH", "1")) ? str("WEBINAR_AUTH", "1") : "1") as RecorderConfig["authMode"];
  const cfg: RecorderConfig = {
    authMode,
    login: str("WEBINAR_LOGIN"),
    password: str("WEBINAR_PASSWORD"),
    displayName: str("WEBINAR_DISPLAY_NAME", "Бот ВИШ (слайды)"),
    facultyId: num("FACULTY_ID", 32),
    subjects: list("RECORD_SUBJECTS"),
    groups: list("RECORD_GROUPS"),
    leadMinutes: num("LEAD_MINUTES", 7),
    pollSeconds: num("POLL_SECONDS", 30),
    captureSeconds: num("CAPTURE_SECONDS", 5),
    maxMinutes: num("MAX_MINUTES", 110),
    botUrl: str("BOT_SLIDES_URL"),
    botToken: str("SLIDES_TOKEN"),
    outDir: str("OUT_DIR", "./data/slides"),
    headless: str("HEADLESS", "1") !== "0",
    chromiumPath: str("CHROMIUM_PATH"),
    logLevel: str("LOG_LEVEL", "info"),
  };
  if (!cfg.login || !cfg.password) throw new Error("WEBINAR_LOGIN и WEBINAR_PASSWORD обязательны: без них портал не отдаст ссылку на комнату");
  return cfg;
}
