/**
 * Геометрия кадра. Без зависимостей: тесты бота импортируют это напрямую, а
 * playwright-core у них не установлен.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Кадр чуть шире области презентации: на pad вверх и вниз, в пределах окна.
 * Ширину не трогаем — по бокам у BBB чат и участники.
 */
export function padClip(box: Box, pad: number, viewport: { width: number; height: number }): Box {
  const p = Math.max(0, pad);
  const y = Math.max(0, box.y - p);
  const bottom = Math.min(viewport.height, box.y + box.height + p);
  return { x: Math.max(0, box.x), y, width: Math.min(box.width, viewport.width - Math.max(0, box.x)), height: Math.max(1, bottom - y) };
}
