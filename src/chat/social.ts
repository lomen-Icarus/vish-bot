/**
 * «Социальность» бота в групповых чатах — всё, что решается без модели:
 * знакомства («@ник это Фамилия Имя 12-23»), просьбы присылать слайды в тему
 * чата, сонные ответы ночью и фразы, которые должны звучать дословно.
 */
import { randomInt } from "node:crypto";
import type { MessageEntity } from "grammy/types";

/** Вместо сухого «я отвечаю только на расписание». */
export const REFUSAL_PHRASE = "Хм... думаю, что на это я не отвечу до следующего обновления социальности";

/** Ответ на предложение новой функции: владелец бота получает пинг. */
export function featureReply(owner: string | null): string {
  return owner ? `Хм.. запишу, спасиба, @${owner} давай делай` : "Хм.. запишу, спасиба";
}

// ---------- ночь ----------

/** Ночь по Москве: с 23:00 до 05:00. */
export function isNight(minutes: number): boolean {
  return minutes >= 23 * 60 || minutes < 5 * 60;
}

/** Сколько бота не трогали в чате, чтобы ночью он «проснулся». */
export const SLEEPY_IDLE_MS = 30 * 60_000;

export const SLEEPY_LINES = ["Мм.м.... уф", "😴", "Поспать не дают....", "🥱"] as const;

/** Случайная сонная реплика: настоящий случай, а не «каждая четвёртая». */
export function sleepyLine(pick: (n: number) => number = randomInt): string {
  return SLEEPY_LINES[pick(SLEEPY_LINES.length)]!;
}

// ---------- общее ----------

function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/** «петрова кира» → «Петрова Кира»; дефисы («Иванов-петров») — тоже с большой. */
function capitalizeName(s: string): string {
  return s
    .split(" ")
    .map((w) => w.split("-").map((p) => (p ? p[0]!.toUpperCase() + p.slice(1).toLowerCase() : p)).join("-"))
    .join(" ");
}

// ---------- знакомства ----------

export interface IntroRequest {
  /** Ник без «@», в нижнем регистре; null — человек без ника (text_mention) или «я». */
  username: string | null;
  /** id человека, если его упомянули без ника или он представился сам. */
  userId: number | null;
  /** ФИО с большой буквы: 2–3 слова. */
  name: string;
  /** Как написали группу («12-23», «ВИШ-12-23»); null — не написали. */
  groupQuery: string | null;
  /** Человек представился сам («я — …»). */
  self: boolean;
}

const WORD = "[А-ЯЁа-яё][А-ЯЁа-яё]*(?:-[А-ЯЁа-яё]+)?";
const GROUP = "(?:виш[-\\s]?)?\\d{1,2}[-\\s]\\d{2}(?:[а-яё]{1,4})?(?:\\s*\\([^)]{1,20}\\))?";
// «это Фамилия Имя [Отчество] [из|группа|гр.] 12-23».
const INTRO_TAIL = new RegExp(`^\\s*[,:]?\\s*(?:это|—|–|-)\\s+(${WORD}(?:\\s+${WORD}){1,2}?)(?:\\s*,?\\s*(?:из\\s+|группа\\s+|гр\\.?\\s*)?(${GROUP}))?\\s*[.!)]*\\s*$`, "iu");
const SELF_INTRO = new RegExp(`^(?:я|меня\\s+зовут)\\s*(?:—|–|-|:)?\\s*(${WORD}(?:\\s+${WORD}){1,2}?)(?:\\s*,?\\s*(?:из\\s+|группа\\s+|гр\\.?\\s*)?(${GROUP}))?\\s*[.!)]*\\s*$`, "iu");

/** Слова, которые не бывают частью ФИО: «это Петрова Кира из 12-23» не должно съесть «из». */
const NOT_NAME = new Set(["из", "группа", "гр", "с", "со", "в", "наш", "наша", "мой", "моя", "староста", "препод", "преподаватель"]);

function cleanName(raw: string): string | null {
  const words = raw.trim().split(/\s+/);
  if (words.length < 2 || words.length > 3) return null;
  if (words.some((w) => NOT_NAME.has(w.toLowerCase()))) return null;
  return capitalizeName(words.join(" "));
}

/**
 * Знакомство в сообщении чата. Вид: «@ник это Фамилия Имя 12-23» (можно с
 * обращением к боту в начале) или, если писали боту, «я — Фамилия Имя 12-23».
 * Упоминание человека без ника (text_mention) тоже подходит.
 */
