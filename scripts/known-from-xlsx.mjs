#!/usr/bin/env node
/**
 * Собирает файл «кого бот узнаёт в лицо»: ФИО + телеграм-ник из выгрузки
 * старост. Нужен только для приветствия по имени на /start.
 *
 *   node scripts/known-from-xlsx.mjs data/known.csv data/students.csv реестр-телеграм.xlsx
 *
 * Правила жёсткие и намеренные:
 *  • берутся ТОЛЬКО те люди, которые уже есть в реестре поиска (students.csv);
 *  • ник берётся, только если он в книге есть — ничего не додумывается;
 *  • ник в поиск студентов не попадает: это отдельный файл, и справочник
 *    поиска его не читает (см. src/students/known.ts);
 *  • ни одного имени и ника в консоль не печатается, только счётчики.
 *
 * Готовый CSV в git не кладётся (data/ в .gitignore) — он едет на сервер.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { norm, sharedStrings, sheetPaths, sheetRows, titleCase, unzip } from "./xlsx.mjs";

const NAME_RE = /^[А-ЯЁ][А-Яа-яЁё-]*[А-Яа-яЁё](\s+[А-ЯЁ][А-Яа-яЁё-]*[А-Яа-яЁё]?){1,3}$/u;
const TG_HEADERS = ["telegram", "телеграм", "телеграмм", "тг", "tg", "ник", "username"];

/** «https://t.me/@wakkki», «@wakkki», «wakkki» → «wakkki». Мусор → null. */
export function telegramHandle(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  const m = /^(?:https?:\/\/)?(?:t(?:elegram)?\.me\/)?@?([A-Za-z0-9_]{4,32})\/?$/.exec(v);
  return m ? m[1].toLowerCase() : null;
}

/** Колонки «ФИО» и «Telegram» по строке-заголовку листа. */
function headerColumns(row) {
  let name = null;
  let tg = null;
  for (const [col, value] of Object.entries(row)) {
    const v = norm(value).replace(/:$/, "");
    if (!tg && TG_HEADERS.includes(v)) tg = col;
    // Заголовком колонки с людьми обычно стоит название группы («ВИШ-12-23»).
    if (!name && (v === "фио" || v.startsWith("фамилия") || v === "студент" || /^(оз)?виш/.test(v))) name = col;
  }
  return name && tg ? { name, tg } : null;
}

function registry(file) {
  const out = new Set();
  for (const line of readFileSync(file, "utf8").split(/\r?\n/).slice(1)) {
    const fio = line.split(";")[0]?.trim();
    if (fio) out.add(norm(fio));
  }
  return out;
}

function main() {
  const [out, students, ...files] = process.argv.slice(2);
  if (!out || !students || !files.length) {
    console.error("Использование: node scripts/known-from-xlsx.mjs <known.csv> <students.csv> <file1.xlsx …>");
    process.exit(2);
  }
  const known = registry(students);
  const people = new Map(); // ключ: нормализованное ФИО
  let outside = 0;
  let noHandle = 0;
  let broken = 0;
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
        if (!NAME_RE.test(raw)) continue;
        const name = titleCase(raw);
        const key = norm(name);
        // Человека нет в реестре поиска — значит, и узнавать его не нужно.
        if (!known.has(key)) {
          outside++;
          continue;
        }
        const cell = row[cols.tg] ?? "";
        if (!cell) {
          noHandle++;
          continue;
        }
        const handle = telegramHandle(cell);
        if (!handle) {
          broken++;
          continue;
        }
        if (!people.has(key)) taken++;
        people.set(key, { name, handle });
      }
      if (cols) console.log(`  ${file} → «${sheet.name}»: ${taken} записей`);
    }
  }
  // Один ник — один человек: если ник встретился дважды, узнавать по нему
  // некого, и обе записи выбрасываются, чтобы бот не назвал чужим именем.
  const byHandle = new Map();
  for (const p of people.values()) byHandle.set(p.handle, (byHandle.get(p.handle) ?? 0) + 1);
  const list = [...people.values()].filter((p) => byHandle.get(p.handle) === 1).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const dropped = people.size - list.length;
  writeFileSync(out, ["ФИО;Телеграм", ...list.map((p) => `${p.name};${p.handle}`)].join("\n") + "\n", "utf8");
  console.log(`\n${list.length} человек с ником. Пропущено: нет в реестре поиска — ${outside}, без ника — ${noHandle}, ник не разобрался — ${broken}, ник на двоих — ${dropped}.`);
  console.log(`Готово: ${out}. В git не кладём — файл едет на сервер (KNOWN_DB).`);
}

main();
