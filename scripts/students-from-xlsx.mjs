#!/usr/bin/env node
/**
 * Собирает справочник студентов (ФИО + группа) для глобального поиска из
 * выгрузок Excel и пишет CSV, который кладётся на сервер в POISK_DB.
 *
 *   node scripts/students-from-xlsx.mjs data/students.csv реестр.xlsx база.xlsx
 *
 * Из книги берутся ТОЛЬКО два столбца — ФИО и группа. Телефоны, почты, баллы,
 * документы и всё остальное не читаются и в файл не попадают. Имена нигде не
 * печатаются: в консоль идёт только статистика.
 *
 * Если один человек встречается в нескольких книгах с разными группами,
 * выигрывает та, что встретилась раньше, поэтому первым аргументом ставьте
 * самый свежий и достоверный реестр.
 *
 * Готовый CSV в репозиторий не коммитится (папка data/ в .gitignore).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

// ---------- минимальный читатель zip (xlsx — это zip) ----------
function unzip(file) {
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
const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");

const textOf = (xml) => [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1])).join("");

function sharedStrings(zip) {
  const entry = zip.get("xl/sharedStrings.xml");
  if (!entry) return [];
  const xml = entry().toString("utf8");
  return [...xml.matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
}

function sheetPaths(zip) {
  const wb = zip.get("xl/workbook.xml")?.().toString("utf8") ?? "";
  const rels = zip.get("xl/_rels/workbook.xml.rels")?.().toString("utf8") ?? "";
  const byId = new Map([...rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1], m[2]]));
  const out = [];
  for (const m of wb.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)) {
    const target = byId.get(m[2]) ?? "";
    out.push({ name: unescapeXml(m[1]), path: target.startsWith("xl/") ? target : `xl/${target.replace(/^\/+/, "")}` });
  }
  return out;
}

/** Строки листа как массив объектов {A: "…", B: "…"}. */
function sheetRows(zip, path, strings) {
  const entry = zip.get(path);
  if (!entry) return [];
  const xml = entry().toString("utf8");
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    // Пустые ячейки записаны как <c r="B7" s="17"/>: без разбора самозакрывающихся
    // тегов регулярка съедала соседние ячейки и строка теряла группу.
    for (const c of rowMatch[1].matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const inner = c[2] ?? "";
      const col = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      if (!col) continue;
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

// ---------- что считаем человеком и группой ----------
const NAME_RE = /^[А-ЯЁ][а-яё-]+(\s+[А-ЯЁ][а-яё-]+){1,3}$/u;
const GROUP_RE = /^(ОЗ)?ВИШ[\s-]*(\d{1,2})[\s-]*(\d{2})\s*(иот)?\s*(\([^)]*\))?\s*$/iu;
const norm = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();

function canonicalGroup(raw) {
  const m = GROUP_RE.exec(raw);
  if (!m) return null;
  const prefix = `${m[1] ? "ОЗ" : ""}ВИШ`;
  const qualifier = m[5] ? ` ${m[5]}` : "";
  return `${prefix}-${Number(m[2])}-${m[3]}${m[4] ? "иот" : ""}${qualifier}`;
}

/** Колонки ФИО и группы по строке заголовка. */
function headerColumns(row) {
  let name = null;
  let group = null;
  for (const [col, value] of Object.entries(row)) {
    const v = norm(value);
    if (!name && (v === "фио" || v.startsWith("фамилия") || v === "студент")) name = col;
    if (!group && (v === "группа" || v === "учебная группа")) group = col;
  }
  return name && group ? { name, group } : null;
}

function main() {
  const [out, ...files] = process.argv.slice(2);
  if (!out || !files.length) {
    console.error("Использование: node scripts/students-from-xlsx.mjs <output.csv> <file1.xlsx> [file2.xlsx …]");
    process.exit(2);
  }
  const students = new Map(); // ключ: нормализованное ФИО
  let conflicts = 0;
  for (const file of files) {
    const zip = unzip(file);
    const strings = sharedStrings(zip);
    for (const sheet of sheetPaths(zip)) {
      const rows = sheetRows(zip, sheet.path, strings);
      let cols = null;
      let taken = 0;
      for (const row of rows) {
        if (!cols) {
          cols = headerColumns(row);
          continue;
        }
        const name = row[cols.name] ?? "";
        const group = canonicalGroup(row[cols.group] ?? "");
        if (!group || !NAME_RE.test(name)) continue;
        const key = norm(name);
        const prev = students.get(key);
        if (prev) {
          if (norm(prev.group) !== norm(group)) conflicts++;
          continue; // первая книга в списке главнее
        }
        students.set(key, { name, group });
        taken++;
      }
      if (cols) console.log(`  ${file} → «${sheet.name}»: ${taken} записей`);
    }
  }
  const list = [...students.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const csv = ["ФИО;Группа", ...list.map((s) => `${s.name};${s.group}`)].join("\n") + "\n";
  writeFileSync(out, csv, "utf8");
  const byGroup = new Map();
  for (const s of list) byGroup.set(s.group, (byGroup.get(s.group) ?? 0) + 1);
  console.log(`\n${list.length} студентов, ${byGroup.size} групп, расхождений по группе: ${conflicts}`);
  for (const [group, n] of [...byGroup.entries()].sort()) console.log(`  ${group}: ${n}`);
  console.log(`\nГотово: ${out}. Этот файл в git не кладём — он едет прямо на сервер (POISK_DB).`);
}

main();
