import { InlineKeyboard, Keyboard } from "grammy";
import type { LogicalGroup } from "../schedule/groups.js";
import type { User } from "../db/repo.js";
import { addDays, fmtDDMM, type LocalDate } from "../time.js";

export const BTN = {
  today: "📅 Сегодня",
  tomorrow: "📅 Завтра",
  otherGroups: "👥 Др. группы",
  week: "🗓 Неделя",
  nextWeek: "🗓 Следующая",
  stream: "🎓 Поток",
  changes: "🔔 Изменения",
  calendar: "📆 Календарь",
  teachers: "👨‍🏫 Преподаватели",
  features: "🧭 Функции",
  search: "🔍 Поиск",
  settings: "⚙️ Настройки",
  ask: "💬 Спросить",
  suggest: "📨 Отправить новость",
  // stream mode
  streamYesterday: "Поток: вчера",
  streamToday: "Поток: сегодня",
  streamTomorrow: "Поток: завтра",
  streamWeek: "Поток: неделя",
  streamCommon: "🤝 Общие пары",
  backToMenu: "◀️ В меню",
} as const;

/** 4 × 3 main menu, order agreed with the customer. */
export function mainKeyboard(): Keyboard {
  return new Keyboard()
    .text(BTN.today)
    .text(BTN.tomorrow)
    .text(BTN.otherGroups)
    .row()
    .text(BTN.week)
    .text(BTN.nextWeek)
    .text(BTN.stream)
    .row()
    .text(BTN.changes)
    .text(BTN.calendar)
    .text(BTN.teachers)
    .row()
    .text(BTN.features)
    .text(BTN.search)
    .text(BTN.settings)
    .resized()
    .persistent();
}

export function streamKeyboard(): Keyboard {
  return new Keyboard()
    .text(BTN.streamYesterday)
    .text(BTN.streamToday)
    .text(BTN.streamTomorrow)
    .row()
    .text(BTN.streamWeek)
    .text(BTN.streamCommon)
    .row()
    .text(BTN.settings)
    .text(BTN.backToMenu)
    .resized()
    .persistent();
}

export function intakePicker(intakes: number[], selected: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const i of intakes) kb.text(`${i === selected ? "✅ " : ""}20${i}`, `si:${i}`);
  return kb;
}

export function groupLabel(g: LogicalGroup): string {
  return g.title.replace(/^ВИШ-/, "").replace(/^ОЗВИШ-/, "оз ").replace(/\s*\((.*?)\)\s*$/, " $1");
}

/** Group picker grouped by course; callback "<prefix>:<key>". */
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
      const label = groupLabel(g);
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

/**
 * Day navigation. Without `peekKey` the callbacks act on the user's own group
 * ("d:<date>"); with it they carry the group key ("pd:<key>:<date>").
 */
export function dayNav(date: LocalDate, today: LocalDate, opts: { image: boolean; peekKey?: string }): InlineKeyboard {
  const d = (x: LocalDate) => (opts.peekKey ? `pd:${opts.peekKey}:${x}` : `d:${x}`);
  const w = (x: LocalDate) => (opts.peekKey ? `pw:${opts.peekKey}:${x}` : `w:${x}`);
  const kb = new InlineKeyboard().text(`◀️ ${fmtDDMM(addDays(date, -1))}`, d(addDays(date, -1)));
  if (date !== today) kb.text("сегодня", d(today));
  kb.text(`${fmtDDMM(addDays(date, 1))} ▶️`, d(addDays(date, 1))).row();
  kb.text("🗓 Неделя", w(date));
  if (opts.image) kb.text("🖼 Картинкой", opts.peekKey ? `pimg:${opts.peekKey}:${date}` : `img:${date}`);
  if (opts.peekKey) kb.row().text("✅ Сделать моей группой", `g:${opts.peekKey}`);
  return kb;
}

export function weekNav(monday: LocalDate, opts: { image: boolean; peekKey?: string }): InlineKeyboard {
  const w = (x: LocalDate) => (opts.peekKey ? `pw:${opts.peekKey}:${x}` : `w:${x}`);
  const d = (x: LocalDate) => (opts.peekKey ? `pd:${opts.peekKey}:${x}` : `d:${x}`);
  const kb = new InlineKeyboard()
    .text("◀️ пред.", w(addDays(monday, -7)))
    .text("текущая", opts.peekKey ? `pw:${opts.peekKey}:today` : "w:today")
    .text("след. ▶️", w(addDays(monday, 7)))
    .row()
    .text("📅 День", d(monday));
  if (opts.image) kb.text("🖼 Картинкой", opts.peekKey ? `pwimg:${opts.peekKey}:${monday}` : `wimg:${monday}`);
  if (!opts.peekKey) kb.text("📆 В календарь", "ics:menu");
  return kb;
}

