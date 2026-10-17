import { createHash } from "node:crypto";
import { InlineKeyboard, Keyboard } from "grammy";
import type { ReplyKeyboardRemove } from "grammy/types";
import type { LogicalGroup } from "../schedule/groups.js";
import type { MenuMode, User } from "../db/repo.js";
import { isTheme, THEME_LABELS } from "../render/themes.js";
import { addDays, fmtDDMM, type LocalDate } from "../time.js";

export const BTN = {
  today: "📅 Сегодня",
  tomorrow: "📅 Завтра",
  otherGroups: "👥 Др. группы",
  /** Та же кнопка в режиме преподавателя (старое нижнее меню): расписание любой группы. */
  students: "👥 Студенты",
  week: "🗓 Неделя",
  nextWeek: "🗓 Следующая",
  stream: "🎓 Поток",
  changes: "🔔 Изменения",
  calendar: "📆 Календарь",
  teachers: "👨‍🏫 Преподы",
  features: "🧭 Функции",
  search: "🔍 ИИ поисковик",
  settings: "⚙️ Настройки",
  ask: "💬 Спросить",
  suggest: "📨 Отправить новость",
  // Новое нижнее меню (2 × 3): «Найти» и «Ещё» открывают панели под сообщением.
  find: "🔍 Найти",
  more: "🗂 Ещё",
  /** 🙋, а не 💬: 💬 — у «Спросить ИИ», одна иконка на два раздела путала, куда писать вопрос. */
  complaint: "🙋 Поддержка",
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
 * Ключ — кнопка в BTN, которую старая подпись заменяет: обработчик слушает все
 * подписи сразу (btnLabels), а счётчики в /stats сводят их в одну строку.
 */
export const LEGACY_BTN = {
  search: ["🔍 Поиск"],
  teachers: ["👨‍🏫 Преподаватели"],
  complaint: ["🏛 Жалоба", "👥 Поддержка", "💬 Поддержка"],
  more: ["☰ Ещё"],
} as const satisfies Partial<Record<keyof typeof BTN, readonly string[]>>;

/** Подпись кнопки и все её старые подписи — для hears. */
export function btnLabels(key: keyof typeof LEGACY_BTN): string[] {
  return [BTN[key], ...LEGACY_BTN[key]];
}

/** Старая подпись → нынешняя (для счётчиков: «☰ Ещё» и «🗂 Ещё» — одна кнопка). */
export function currentLabel(text: string): string {
  for (const [key, old] of Object.entries(LEGACY_BTN) as Array<[keyof typeof LEGACY_BTN, readonly string[]]>) if (old.includes(text)) return BTN[key];
  return text;
}

/**
 * Кнопки панели «🔍 Найти». Это кнопки под сообщением, а не нижнее меню,
 * поэтому в MENU_TEXTS их нет; здесь они — чтобы тексты ссылались на них
 * той же подписью, что видна в панели.
 */
export const FIND_BTN = {
  /** «Другие», чтобы не путать с «👥 Группа» в настройках (там — сменить свою). */
  groups: "👥 Другие группы",
  /** То же место у преподавателя: расписание любой группы. */
  teacherGroups: "👥 Группы",
  stream: "🎓 Поток",
  teachers: "👨‍🏫 Где препод",
  poisk: "🕵️ Где студент",
  ask: "💬 Спросить ИИ",
} as const;

/** Кнопки панели «🗂 Ещё» — по той же причине, что FIND_BTN. */
export const MORE_BTN = {
  changes: "🔔 Изменения и объявления",
  calendar: "📆 Календарь телефона",
  settings: "⚙️ Настройки",
  help: "❓ Как пользоваться",
  recordMe: "🎥 Запись моей группы",
  recordNew: "🎥 Записывать мою группу",
} as const;

/** Где студент подаёт заявку на запись и где смотрит её статус — одна дорожка во всех текстах. */
export const FORM_PATH = `${BTN.more} → ${MORE_BTN.recordNew}`;
export const STATUS_PATH = `${BTN.more} → ${MORE_BTN.recordMe}`;

/** Every label of the reply keyboards; a pending flow must never swallow one. */
export const MENU_TEXTS: ReadonlySet<string> = new Set([...Object.values(BTN), ...Object.values(LEGACY_BTN).flat()]);

export function isMenuText(text: string | undefined): boolean {
  return !!text && MENU_TEXTS.has(text.trim());
}

/**
 * Нижнее меню и то, как оно себя ведёт. По умолчанию — «сворачивается»: без
 * is_persistent, и на телефоне в поле ввода есть значок ▦, которым меню
 * сворачивают и разворачивают (с is_persistent Telegram показывает его всегда
 * вместо клавиатуры, и свернуть его на телефоне нельзя). «После нажатия» —
 * one_time_keyboard: нажал кнопку — меню само свернулось, вернуть — тем же
 * значком. «Скрыто» — меню убрано совсем, команды остаются в кнопке «Меню»
 * слева от поля ввода.
 */
export const MENU_MODES: readonly MenuMode[] = ["collapsible", "once", "hidden"];
export const MENU_MODE_LABELS: Record<MenuMode, string> = { collapsible: "сворачивается", once: "сворачивать после нажатия", hidden: "скрыто" };

function menuBehaviour(kb: Keyboard, mode: MenuMode): Keyboard {
  kb.resized();
  return mode === "once" ? kb.oneTime() : kb;
}

/**
 * Подсказка в поле ввода: бот понимает текст и без кнопок — номер группы,
 * фамилию, предмет, дату. Telegram пускает до 64 символов.
 */
export const INPUT_HINT = "14-24, Иванова, матан, 15.10";

/**
 * Главное меню 2 × 3. Внизу — только то, что жмут каждый день; всё остальное
 * за «🔍 Найти» (группы, поток, преподаватели, вопрос ИИ) и «🗂 Ещё»
 * (изменения, календарь, настройки, справка) — панелями под сообщением,
 * которые меняются на месте и не засоряют чат. Старые кнопки 4 × 3 у кого-то
 * ещё висят в чате — их подписи по-прежнему работают (см. hears в обработчиках).
 */
export function mainKeyboard(mode: MenuMode = "collapsible"): Keyboard {
  const kb = new Keyboard().text(BTN.today).text(BTN.tomorrow).text(BTN.week).row().text(BTN.find).text(BTN.more).text(BTN.complaint).placeholder(INPUT_HINT);
  return menuBehaviour(kb, mode);
}

/**
 * Меню режима преподавателя — те же кнопки: «Сегодня / Неделя» — его
 * собственные пары, а «🔍 Найти» начинается с «👥 Группы» (расписание любой группы).
 */
export function teacherKeyboard(mode: MenuMode = "collapsible"): Keyboard {
  return mainKeyboard(mode);
}

export type MenuMarkup = Keyboard | ReplyKeyboardRemove;

/** Нижнее меню этого человека: обычное или режима преподавателя — или «убрать», если он его скрыл. */
export function menuFor(user: Pick<User, "teacherMode" | "menuMode"> | null | undefined): MenuMarkup {
  const mode = user?.menuMode ?? "collapsible";
  if (mode === "hidden") return { remove_keyboard: true };
  return user?.teacherMode ? teacherKeyboard(mode) : mainKeyboard(mode);
}

/** Отпечаток меню: то же меню — тот же отпечаток (по нему бот понимает, что меню уже стоит). */
export function menuStamp(markup: unknown): string {
  return createHash("sha1").update(JSON.stringify(markup)).digest("base64url").slice(0, 12);
}

/** Отпечатки возможных меню считаем один раз: вариантов всего пять. */
const stamps = new Map<string, string>();
export function menuStampFor(user: Pick<User, "teacherMode" | "menuMode">): string {
  const key = `${user.teacherMode ? 1 : 0}|${user.menuMode}`;
  let stamp = stamps.get(key);
  if (!stamp) stamps.set(key, (stamp = menuStamp(menuFor(user))));
  return stamp;
}

/** Где искать меню — для подсказок в тексте («Нажми кнопку ниже» не годится, если меню скрыто). */
export function menuHint(user: Pick<User, "menuMode"> | null | undefined): string {
  return user?.menuMode === "hidden" ? "Команды — в кнопке «Меню» слева от поля ввода, вернуть кнопки внизу — /menu" : "Меню — внизу 👇";
}

/** Как сослаться на кнопку в тексте: «📅 Сегодня», а если меню скрыто — командой. */
export function btnRef(user: Pick<User, "menuMode"> | null | undefined, label: string, command: string): string {
  return user?.menuMode === "hidden" ? command : `«${label}»`;
}

/**
 * Как сослаться на пункт панели «🔍 Найти» или «🗂 Ещё»: «🔍 Найти → 👨‍🏫 Где препод»,
 * а если нижнее меню скрыто — командой.
 */
export function panelRef(user: Pick<User, "menuMode"> | null | undefined, panel: string, item: string, command: string): string {
  return user?.menuMode === "hidden" ? command : `«${panel} → ${item}»`;
}

/**
 * Меню режима потока. Его открывают сами, поэтому оно приходит и тем, кто
 * скрыл основное меню (свернуть его можно тем же значком ▦), а «◀️ В меню»
 * возвращает к их выбору. `poisk` добавляет кнопку глобального поиска
 * студента (POISK=TRUE).
 */
export function streamKeyboard(opts: { poisk?: boolean; mode?: MenuMode } = {}): Keyboard {
  const kb = new Keyboard().text(BTN.streamYesterday).text(BTN.streamToday).text(BTN.streamTomorrow).row().text(BTN.streamWeek).text(BTN.streamCommon).row();
  if (opts.poisk) kb.text(BTN.whereStudent).row();
  return menuBehaviour(kb.text(BTN.settings).text(BTN.backToMenu), opts.mode === "once" ? "once" : "collapsible");
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
    // Курс не понятен из названия — общий раздел, а не «(0 курс)».
    const section = !g.course ? "Другие группы" : g.prefix === "ВИШ" ? `${g.course} курс` : `${g.prefix} (${g.course} курс)`;
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
  // Ключ группы бывает длинным («виш-11-23 (радиотехника и …)»): groupCb
  // укладывает его в 64 байта callback_data, service.group() узнаёт обрезанный.
  const d = (x: LocalDate) => (opts.peekKey ? groupCb("pd", opts.peekKey, x) : `d:${x}`);
  const w = (x: LocalDate) => (opts.peekKey ? groupCb("pw", opts.peekKey, x) : `w:${x}`);
  // No "сегодня" button between the arrows: people read it as the date they are on.
  const kb = new InlineKeyboard().text(`◀️ ${fmtDDMM(addDays(date, -1))}`, d(addDays(date, -1))).text(`${fmtDDMM(addDays(date, 1))} ▶️`, d(addDays(date, 1))).row();
  kb.text("🗓 Неделя", w(date));
  if (opts.image) kb.text("🖼 Картинкой", opts.peekKey ? groupCb("pimg", opts.peekKey, date) : `img:${date}`);
  if (opts.peekKey) kb.row().text("✅ Сделать моей группой", groupCb("g", opts.peekKey));
  return kb;
}

export function weekNav(monday: LocalDate, opts: { image: boolean; peekKey?: string }): InlineKeyboard {
  const w = (x: LocalDate) => (opts.peekKey ? groupCb("pw", opts.peekKey, x) : `w:${x}`);
  const d = (x: LocalDate) => (opts.peekKey ? groupCb("pd", opts.peekKey, x) : `d:${x}`);
  const kb = new InlineKeyboard()
    .text("◀️ пред.", w(addDays(monday, -7)))
    .text("текущая", opts.peekKey ? groupCb("pw", opts.peekKey, "today") : "w:today")
    .text("след. ▶️", w(addDays(monday, 7)))
    .row()
    .text("📅 День", d(monday));
  if (opts.image) kb.text("🖼 Картинкой", opts.peekKey ? groupCb("pwimg", opts.peekKey, monday) : `wimg:${monday}`);
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
  kb.text(`⌨️ Нижнее меню: ${MENU_MODE_LABELS[user.menuMode]}`, "s:menu").row();
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

/**
 * Hashtags that route a channel post to a topic. Окончания — любые буквы
 * (\w в JS — только латиница даже с флагом u), а в конце — граница слова:
 * иначе «#сантехника» уходила в события через «санта».
 */
export const TOPIC_HASHTAGS: Record<Topic, RegExp> = {
  contests: /#(?:конкурс|стипенди|конференци|грант|олимпиад|хакатон|возможност)[\p{L}\p{N}_]*/iu,
  announcements: /#(?:объявлени|срочн|важн|дистант|отмен|дедлайн)[\p{L}\p{N}_]*/iu,
  events: /#(?:(?:событи|мероприят|маслениц|защит|праздник|встреч)[\p{L}\p{N}_]*|санта(?!\p{L}))/iu,
};

export function onboardingKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✅ Включить рекомендуемые", "ob:on").row().text("⚙️ Настроить самому", "ob:custom").text("Позже", "ob:later");
}

export const WEBINAR_URL = "https://tt.chuvsu.ru/webinar";

/**
 * Напоминания о парах и пункт настроек, который их включает. Кнопка
 * «отключить» — прямо под напоминанием: не всякий найдёт нужную строчку в
 * настройках, а надоевшее напоминание хочется выключить тут же.
 */
export const REMINDERS = {
  first: { field: "remindFirstMin", label: "до первой пары" },
  each: { field: "remindEachMin", label: "перед каждой парой" },
  distance: { field: "remindDistanceMin", label: "перед дистантом" },
  evening: { field: "eveningAt", label: "вечером на завтра" },
} as const satisfies Record<string, { field: keyof User; label: string }>;
export type ReminderKind = keyof typeof REMINDERS;
export const REMINDER_KINDS = Object.keys(REMINDERS) as ReminderKind[];

export function reminderOff(kind: ReminderKind, kb = new InlineKeyboard()): InlineKeyboard {
  return kb.text("🔕 Отключить эти уведомления", `rm:off:${kind}`);
}
