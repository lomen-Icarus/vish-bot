/**
 * Общая учётка (профиль 1 из .env) под тем же присмотром, что и слоты: раз в
 * 6 часов «жива ли» (заход на пару тоже считается), состояние уходит боту в
 * отчёте отдельной строкой — в /slots она видна сверху, о потере доступа
 * приходит весть. Сама учётка остаётся в .env и на пары пробуется всегда,
 * даже «потерянной»: это единственный ключ для групп без своих слотов, и
 * ложная тревога не должна оставить их без записи.
 *
 * Состояние — data/general.json (без логина и пароля). Только для режима
 * «обучающийся»: проверка идёт через кабинет студента lk.chuvsu.ru.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CHECK_EVERY_MS } from "./accounts.js";
import type { WebinarProfile } from "./config.js";
import type { LiveState, LiveTarget } from "./liveness.js";

/** Название строки общей учётки в отчёте боту — бот узнаёт её по нему. */
export const GENERAL_SLOT = "Общая учётка (.env)";
export const GENERAL_KEY = "general";

export class GeneralWatch {
  private state: LiveState = { status: "ok", failures: 0, lastOkAt: null, nextCheckAt: 0 };

  constructor(
    private readonly file: string,
    readonly profile: Pick<WebinarProfile, "login" | "password">,
  ) {
    if (existsSync(file)) {
      try {
        this.state = { ...this.state, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<LiveState>) };
      } catch {
        /* битый файл — начнём заново */
      }
    }
  }

  /** null — профиль 1 не «обучающийся», через кабинет студента его не проверить. */
  static forProfile(dir: string, profile: WebinarProfile): GeneralWatch | null {
    return profile.authMode === "1" ? new GeneralWatch(path.join(dir, "general.json"), profile) : null;
  }

  get current(): LiveState {
    return { ...this.state };
  }

  update(patch: Partial<LiveState>): void {
    Object.assign(this.state, patch);
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Заход на пару под ней прошёл — значит, жива. */
  noteJoin(now = Date.now()): void {
    this.update({ status: "ok", failures: 0, lastOkAt: new Date(now).toISOString(), nextCheckAt: now + CHECK_EVERY_MS });
  }

  /** Цель для проверки «аккаунт жив» вместе со слотами. */
  target(): LiveTarget {
    return { key: GENERAL_KEY, login: this.profile.login, password: this.profile.password, state: this.current, save: (patch) => this.update(patch), fresh: () => this.current };
  }

  /** Строка для отчёта боту. */
  summary(): { group: string; status: string; lastOkAt: string | null } {
    return { group: GENERAL_SLOT, status: this.state.status, lastOkAt: this.state.lastOkAt };
  }
}
