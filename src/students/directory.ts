/**
 * Справочник студентов для глобального поиска («сыск»).
 *
 * Файл лежит ТОЛЬКО на хостинге (том Docker рядом с базой бота) и никогда не
 * попадает в репозиторий: путь задаётся переменной POISK_DB. Из файла читаются
 * ровно три поля — ФИО, группа и (если есть) подгруппа. Любые другие столбцы
 * (телефон, почта, паспорт, оценки) игнорируются на этапе загрузки, поэтому
 * бот физически не может их показать.
 *
 * Поддерживаются три формата:
 *   • CSV/TSV  — «ФИО;Группа;Подгруппа», разделитель определяется сам;
 *   • JSON     — массив объектов {fio|name, group, subgroup};
 *   • SQLite   — первая таблица, где есть столбец с ФИО и столбец с группой.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nameMatch, normName } from "../text/match.js";
import { logger } from "../logger.js";
import { decodeText } from "../text/decode.js";

export interface StudentRecord {
  /** Стабильный короткий идентификатор для callback_data (ФИО + группа). */
  id: string;
  name: string;
  /** Как группа записана в файле, например «ВИШ-12-23». */
  groupTitle: string;
  subgroup: number | null;
}

export interface StudentHit {
  student: StudentRecord;
  score: number;
  /** Совпадение нашлось только с опечатками — предлагать, а не открывать сразу. */
  fuzzy: boolean;
}

const NAME_KEYS = ["фио", "ф и о", "фамилия имя отчество", "студент", "name", "fio", "fullname", "full name", "student"];
// Выгрузки часто разносят ФИО по трём колонкам.
const SURNAME_KEYS = ["фамилия", "surname", "last name", "lastname"];
const FIRSTNAME_KEYS = ["имя", "first name", "firstname"];
const MIDDLENAME_KEYS = ["отчество", "middle name", "middlename", "patronymic"];
const GROUP_KEYS = ["группа", "учебная группа", "group", "group name", "grp"];
const SUBGROUP_KEYS = ["подгруппа", "подгр", "subgroup", "sub group", "subgrp"];

function keyOf(name: string, group: string): string {
  return createHash("sha1").update(`${normName(name)}|${normName(group)}`).digest("base64url").slice(0, 12);
}

function pickColumn(headers: string[], keys: string[]): number {
  const norm = headers.map((h) => normName(h));
  for (const k of keys) {
    const i = norm.findIndex((h) => h === k);
    if (i >= 0) return i;
  }
  for (const k of keys) {
    const i = norm.findIndex((h) => h.includes(k));
    if (i >= 0) return i;
  }
  return -1;
}

/** Одна строка CSV с учётом кавычек. */
function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function detectDelimiter(sample: string): string {
  // Запятые внутри «"Фамилия, имя, отчество"» — не разделители: считаем только
  // то, что снаружи кавычек, иначе весь файл прочитается одной колонкой.
  const outside = sample.replace(/"[^"]*"/g, "");
  const counts = [";", "\t", ",", "|"].map((d) => [d, outside.split(d).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 1 ? counts[0]![0] : ";";
}

function toSubgroup(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[^\d]/g, ""));
  return n === 1 || n === 2 ? n : null;
}

interface RawRow {
  name: string;
  group: string;
  subgroup: number | null;
}

/** «Группа» без единой цифры — это заголовок или мусор, а не учебная группа. */
function looksLikeGroup(value: string): boolean {
  return /\d/.test(value);
}

