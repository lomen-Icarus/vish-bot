/**
 * Natural-language questions about the timetable. The model gets the own
 * group's next two weeks inline plus tools to look at any group, search a
 * subject by a colloquial name and list groups; it must refuse off-topic asks.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ScheduleService } from "../schedule/service.js";
import { findGroup, type LogicalGroup } from "../schedule/groups.js";
import { filterSubgroup } from "../schedule/format.js";
import { lessonTypeLabel, type Occurrence } from "../schedule/model.js";
import { addDays, fmtHHMM, isLocalDate, mondayOf, todayMsk, weekdayName, type LocalDate } from "../time.js";
import { logger } from "../logger.js";

export interface AskOptions {
  model: string;
}

export interface AskResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

const SYSTEM = `Ты — помощник по расписанию Высшей инженерной школы (ВИШ) ЧувГУ внутри Telegram-бота.
Отвечай ТОЛЬКО на вопросы о расписании занятий: пары, время, аудитории, дни, недели, сессия, переносы, любые группы ВИШ.
На любые другие темы (решение задач, лабы, код, тексты, советы, болтовня) отвечай ровно одной фразой:
"Я отвечаю только на вопросы о расписании 🙂" — без исключений.

Как отвечать:
- Студенты называют предметы разговорно: «математика»/«матан» = «Математический анализ», «Алгебра и геометрия» тоже математика; «физра» = «Физическая культура и спорт»; «инфа» = «Информатика»; «прога» = «Программирование»/«Основы программирования»; «англ» = «Иностранный язык»; «история» = «История России»; «ОРГ» = «Основы российской государственности». Если точного предмета нет — ищи по смыслу инструментом find_subject и предлагай ближайшие совпадения.
- Если спрашивают про другую группу (например «у 14-26») — используй get_schedule для неё; названия групп вида «14-26» = «ВИШ-14-26».
- Расписание своей группы на две недели уже дано в сообщении; для других дат и групп используй инструменты. Не выдумывай пары.
- Отвечай кратко, по-русски, на «ты». Формат Telegram HTML: только теги <b>, <i>, <code>. Без Markdown, без списков через «*».
- Даты пиши как «пн 14.09», время как 11:40–13:00.`;

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
    const bits = [o.slot != null ? `${o.slot} пара` : "", t, o.subject, `(${lessonTypeLabel(o.type)})`, o.isDistance ? "дистанционно" : o.room ? `ауд. ${o.room}` : "", o.subgroup ? `${o.subgroup} подгр.` : "", o.groups?.length ? `группы: ${o.groups.join(", ")}` : "", o.status === "moved" ? `ПЕРЕНЕСЕНА на ${o.movedTo?.date ?? "?"}` : "", o.movedFrom ? `перенос с ${o.movedFrom.date}` : ""].filter(Boolean);
    lines.push(`  ${bits.join(" | ")}`);
  }
  return lines.join("\n").trim() || "пар нет";
}

export class AskService {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly service: ScheduleService,
    private readonly opts: AskOptions,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  }

  private resolveGroup(query: string, fallback: LogicalGroup): LogicalGroup | null {
    const q = query.trim();
    if (!q || /^(моя|своя|мы|наша)$/iu.test(q)) return fallback;
    const found = findGroup(this.service.groups(), q);
    return found.length === 1 ? found[0]! : found.length > 1 ? (found.find((g) => g.key === fallback.key) ?? found[0]!) : null;
  }

  private tools(own: LogicalGroup, subgroup: number | null) {
    const service = this.service;
    const today = todayMsk();
    const resolve = (q: string) => this.resolveGroup(q, own);

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
        if (!isLocalDate(input.from) || !isLocalDate(input.to)) return "Даты нужны в формате YYYY-MM-DD";
        const to = addDays(input.from, 28) < input.to ? addDays(input.from, 28) : input.to;
        const list = service.materialize(g, input.from, to);
        return `Расписание ${g.title} с ${input.from} по ${to}:\n${fmtLessons(g.key === own.key ? filterSubgroup(list, subgroup) : list, today)}`;
      },
    });

    const findSubject = betaZodTool({
      name: "find_subject",
      description: "Найти предмет по разговорному или частичному названию в расписании группы на ближайшие 8 недель. Возвращает подходящие предметы и их ближайшие пары.",
      inputSchema: z.object({
        query: z.string().describe("Слово или часть названия: «математика», «физ», «прога»"),
        group: z.string().optional().describe("Группа; по умолчанию своя"),
      }),
      run: async (input) => {
        const g = resolve(input.group ?? "");
        if (!g) return `Группа «${input.group}» не найдена.`;
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

    return [getSchedule, findSubject, listGroups];
  }

  async answer(input: { question: string; group: LogicalGroup; subgroup: number | null; userId: number }): Promise<AskResult> {
    const question = input.question.slice(0, 500);
    const today = todayMsk();
    const from = mondayOf(today);
    const own = filterSubgroup(this.service.materialize(input.group, from, addDays(from, 13)), input.subgroup);
    const wi = this.service.weekInfo(today);
    const context = fmtLessons(own, today);
    const runner = this.client.beta.messages.toolRunner({
      model: this.opts.model,
      max_tokens: 1200,
      max_iterations: 6,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "medium" },
      tools: this.tools(input.group, input.subgroup),
      messages: [
        {
          role: "user",
          content: `Сегодня ${today} (${weekdayName(today)}${wi.week ? `, ${wi.week} учебная неделя, ${wi.parity === "odd" ? "нечётная" : "чётная"}` : ""}). Моя группа: ${input.group.title}${input.subgroup ? `, подгруппа ${input.subgroup}` : ""}.\n\nРасписание моей группы на эту и следующую неделю:\n${context}\n\nВопрос: ${question}`,
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
        return { text: "Я отвечаю только на вопросы о расписании 🙂", inputTokens, outputTokens };
      }
    }
    const final = await runner.done();
    const text = final.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return { text: text || "Не нашёл ответа в расписании.", inputTokens, outputTokens };
  }
}
