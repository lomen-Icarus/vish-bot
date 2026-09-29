/**
 * Имя PDF со слайдами в Telegram: «2026-09-29-Безопасность жизнедеятельности.pdf».
 * Одно на рассылку и на «скинь слайды» в чате — чтобы файл одной записи не
 * назывался по-разному в зависимости от того, как он пришёл.
 */
export function deckFileName(deck: { date: string; subject: string }): string {
  const subject = deck.subject.replace(/[^\p{L}\p{N} .-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 50).trim();
  return `${deck.date}-${subject || "slides"}.pdf`;
}
