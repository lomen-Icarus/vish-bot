/**
 * «Бот узнаёт своих» — сопоставление телеграм-ника с именем человека.
 *
 * Зачем: на /start приятно получить «Привет, Данил» вместо «С возвращением».
 * Регистрации в боте нет и не будет: ФИО у людей не спрашивают нигде, имя
 * берётся из файла старост, который лежит ТОЛЬКО на хостинге (KNOWN_DB).
 *
 * Почему отдельный файл, а не столбец в реестре поиска: ник не должен попасть
 * в поиск студентов ни при каких обстоятельствах. Поиск читает POISK_DB и про
 * этот файл не знает, а ник не покидает этот модуль: наружу уходит либо имя
 * («Привет, Данил»), либо вердикт «пользуется / не встречался» для сверки
 * списка активистов админом (status). Обратный поиск по ФИО есть только
 * внутри, и результат его — не ник, а да/нет.
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
  /** Слова ФИО в нормальном виде: считаются один раз при загрузке. */
  words: string[];
}

/** Ответ на вопрос «пользуется ли этот человек ботом». */
export type KnownStatus =
  /** Ник из файла встречался боту. */
  | "uses"
  /** Ник известен, но с него боту не писали. */
  | "not-seen"
  /** Такого человека в файле нет — сказать нечего. */
  | "no-handle"
  /** В файле несколько подходящих людей: угадывать нельзя. */
  | "ambiguous";

/**
 * Один ли это человек. Сравнение нарочно строгое, без поправки на опечатки:
 * здесь не подсказка в поиске, а утверждение «вот этот человек пользуется
 * ботом», и ошибиться в нём хуже, чем ответить «не знаю».
 *
 * Фамилия — точно. Имя и отчество — точно, но инициал совпадает с полным
 * словом («Иванов И. И.» = «Иванов Иван Иванович»), а отсутствующее слово ничему
 * не противоречит («Иванов Иван» подходит любому Иванову Ивану). Зато два
 * РАЗНЫХ отчества — это разные люди, и на них матч обязан развалиться.
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1 || b.length === 1) return a[0] === b[0];
  return false;
}

export function samePersonWords(want: string[], have: string[]): boolean {
  if (!want.length || !have.length || !sameWord(want[0]!, have[0]!)) return false;
  for (let i = 1; i < Math.min(want.length, have.length, 3); i++) {
    if (!sameWord(want[i]!, have[i]!)) return false;
  }
  return true;
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
        map.set(handle, { name, firstName: firstNameOf(name), words: normName(name).split(" ").filter(Boolean) });
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
   * нигде не всплыл: наружу уходит только вердикт. Четыре ответа, и «не знаю»
   * тут не одно и то же, что «нет»: см. KnownStatus.
   */
  status(fio: string, botUsernames: Set<string>): KnownStatus {
    this.reloadIfChanged();
    const want = normName(fio).split(" ").filter(Boolean);
    if (!want.length) return "no-handle";
    let found: string | null = null;
    let hits = 0;
    for (const [handle, person] of this.byHandle) {
      if (!samePersonWords(want, person.words)) continue;
      found = handle;
      // Двое подходящих — это либо полные тёзки, либо спросили без отчества:
      // в обоих случаях угадывать нельзя, и молчать об этом тоже нельзя.
      if (++hits > 1) return "ambiguous";
    }
    if (!found) return "no-handle";
    return botUsernames.has(found) ? "uses" : "not-seen";
  }

  count(): number {
    this.reloadIfChanged();
    return this.byHandle.size;
  }

  stats(): { count: number; file: string; error: string | null } {
    return { count: this.count(), file: this.file, error: this.error };
  }
}
