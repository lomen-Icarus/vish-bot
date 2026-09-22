/**
 * «Бот узнаёт своих» — сопоставление телеграм-ника с именем человека.
 *
 * Зачем: на /start приятно получить «Привет, Данил» вместо «С возвращением».
 * Регистрации в боте нет и не будет: ФИО у людей не спрашивают нигде, имя
 * берётся из файла старост, который лежит ТОЛЬКО на хостинге (KNOWN_DB).
 *
 * Почему отдельный файл, а не столбец в реестре поиска: ник не должен попасть
 * в поиск студентов ни при каких обстоятельствах. Поиск читает POISK_DB и про
 * этот файл не знает; здесь нет ни поиска по имени, ни выдачи ников наружу —
 * только «этот ник → это имя».
 *
 * Группу из файла бот никогда не навязывает: файл годичной давности, группы
 * успевают поменяться, а ФИО — нет.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { normName } from "../text/match.js";
import { logger } from "../logger.js";

export interface KnownPerson {
  /** Полное ФИО из файла. */
  name: string;
  /** Имя для обращения: «Албуткин Данил Иванович» → «Данил». */
  firstName: string;
}

/** «Фамилия Имя Отчество» → «Имя». Одно слово — им и обращаемся. */
function firstNameOf(fio: string): string {
  const parts = fio.split(/\s+/).filter(Boolean);
  return parts[1] ?? parts[0] ?? fio;
}

/** Ник без «@» и адреса, в нижнем регистре: ровно так он хранится и сравнивается. */
export function normalizeHandle(raw: string | null | undefined): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  const m = /^(?:https?:\/\/)?(?:t(?:elegram)?\.me\/)?@?([A-Za-z0-9_]{4,32})\/?$/.exec(v);
  return m ? m[1]!.toLowerCase() : null;
}

/** Как часто заглядывать, не подменили ли файл на сервере. */
const CHECK_EVERY_MS = 5000;

export class KnownPeople {
  private byHandle = new Map<string, KnownPerson>();
  private mtimeMs = -1;
  private size = -1;
  private checkedAt = 0;
  private error: string | null = null;

  constructor(private readonly file: string) {
    this.reload();
  }

  private reloadIfChanged(): void {
    // statSync на каждый вызов — это сисколл на каждое открытие настроек и
    // каждый /start. Файл меняют раз в год, секунды проверки хватает с лихвой.
    if (Date.now() - this.checkedAt < CHECK_EVERY_MS) return;
    this.checkedAt = Date.now();
    try {
      const st = statSync(this.file);
      if (st.mtimeMs !== this.mtimeMs || st.size !== this.size) this.reload();
    } catch {
      // Файл убрали с сервера — значит, узнавание выключили. Продолжать
      // здороваться по имени из памяти было бы ровно обратным тому, чего хотел
      // админ, когда его удалял.
      if (this.byHandle.size) logger.warn({ file: this.file }, "known people file disappeared: узнавание выключено");
      this.byHandle = new Map();
      this.error = "файла нет";
      this.mtimeMs = -1;
      this.size = -1;
    }
  }

  private reload(): void {
    if (!existsSync(this.file)) {
      this.byHandle = new Map();
      this.error = "файла нет";
      return;
    }
    const st = statSync(this.file);
    this.mtimeMs = st.mtimeMs;
    this.size = st.size;
    try {
      const map = new Map<string, KnownPerson>();
      const dupes = new Set<string>();
      for (const line of readFileSync(this.file, "utf8").split(/\r?\n/)) {
        const [rawName, rawHandle] = line.split(/[;,\t]/);
        const name = (rawName ?? "").trim();
        const handle = normalizeHandle(rawHandle);
        if (!name || !handle || !/\s/.test(name)) continue;
        // Один ник у двоих — узнавать по нему нельзя: выкидываем обоих, иначе
        // бот поздоровается чужим именем.
        if (map.has(handle)) dupes.add(handle);
        map.set(handle, { name, firstName: firstNameOf(name) });
      }
      for (const h of dupes) map.delete(h);
      this.byHandle = map;
      this.error = null;
      logger.info({ count: map.size, file: this.file }, "known people loaded");
    } catch (err) {
      // Не запоминаем размер и время: иначе следующая проверка решит, что файл
      // «не менялся», и битая загрузка застынет навсегда.
      this.mtimeMs = -1;
      this.size = -1;
      this.byHandle = new Map();
      this.error = String(err).slice(0, 200);
      logger.warn({ err: String(err), file: this.file }, "known people load failed");
    }
  }

  /** Кто это, если ник есть в файле. Ник наружу не отдаётся никогда. */
  byUsername(username: string | null | undefined): KnownPerson | null {
    this.reloadIfChanged();
    const handle = normalizeHandle(username);
    return handle ? (this.byHandle.get(handle) ?? null) : null;
  }

  /**
   * Пользуется ли этот человек ботом. Сверка идёт внутри модуля, чтобы ник
   * нигде не всплыл: наружу уходит только вердикт.
   *   uses      — ник из списка старост встречался боту;
   *   not-seen  — ник известен, но такой человек боту не писал;
   *   no-handle — ника нет в списке, сказать нечего.
   */
  status(fio: string, botUsernames: Set<string>): "uses" | "not-seen" | "no-handle" {
    this.reloadIfChanged();
    const handle = this.handleOf(fio);
    if (!handle) return "no-handle";
    return botUsernames.has(handle) ? "uses" : "not-seen";
  }

  /** Ник по ФИО: точное совпадение, иначе «фамилия + имя» (отчество могли не дописать). */
  private handleOf(fio: string): string | null {
    const want = normName(fio);
    if (!want) return null;
    const short = want.split(" ").slice(0, 2).join(" ");
    let byShort: string | null = null;
    let shortHits = 0;
    for (const [handle, person] of this.byHandle) {
      const have = normName(person.name);
      if (have === want) return handle;
      if (have.split(" ").slice(0, 2).join(" ") === short) {
        byShort = handle;
        shortHits++;
      }
    }
    // Двое с одинаковыми фамилией и именем — угадывать нельзя.
    return shortHits === 1 ? byShort : null;
  }

  count(): number {
    this.reloadIfChanged();
    return this.byHandle.size;
  }

  stats(): { count: number; file: string; error: string | null } {
    return { count: this.count(), file: this.file, error: this.error };
  }
}
