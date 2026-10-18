/**
 * ИИ про все группы сразу: «когда кончаются пары у групп завтра» — одним
 * инструментом groups_day, списком по строке на группу.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { AskService } from "../src/ai/ask.js";
import {
  ChatService,
  type ChatClient,
  type ChatTool,
} from "../src/chat/service.js";
import { QaBase } from "../src/chat/qa.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";

const g = (title: string, course: number): LogicalGroup => ({
  key: title.toLowerCase(),
  title,
  prefix: "ВИШ",
  number: Number(title.split("-")[1]),
  intake: Number(title.split("-")[2]),
  course,
  portalIds: [],
  portalNames: [],
});
const occ = (
  start: number,
  end: number,
  subject: string,
  over: Partial<Occurrence> = {},
): Occurrence =>
  ({
    groupKey: "x",
    period: 1,
    date: "2026-10-19",
    slot: 1,
    start,
    end,
    subject,
    type: "лк",
    room: null,
    teacher: null,
    subgroup: null,
    isDistance: false,
    status: "scheduled",
    sources: [],
    ...over,
  }) as Occurrence;

function service(): ScheduleService {
  const groups = [g("ВИШ-11-23", 4), g("ВИШ-12-23", 4), g("ВИШ-14-25", 2)];
  const days: Record<string, Occurrence[]> = {
    "ВИШ-11-23": [],
    "ВИШ-12-23": [
      occ(500, 580, "Физика"),
      occ(590, 670, "Химия"),
      occ(810, 890, "История"),
      occ(500, 580, "Физика", { status: "moved" }),
    ],
    "ВИШ-14-25": [occ(700, 780, "Матан")],
  };
  return {
    groups: () => groups,
    lessonsOn: (grp: LogicalGroup) => days[grp.title] ?? [],
    materialize: () => [],
    ppaItems: () => [],
  } as unknown as ScheduleService;
}

type Tool = {
  name: string;
  run: (i: unknown) => Promise<unknown>;
  parse: (i: unknown) => unknown;
};

describe("groups_day", () => {
  it("все группы одним списком: начало–конец и число пар, «пар нет»; перенесённая не считается; фильтр по курсу", async () => {
    const tools = new AskService("sk-test", service(), {
      model: "m",
    }).groupTools({
      group: null,
      subgroup: null,
      userId: 7,
    }) as unknown as Tool[];
    const t = tools.find((x) => x.name === "groups_day")!;
    const out = String(await t.run(t.parse({ date: "2026-10-19" })));
    expect(out).toContain("ВИШ-11-23: пар нет");
    expect(out).toContain("ВИШ-12-23: 08:20–14:50, пар: 3");
    expect(out).toContain("ВИШ-14-25: 11:40–13:00, пар: 1");
    const second = String(
      await t.run(t.parse({ date: "2026-10-19", course: 2 })),
    );
    expect(second).toContain("ВИШ-14-25");
    expect(second).not.toContain("ВИШ-12-23");
  });

  it("есть и в личке", () => {
    const priv = (
      new AskService("sk-test", service(), { model: "m" }) as unknown as {
        tools: (...a: unknown[]) => Tool[];
      }
    ).tools(
      null,
      null,
      "",
      { teachers: [], webinarTeachers: [], groupKeys: [], students: [] },
      7,
    );
    expect(priv.map((t) => t.name)).toContain("groups_day");
  });
});

const qa = (): QaBase => {
  const dir = mkdtempSync(path.join(tmpdir(), "qa-"));
  writeFileSync(path.join(dir, "qa.csv"), "вопрос;ответ\n");
  return new QaBase(path.join(dir, "qa.csv"));
};
const input = (tools: ChatTool[]) => ({
  chatTitle: null,
  speaker: "Аня",
  speakerId: 7,
  text: "когда кончаются пары у групп завтра списком",
  history: [],
  transcript: [],
  repliedTo: null,
  now: { date: "2026-10-18", minutes: 600 },
  tools,
});

describe("болталка: список по группам и пустой ответ", () => {
  it("с groups_day в подсказке — правило «одним вызовом, списком»", () => {
    const tools = new AskService("sk-test", service(), {
      model: "m",
    }).groupTools({ group: null, subgroup: null, userId: 7 });
    const noop: ChatClient = {
      messages: { create: async () => ({}) as Anthropic.Message },
    };
    const req = new ChatService(
      null,
      { model: "m", contextMessages: 0, botUsername: "vish_bot" },
      qa(),
      noop,
    ).buildRequest(input(tools), []);
    const system = (req.system as Anthropic.TextBlockParam[])
      .map((b) => b.text)
      .join("\n");
    expect(system).toContain("один вызов groups_day");
    expect(system).toContain("по строке на группу");
  });

  it("модель упёрлась в лимит и ничего не написала — честная фраза, а не пустота", async () => {
    const client: ChatClient = {
      messages: {
        create: async () =>
          ({
            id: "m",
            type: "message",
            role: "assistant",
            model: "m",
            content: [],
            stop_reason: "max_tokens",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }) as unknown as Anthropic.Message,
      },
    };
    const reply = await new ChatService(
      null,
      { model: "m", contextMessages: 0, botUsername: "vish_bot" },
      qa(),
      client,
    ).reply(input([]));
    expect(reply.text).toContain("спроси покороче");
  });
});

describe("год в датах", () => {
  it("дата прошлого года — инструмент говорит «не тот год», а не «пар нет»; пустые дни названы с днём недели", async () => {
    const svc = {
      ...service(),
      materialize: (_g: LogicalGroup, from: string) =>
        from === "2026-10-21"
          ? []
          : [occ(500, 580, "Физика", { date: "2026-10-19" })],
    } as unknown as ScheduleService;
    const tools = new AskService("sk-test", svc, { model: "m" }).groupTools({
      group: null,
      subgroup: null,
      userId: 7,
    }) as unknown as Tool[];
    const get = tools.find((x) => x.name === "get_schedule")!;
    const day = tools.find((x) => x.name === "groups_day")!;
    const far = String(
      await get.run(
        get.parse({ group: "12-23", from: "2025-10-21", to: "2025-10-21" }),
      ),
    );
    expect(far).toContain("не этот учебный год");
    expect(String(await day.run(day.parse({ date: "2025-10-21" })))).toContain(
      "не этот учебный год",
    );
    const week = String(
      await get.run(
        get.parse({ group: "12-23", from: "2026-10-19", to: "2026-10-20" }),
      ),
    );
    expect(week).toContain("Без пар: 2026-10-20 Вторник");
  });

  it("в контексте чата — полная дата с годом", () => {
    const noop: ChatClient = {
      messages: { create: async () => ({}) as Anthropic.Message },
    };
    const req = new ChatService(
      null,
      { model: "m", contextMessages: 0, botUsername: "vish_bot" },
      qa(),
      noop,
    ).buildRequest(input([]), []);
    expect(JSON.stringify(req.messages.at(-1))).toContain("(2026-10-18)");
  });
});
