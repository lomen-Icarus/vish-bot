/**
 * Минимальный читатель xlsx без зависимостей: xlsx — это zip с XML внутри.
 * Общий для скриптов, которые собирают файлы реестра для сервера.
 */
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

// ---------- минимальный читатель zip (xlsx — это zip) ----------
export function unzip(file) {
  const buf = readFileSync(file);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error(`${file}: это не xlsx (не найден конец zip-архива)`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compressedSize);
    out.set(name, () => (method === 0 ? raw : inflateRawSync(raw)));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

// ---------- разбор xlsx ----------
export const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

export const textOf = (xml) => [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join("");

export function sharedStrings(zip) {
  const entry = zip.get("xl/sharedStrings.xml");
  if (!entry) return [];
  const xml = entry().toString("utf8");
  // Пустая строка пишется как <si/>: если её пропустить, все следующие индексы
  // съедут на единицу и таблица прочитается чужими значениями.
  return [...xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) => textOf(m[1] ?? ""));
}

export function sheetPaths(zip) {
  const wb = zip.get("xl/workbook.xml")?.().toString("utf8") ?? "";
  const rels = zip.get("xl/_rels/workbook.xml.rels")?.().toString("utf8") ?? "";
  const byId = new Map([...rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const out = [];
  for (const m of wb.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)) {
    // Target бывает относительным («worksheets/sheet1.xml») и абсолютным («/xl/worksheets/sheet1.xml»).
    const target = (byId.get(m[2]) ?? "").replace(/^\/+/, "");
    out.push({ name: unescapeXml(m[1]), path: target.startsWith("xl/") ? target : `xl/${target}` });
  }
  return out;
}

/** Строки листа как массив объектов {A: "…", B: "…"}. */
export function sheetRows(zip, path, strings) {
  const entry = zip.get(path);
  if (!entry) return [];
  const xml = entry().toString("utf8");
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    // Атрибут r у ячейки необязателен: тогда считаем колонки по порядку.
    let cursor = 0;
    // Пустые ячейки записаны как <c r="B7" s="17"/>: без разбора самозакрывающихся
    // тегов регулярка съедала соседние ячейки и строка теряла группу.
    for (const c of rowMatch[1].matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const inner = c[2] ?? "";
      const col = /r="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? columnName(cursor);
      cursor = columnIndex(col) + 1;
      const type = /t="([^"]+)"/.exec(attrs)?.[1];
      let value = "";
      if (type === "s") {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? -1);
        value = strings[idx] ?? "";
      } else if (type === "inlineStr") {
        value = textOf(inner);
      } else {
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "");
      }
      cells[col] = value.replace(/\s+/g, " ").trim();
    }
    rows.push(cells);
  }
  return rows;
}

/** «A» → 0, «B» → 1, «AA» → 26. */
export function columnIndex(name) {
  let n = 0;
  for (const ch of name) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function columnName(index) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out || "A";
}


/** «СИДОРОВ СИДОР» → «Сидоров Сидор», дефисные части тоже с заглавной. */
export function titleCase(name) {
  if (name !== name.toUpperCase()) return name;
  return name.toLowerCase().replace(/(^|[\s-])([а-яёa-z])/gu, (_, sep, ch) => sep + ch.toUpperCase());
}

/** Ключ сравнения ФИО: регистр, «ё» и лишние пробелы значения не имеют. */
export const norm = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