export function parseIntro(text: string, entities: MessageEntity[], botUsername: string | null, botId: number, from: { id: number; username?: string | undefined }, addressed: boolean): IntroRequest | null {
  const bot = botUsername ? `@${botUsername.toLowerCase()}` : null;
  const sorted = [...entities].sort((a, b) => a.offset - b.offset);
  let pos = 0;
  for (const e of sorted) {
    if (e.type !== "mention" && e.type !== "text_mention") continue;
    const before = text.slice(pos, e.offset);
    // До упоминания может стоять только обращение к боту и знаки.
    if (/[\p{L}\p{N}]/u.test(before)) break;
    const piece = text.slice(e.offset, e.offset + e.length);
    const isBot = (e.type === "mention" && bot !== null && piece.toLowerCase() === bot) || (e.type === "text_mention" && e.user.id === botId);
    if (isBot) {
      pos = e.offset + e.length;
      continue;
    }
    const m = INTRO_TAIL.exec(text.slice(e.offset + e.length));
    if (!m) return null;
    const name = cleanName(m[1]!);
    if (!name) return null;
    if (e.type === "text_mention") return { username: null, userId: e.user.id, name, groupQuery: m[2]?.trim() ?? null, self: e.user.id === from.id };
    const username = piece.replace(/^@/, "").toLowerCase();
    return { username, userId: null, name, groupQuery: m[2]?.trim() ?? null, self: !!from.username && from.username.toLowerCase() === username };
  }
  if (!addressed) return null;
  // «@бот я — Петрова Кира 12-23»: упоминание бота уже позади.
  const m = SELF_INTRO.exec(text.slice(pos).replace(/^[\s,.:;!—–-]+/, ""));
  // Без группы «я …» — скорее всего, не знакомство («я устал от пар»).
  if (!m || !m[2]) return null;
  const name = cleanName(m[1]!);
  if (!name) return null;
  return { username: from.username?.toLowerCase() ?? null, userId: from.id, name, groupQuery: m[2]?.trim() ?? null, self: true };
}

// ---------- слайды в чат ----------

export type SlidesRequest =
  | { kind: "subscribe"; subject: string | null; group: string | null }
  /** Разовое «скинь слайды по …»: прислать готовый PDF, а нет его — предложить подписку. */
  | { kind: "send"; subject: string | null; group: string | null }
  | { kind: "unsubscribe"; subject: string | null }
  | { kind: "list" };

const GROUP_IN_TEXT = new RegExp(`(?:для\\s+|у\\s+|группы\\s+|группе\\s+)?(${GROUP})`, "iu");
/** Хвосты, которые к названию предмета не относятся. */
const SUBJECT_TAIL = /\s+(?:сюда|здесь|тут|в\s+этот\s+чат|в\s+эту\s+тему|в\s+эту\s+ветку|в\s+чат|пожалуйста|пж|плиз|please|спасибо)(?=[\s.,!?)]|$).*$/iu;

function subjectAfterPo(text: string): string | null {
  const m = /(?:^|\s)по\s+(.+)$/iu.exec(text);
  if (!m) return null;
  // «по вебинарам по физике» — про физику; «практикум по программированию»
  // при этом остаётся целым: снимается только слово-обёртка в начале.
  let raw = m[1]!.replace(/^(?:вебинар\p{L}*|онлайн[-\s]?пар\p{L}*|пар\p{L}*|лекци\p{L}*|предмет\p{L}*)\s+по\s+/iu, "");
  raw = raw.replace(SUBJECT_TAIL, "").replace(/[.!?,;:)]+$/u, "").trim();
  return raw && raw.length <= 80 ? raw : null;
}

/**
 * Просьба про слайды вебинаров в чате: «сюда присылай слайды по физике»,
 * «не присылай сюда слайды по физике», «какие слайды сюда приходят».
 */
/** Слово или начало слова: «кинь» не должно находиться внутри «скинь». */
const W = "(?:^|[^\\p{L}])";
/** «Присылай», «кидай», «подпиши» — про постоянную рассылку. */
const ONGOING = new RegExp(`${W}(?:присылай|присылать|присылайте|кидай|кидайте|скидывай|скидывайте|подпиш|получать|отправляй|отправлять|шли|шлите)`, "u");
/** «Скинь», «пришли», «покажи» — разовая просьба: это к модели, а не подписка. */
const ONE_OFF = new RegExp(`${W}(?:скинь|скиньте|кинь|киньте|пришли|пришлите|отправь|отправьте|покажи|покажите|дай|дайте|найди|где|есть\\s+ли)`, "u");
const HERE = new RegExp(`${W}(?:сюда|здесь|тут|в\\s+этот\\s+чат|в\\s+эту\\s+тему|в\\s+эту\\s+ветку)`, "u");
const OFF = new RegExp(`${W}(?:не\\s+(?:присылай|присылайте|присылать|кидай|кидайте|скидывай|скидывайте|шли|шлите|отправляй|отправлять|надо|нужно|нужны)|отпиш|отключ|хватит|стоп|убери|уберите|больше\\s+не)`, "u");
const LIST = new RegExp(`${W}(?:какие|список|куда)(?:[^\\p{L}]|$)`, "u");

/** Предмет после «по …» и группа, если названа (в предмете или где угодно в тексте). */
function subjectAndGroup(text: string): { subject: string | null; group: string | null } {
  let subject = subjectAfterPo(text);
  let group: string | null = null;
  if (subject) {
    const g = GROUP_IN_TEXT.exec(subject);
    if (g) {
      group = g[1]!.trim();
      subject = subject.replace(g[0], " ").replace(/\s+/g, " ").trim() || null;
    }
  }
  if (!group) group = GROUP_IN_TEXT.exec(text.replace(/@\w+/g, " "))?.[1]?.trim() ?? null;
  return { subject, group };
}

