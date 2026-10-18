/**
 * Общие мелочи планировщика: время по Москве и фильтр «эту пару записываем».
 * Отдельный модуль, чтобы разведка (probe) могла ими пользоваться, не запуская
 * при импорте боевой цикл записи.
 */
import type { RecorderConfig, WebinarProfile } from "./config.js";
import type { WebinarRow } from "./portal.js";

/** Московская дата и минуты с полуночи: расписание живёт в этом часовом поясе. */
export function mskNow(at = new Date()): { date: string; minutes: number } {
  const shifted = new Date(at.getTime() + 3 * 60 * 60 * 1000);
  return { date: shifted.toISOString().slice(0, 10), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

/**
 * Сравнимая форма: регистр, «ё», пробелы. Пробел перед скобкой убираем: портал
 * пишет то «ВИШ-11-23(РЗиАЭС)», то «ВИШ-11-23 (ЭиЭА)», а код «11-23(эиэа)»
 * должен находить своё и не находить чужое.
 */
export const norm = (s: string): string => s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").replace(/\s*\(/g, "(").trim();

/** Подходит ли эта пара под фильтры записи. */
export function wanted(row: WebinarRow, cfg: Pick<RecorderConfig, "subjects" | "groups"> & Partial<Pick<RecorderConfig, "skipSubjects">>): boolean {
  // Вне расписания бывают закрытые встречи — их записывать нельзя.
  if (!row.scheduled) return false;
  if (!row.groups.length) return false;
  if (cfg.subjects.length && !cfg.subjects.some((s) => norm(row.subject).includes(norm(s)))) return false;
  // Пары без слайдов (физкультура и т. п.) не занимают место для записи.
  if (cfg.skipSubjects?.some((s) => norm(s) && norm(row.subject).includes(norm(s)))) return false;
  if (cfg.groups.length && !matchesGroups(cfg.groups, row.groups)) return false;
  return true;
}

/**
 * Есть ли среди групп пары хоть одна из списка: «11-25» подходит к
 * «ВИШ-11-25» и «ОЗВИШ-11-25», но не к «ВИШ-111-25»; «1-25» не подходит к
 * «ВИШ-11-25». Код группы должен стоять целиком, не внутри другого числа.
 */
export function matchesGroups(codes: string[], rowGroups: string[]): boolean {
  return codes.some((code) => {
    const c = norm(code);
    if (!c) return false;
    return rowGroups.some((rg) => {
      const r = norm(rg);
      let at = r.indexOf(c);
      while (at >= 0) {
        const before = at === 0 ? "" : r[at - 1]!;
        const after = r[at + c.length] ?? "";
        if (!/\d/.test(before) && !/\d/.test(after)) return true;
        at = r.indexOf(c, at + 1);
      }
      return false;
    });
  });
}

/**
 * Какими профилями заходить на эту пару и в каком порядке: сначала заведённые
 * для её групп, потом общие (без групп). Профиль чужих групп не пробуем
 * никогда: иначе студент одного набора заходил бы под своим именем на пары
 * другого, стоило первому профилю споткнуться.
 */
export function profilesFor(row: Pick<WebinarRow, "groups">, profiles: WebinarProfile[]): WebinarProfile[] {
  return [...profiles.filter((p) => p.groups.length && matchesGroups(p.groups, row.groups)), ...profiles.filter((p) => !p.groups.length)];
}

/** Профили для лога: только номер и группы — ни логина, ни пароля. */
export function profileSummary(profiles: WebinarProfile[]): string[] {
  return profiles.map((p) => `${p.name}${p.groups.length ? ` (${p.groups.join(", ")})` : ""}`);
}

/** Ключ, по которому понимаем, что эту пару мы уже записали сегодня. */
export const keyOf = (date: string, row: WebinarRow): string => `${date}|${row.startMinutes ?? "?"}|${norm(row.subject)}|${norm(row.teacher)}`;

/** Что планировщик помнит о сегодняшних парах. */
export interface RecordState {
  /** Записаны (или точно больше не нужны). */
  done: Set<string>;
  /** Записываются прямо сейчас. */
  active: Set<string>;
  /** Не получилось — когда пробовать снова (мс). */
  retryAt: Map<string, number>;
}

export interface DuePlan {
  /** Начать запись сейчас. */
  start: WebinarRow[];
  /** Пара скоро или идёт, но кнопки «Подключиться» ещё нет (или ждём повтора). */
  waiting: WebinarRow[];
  /** Готовы, но все места для одновременной записи заняты. */
  skipped: WebinarRow[];
}

/**
 * Какие пары записывать сейчас. Пара «в работе» с момента «за leadMinutes до
 * начала» и до её конца: пока она идёт, неудачная попытка (комнату ещё не
 * открыли, бот не зашёл, ни одного слайда) повторяется — раньше после трёх
 * осечек за первые минуты пара терялась целиком.
 */
export function planRecording(
  rows: WebinarRow[],
  now: { date: string; minutes: number },
  cfg: Pick<RecorderConfig, "subjects" | "groups" | "leadMinutes" | "maxParallel"> & Partial<Pick<RecorderConfig, "skipSubjects" | "profiles">>,
  state: RecordState,
  nowMs: number,
): DuePlan {
  const inWindow = rows.filter((r) => wanted(r, cfg) && r.startMinutes != null && now.minutes >= r.startMinutes - cfg.leadMinutes && (r.endMinutes == null || now.minutes < r.endMinutes));
  const open = mergeSamePair(inWindow, now.date).filter((r) => {
    const key = keyOf(now.date, r);
    return !state.done.has(key) && !state.active.has(key);
  });
  // Сначала пары, для групп которых заведён свой профиль (поток, куда пускают
  // только своих: иначе их не записать никак), потом остальные; внутри — по
  // времени начала. Одновременно открыто бывает 7 комнат, а мест — 1–2.
  const own = (r: WebinarRow): number => (cfg.profiles?.some((p) => p.groups.length && matchesGroups(p.groups, r.groups)) ? 0 : 1);
  const ready = open
    .filter((r) => r.joinId && (state.retryAt.get(keyOf(now.date, r)) ?? 0) <= nowMs)
    .sort((a, b) => own(a) - own(b) || (a.startMinutes ?? 0) - (b.startMinutes ?? 0));
  const free = Math.max(0, cfg.maxParallel - state.active.size);
  return { start: ready.slice(0, free), skipped: ready.slice(free), waiting: open.filter((r) => !ready.includes(r)) };
}

/**
 * Одна пара — один бот. Портал может показать одну лекцию несколькими
 * строками (поток — по комнате на группу): ключ у них один. Строки не
 * отбрасываем, а сливаем: группы — все (по ним выбираются учётки и кому
 * отправить PDF), основная комната — первая, где уже можно подключиться,
 * остальные — запасные (alts).
 */
export function mergeSamePair(rows: WebinarRow[], date: string): WebinarRow[] {
  const byKey = new Map<string, WebinarRow[]>();
  for (const r of rows) {
    const key = keyOf(date, r);
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  return [...byKey.values()].map((same) => {
    if (same.length === 1) return same[0]!;
    const main = same.find((r) => r.joinId) ?? same[0]!;
    const groups = [...new Set(same.flatMap((r) => r.groups))];
    return { ...main, groups, alts: same.filter((r) => r !== main && r.joinId) };
  });
}

/**
 * Имя файла без опасных символов: дата, время начала, предмет и фамилия
 * преподавателя. Фамилия нужна: две пары одного предмета в одно время у
 * разных потоков (ключ пары их различает) иначе писали бы кадры в одну папку
 * и собирались в один PDF.
 */
export function deckBaseName(date: string, startMinutes: number | null, subject: string, teacher = ""): string {
  const hhmm = startMinutes != null ? `${String(Math.floor(startMinutes / 60)).padStart(2, "0")}${String(startMinutes % 60).padStart(2, "0")}` : "xxxx";
  const clean = (s: string): string => s.replace(/[^\p{L}\p{N} .-]/gu, "").trim().replace(/\s+/g, "-");
  const safe = clean(subject).slice(0, 50) || "вебинар";
  // Фамилия и инициалы: у однофамильцев в одно время одного предмета иначе
  // одна папка на две пары (keyOf их различает по полному ФИО).
  const [surname = "", ...rest] = teacher.split(/[\s.]+/).filter(Boolean);
  const initials = rest.map((w) => w.charAt(0)).join("");
  const who = clean(`${surname}${initials ? `-${initials}` : ""}`).slice(0, 24);
  return `${date}-${hhmm}-${safe}${who ? `-${who}` : ""}`.replace(/[/\\]/g, "-");
}
