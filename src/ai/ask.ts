/**
 * Natural-language questions about the timetable. The model gets the own
 * group's next two weeks inline plus tools to look at any group, search a
 * subject by a colloquial name, list groups and look up teachers; it must
 * refuse off-topic asks.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ScheduleService } from "../schedule/service.js";
import { findGroup, type LogicalGroup } from "../schedule/groups.js";
import { filterSubgroup } from "../schedule/format.js";
import { lessonTypeLabel, type Occurrence } from "../schedule/model.js";
import type { TeacherService } from "../portal/teachers.js";
import type { WebinarService, WebinarTeacher } from "../portal/webinars.js";
import { addDays, fmtHHMM, isLocalDate, mondayOf, todayMsk, weekdayName, type LocalDate } from "../time.js";
import { logger } from "../logger.js";
import { whereNowPlain } from "../people/profile.js";
import type { ChatTool } from "../chat/service.js";

export interface AskOptions {
  model: string;
}

/**
 * Доступ к реестру студентов для ИИ-поиска. Живёт за интерфейсом: сам сервис
 * ничего не знает ни про лимиты, ни про журнал — это дело бота.
 */
export interface StudentLookup {
  search(query: string, limit: number): Array<{ id: string; name: string; groupTitle: string; subgroup: number | null; fuzzy: boolean }>;
  /** Можно ли этому человеку искать людей прямо сейчас (дневной лимит). */
  allowed(userId: number): boolean;
  /** Записать обращение в журнал (аудит + лимит). */
  note(userId: number, query: string, studentId: string | null): void;
  /** Где человек должен быть сейчас по расписанию его группы. */
  whereabouts(studentId: string): string | null;
}

/**
 * Кого назвали инструменты по ходу ответа: бот вешает это кнопками под текстом,
 * а если человек нашёлся ровно один и точно (exact) — присылает его карточку.
 */
export interface AskMentions {
  /** Преподаватели из справочника портала. */
  teachers: Array<{ id: number; name: string; exact: boolean }>;
  /** Преподаватели, известные только по странице вебинаров. */
  webinarTeachers: Array<{ name: string; exact: boolean }>;
  /** Ключи групп, чьё расписание смотрели. */
  groupKeys: string[];
  /** Найденные студенты (когда включён глобальный поиск). */
  students: Array<{ id: string; name: string; groupTitle: string; exact: boolean }>;
}

export interface AskResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  mentions: AskMentions;
}

function emptyMentions(): AskMentions {
  return { teachers: [], webinarTeachers: [], groupKeys: [], students: [] };
}

function remember<T>(list: T[], item: T, same: (a: T, b: T) => boolean, limit = 6): void {
  if (list.length >= limit || list.some((x) => same(x, item))) return;
  list.push(item);
}

