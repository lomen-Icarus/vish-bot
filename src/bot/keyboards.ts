import { InlineKeyboard, Keyboard } from "grammy";
import type { LogicalGroup } from "../schedule/groups.js";
import type { User } from "../db/repo.js";
import { isTheme, THEME_LABELS } from "../render/themes.js";
import { addDays, fmtDDMM, type LocalDate } from "../time.js";

export const BTN = {
  today: "📅 Сегодня",
  tomorrow: "📅 Завтра",
  otherGroups: "👥 Др. группы",
  /** Та же кнопка в режиме преподавателя: расписание любой группы. */
  students: "👥 Студенты",
  week: "🗓 Неделя",
  nextWeek: "🗓 Следующая",
  stream: "🎓 Поток",
  changes: "🔔 Изменения",
  calendar: "📆 Календарь",
  teachers: "👨‍🏫 Преподаватели",
  features: "🧭 Функции",
  search: "🔍 ИИ поисковик",
  settings: "⚙️ Настройки",
  ask: "💬 Спросить",
  suggest: "📨 Отправить новость",
  // stream mode
  streamYesterday: "Поток: вчера",
  streamToday: "Поток: сегодня",
  streamTomorrow: "Поток: завтра",
  streamWeek: "Поток: неделя",
  streamCommon: "🤝 Общие пары",
  whereStudent: "🕵️ Где студент",
  backToMenu: "◀️ В меню",
} as const;

/**
 * Старые подписи кнопок. Нижнее меню живёт в чате, пока его не заменит новое,
 * поэтому у кого-то ещё висит прежняя кнопка — она должна работать как раньше.
 */
export const LEGACY_BTN = {
  search: "🔍 Поиск",
} as const;

/** Every label of the reply keyboards; a pending flow must never swallow one. */
export const MENU_TEXTS: ReadonlySet<string> = new Set([...Object.values(BTN), ...Object.values(LEGACY_BTN)]);

export function isMenuText(text: string | undefined): boolean {
  return !!text && MENU_TEXTS.has(text.trim());
}

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

/**
 * Меню режима преподавателя: то же самое, только третья кнопка — «Студенты»
 * (расписание любой группы), а «Сегодня / Завтра / Неделя» — его собственные пары.
 */
export function teacherKeyboard(): Keyboard {
  return new Keyboard()
    .text(BTN.today)
    .text(BTN.tomorrow)
    .text(BTN.students)
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

/** Нижнее меню этого человека: обычное или режима преподавателя. */
export function menuFor(user: Pick<User, "teacherMode"> | null | undefined): Keyboard {
  return user?.teacherMode ? teacherKeyboard() : mainKeyboard();
}

/** `poisk` добавляет кнопку глобального поиска студента (POISK=TRUE). */
export function streamKeyboard(opts: { poisk?: boolean } = {}): Keyboard {
  const kb = new Keyboard().text(BTN.streamYesterday).text(BTN.streamToday).text(BTN.streamTomorrow).row().text(BTN.streamWeek).text(BTN.streamCommon).row();
  if (opts.poisk) kb.text(BTN.whereStudent).row();
  return kb.text(BTN.settings).text(BTN.backToMenu).resized().persistent();
}

export function intakePicker(intakes: number[], selected: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const i of intakes) kb.text(`${i === selected ? "✅ " : ""}20${i}`, `si:${i}`);
  return kb;
}

/**
 * Данные кнопки с ключом группы. Ключ приходит из названия на портале и бывает
 * длинным («виш-11-23 (радиотехника и телекоммуникации)»), а Telegram не
 * принимает callback_data длиннее 64 байт и отвергает всю клавиатуру целиком.
 * Режем по байтам; ScheduleService.group() понимает такой обрезок.
 */
export function groupCb(prefix: string, key: string, suffix = ""): string {
  const tail = suffix ? `:${suffix}` : "";
  const room = 64 - Buffer.byteLength(`${prefix}:${tail}`);
  let cut = key;
  while (Buffer.byteLength(cut) > room) cut = cut.slice(0, -1);
  return `${prefix}:${cut}${tail}`;
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
      kb.text(`${mark}${label}`, groupCb(cb, g.key));
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
  // No "сегодня" button between the arrows: people read it as the date they are on.
  const kb = new InlineKeyboard().text(`◀️ ${fmtDDMM(addDays(date, -1))}`, d(addDays(date, -1))).text(`${fmtDDMM(addDays(date, 1))} ▶️`, d(addDays(date, 1))).row();
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

/** Как и в расписании группы, без кнопки «сегодня»: её читают как текущую дату. */
export function teacherDayNav(teacherId: number, date: LocalDate, opts: { following?: boolean } = {}): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(`◀️ ${fmtDDMM(addDays(date, -1))}`, `td:${teacherId}:${addDays(date, -1)}`)
    .text(`${fmtDDMM(addDays(date, 1))} ▶️`, `td:${teacherId}:${addDays(date, 1)}`)
    .row();
  kb.text("🗓 Неделя", `tw:${teacherId}:${date}`).text("🔎 Другой", "t:search").row();
  kb.text(opts.following ? "🔕 Не следить за преподом" : "👁 Следить за преподом", `twf:${teacherId}`);
  return kb;
}