/**
 * Просьба про слайды вебинаров в чате: «сюда присылай слайды по физике»,
 * «не присылай сюда слайды по физике», «какие слайды сюда приходят».
 * Разовое «скинь слайды по физике» — прислать готовый PDF (kind send).
 */
export function parseSlidesRequest(text: string): SlidesRequest | null {
  const t = norm(text);
  if (!/слайд/.test(t)) return null;
  if (OFF.test(t)) {
    const subject = subjectAfterPo(text);
    return { kind: "unsubscribe", subject: subject ? subject.replace(GROUP_IN_TEXT, "").trim() || null : null };
  }
  if (LIST.test(t) && !/(?:^|\s)по\s/.test(t)) return { kind: "list" };
  const ongoing = ONGOING.test(t);
  if (ONE_OFF.test(t) && !ongoing) return { kind: "send", ...subjectAndGroup(text) };
  if (!ongoing && !HERE.test(t)) return null;
  return { kind: "subscribe", ...subjectAndGroup(text) };
}

// ---------- подбор предмета ----------

/** Как студенты называют предметы. */
const SUBJECT_ALIASES: Array<[RegExp, string]> = [
  [/^матан\p{L}*$/u, "математический анализ"],
  [/^вышмат\p{L}*$/u, "высшая математика"],
  [/^физр\p{L}*$/u, "физическая культура"],
  [/^инф[аеуыо]$/u, "информатика"],
  [/^прог[аеуи]$/u, "программирование"],
  [/^англ\p{L}*$/u, "иностранный язык"],
  [/^орг$/u, "основы российской государственности"],
  [/^бжд$/u, "безопасность жизнедеятельности"],
  [/^тервер\p{L}*$/u, "теория вероятностей"],
  [/^начерт\p{L}*$/u, "начертательная геометрия"],
];

/** Слова, которые к названию предмета не относятся: «по вебинарам физики». */
const SUBJECT_STOP = new Set([
  "вебинар", "вебинара", "вебинаров", "вебинарам", "вебинары", "пара", "пары", "пар", "парам", "паре", "лекция", "лекции", "лекций", "лекциям", "предмет", "предмету", "предмета", "слайды", "слайдов", "онлайн",
  // «с прошлой пары», «за сегодня», «последней лекции» — время, а не предмет.
  "прошлой", "прошлую", "прошлого", "последней", "последнюю", "последнего", "вчерашней", "вчерашнюю", "сегодняшней", "сегодняшнюю", "вчера", "сегодня", "завтра", "недавней",
]);

function normSubject(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

/** Ключ предмета для сравнения: регистр, «ё», знаки и лишние пробелы не важны. */
export const subjectKey = normSubject;

/**
 * Тот же ли это предмет: ключи равны или один — целые слова внутри другого
 * («физика» и «физика лекция»). По основам слов не сравниваем нарочно:
 * «программирование» и «практикум по программированию» — разные предметы.
 */
export function sameSubject(a: string, b: string): boolean {
  const x = subjectKey(a);
  const y = subjectKey(b);
  if (!x || !y) return false;
  return x === y || ` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `);
}

/**
 * То же, но терпимо к хвосту: «по БЖД пожаслуйста», «по физике плз» — не
 * нашлось целиком, пробуем без одного-трёх последних слов.
 */
export function matchSubjectsLoose(query: string, subjects: string[], limit = 4): string[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  for (let n = words.length; n >= 1 && n >= words.length - 3; n--) {
    const found = matchSubjects(words.slice(0, n).join(" "), subjects, limit);
    if (found.length) return found;
  }
  return [];
}

/**
 * Предметы из списка, похожие на запрос: точное совпадение — первым, дальше
 * по числу совпавших основ слов. Каждое слово запроса должно найтись.
 */
export function matchSubjects(query: string, subjects: string[], limit = 4): string[] {
  const words = normSubject(query)
    .split(" ")
    .filter((w) => w && !SUBJECT_STOP.has(w));
  const expanded = words.flatMap((w) => {
    const alias = SUBJECT_ALIASES.find(([re]) => re.test(w));
    return alias ? alias[1].split(" ") : [w];
  });
  const q = expanded.join(" ");
  if (!q) return [];
  const stems = expanded.filter((w) => w.length >= 3).map((w) => w.slice(0, Math.max(3, Math.min(w.length - 1, 5))));
  const scored: Array<{ subject: string; score: number }> = [];
  for (const subject of new Set(subjects)) {
    const s = normSubject(subject);
    if (s === q) {
      scored.push({ subject, score: 1000 });
      continue;
    }
    const sw = s.split(" ");
    const hits = stems.filter((st) => sw.some((w) => w.startsWith(st))).length;
    if (stems.length && hits === stems.length) scored.push({ subject, score: 100 + hits * 10 - sw.length });
    else if (s.includes(q) && q.length >= 4) scored.push({ subject, score: 50 });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.subject.length - b.subject.length || a.subject.localeCompare(b.subject, "ru"))
    .slice(0, limit)
    .map((x) => x.subject);
}
