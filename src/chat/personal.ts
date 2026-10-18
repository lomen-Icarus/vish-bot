/**
 * Личные ответы болталки: «этому человеку — вот это». Отдельный тип рядом со
 * сценарием «вопрос → ответ» (qa.ts), тот не меняется.
 *
 * Человек из файла зовёт бота в групповом чате («@бот …» или ответом на
 * сообщение бота) — и вместо ответа ИИ получает заготовку: в первый раз
 * всегда, дальше — с заданным шансом. Не выпало — отвечает ИИ, как обычно.
 * Модель не зовётся, ИИ-лимит не тратится.
 *
 * Файл — CSV (CHAT_PERSONAL_DB), лежит только на хостинге (в нём ники). Формат:
 *
 *   ник;частота;сообщение
 *   @ivan_petrov;30;Ваня, опять ты?
 *   @kira;100%;gif:<file_id> Кира пришла
 *   123456789;5;по id, если у человека нет ника
 *
 * - ник — с «@», без него или ссылкой t.me/…; вместо ника можно числовой id;
 * - частота — шанс в процентах после первого раза: «30», «30%», «2,5»; 0 — только первый раз;
 * - «первый раз» — один за всё время (во всех чатах); поменяешь текст — первый раз будет снова;
 * - строк на одного человека может быть несколько: шанс у каждой свой;
 * - сообщение — текст или гифка, как в сценарии: «gif:<file_id> подпись»;
 *   «;» в сообщении можно не брать в кавычки: всё после второй колонки — сообщение;
 * - строки с «#» — комментарии; первая строка «ник;частота;…» — заголовок.
 *
 * Бот перечитывает файл сам, когда тот меняется: перезапуск не нужен.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { answerCell, csvField, decodeText, detectDelimiter, normQa, parseRecords, splitMedia, type QaMedia } from "./qa.js";
import { logger } from "../logger.js";

export interface PersonalEntry {
  /** Ник без «@», в нижнем регистре; null — задан id. */
  username: string | null;
  userId: number | null;
  /** Шанс после первого раза, в процентах (0–100). */
  percent: number;
  /** Текст; при гифке — подпись (может быть пустой). */
  answer: string;
  media: QaMedia | null;
  /** Метка строки для «первый раз уже был»: от человека и текста, правка текста её меняет. */
  key: string;
}

export interface PersonalParseResult {
  entries: PersonalEntry[];
  skipped: number;
  delimiter: string;
}

/** Больше личных ответов в файле — уже не пасхалки, а свалка. */
export const PERSONAL_MAX_ENTRIES = 500;

const CHECK_EVERY_MS = 5000;

const HEADER_WORDS = new Set(["ник", "ники", "nick", "username", "кто", "логин"]);

/** «@Ivan_P», «ivan_p», «t.me/ivan_p» → ник; «123456789» → id. */
export function parseWho(cell: string): { username: string | null; userId: number | null } | null {
  const s = cell
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?t(?:elegram)?\.me\//i, "")
    .replace(/^@/, "")
    .replace(/\/+$/, "");
  if (/^\d{3,15}$/.test(s)) return { username: null, userId: Number(s) };
  if (/^[a-z][a-z0-9_]{2,31}$/i.test(s)) return { username: s.toLowerCase(), userId: null };
  return null;
}

/** «30», «30%», «2,5» → проценты; вне 0–100 или не число — null. */
export function parsePercent(cell: string): number | null {
  const m = /^(\d{1,3}(?:[.,]\d+)?)\s*%?$/.exec(cell.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(",", "."));
  return n >= 0 && n <= 100 ? n : null;
}

function entryKey(who: { username: string | null; userId: number | null }, cell: string): string {
  return createHash("sha256").update(`${who.username ?? who.userId}\n${cell}`).digest("hex").slice(0, 16);
}

export function makeEntry(who: { username: string | null; userId: number | null }, percent: number, cell: string): PersonalEntry | null {
  const { media, text } = splitMedia(cell);
  if (!text && !media) return null;
  return { ...who, percent, answer: text, media, key: entryKey(who, answerCell(text, media)) };
}

export function parsePersonal(raw: string): PersonalParseResult {
  const text = raw.replace(/^﻿/, "");
  const delimiter = detectDelimiter(text);
  const records = parseRecords(text, delimiter);
  if (records.length && HEADER_WORDS.has(normQa(records[0]![0] ?? ""))) records.shift();
  // Сообщение — последняя колонка: «;» в нём без кавычек разрезал бы его на части.
  const glue = delimiter === "\t" ? " " : `${delimiter} `;
  const entries: PersonalEntry[] = [];
  let skipped = 0;
  for (const cells of records) {
    const who = parseWho(cells[0] ?? "");
    const percent = parsePercent(cells[1] ?? "");
    const entry = who && percent !== null ? makeEntry(who, percent, cells.slice(2).filter(Boolean).join(glue)) : null;
    if (!entry || entries.length >= PERSONAL_MAX_ENTRIES) {
      skipped++;
      continue;
    }
    entries.push(entry);
  }
  return { entries, skipped, delimiter };
}

/** Как строку показывают и пишут в файл: «@ник» или id. */
export function whoLabel(e: { username: string | null; userId: number | null }): string {
  return e.username ? `@${e.username}` : String(e.userId);
}

/** «30» без лишних нулей: 2.5 → «2,5». */
function percentCell(p: number): string {
  return String(p).replace(".", ",");
}

