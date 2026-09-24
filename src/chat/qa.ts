/**
 * Сценарий болталки: база «вопрос → ответ», которую пополняет админ.
 *
 * Ответ всё равно пишет ИИ: база — не автоответчик, а заготовки. Если реплика
 * похожа на вопрос из базы (дословно, другими словами или с опечаткой), модель
 * получает заготовленный ответ и отвечает им — дословно или близко к тексту,
 * подстроив под собеседника. Вся база к тому же лежит в системном промпте:
 * так модель узнаёт вопрос и тогда, когда слова совсем другие.
 *
 * Файл — CSV (CHAT_QA_DB), лежит только на хостинге. Формат:
 *
 *   вопрос;ответ;подсказка
 *   сосал?|сосал|ты сосал?;Ответ, который вставит админ;
 *   как дела;Лучше всех, пока пары не начались;шутливо
 *
 * - разделитель «;» (Excel), табуляция или «,» (Google Таблицы) — определяется сам;
 * - несколько вариантов вопроса — через «|»;
 * - третья колонка необязательна: подсказка модели, как отвечать («дословно», «с сарказмом»);
 * - поле с «;», кавычками или переносом строки берётся в двойные кавычки, "" внутри — это одна ";
 * - строки, начинающиеся с «#», — комментарии; первая строка «вопрос;ответ» — заголовок.
 *
 * Бот перечитывает файл сам, когда тот меняется: перезапуск не нужен.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { editDistance, typoBudget } from "../text/match.js";
import { logger } from "../logger.js";

export interface QaEntry {
  /** Варианты вопроса как в файле. */
  questions: string[];
  answer: string;
  /** Подсказка модели, как отвечать; null — отвечать заготовкой по смыслу. */
  hint: string | null;
  /** Варианты вопроса в нормальном виде: считаются один раз при загрузке. */
  norm: string[];
}

export interface QaParseResult {
  entries: QaEntry[];
  /** Строки, из которых не получилось взять ни вопроса, ни ответа. */
  skipped: number;
  delimiter: string;
}

/** Больше заготовок в одну базу — это уже не сценарий, а свалка: остальное отбрасываем. */
export const QA_MAX_ENTRIES = 2000;

/** Как часто заглядывать, не поменяли ли файл на сервере. */
const CHECK_EVERY_MS = 5000;

/**
 * Текст файла: UTF-8, а если это не UTF-8 — Windows-1251 (так сохраняет CSV
 * русский Excel, если не выбрать «CSV UTF-8»).
 */
export function decodeText(buf: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("windows-1251").decode(buf);
  }
}

/** Нижний регистр, ё → е, всё, кроме букв и цифр, — пробел. */
export function normQa(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Разбирает CSV целиком, а не построчно: ответ в кавычках может занимать
 * несколько строк. Возвращает записи (массивы ячеек).
 */
function parseRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let atRecordStart = true;
  let comment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (comment) {
      if (ch === "\n") {
        comment = false;
        atRecordStart = true;
      }
      continue;
    }
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (atRecordStart && ch === "#") {
      comment = true;
      continue;
    }
    atRecordStart = false;
    if (ch === '"' && !cell.trim()) {
      cell = "";
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some((c) => c)) records.push(row);
      row = [];
      cell = "";
      atRecordStart = true;
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c)) records.push(row);
  return records;
}

/**
 * «;», если он есть в первой строке вне кавычек; иначе табуляция; иначе «,».
 * Именно в таком порядке: в ответах полно запятых, а «;» в первой строке
 * почти всегда разделитель.
 */
function detectDelimiter(text: string): string {
  const first = (text.split(/\r?\n/).find((l) => l.trim() && !l.trimStart().startsWith("#")) ?? "").replace(/"[^"]*"/g, "");
  if (first.includes(";")) return ";";
  if (first.includes("\t")) return "\t";
  if (first.includes(",")) return ",";
  return ";";
}

const HEADER_WORDS = new Set(["вопрос", "вопросы", "question", "questions", "q"]);

export function parseQa(raw: string): QaParseResult {
  const text = raw.replace(/^﻿/, "");
  const delimiter = detectDelimiter(text);
  const records = parseRecords(text, delimiter);
  if (records.length && HEADER_WORDS.has(normQa(records[0]![0] ?? ""))) records.shift();
  const entries: QaEntry[] = [];
  let skipped = 0;
  for (const cells of records) {
    const questions = (cells[0] ?? "")
      .split("|")
      .map((q) => q.trim())
      .filter(Boolean);
    const answer = (cells[1] ?? "").trim();
    const norm = questions.map(normQa).filter(Boolean);
    if (!norm.length || !answer) {
      skipped++;
      continue;
    }
    if (entries.length >= QA_MAX_ENTRIES) {
      skipped++;
      continue;
    }
    const hint = (cells[2] ?? "").trim() || null;
    entries.push({ questions, answer, hint, norm });
  }
  return { entries, skipped, delimiter };
}

