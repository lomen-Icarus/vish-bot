/**
 * Текст файла, который положили на хостинг руками: UTF-8 (с BOM или без) или
 * Windows-1251 — так CSV сохраняет русский Excel. Строгий UTF-8 на cp1251
 * падает, и тогда читаем как cp1251; иначе вместо ФИО получались «������».
 */
export function decodeText(buf: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1251").decode(buf);
  }
}