const SYSTEM = `Ты — помощник по расписанию Высшей инженерной школы (ВИШ) ЧувГУ внутри Telegram-бота.
Отвечай на вопросы о расписании и о самом боте: пары, время, аудитории, дни, недели, сессия, переносы, любые группы ВИШ, преподаватели (что ведут, у каких групп, когда), а также как пользоваться ботом, что он умеет, где что нажать, как включить уведомления и календарь.
На любые другие темы (решение задач, лабы, код, тексты, советы, болтовня) отвечай ровно одной фразой:
"Я отвечаю только на вопросы о расписании и о боте 🙂" — без исключений.

Как отвечать:
- Студенты называют предметы разговорно: «математика»/«матан» = «Математический анализ», «Алгебра и геометрия» тоже математика; «физра» = «Физическая культура и спорт»; «инфа» = «Информатика»; «прога» = «Программирование»/«Основы программирования»; «англ» = «Иностранный язык»; «история» = «История России»; «ОРГ» = «Основы российской государственности». Если точного предмета нет — ищи по смыслу инструментом find_subject и предлагай ближайшие совпадения.
- Если спрашивают про другую группу (например «у 14-26») — используй get_schedule для неё; названия групп вида «14-26» = «ВИШ-14-26».
- Спрашивают и о самом боте: «как включить анонимность», «как убрать своё имя», «как поменять оформление», «как сменить группу», «как посмотреть расписание другой группы», «как включить напоминания». Это нормальные вопросы — вызови bot_help и ответь по нему конкретными кнопками и командами. Не выдумывай пунктов, которых там нет.
- Вопрос могут задать как угодно: «как дела у беляева», «что там у беляева», «где сейчас Беляев», «в какой группе Беляева» — во всех этих случаях речь о студенте, вызывай find_student. Про успеваемость, настроение и личную жизнь бот не знает ничего: скажи это одной фразой и покажи то, что знаешь, — группу и где человек должен быть по расписанию.
- В поиск пишут что угодно одной строкой: фамилию преподавателя, ФИО студента, номер группы, название предмета, «кто ведёт физику», «где Иванов». Сначала пойми, о ком или о чём речь, и используй нужный инструмент — не отказывай только потому, что это не похоже на вопрос о расписании. Обязательно помечай, кого нашёл: «преподаватель (ВИШ)», «студент ВИШ, группа 12-23», «группа», «предмет». Если под запрос подходит и преподаватель, и студент — покажи оба варианта.
- Опечатки — это нормально. Если фамилия или название написаны с ошибкой, всё равно ищи: инструменты сами подбирают похожие. Если нашлись похожие люди — не отвечай «не найден», а предложи варианты: «Возможно, ты про Троишестову Д. С. или Троицкую А. В.?» Кнопки с этими именами бот добавит под ответом сам, поэтому просто назови их и попроси выбрать.
- Пометка «(ВИШ)» рядом с фамилией — не украшение: в ЧувГУ есть полные тёзки, и она означает «ведёт у нашей школы». Если инструмент вернул фамилию с «(ВИШ)», пиши её с этой пометкой; если пометки нет — не добавляй её сам. Преподаватели онлайн-пар ВИШ — всегда наши.
- Вопросы про преподавателя («кто такая Иванова», «что ведёт Петров», «когда у Сидорова пары», «кто ведёт физику») — это вопросы о расписании. Используй find_teacher: он ищет по фамилии или имени в любом порядке и возвращает предметы, группы и ближайшие пары. Отвечай тем, что есть в расписании: какие предметы ведёт, у каких групп, когда ближайшие пары. Биографию, должность и контакты бот не знает — так и скажи, если спросят.
- В расписании групп портал НЕ указывает преподавателя. Преподаватели известны по онлайн-парам (страница вебинаров) и, если у бота есть учётка портала, по справочнику преподавателей. Отвечая про человека, опирайся только на то, что вернул find_teacher, и честно говори, если данных нет. Не угадывай.
- Расписание своей группы на две недели уже дано в сообщении; для других дат и групп используй инструменты. Не выдумывай пары и людей.
- Отвечай кратко, по-русски, на «ты». Формат Telegram HTML: только теги <b>, <i>, <code>. Без Markdown, без списков через «*».
- Про сам бот отвечай инструментом bot_help: там точный список кнопок и возможностей. Не выдумывай кнопок, которых там нет.
- Если группа пользователя не выбрана, скажи, что её нужно выбрать кнопкой «👥 Др. группы» или командой /group, и всё равно ответь тем, что можешь.
- Даты пиши как «пн 14.09», время как 11:40–13:00.
- Когда инструмент точно нашёл одного человека (преподавателя или студента), бот сам пришлёт под твоим ответом его карточку: кто это, где он сейчас по расписанию и пары на день с кнопками. Поэтому не пересказывай его расписание целиком — ответь на сам вопрос одной-двумя фразами.`;

function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function fmtLessons(list: Occurrence[], today: LocalDate): string {
  const lines: string[] = [];
  let current: LocalDate | null = null;
  for (const o of list) {
    if (o.date !== current) {
      current = o.date;
      lines.push(`\n${o.date} ${weekdayName(o.date)}${o.date === today ? " (сегодня)" : ""}:`);
    }
    const t = o.start != null && o.end != null ? `${fmtHHMM(o.start)}-${fmtHHMM(o.end)}` : "";
    const bits = [
      o.slot != null ? `${o.slot} пара` : "",
      t,
      o.subject,
      `(${lessonTypeLabel(o.type)})`,
      o.teacher ? `преп. ${o.teacher}` : "",
      o.isDistance ? "дистанционно" : o.room ? `ауд. ${o.room}` : "",
      o.subgroup ? `${o.subgroup} подгр.` : "",
      o.groups?.length ? `группы: ${o.groups.join(", ")}` : "",
      o.status === "moved" ? `ПЕРЕНЕСЕНА на ${o.movedTo?.date ?? "?"}` : "",
      o.movedFrom ? `перенос с ${o.movedFrom.date}` : "",
    ].filter(Boolean);
    lines.push(`  ${bits.join(" | ")}`);
  }
  return lines.join("\n").trim() || "пар нет";
}

