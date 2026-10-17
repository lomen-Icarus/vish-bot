/**
 * Слоты записи: учётки студентов, которые админ одобрил в боте. Один слот —
 * одна группа (в общих лекциях потока перечислены все его группы, поэтому
 * учётка группы пускает и туда). Лежат в data/accounts.json (права 0600),
 * не в .env: записывалка подхватывает изменения сразу, без пересоздания
 * контейнера. Профили из .env (учётки владельца) живут как раньше и идут
 * первыми; слоты — вслед за ними.
 *
 * В логах слот — только группой («slot:ВИШ-14-25»): ни логина, ни пароля.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WebinarProfile } from "./config.js";

export type SlotStatus = "ok" | "lost";

export interface Slot {
  /** Группа, как её называет бот: «ВИШ-14-25», «ВИШ-11-23 (ЭиЭА)». */
  group: string;
  /** Коды для сверки со строками вебинаров: «14-25», «11-23(эиэа)». */
  codes: string[];
  login: string;
  password: string;
  /** Номер заявки в боте и кто её подал — чтобы бот мог отозвать и уведомить. */
  requestId: number;
  userId: number;
  installedAt: string;
  status: SlotStatus;
  /** Когда вход последний раз прошёл (заход на пару или проверка кабинета). */
  lastOkAt: string | null;
  /** Неудачных проверок подряд. */
  failures: number;
  /** Когда проверять в следующий раз (мс). */
  nextCheckAt: number;
}

interface FileShape {
  v: 1;
  slots: Slot[];
}

export const SLOT_PREFIX = "slot:";

export class AccountStore {
  private slots = new Map<string, Slot>();

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, "utf8")) as Partial<FileShape>;
      for (const s of data.slots ?? []) this.slots.set(s.group, s);
    }
  }

  static inDir(dir: string): AccountStore {
    return new AccountStore(path.join(dir, "accounts.json"));
  }

  list(): Slot[] {
    return [...this.slots.values()].sort((a, b) => a.group.localeCompare(b.group));
  }

  get(group: string): Slot | undefined {
    return this.slots.get(group);
  }

  /** Поставить учётку в слот группы (прежняя, если была, заменяется). Повтор той же заявки ничего не меняет. */
  install(entry: { group: string; codes: string[]; login: string; password: string; requestId: number; userId: number }, now = Date.now()): Slot {
    const old = this.slots.get(entry.group);
    if (old && old.requestId === entry.requestId) return old;
    const slot: Slot = { ...entry, installedAt: new Date(now).toISOString(), status: "ok", lastOkAt: new Date(now).toISOString(), failures: 0, nextCheckAt: now + CHECK_EVERY_MS };
    this.commit(new Map(this.slots).set(entry.group, slot));
    return slot;
  }

  remove(group: string): boolean {
    if (!this.slots.has(group)) return false;
    const next = new Map(this.slots);
    next.delete(group);
    this.commit(next);
    return true;
  }

  /**
   * Поправить состояние слота. installedAt — «тот ли это слот»: проверка
   * «жива ли» и заход на пару берут слот в начале и пишут итог по имени
   * группы; если слот за это время заменили, итог по старой учётке не должен
   * лечь на новую (иначе свежий слот мог сразу стать «не пускает»).
   */
  update(group: string, patch: Partial<Pick<Slot, "status" | "lastOkAt" | "failures" | "nextCheckAt">>, installedAt?: string): void {
    const slot = this.slots.get(group);
    if (!slot || (installedAt !== undefined && slot.installedAt !== installedAt)) return;
    this.commit(new Map(this.slots).set(group, { ...slot, ...patch }));
  }

  /** Профили для захода на пары: только живые слоты; «потерянные» не пробуем, пока их не проверят заново. */
  profiles(): WebinarProfile[] {
    return this.list()
      .filter((s) => s.status === "ok")
      .map((s) => ({ name: `${SLOT_PREFIX}${s.group}`, authMode: "1", login: s.login, password: s.password, groups: s.codes }));
  }

  /**
   * Сначала файл, потом память. Наоборот — при неудачной записи (кончился
   * диск) повтор задания стал бы пустой операцией с ответом «готово», а на
   * диске осталась бы прежняя учётка: отозванная «воскресла» бы после перезапуска.
   */
  private commit(next: Map<string, Slot>): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const slots = [...next.values()].sort((a, b) => a.group.localeCompare(b.group));
    writeFileSync(tmp, JSON.stringify({ v: 1, slots } satisfies FileShape, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.slots = next;
  }
}

/** Раз в сколько проверять, жив ли вход. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Первая неудача — переспросить скоро: одна осечка ещё не «доступ потерян». */
export const RECHECK_SOON_MS = 15 * 60 * 1000;