function parseCsv(text: string): RawRow[] {
  // BOM от Excel иначе прилипает к первому заголовку, и колонки не находятся.
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim().length > 0 && !l.trimStart().startsWith("#"));
  if (!lines.length) return [];
  const delimiter = detectDelimiter(lines[0]!);
  const first = splitCsvLine(lines[0]!, delimiter);
  let nameIdx = pickColumn(first, NAME_KEYS);
  const surnameIdx = pickColumn(first, SURNAME_KEYS);
  const firstNameIdx = pickColumn(first, FIRSTNAME_KEYS);
  const middleNameIdx = pickColumn(first, MIDDLENAME_KEYS);
  let groupIdx = pickColumn(first, GROUP_KEYS);
  let subIdx = pickColumn(first, SUBGROUP_KEYS);
  const composed = nameIdx < 0 && surnameIdx >= 0 && firstNameIdx >= 0;
  let body = lines.slice(1);
  if ((nameIdx < 0 && !composed) || groupIdx < 0) {
    // Заголовок не опознан: считаем, что это ФИО;Группа;Подгруппа. Саму строку
    // заголовка спасает проверка looksLikeGroup — в «Группа» нет цифр.
    nameIdx = 0;
    groupIdx = 1;
    subIdx = 2;
    body = lines;
  }
  const rows: RawRow[] = [];
  for (const line of body) {
    const cells = splitCsvLine(line, delimiter);
    const name = composed
      ? [cells[surnameIdx], cells[firstNameIdx], middleNameIdx >= 0 ? cells[middleNameIdx] : ""].filter((x) => x && x.trim()).join(" ").trim()
      : (cells[nameIdx] ?? "").trim();
    const group = (cells[groupIdx] ?? "").trim();
    if (!name || !group || !looksLikeGroup(group)) continue;
    rows.push({ name, group, subgroup: subIdx >= 0 ? toSubgroup(cells[subIdx]) : null });
  }
  return rows;
}

function parseJson(text: string): RawRow[] {
  // Сообщение JSON.parse содержит кусок разбираемого файла (то есть чужие ФИО),
  // а этот текст уходит в лог и в /health. Подменяем его нейтральным.
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new Error("файл не является корректным JSON");
  }
  const list = Array.isArray(data) ? data : Array.isArray((data as { students?: unknown }).students) ? ((data as { students: unknown[] }).students) : [];
  const rows: RawRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const entries = Object.entries(o);
    const find = (keys: string[]): unknown => entries.find(([k]) => keys.includes(normName(k)))?.[1] ?? entries.find(([k]) => keys.some((x) => normName(k).includes(x)))?.[1];
    const name = String(find(NAME_KEYS) ?? "").trim();
    const group = String(find(GROUP_KEYS) ?? "").trim();
    if (!name || !group) continue;
    rows.push({ name, group, subgroup: toSubgroup(find(SUBGROUP_KEYS)) });
  }
  return rows;
}

function parseSqlite(file: string): RawRow[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: string }>).map((t) => t.name);
    for (const table of tables) {
      const cols = (db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as Array<{ name: string }>).map((c) => c.name);
      const nameCol = cols[pickColumn(cols, NAME_KEYS)];
      const groupCol = cols[pickColumn(cols, GROUP_KEYS)];
      if (!nameCol || !groupCol) continue;
      const subCol = cols[pickColumn(cols, SUBGROUP_KEYS)];
      // Читаем только три столбца: остальное содержимое базы бот не видит.
      const quote = (x: string): string => `"${x.replace(/"/g, '""')}"`;
      const q = `SELECT ${quote(nameCol)} AS n, ${quote(groupCol)} AS g${subCol ? `, ${quote(subCol)} AS s` : ""} FROM ${quote(table)}`;
      const rows = db.prepare(q).all() as Array<{ n: unknown; g: unknown; s?: unknown }>;
      const out: RawRow[] = [];
      for (const r of rows) {
        const name = String(r.n ?? "").trim();
        const group = String(r.g ?? "").trim();
        if (!name || !group) continue;
        out.push({ name, group, subgroup: toSubgroup(r.s) });
      }
      if (out.length) return out;
    }
    return [];
  } finally {
    db.close();
  }
}

export class StudentDirectory {
  private students: StudentRecord[] = [];
  private byId = new Map<string, StudentRecord>();
  private mtimeMs = -1;
  private size = -1;
  private loadedAt: Date | null = null;
  private error: string | null = null;

  constructor(private readonly file: string) {
    this.reload();
  }