/** Онлайн-пары преподавателя на сегодня как пары расписания — для строки «где сейчас». */
function webinarToday(t: WebinarTeacher, today: LocalDate): Occurrence[] {
  return t.lessons
    .filter((l) => l.date === today && l.scheduled)
    .map((l) => ({ groupKey: "webinar", period: 1 as const, date: l.date, slot: l.slot, start: l.start, end: l.end, subject: l.subject, type: l.type.replace(/\.$/, "").toLowerCase(), room: null, teacher: null, subgroup: l.subgroup, isDistance: true, status: "scheduled" as const, sources: [], groups: l.groups }))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

/** What the webinar page knows about a teacher, as plain text for the model. */
function describeWebinarTeacher(t: WebinarTeacher, webinars: WebinarService, today: LocalDate): string {
  const title = [t.position, t.degree].filter(Boolean).join(", ");
  const next = webinars.upcoming(t, 6).map((l) => `  ${l.date} ${weekdayName(l.date)}${l.slot ? ` | ${l.slot} пара` : ""} | ${l.subject} (${lessonTypeLabel(l.type)}) | дистанционно | группы: ${l.groups.join(", ")}${l.title ? ` | тема: ${l.title}` : ""}`);
  return [
    `${t.name}${title ? ` (${title})` : ""} — по странице вебинаров ВИШ (только онлайн-пары ближайших дней и недавнего прошлого):`,
    `ведёт онлайн: ${t.subjects.join("; ")}`,
    `группы: ${t.groups.join(", ")}`,
    // Та же строка, что в карточке человека: модель и кнопка говорят одно и то же.
    `где сейчас (по онлайн-парам): ${whereNowPlain(webinarToday(t, today), "teacher", null)}`,
    next.length ? `ближайшие онлайн-пары (сегодня ${today}):\n${next.join("\n")}` : "ближайших онлайн-пар нет",
  ].join("\n");
}

export class AskService {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly service: ScheduleService,
    private readonly opts: AskOptions,
    private readonly teachers: TeacherService | null = null,
    private readonly webinars: WebinarService | null = null,
    private readonly students: StudentLookup | null = null,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 180_000 });
  }

  private resolveGroup(query: string, fallback: LogicalGroup): LogicalGroup | null {
    const q = query.trim();
    if (!q || /^(моя|своя|мы|наша)$/iu.test(q)) return fallback;
    const found = findGroup(this.service.groups(), q);
    return found.length === 1 ? found[0]! : found.length > 1 ? (found.find((g) => g.key === fallback.key) ?? found[0]!) : null;
  }

  private tools(own: LogicalGroup | null, subgroup: number | null, botHelp: string | undefined, mentions: AskMentions, userId: number, mode: "private" | "group" = "private") {
    const service = this.service;
    const teachers = this.teachers;
    const webinars = this.webinars;
    const today = todayMsk();
    const resolve = (q: string) => (own ? this.resolveGroup(q, own) : (findGroup(service.groups(), q)[0] ?? null));

    const getSchedule = betaZodTool({
      name: "get_schedule",
      description: "Расписание группы ВИШ на диапазон дат (не больше 28 дней). Группа: «ВИШ-14-26», «14-26» или «моя».",
      inputSchema: z.object({
        group: z.string().describe("Название группы, например 14-26"),
        from: z.string().describe("Дата начала YYYY-MM-DD"),
        to: z.string().describe("Дата конца YYYY-MM-DD"),
      }),
      run: async (input) => {
        const g = resolve(input.group);
        if (!g) return `Группа «${input.group}» не найдена. Известные группы: ${service.groups().map((x) => x.title).join(", ")}`;
        remember(mentions.groupKeys, g.key, (a, b) => a === b);
        if (!isLocalDate(input.from) || !isLocalDate(input.to)) return "Даты нужны в формате YYYY-MM-DD";
        const to = addDays(input.from, 28) < input.to ? addDays(input.from, 28) : input.to;
        const list = service.materialize(g, input.from, to);
        return `Расписание ${g.title} с ${input.from} по ${to}:\n${fmtLessons(own && g.key === own.key ? filterSubgroup(list, subgroup) : list, today)}`;
      },
    });

    const findSubject = betaZodTool({
      name: "find_subject",
      description: "Найти предмет по разговорному или частичному названию в расписании группы на ближайшие 8 недель. Возвращает подходящие предметы, их преподавателей и ближайшие пары.",
      inputSchema: z.object({
        query: z.string().describe("Слово или часть названия: «математика», «физ», «прога»"),
        group: z.string().optional().describe("Группа; по умолчанию своя"),
      }),
      run: async (input) => {
        const g = resolve(input.group ?? "");
        if (!g) return `Группа «${input.group}» не найдена.`;
        remember(mentions.groupKeys, g.key, (a, b) => a === b);
        const list = service.materialize(g, today, addDays(today, 56));
        const q = normalize(input.query);
        const stems = q.split(" ").filter((w) => w.length >= 3).map((w) => w.slice(0, Math.max(3, Math.min(w.length - 1, 5))));
        const bySubject = new Map<string, Occurrence[]>();
        for (const o of list) {
          const subj = normalize(o.subject);
          const hit = q.length && (subj.includes(q) || stems.some((st) => subj.split(" ").some((w) => w.startsWith(st))));
          if (hit) bySubject.set(o.subject, [...(bySubject.get(o.subject) ?? []), o]);
        }
        if (!bySubject.size) return `В расписании ${g.title} ничего похожего на «${input.query}» нет. Все предметы: ${[...new Set(list.map((o) => o.subject))].join("; ")}`;
        return [...bySubject.entries()].map(([subject, occ]) => `${subject}:\n${fmtLessons(occ.slice(0, 6), today)}`).join("\n\n");
      },
    });

    const listGroups = betaZodTool({
      name: "list_groups",
      description: "Список всех групп ВИШ с курсом.",
      inputSchema: z.object({}),
      run: async () => service.groups().map((g) => `${g.title} (${g.course} курс)`).join("\n"),
    });

    const findTeacher = betaZodTool({
      name: "find_teacher",
      description: "Найти преподавателя по фамилии и/или имени (в любом порядке, можно с инициалами). С учёткой портала возвращает полное расписание преподавателя на 2 недели; без неё — только онлайн-пары ближайших дней (предмет, группы, тема).",
      inputSchema: z.object({
        query: z.string().describe("Фамилия и/или имя: «Иванова», «Дарья Иванова», «Иванова Д.А.»"),
      }),
      run: async (input) => {
        const out: string[] = [];
        // Webinar rows name the teacher of every online lesson and are readable without an account.
        const webinarHits = webinars?.searchScored(input.query, 3) ?? [];
        const fromWebinars = webinarHits.map((x) => x.teacher);
        // Нашлось только по опечатке — так и скажи, а не выдавай за точный ответ.
        if (webinarHits.length && webinarHits.every((x) => x.fuzzy)) {
          out.push(`Точного совпадения с «${input.query}» нет; ниже — похожие по написанию: ${fromWebinars.map((t) => t.name).join("; ")}. Предложи выбрать, кнопки бот добавит сам.`);
        }
        for (const hit of webinarHits) {
          out.push(describeWebinarTeacher(hit.teacher, webinars!, today));
          remember(mentions.webinarTeachers, { name: hit.teacher.name, exact: !hit.fuzzy }, (a, b) => a.name.toLowerCase() === b.name.toLowerCase());
        }
        if (!teachers) {
          out.push(
            fromWebinars.length
              ? "Это всё, что известно из расписания онлайн-пар: полное расписание преподавателя портал показывает только авторизованным, а у бота нет учётки."
              : `Про «${input.query}» в расписании онлайн-пар ВИШ ничего нет, а полный справочник преподавателей портал показывает только авторизованным (у бота нет учётки портала). Скажи это честно.`,
          );
          return out.join("\n\n");
        }
        const scored = await teachers.searchScored(input.query, 5);
        const found = scored.map((x) => x.ref);
        // Пометка «(ВИШ)» берётся из карты преподавателей, а ночной обход портала
        // до нужной фамилии мог ещё не дойти — проверяем тех, кого нашли.
        await teachers.ensureMapped(found);
        const tag = (t: { id: number; name: string }): string => (teachers.isVish(t.id, t.name) ? " (ВИШ)" : "");
        for (const x of scored) remember(mentions.teachers, { id: x.ref.id, name: x.ref.name, exact: !x.fuzzy }, (a, b) => a.id === b.id);
        if (!found.length) {
          out.push(`В справочнике преподавателей ЧувГУ «${input.query}» не найден — даже с поправкой на опечатки. Попроси написать фамилию иначе или прислать инициалы.`);
          return out.join("\n\n");
        }
        // Совпало только с опечатками — не выдавай это за точный ответ.
        if (scored[0]!.fuzzy) {
          out.push(`Точного совпадения с «${input.query}» нет, но похоже на: ${found.map((t) => `${t.name}${tag(t)}`).join("; ")}. Предложи выбрать из них, кнопки бот добавит сам. Ниже — расписание первого из списка, на случай если это он.`);
        } else if (found.length > 1) {
          out.push(`Похожие преподаватели: ${found.map((t) => `${t.name}${tag(t)}`).join("; ")}. Показываю первого, остальные можно предложить кнопками.`);
        }
        const t = found[0]!;
        try {
          const { lessons, fullName } = await teachers.lessons(t, today, addDays(today, 14));
          // Страница называет группы каждой пары: заодно уточняем пометку «(ВИШ)».
          teachers.noteFromLessons(t.id, fullName ?? t.name, lessons);
          const subjects = [...new Set(lessons.map((o) => o.subject))];
          const groups = [...new Set(lessons.flatMap((o) => o.groups ?? []))];
          out.push(
            `${fullName ?? t.name}${tag(t)} — преподаватель: ${subjects.length ? `ведёт ${subjects.join("; ")}` : "в ближайшие 2 недели пар нет"}${groups.length ? `. Группы: ${groups.join(", ")}` : ""}.\nГде сейчас по расписанию: ${whereNowPlain(lessons, "teacher", null)}\nПары на 2 недели:\n${fmtLessons(lessons.slice(0, 20), today)}`,
          );
        } catch (err) {
          logger.warn({ err: String(err), teacher: t.id }, "ask: teacher page failed");
          out.push(`${t.name}${tag(t)} есть в справочнике, но портал не отдал расписание (попробуй позже).`);
        }
        return out.join("\n\n");
      },
    });

    const students = this.students;
    const findStudent = betaZodTool({
      name: "find_student",
      description:
        "Найти студента ВИШ по ФИО в реестре школы и сказать, где он должен быть сейчас по расписанию своей группы. Использовать при любом вопросе про конкретного человека, как бы он ни был задан: «где Иванов», «в какой группе Петрова», «как дела у Беляева», «что там у Сидорова», «чем занят Кузнецов сейчас».",
      inputSchema: z.object({ query: z.string().describe("Фамилия, можно с именем") }),
      run: async (input) => {
        if (!students) return "Глобальный поиск студентов в этом боте выключен. Скажи, что бот ищет только преподавателей, группы и предметы.";
        if (!students.allowed(userId)) return "У этого человека на сегодня кончился лимит поисков людей. Так и скажи.";
        const found = students.search(input.query, 5);
        students.note(userId, input.query, found[0]?.id ?? null);
        if (!found.length) return `В реестре студентов ВИШ никого похожего на «${input.query}» нет. Возможно, это первокурсник: их в реестре нет.`;
        for (const st of found) remember(mentions.students, { id: st.id, name: st.name, groupTitle: st.groupTitle, exact: !st.fuzzy }, (a, b) => a.id === b.id);
        const exact = found.filter((f) => !f.fuzzy);
        const list = (exact.length ? exact : found).slice(0, 5);
        const lines = list.map((st) => {
          const where = students.whereabouts(st.id);
          return `${st.name} — студент ВИШ, группа ${st.groupTitle}${st.subgroup ? `, ${st.subgroup} подгруппа` : ""}.${where ? ` ${where}` : ""}`;
        });
        const note = exact.length ? "" : `\nТочного совпадения нет, это похожие по написанию — предложи выбрать.`;
        return `${lines.join("\n")}${note}\nЭто расписание его группы, а не факт присутствия: предупреди об этом одной фразой. Ничего другого про человека бот не знает — ни оценок, ни контактов, ни «как дела».`;
      },
    });

    const botHelpTool = betaZodTool({
      name: "bot_help",
      description: "Что умеет бот и какие у него кнопки и команды. Используй для любых вопросов о боте и о том, как им пользоваться.",
      inputSchema: z.object({}),
      run: async () => botHelp ?? "Справка по боту недоступна.",
    });

    // В общем чате про конкретных людей не говорим вовсе: «где сейчас Беляев»
    // в группе на сорок человек — это уже не расписание, а слежка на публике.
    return students && mode === "private" ? [getSchedule, findSubject, listGroups, findTeacher, findStudent, botHelpTool] : [getSchedule, findSubject, listGroups, findTeacher, botHelpTool];
  }

  /**
   * Инструменты для болталки в группах: расписание, предметы, группы,
   * преподаватели и справка по боту — без поиска студентов: «где сейчас
   * Беляев» в чате на сорок человек — это уже слежка на публике.
   */
  groupTools(input: { group: LogicalGroup | null; subgroup: number | null; userId: number; botHelp?: string }): ChatTool[] {
    // Все они — betaZodTool, то есть обычные инструменты с input_schema.
    return this.tools(input.group, input.subgroup, input.botHelp, emptyMentions(), input.userId, "group") as unknown as ChatTool[];
  }

  async answer(input: { question: string; group: LogicalGroup | null; subgroup: number | null; userId: number; botHelp?: string; self?: { name: string; lessons: Occurrence[] } }): Promise<AskResult> {
    const question = input.question.slice(0, 500);
    const today = todayMsk();
    const from = mondayOf(today);
    const own = input.group ? filterSubgroup(this.service.materialize(input.group, from, addDays(from, 13)), input.subgroup) : [];
    const wi = this.service.weekInfo(today);
    const context = input.group ? fmtLessons(own, today) : "";
    // Режим преподавателя: спрашивает сам преподаватель, «моё расписание» — его пары.
    const about = input.self
      ? `Я преподаватель: ${input.self.name}. Мои пары на эту и следующую неделю:\n${fmtLessons(input.self.lessons, today)}`
      : input.group
        ? `Моя группа: ${input.group.title}${input.subgroup ? `, подгруппа ${input.subgroup}` : ""}.\n\nРасписание моей группы на эту и следующую неделю:\n${context}`
        : "Моя группа пока не выбрана.";
    const mentions = emptyMentions();
    const runner = this.client.beta.messages.toolRunner({
      model: this.opts.model,
      // У Sonnet 5 размышление включено по умолчанию, и max_tokens ограничивает
      // его вместе с ответом: при 1200 ответ мог обрезаться на полуслове или
      // не начаться вовсе. Платится только то, что модель реально написала.
      max_tokens: 8000,
      max_iterations: 6,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "medium" },
      tools: this.tools(input.group, input.subgroup, input.botHelp, mentions, input.userId),
      messages: [
        {
          role: "user",
          content: `Сегодня ${today} (${weekdayName(today)}${wi.week ? `, ${wi.week} учебная неделя, ${wi.parity === "odd" ? "нечётная" : "чётная"}` : ""}). ${about}\n\nВопрос: ${question}`,
        },
      ],
    });
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const message of runner) {
      inputTokens += message.usage.input_tokens;
      outputTokens += message.usage.output_tokens;
      if (message.stop_reason === "refusal") {
        logger.warn({ category: message.stop_details?.category }, "ask: model refused");
        return { text: "Я отвечаю только на вопросы о расписании 🙂", inputTokens, outputTokens, mentions };
      }
    }
    const final = await runner.done();
    const text = final.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (final.stop_reason === "max_tokens") {
      logger.warn({ outputTokens }, "ask: answer hit max_tokens");
      // Обрезанный ответ лучше честно пометить, чем выдать за полный.
      return { text: text ? `${text}…\n\n<i>Ответ получился слишком длинным и обрезан — спроси точнее.</i>` : "Ответ получился слишком длинным. Спроси точнее — например, про один день или одну группу.", inputTokens, outputTokens, mentions };
    }
    return { text: text || "Не нашёл ответа в расписании.", inputTokens, outputTokens, mentions };
  }
}
