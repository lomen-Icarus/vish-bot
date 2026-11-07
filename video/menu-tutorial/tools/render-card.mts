/**
 * Карточка дня для кадров 01/02 — тем же кодом, что рисует бот.
 * Запуск из корня репозитория:
 *   npx tsx video/menu-tutorial/tools/render-card.mts video/menu-tutorial/source/card-sunday-vish-67-67.png
 */
import { writeFileSync } from "node:fs";
import { createThemedRenderer } from "../../../src/render/themes.js";
import type { LogicalGroup } from "../../../src/schedule/groups.js";
import { wallClock, type LocalDate } from "../../../src/time.js";

const out = process.argv[2];
if (!out) throw new Error("usage: render-card.mts <out.png>");

const renderer = await createThemedRenderer("midnight");
if (!renderer) throw new Error("renderer unavailable");

const group: LogicalGroup = {
  key: "ВИШ-67-67",
  title: "ВИШ-67-67",
  prefix: "ВИШ",
  number: 67,
  intake: 67,
  course: 1,
  portalIds: [],
  portalNames: [],
};
// воскресенье 8 ноября 2026, 06:00 МСК (03:00 UTC), 10-я (чётная) неделя
const now = wallClock(new Date("2026-11-08T03:00:00Z"));
const date: LocalDate = now.date;

const png = await renderer.renderDay({
  group,
  date,
  lessons: [],
  weekInfo: { week: 10, parity: "even", semester: 1 },
  today: date, // в ролике пользователь отправил /today
  now,
});
writeFileSync(out, png);
console.log(`card -> ${out}`);