export function teacherWeekNav(teacherId: number, monday: LocalDate, opts: { following?: boolean } = {}): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("◀️ пред.", `tw:${teacherId}:${addDays(monday, -7)}`)
    .text("след. ▶️", `tw:${teacherId}:${addDays(monday, 7)}`)
    .row()
    .text("📅 День", `td:${teacherId}:${monday}`)
    .text("🔎 Другой", "t:search")
    .row();
  kb.text(opts.following ? "🔕 Не следить за преподом" : "👁 Следить за преподом", `twf:${teacherId}`);
  return kb;
}

/** Stream day: date arrows, optional poster button, and one tiny button per group of the stream. */
export function streamDayNav(date: LocalDate, today: LocalDate, opts: { image: boolean; groups?: LogicalGroup[] } = { image: false }): InlineKeyboard {
  const kb = new InlineKeyboard().text(`◀️ ${fmtDDMM(addDays(date, -1))}`, `sd:${addDays(date, -1)}`).text(`${fmtDDMM(addDays(date, 1))} ▶️`, `sd:${addDays(date, 1)}`);
  if (opts.image) kb.row().text("🖼 Картинкой", `simg:${date}`);
  if (opts.groups?.length) {
    kb.row();
    // A new message: the stream screen stays where it is.
    for (const g of opts.groups) {
      const qualifier = /\((.*?)\)/.exec(g.title)?.[1]?.trim();
      kb.text(qualifier ? `${g.number} ${qualifier}` : String(g.number), groupCb("pdn", g.key, date));
    }
  }
  return kb;
}

const onoff = (v: boolean) => (v ? "вкл ✅" : "выкл ◻️");

export function minutesLabel(min: number | null): string {
  if (min == null) return "выкл";
  if (min % 60 === 0) return `${min / 60} ч`;
  return `${min} мин`;
}

/** Подписи для пункта «Преподаватели» в настройках. */
export const TEACHER_VIEW_LABELS: Record<string, string> = {
  bold: "с выделением",
  plain: "без выделения",
  off: "не показывать",
};

export function formatPicker(): InlineKeyboard {
  return new InlineKeyboard().text("📝 Текстом", "fmt:text").text("🖼 Картинкой", "fmt:image").row().text("📝🖼 И так, и так", "fmt:both");
}

export function settingsKeyboard(user: User, group: LogicalGroup | null, opts: { topics: string[]; hasImages: boolean; watchCount: number; defaultTheme: string; teacherCount?: number; slides?: boolean; known?: boolean }): InlineKeyboard {
  const kb = new InlineKeyboard();
  // В режиме преподавателя «своя группа» — это он сам.
  if (user.teacherMode) kb.text(`👨‍🏫 Режим преподавателя: ${user.teacherName ?? "включён"}`.slice(0, 60), "s:group").row();
  else kb.text(`👥 Группа: ${group?.title ?? "не выбрана"}`, "s:group").row();
  kb.text(`🔢 Подгруппа: ${user.subgroup ? `${user.subgroup}` : "все"}`, "s:subgroup");
  if (opts.hasImages) kb.text(`🖼 Формат: ${{ text: "текст", image: "картинка", both: "оба" }[user.format]}`, "s:format");
  kb.row();
  if (opts.hasImages) {
    // Even a "text" user gets posters from the «🖼 Картинкой» button and reminders.
    const theme = isTheme(user.posterTheme) ? user.posterTheme : isTheme(opts.defaultTheme) ? opts.defaultTheme : "midnight";
    kb.text(`🎨 Оформление картинок: ${THEME_LABELS[theme] ?? THEME_LABELS.midnight}`, "s:theme").row();
  }
  kb.text(`👨‍🏫 Преподаватели: ${TEACHER_VIEW_LABELS[user.teacherView]}`, "s:teacher").row();
  kb.text(`🔔 Изменения: ${onoff(user.notifyChanges)}`, "s:changes").text(`🎓 Сессия: ${onoff(user.notifySession)}`, "s:session").row();
  if (opts.slides) kb.text(`📎 Слайды записанных пар: ${onoff(user.wantSlides)}`, "s:slides").row();
  kb.text(`⏰ До первой пары: ${minutesLabel(user.remindFirstMin)}`, "s:first").row();
  kb.text(`⏱ Перед каждой парой: ${minutesLabel(user.remindEachMin)}`, "s:each").row();
  kb.text(`💻 Дистант, ссылка на вебинар: ${minutesLabel(user.remindDistanceMin)}`, "s:distance").row();
  kb.text(`🌙 Вечером на завтра: ${user.eveningAt ?? "выкл"}`, "s:evening").row();
  kb.text(`🤫 Тихие часы: ${user.quietFrom ? `${user.quietFrom}–${user.quietTo}` : "выкл"}`, "s:quiet").row();
  for (const t of opts.topics) kb.text(`${user.topics.includes(t) ? "✅" : "▫️"} ${TOPIC_LABELS[t] ?? t}`, `s:topic:${t}`);
  if (opts.topics.length) kb.row();
  kb.text(`👀 Следить за другими группами${opts.watchCount ? ` (${opts.watchCount})` : ""}`, "s:watch").row();
  // Пункт показываем только там, где узнавание вообще возможно: иначе это
  // тумблер от несуществующей лампочки.
  if (opts.known) kb.text(`🕶 Усиленная анонимность: ${onoff(user.anon)}`, "s:anon").row();
  if (opts.teacherCount) kb.text(`👨‍🏫 Слежу за преподавателями (${opts.teacherCount})`, "s:teachers").row();
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