export function teacherDayNav(teacherId: number, date: LocalDate, today: LocalDate): InlineKeyboard {
  const kb = new InlineKeyboard().text(`◀️ ${fmtDDMM(addDays(date, -1))}`, `td:${teacherId}:${addDays(date, -1)}`);
  if (date !== today) kb.text("сегодня", `td:${teacherId}:${today}`);
  kb.text(`${fmtDDMM(addDays(date, 1))} ▶️`, `td:${teacherId}:${addDays(date, 1)}`).row();
  kb.text("🗓 Неделя", `tw:${teacherId}:${date}`).text("🔎 Другой", "t:search");
  return kb;
}

export function teacherWeekNav(teacherId: number, monday: LocalDate): InlineKeyboard {
  return new InlineKeyboard()
    .text("◀️ пред.", `tw:${teacherId}:${addDays(monday, -7)}`)
    .text("след. ▶️", `tw:${teacherId}:${addDays(monday, 7)}`)
    .row()
    .text("📅 День", `td:${teacherId}:${monday}`)
    .text("🔎 Другой", "t:search");
}

/** Stream day: date arrows, optional poster button, and one tiny button per group of the stream. */
export function streamDayNav(date: LocalDate, today: LocalDate, opts: { image: boolean; groups?: LogicalGroup[] } = { image: false }): InlineKeyboard {
  const kb = new InlineKeyboard().text(`◀️ ${fmtDDMM(addDays(date, -1))}`, `sd:${addDays(date, -1)}`);
  if (date !== today) kb.text("сегодня", `sd:${today}`);
  kb.text(`${fmtDDMM(addDays(date, 1))} ▶️`, `sd:${addDays(date, 1)}`);
  if (opts.image) kb.row().text("🖼 Картинкой", `simg:${date}`);
  if (opts.groups?.length) {
    kb.row();
    for (const g of opts.groups) kb.text(String(g.number) + (g.title.includes("(") ? ` ${groupLabel(g).split(" ").slice(1).join(" ").slice(0, 5)}` : ""), `pd:${g.key}:${date}`);
  }
  return kb;
}

const onoff = (v: boolean) => (v ? "вкл ✅" : "выкл ◻️");

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
  kb.text(`💻 Дистант, ссылка на вебинар: ${minutesLabel(user.remindDistanceMin)}`, "s:distance").row();
  kb.text(`🌙 Вечером на завтра: ${user.eveningAt ?? "выкл"}`, "s:evening").row();
  kb.text(`🤫 Тихие часы: ${user.quietFrom ? `${user.quietFrom}–${user.quietTo}` : "выкл"}`, "s:quiet").row();
  for (const t of opts.topics) kb.text(`${user.topics.includes(t) ? "✅" : "▫️"} ${TOPIC_LABELS[t] ?? t}`, `s:topic:${t}`);
  if (opts.topics.length) kb.row();
  kb.text(`👀 Следить за другими группами${opts.watchCount ? ` (${opts.watchCount})` : ""}`, "s:watch").row();
  kb.text("✖️ Закрыть", "s:close");
  return kb;
}

export const TOPICS = ["contests", "announcements", "events"] as const;
export type Topic = (typeof TOPICS)[number];
export const TOPIC_LABELS: Record<string, string> = {
  contests: "Конкурсы и стипендии",
  announcements: "Объявления",
  events: "События ВИШ",
};
export const TOPIC_HINTS: Record<string, string> = {
  contests: "конкурсы, конференции, гранты, стипендии и другие возможности",
  announcements: "срочное и важное: дистант, отмены, дедлайны, изменения в учёбе",
  events: "жизнь школы: Тайный Санта, Масленица, защиты проектов, встречи",
};

/** Hashtags that route a channel post to a topic. */
export const TOPIC_HASHTAGS: Record<Topic, RegExp> = {
  contests: /#(конкурс|конкурсы|стипенди\w*|конференци\w*|грант\w*|олимпиад\w*|хакатон\w*|возможност\w*)/iu,
  announcements: /#(объявлени\w*|срочно|важно|дистант\w*|отмена|дедлайн\w*)/iu,
  events: /#(событи\w*|мероприят\w*|санта|масленица|защит\w*|праздник\w*|встреча)/iu,
};

export function onboardingKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✅ Включить рекомендуемые", "ob:on").row().text("⚙️ Настроить самому", "ob:custom").text("Позже", "ob:later");
}

export const WEBINAR_URL = "https://tt.chuvsu.ru/webinar";