  /** Перечитывает файл, если его подменили на сервере (без перезапуска бота). */
  private reloadIfChanged(): void {
    try {
      const st = statSync(this.file);
      if (st.mtimeMs !== this.mtimeMs || st.size !== this.size) this.reload();
    } catch {
      if (this.students.length) {
        this.error = "файл со студентами пропал, работаю по последней загруженной копии";
        logger.warn({ file: this.file }, "student directory file disappeared");
      }
      this.mtimeMs = -1;
      this.size = -1;
    }
  }

  reload(): void {
    const file = path.resolve(this.file);
    if (!existsSync(file)) {
      this.error = `файл ${this.file} не найден`;
      this.students = [];
      this.byId = new Map();
      this.mtimeMs = -1;
      this.size = -1;
      return;
    }
    let st;
    try {
      st = statSync(file);
    } catch {
      this.error = `файл ${this.file} не читается`;
      return;
    }
    // Запоминаем файл сразу: иначе после неудачи reloadIfChanged() снова видит
    // «файл изменился» и перечитывает его на каждый поиск, засоряя лог.
    this.mtimeMs = st.mtimeMs;
    this.size = st.size;
    try {
      const ext = path.extname(file).toLowerCase();
      const raw = ext === ".sqlite" || ext === ".db" || ext === ".sqlite3" ? parseSqlite(file) : ext === ".json" ? parseJson(decodeText(readFileSync(file))) : parseCsv(decodeText(readFileSync(file)));
      const list: StudentRecord[] = [];
      const seen = new Set<string>();
      for (const r of raw) {
        // Строка без цифр в группе — это заголовок или мусор, а не студент.
        if (!looksLikeGroup(r.group)) continue;
        const id = keyOf(r.name, r.group);
        if (seen.has(id)) continue;
        seen.add(id);
        list.push({ id, name: r.name.replace(/\s+/g, " ").trim(), groupTitle: r.group.replace(/\s+/g, " ").trim(), subgroup: r.subgroup });
      }
      this.students = list;
      this.byId = new Map(list.map((s) => [s.id, s]));
      this.loadedAt = new Date();
      this.error = list.length ? null : "файл прочитан, но ни одной записи «ФИО + группа» в нём не нашлось";
      // Никаких имён в логах: только количество.
      logger.info({ count: list.length, file: this.file }, "student directory loaded");
    } catch (err) {
      // В тексте ошибки парсера может оказаться кусок файла, то есть чужие ФИО:
      // наружу отдаём только тип ошибки.
      // Свои понятные сообщения оставляем, чужие (от парсеров) — нет.
      const safe = err instanceof Error && err.message.startsWith("файл") ? err.message : "не удалось разобрать файл";
      this.error = safe;
      logger.warn({ err: safe, file: this.file }, "student directory load failed");
    }
  }

  count(): number {
    this.reloadIfChanged();
    return this.students.length;
  }

  ready(): boolean {
    return this.count() > 0;
  }

  get(id: string): StudentRecord | null {
    this.reloadIfChanged();
    return this.byId.get(id) ?? null;
  }

  /** Поиск по ФИО в любом порядке слов, с опечатками. */
  search(query: string, limit = 8): StudentHit[] {
    this.reloadIfChanged();
    const q = query.trim();
    if (q.length < 3) return [];
    const hits: StudentHit[] = [];
    for (const student of this.students) {
      const m = nameMatch(student.name, q);
      if (m.score > 0) hits.push({ student, score: m.score, fuzzy: m.fuzzy });
    }
    hits.sort((a, b) => Number(a.fuzzy) - Number(b.fuzzy) || b.score - a.score || a.student.name.localeCompare(b.student.name, "ru"));
    return hits.slice(0, limit);
  }

  /** Различные группы, которые встречаются в файле (для подсказки «каких курсов нет»). */
  groupTitles(): string[] {
    this.reloadIfChanged();
    return [...new Set(this.students.map((s) => s.groupTitle))];
  }

  /** Для /health: сколько записей, откуда и когда прочитаны. */
  stats(): { count: number; file: string; loadedAt: Date | null; error: string | null } {
    this.reloadIfChanged();
    return { count: this.students.length, file: this.file, loadedAt: this.loadedAt, error: this.error };
  }
}