export function personalLine(e: PersonalEntry, delimiter = ";"): string {
  // «2,5» с разделителем «,» стало бы двумя колонками.
  const pct = delimiter === "," ? String(e.percent) : percentCell(e.percent);
  return [whoLabel(e), pct, answerCell(e.answer, e.media)].map((c) => csvField(c, delimiter)).join(delimiter);
}

/** Метка в meta: этой строке «первый раз» уже отправлен. */
export const personalSentKey = (key: string): string => `chat:personal-sent:${key}`;

/**
 * Что прислать позвавшему бота вместо ответа ИИ. Строка, которую человеку
 * ещё не присылали, — всегда; дальше у каждой строки свой шанс, а из
 * выпавших берётся случайная. null — человека нет в файле или шанс не выпал.
 */
export function pickPersonal(
  entries: PersonalEntry[],
  from: { id: number; username?: string | undefined },
  wasSent: (key: string) => boolean,
  random: (n: number) => number,
): { entry: PersonalEntry; first: boolean } | null {
  const nick = from.username?.toLowerCase() ?? null;
  const mine = entries.filter((e) => (e.userId !== null && e.userId === from.id) || (e.username !== null && e.username === nick));
  if (!mine.length) return null;
  const fresh = mine.find((e) => !wasSent(e.key));
  if (fresh) return { entry: fresh, first: true };
  // Шанс с точностью до сотой процента: random(10000) — от 0 до 9999.
  const hits = mine.filter((e) => e.percent > 0 && random(10_000) < Math.round(e.percent * 100));
  if (!hits.length) return null;
  return { entry: hits.length === 1 ? hits[0]! : hits[random(hits.length)]!, first: false };
}

const HEADER = (d: string): string => `ник${d}частота${d}сообщение`;

export class PersonalReplies {
  private list: PersonalEntry[] = [];
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
      if (this.list.length) logger.warn({ file: this.file }, "chat personal replies file disappeared");
      this.list = [];
      this.error = "файла нет";
      this.mtimeMs = -1;
      this.size = -1;
    }
  }

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
      const parsed = parsePersonal(decodeText(readFileSync(this.file)));
      this.list = parsed.entries;
      this.delimiter = parsed.delimiter;
      this.skipped = parsed.skipped;
      this.mtimeMs = st.mtimeMs;
      this.size = st.size;
      this.error = null;
      logger.info({ count: parsed.entries.length, skipped: parsed.skipped }, "chat personal replies loaded");
    } catch (err) {
      this.list = [];
      this.mtimeMs = -1;
      this.size = -1;
      this.error = String(err).slice(0, 200);
      logger.warn({ err: String(err) }, "chat personal replies load failed");
    }
  }

  entries(): PersonalEntry[] {
    this.reloadIfChanged();
    return this.list;
  }

  stats(): { count: number; skipped: number; error: string | null; file: string } {
    this.reloadIfChanged();
    return { count: this.list.length, skipped: this.skipped, error: this.error, file: this.file };
  }

  private ensureDir(): void {
    mkdirSync(path.dirname(path.resolve(this.file)), { recursive: true });
  }

  private write(body: string): void {
    this.ensureDir();
    if (existsSync(this.file)) copyFileSync(this.file, `${this.file}.bak`);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, this.file);
    this.reload();
  }

  /** Дописать строку в конец файла (создаёт файл с заголовком, если его не было). */
  append(entry: PersonalEntry): void {
    this.ensureDir();
    const exists = existsSync(this.file);
    const current = exists ? decodeText(readFileSync(this.file)) : "";
    const delimiter = exists && current.trim() ? detectDelimiter(current.replace(/^﻿/, "")) : ";";
    const head = exists && current.trim() ? (current.endsWith("\n") ? "" : "\n") : `${HEADER(delimiter)}\n`;
    writeFileSync(this.file, `${exists && current.trim() ? current : ""}${head}${personalLine(entry, delimiter)}\n`, "utf8");
    this.reload();
  }

  /** Заменить файл целиком (прислали из бота). Пустой не принимает; старый — рядом как .bak. */
  replace(content: string): PersonalParseResult {
    const parsed = parsePersonal(content);
    if (parsed.entries.length) this.write(content.replace(/^﻿/, ""));
    return parsed;
  }

  /** Удалить все строки этого человека («@ник» или id). */
  remove(who: string): number {
    const w = parseWho(who);
    if (!w) return 0;
    return this.rewrite((e) => !(w.username !== null ? e.username === w.username : e.userId === w.userId));
  }

  /** Удалить строку по номеру в списке /qp (с единицы). */
  removeAt(n: number): number {
    return this.rewrite((_e, i) => i !== n - 1);
  }

  private rewrite(keepIf: (e: PersonalEntry, i: number) => boolean): number {
    this.reload();
    // Пересборка из разобранных строк молча выбросила бы неразобранные.
    if (this.skipped > 0) throw new Error(`в файле есть строки, которые бот не разобрал (${this.skipped}); удали строку в самом файле`);
    const all = this.list;
    const keep = all.filter(keepIf);
    const removed = all.length - keep.length;
    if (!removed) return 0;
    const d = this.delimiter;
    this.write([HEADER(d), ...keep.map((e) => personalLine(e, d))].join("\n") + "\n");
    return removed;
  }

  raw(): string | null {
    return existsSync(this.file) ? decodeText(readFileSync(this.file)) : null;
  }
}
