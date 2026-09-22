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
import { writeFileSync } from "node:fs";
import { norm, sharedStrings, sheetPaths, sheetRows, titleCase, unzip } from "./xlsx.mjs";

// ---------- что считаем человеком и группой ----------
// Двойные фамилии («Кузнецов-Смирнов») и выгрузки капсом тоже люди.
const NAME_RE = /^[А-ЯЁ][А-Яа-яЁё-]*[А-Яа-яЁё](\s+[А-ЯЁ][А-Яа-яЁё-]*[А-Яа-яЁё]?){1,3}$/u;
const GROUP_RE = /^(ОЗ)?ВИШ[\s-]*(\d{1,2})[\s-]*(\d{2})\s*(иот)?\s*(\([^)]*\))?\s*$/iu;
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
        const raw = row[cols.name] ?? "";
        const group = canonicalGroup(row[cols.group] ?? "");
        if (!group || !NAME_RE.test(raw)) continue;
        const name = titleCase(raw);
        const key = norm(name);
        const prev = students.get(key);
        if (prev) {
          if (norm(prev.group) === norm(group)) continue; // та же запись
          if (prev.file !== file) {
            // Один человек в разных книгах с разными группами: верим первой.
            conflicts++;
            continue;
          }
          // Внутри одной книги это два РАЗНЫХ человека с одинаковым ФИО —
          // оба должны попасть в справочник, иначе один просто исчезнет.
          students.set(`${key}|${norm(group)}`, { name, group, file });
          taken++;
          continue;
        }
        students.set(key, { name, group, file });
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
