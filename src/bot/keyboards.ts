import { InlineKeyboard, Keyboard } from "grammy";
import type { LogicalGroup } from "../schedule/groups.js";
import type { User } from "../db/repo.js";
import { addDays, fmtDDMM, type LocalDate } from "../time.js";

export const BTN = {
  today: "📅 Сегодня",
  tomorrow: "📅 Завтра",
  week: "🗓 Неделя",
  nextWeek: "🗓 Следующая",
  changes: "🔔 Изменения",
  settings: "⚙️ Настройки",
  suggest: "📨 Предложить новость",
  ask: "💬 Спросить",
} as const;

export function mainKeyboard(opts: { ask: boolean; suggest: boolean }): Keyboard {
  const kb = new Keyboard().text(BTN.today).text(BTN.tomorrow).row().text(BTN.week).text(BTN.nextWeek).row().text(BTN.changes).text(BTN.settings);
  if (opts.suggest || opts.ask) {
    kb.row();
    if (opts.suggest) kb.text(BTN.suggest);
    if (opts.ask) kb.text(BTN.ask);
  }
  return kb.resized().persistent();
}

/** Group picker grouped by course; callback "g:<key>". */
export function groupPicker(groups: LogicalGroup[], opts: { prefix?: string; selected?: string | null } = {}): InlineKeyboard {
  const kb = new InlineKeyboard();
  const cb = opts.prefix ?? "g";
  const byCourse = new Map<string, LogicalGroup[]>();
  for (const g of groups) {
    const section = g.prefix === "ВИШ" ? `${g.course} курс` : `${g.prefix} (${g.course} курс)`;
    const list = byCourse.get(section) ?? [];
    list.push(g);
    byCourse.set(section, list);
  }
  for (const [section, list] of byCourse) {
    kb.text(`— ${section} —`, "noop").row();
    let inRow = 0;
    for (const g of list) {
      const mark = opts.selected === g.key ? "✅ " : "";
      const label = g.title.replace(/^ВИШ-/, "").replace(/^ОЗВИШ-/, "оз ");
      kb.text(`${mark}${label}`, `${cb}:${g.key}`);
      inRow++;
      const wide = label.length > 8;
      if (inRow >= (wide ? 2 : 3)) {
        kb.row();
        inRow = 0;
      }
    }
    if (inRow) kb.row();
  }
  return kb;
}

export function dayNav(date: LocalDate, today: LocalDate, opts: { image: boolean }): InlineKeyboard {
  const kb = new InlineKeyboard().text(`◀️ ${fmtDDMM(addDays(date, -1))}`, `d:${addDays(date, -1)}`);
  if (date !== today) kb.text("сегодня", `d:${today}`);
  kb.text(`${fmtDDMM(addDays(date, 1))} ▶️`, `d:${addDays(date, 1)}`).row();
  kb.text("🗓 Неделя", `w:${date}`);
  if (opts.image) kb.text("🖼 Картинкой", `img:${date}`);
  return kb;
}

export function weekNav(monday: LocalDate, opts: { image: boolean }): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("◀️ пред.", `w:${addDays(monday, -7)}`)
    .text("текущая", `w:today`)
    .text("след. ▶️", `w:${addDays(monday, 7)}`)
    .row()
    .text("📅 День", `d:${monday}`);
  if (opts.image) kb.text("🖼 Картинкой", `wimg:${monday}`);
  return kb;
}

const onoff = (v: boolean) => (v ? "вкл ✅" : "выкл ❌");

export function minutesLabel(min: number | null): string {
  if (min == null) return "выкл";
  if (min % 60 === 0) return `${min / 60} ч`;
  return `${min} мин`;
}

export function settingsKeyboard(user: User, group: LogicalGroup | null, opts: { topics: string[]; hasImages: boolean; watchCount: number }): InlineKeyboard {
  const kb = new InlineKeyboard();
  kb.text(`👥 Группа: ${group?.title ?? "не выбрана"}`, "s:group").row();
  kb.text(`🔢 Подгруппа: ${user.subgroup ? `${user.subgroup}` : "все"}`, "s:subgroup");
  if (opts.hasImages) kb.text(`🖼 Формат: ${{ text: "текст", image: "картинка", both: "оба" }[user.format]}`, "s:format");
  kb.row();
  kb.text(`🔔 Изменения: ${onoff(user.notifyChanges)}`, "s:changes").text(`🎓 Сессия: ${onoff(user.notifySession)}`, "s:session").row();
  kb.text(`⏰ До первой пары: ${minutesLabel(user.remindFirstMin)}`, "s:first").row();
  kb.text(`⏱ Перед каждой парой: ${minutesLabel(user.remindEachMin)}`, "s:each").row();
  kb.text(`🌙 Вечером на завтра: ${user.eveningAt ?? "выкл"}`, "s:evening").row();
  kb.text(`🤫 Тихие часы: ${user.quietFrom ? `${user.quietFrom}–${user.quietTo}` : "выкл"}`, "s:quiet").row();
  kb.text(`📢 Объявления портала: ${onoff(user.notifyNotices)}`, "s:notices").row();
  for (const t of opts.topics) kb.text(`${user.topics.includes(t) ? "✅" : "▫️"} ${TOPIC_LABELS[t] ?? t}`, `s:topic:${t}`);
  if (opts.topics.length) kb.row();
  kb.text(`👀 Следить за другими группами${opts.watchCount ? ` (${opts.watchCount})` : ""}`, "s:watch").row();
  kb.text("✖️ Закрыть", "s:close");
  return kb;
}

export const TOPICS = ["contests", "announcements", "events"] as const;
export const TOPIC_LABELS: Record<string, string> = {
  contests: "Конкурсы и стипендии",
  announcements: "Объявления",
  events: "События ВИШ",
};

export function onboardingKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✅ Включить рекомендуемые", "ob:on").row().text("⚙️ Настроить самому", "ob:custom").text("Позже", "ob:later");
}
