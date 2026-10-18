/**
 * Имя PDF со слайдами в Telegram: «2026-09-29-Безопасность жизнедеятельности.pdf».
 * Одно на рассылку и на «скинь слайды» в чате — чтобы файл одной записи не
 * назывался по-разному в зависимости от того, как он пришёл. Часть большого
 * PDF — «…-часть 2.pdf»: иначе у частей одно имя и их не различить.
 */
export function deckFileName(deck: { date: string; subject: string; title?: string | null }): string {
  const subject = deck.subject.replace(/[^\p{L}\p{N} .-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 50).trim();
  const part = deckPart(deck.title);
  return `${deck.date}-${subject || "slides"}${part ? `-часть ${part.index}` : ""}.pdf`;
}

/**
 * Номер части: записывалка делит PDF больше лимита Telegram и пишет в тему
 * «… · часть 2 из 3» (recorder/src/deliver.ts).
 */
export function deckPart(title: string | null | undefined): { index: number; count: number } | null {
  // Только в конце: тема с портала сама бывает «Интегралы (часть 1 из 2)».
  const m = /(?:^|· )часть (\d+) из (\d+)$/.exec(title ?? "");
  return m ? { index: Number(m[1]), count: Number(m[2]) } : null;
}

/** « · ч. 2/3» для подписей и кнопок; у целого PDF — пусто. */
export function deckPartLabel(title: string | null | undefined): string {
  const part = deckPart(title);
  return part ? ` · ч. ${part.index}/${part.count}` : "";
}

/**
 * Новые раньше — по дате пары, а не по порядку записи: недоставленная пачка
 * бывает добавлена позже. Внутри дня — позже записанная пара первой; части
 * одной пары — подряд и по порядку: 1, 2, 3 (по id последней шла бы часть 3).
 * Общий для «слайды…» в личке и в чате.
 */
export function newestFirst<T extends { id: number; date: string; subject: string; title?: string | null }>(decks: T[]): T[] {
  const pair = (d: T): string => `${d.date}|${d.subject}`;
  const latest = new Map<string, number>();
  for (const d of decks) latest.set(pair(d), Math.max(latest.get(pair(d)) ?? 0, d.id));
  return [...decks].sort(
    (a, b) => b.date.localeCompare(a.date) || latest.get(pair(b))! - latest.get(pair(a))! || (deckPart(a.title)?.index ?? 0) - (deckPart(b.title)?.index ?? 0) || b.id - a.id,
  );
}
