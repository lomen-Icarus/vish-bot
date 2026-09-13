import Anthropic from "@anthropic-ai/sdk";
import type { ScheduleService } from "../schedule/service.js";
import type { LogicalGroup } from "../schedule/groups.js";
import { filterSubgroup } from "../schedule/format.js";
import { lessonTypeLabel } from "../schedule/model.js";
import { addDays, fmtHHMM, mondayOf, todayMsk, weekdayName, type LocalDate } from "../time.js";
import { logger } from "../logger.js";

export interface AskOptions {
  model: string;
}

export interface AskResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

const SYSTEM = `Ты — помощник по расписанию Высшей инженерной школы ЧувГУ внутри Telegram-бота.
Отвечай ТОЛЬКО на вопросы о расписании занятий (пары, время, аудитории, дни, недели, сессия, переносы).
На любые другие темы (решение задач, лабораторные, код, тексты, советы, разговоры) отвечай одной фразой:
"Я отвечаю только на вопросы о расписании 🙂" — без исключений и без объяснений.
Данные расписания приходят в сообщении пользователя как контекст; не выдумывай пары, которых там нет.
Если ответа нет в данных, так и скажи и предложи посмотреть неделю кнопкой.
Отвечай кратко, по-русски, на "ты", можно использовать простое HTML-форматирование Telegram: <b>, <i>, <code>. Не используй Markdown.`;

export class AskService {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    private readonly service: ScheduleService,
    private readonly opts: AskOptions,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  /** Two weeks of the group's schedule as compact text for the model. */
  private context(group: LogicalGroup, subgroup: number | null): string {
    const today = todayMsk();
    const from = mondayOf(today);
    const to = addDays(from, 20);
    const all = filterSubgroup(this.service.materialize(group, from, to), subgroup);
    const lines: string[] = [];
    let current: LocalDate | null = null;
    for (const o of all) {
      if (o.date !== current) {
        current = o.date;
        const wi = this.service.weekInfo(o.date);
        lines.push(`\n${o.date} ${weekdayName(o.date)}${o.date === today ? " (сегодня)" : ""}${wi.week ? `, ${wi.week} неделя` : ""}:`);
      }
      const t = o.start != null && o.end != null ? `${fmtHHMM(o.start)}-${fmtHHMM(o.end)}` : "";
      const bits = [o.slot != null ? `${o.slot} пара` : "", t, o.subject, `(${lessonTypeLabel(o.type)})`, o.isDistance ? "дистанционно" : o.room ? `ауд. ${o.room}` : "", o.subgroup ? `${o.subgroup} подгр.` : "", o.status === "moved" ? `ПЕРЕНЕСЕНА на ${o.movedTo?.date ?? "?"}` : "", o.movedFrom ? `перенос с ${o.movedFrom.date}` : ""].filter(Boolean);
      lines.push(`  ${bits.join(" | ")}`);
    }
    return lines.join("\n").trim() || "Пар в ближайшие три недели нет.";
  }

  async answer(input: { question: string; group: LogicalGroup; subgroup: number | null; userId: number }): Promise<AskResult> {
    const question = input.question.slice(0, 500);
    const context = this.context(input.group, input.subgroup);
    const res = await this.client.messages.create({
      model: this.opts.model,
      max_tokens: 700,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: `Группа: ${input.group.title}${input.subgroup ? `, подгруппа ${input.subgroup}` : ""}. Сегодня ${todayMsk()}.\n\nРасписание:\n${context}\n\nВопрос студента: ${question}`,
        },
      ],
    });
    if (res.stop_reason === "refusal") {
      logger.warn({ category: res.stop_details?.category }, "ask: model refused");
      return { text: "Я отвечаю только на вопросы о расписании 🙂", inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
    }
    const text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return { text: text || "Не нашёл ответа в расписании.", inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens };
  }
}