/** Поле CSV: в кавычки, если в нём разделитель, кавычка или перенос строки. */
function csvField(value: string, delimiter: string): string {
  return /["\r\n]/.test(value) || value.includes(delimiter) || value !== value.trim() || value.startsWith("#") ? `"${value.replace(/"/g, '""')}"` : value;
}

export function qaLine(questions: string[], answer: string, hint: string | null, delimiter = ";"): string {
  const cells = [questions.join("|"), answer, ...(hint ? [hint] : [])];
  return cells.map((c) => csvField(c, delimiter)).join(delimiter);
}

export interface QaMatch {
  entry: QaEntry;
  /** Каким вариантом совпало. */
  question: string;
  /** exact — реплика и есть вопрос; phrase — вопрос внутри реплики; typo — с опечаткой. */
  how: "exact" | "phrase" | "typo";
}

export class QaBase {
  private list: QaEntry[] = [];
  private delimiter = ";";
  private mtimeMs = -1;
  private size = -1;
  private checkedAt = 0;
  private error: string | null = null;
  private skipped = 0;

  constructor(readonly file: string) {
    this.reload();
  }

  private reloadIfChanged(): void {
    if (Date.now() - this.checkedAt < CHECK_EVERY_MS) return;
    this.checkedAt = Date.now();
    try {
      const st = statSync(this.file);
      if (st.mtimeMs !== this.mtimeMs || st.size !== this.size) this.reload();
    } catch {
      if (this.list.length) logger.warn({ file: this.file }, "chat Q&A file disappeared: сценарий пуст");
      this.list = [];
      this.error = "файла нет";
      this.mtimeMs = -1;
      this.size = -1;
    }
  }

  /** Перечитать файл прямо сейчас (после загрузки из бота). */
  reload(): void {
    this.checkedAt = Date.now();
    if (!existsSync(this.file)) {
      this.list = [];
      this.error = "файла нет";
      this.mtimeMs = -1;
      this.size = -1;
      return;
    }
    try {
      const st = statSync(this.file);
      const parsed = parseQa(decodeText(readFileSync(this.file)));
      this.list = parsed.entries;
      this.delimiter = parsed.delimiter;
      this.skipped = parsed.skipped;
      this.mtimeMs = st.mtimeMs;
      this.size = st.size;
      this.error = null;
      logger.info({ count: parsed.entries.length, skipped: parsed.skipped, file: this.file }, "chat Q&A loaded");
    } catch (err) {
      // Размер и время не запоминаем: иначе битая загрузка застынет до следующей правки.
      this.list = [];
      this.mtimeMs = -1;
      this.size = -1;
      this.error = String(err).slice(0, 200);
      logger.warn({ err: String(err), file: this.file }, "chat Q&A load failed");
    }
  }

  entries(): QaEntry[] {
    this.reloadIfChanged();
    return this.list;
  }

  stats(): { count: number; skipped: number; error: string | null; file: string } {
    this.reloadIfChanged();
    return { count: this.list.length, skipped: this.skipped, error: this.error, file: this.file };
  }

  /**
   * Заготовки, на которые похожа реплика: сначала точные, потом те, чей вопрос
   * стоит в реплике целыми словами, потом с опечаткой. Длинный вопрос важнее
   * короткого: «как дела на парах» точнее, чем «как дела».
   */
  match(text: string, limit = 3): QaMatch[] {
    const msg = normQa(text);
    if (!msg) return [];
    const padded = ` ${msg} `;
    const found: Array<QaMatch & { score: number }> = [];
    for (const entry of this.entries()) {
      let best: (QaMatch & { score: number }) | null = null;
      entry.norm.forEach((q, i) => {
        let hit: (QaMatch & { score: number }) | null = null;
        if (q === msg) hit = { entry, question: entry.questions[i] ?? q, how: "exact", score: 3000 + q.length };
        else if (padded.includes(` ${q} `)) hit = { entry, question: entry.questions[i] ?? q, how: "phrase", score: 1000 + q.length };
        else {
          const budget = typoBudget(q.length);
          if (budget && editDistance(msg, q, budget) <= budget) hit = { entry, question: entry.questions[i] ?? q, how: "typo", score: 500 + q.length };
        }
        if (hit && (!best || hit.score > best.score)) best = hit;
      });
      if (best) found.push(best);
    }
    return found
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ entry, question, how }) => ({ entry, question, how }));
  }

  private ensureDir(): void {
    mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
  }

  /** Дописать заготовку в конец файла (создаёт файл с заголовком, если его не было). */
  append(questions: string[], answer: string, hint: string | null = null): void {
    this.ensureDir();
    const exists = existsSync(this.file);
    const current = exists ? decodeText(readFileSync(this.file)) : "";
    const delimiter = exists ? this.delimiter : ";";
    const head = exists ? (current && !current.endsWith("\n") ? "\n" : "") : `вопрос${delimiter}ответ${delimiter}подсказка\n`;
    writeFileSync(this.file, `${current}${head}${qaLine(questions, answer, hint, delimiter)}\n`, "utf8");
    this.reload();
  }

  /**
   * Заменить базу целиком (файл, присланный админом в бот). Пустую или
   * нечитаемую базу не принимает; старую кладёт рядом как .bak.
   */
  replace(content: string): QaParseResult {
    const parsed = parseQa(content);
    if (!parsed.entries.length) return parsed;
    this.ensureDir();
    if (existsSync(this.file)) copyFileSync(this.file, `${this.file}.bak`);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, content.replace(/^﻿/, ""), "utf8");
    renameSync(tmp, this.file);
    this.reload();
    return parsed;
  }

  /** Текст файла как есть — чтобы админ скачал, поправил и прислал обратно. */
  raw(): string | null {
    return existsSync(this.file) ? decodeText(readFileSync(this.file)) : null;
  }
}
