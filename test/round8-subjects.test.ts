import { describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { subjectHandlers } from "../src/bot/handlers/subjects.js";
import { formatSubjectTable, summarizeSubjects } from "../src/schedule/subjects.js";
import type { BotContext, Deps } from "../src/bot/context.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
const group: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [1], portalNames: ["ВИШ-12-23"] };
const occ = (date: string, subject: string, type: string, extra: Partial<Occurrence> = {}): Occurrence => ({ groupKey: group.key, period: 1, date, slot: 1, start: 8 * 60 + 20, end: 9 * 60 + 40, subject, type, room: "Г-101", teacher: "Иванова Ирина Ивановна", subgroup: null, isDistance: false, status: "scheduled", sources: [], ...extra });

const lessons = [
  occ("2026-09-02", "Математический анализ", "лк"),
  occ("2026-09-09", "Математический анализ", "пр", { room: "В-215" }),
  occ("2026-09-16", "Математический анализ", "лк", { status: "moved" }),
  occ("2026-09-23", "Математический анализ", "лк"),
  occ("2026-09-30", "Математический анализ", "лб", { subgroup: 1, isDistance: true }),
  occ("2026-09-10", "Физика", "лк"),
];

describe("панель предметов", () => {
  it("считает пары по типам, прошедшие и оставшиеся, без опустевших слотов переноса", () => {
    const [mat] = summarizeSubjects(lessons);
    expect(mat!.subject).toBe("Математический анализ");
    expect(mat!.lessons).toHaveLength(4);
    const text = formatSubjectTable(mat!, { owner: "ВИШ-12-23", periodLabel: "осенний семестр", today: "2026-09-23", nowMinutes: 9 * 60 });
    expect(text).toContain("Всего 4: ЛК 2 · ПР 1 · ЛБ 1");
    expect(text).toContain("прошло 2, осталось 2");
    expect(text).toContain("→ 23.09");
    expect(text).toContain("✓ 02.09");
    expect(text).toContain("ЛБ1");
    expect(text).toContain("Иванова И. И.");
    const onlyLab = formatSubjectTable(mat!, { owner: "ВИШ-12-23", periodLabel: "осенний семестр", today: "2026-09-23", nowMinutes: 9 * 60, type: "лб" });
    expect(onlyLab).toContain("ЛБ: прошло 0, осталось 1");
    expect(onlyLab).not.toContain("02.09");
  });

  it("/subjects показывает предметы кнопками, нажатие — таблицу предмета", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "u", "U");
    repo.updateUser(7, { groupKey: group.key });
    const service = {
      group: (k: string) => (k === group.key ? group : null),
      groups: () => [group],
      materialize: () => lessons,
      semesterFor: () => 1 as const,
      weekOneMonday: () => "2026-09-01",
    } as unknown as ScheduleService;
    const deps = { config: {}, repo, service, webinars: null, teachers: null } as unknown as Deps;
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const runOnce = async (update: Update): Promise<void> => {
      const api = new Api("123:FAKE");
      api.config.use(async (_prev, method, payload) => {
        calls.push({ method, payload: payload as Record<string, unknown> });
        return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
      });
      const ctx = new Context(update, api, ME) as BotContext;
      ctx.deps = deps;
      ctx.user = repo.getUser(7)!;
      await new Composer<BotContext>().use(subjectHandlers).middleware()(ctx, async () => undefined);
    };
    await runOnce({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 7, type: "private", first_name: "U" }, from: { id: 7, is_bot: false, first_name: "U" }, text: "/subjects", entities: [{ type: "bot_command", offset: 0, length: 9 }] } });
    const list = calls[0]!;
    expect(String(list.payload.text)).toContain("Предметы · ВИШ-12-23");
    const kb = (list.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    expect(kb.map((r) => r[0]!.text)).toEqual(["Математический анализ · 4", "Физика · 1"]);
    await runOnce({ update_id: 2, callback_query: { id: "1", from: { id: 7, is_bot: false, first_name: "U" }, chat_instance: "1", data: kb[0]![0]!.callback_data, message: { message_id: 2, date: 0, chat: { id: 7, type: "private", first_name: "U" }, text: "x" } as never } });
    const detail = calls.find((c) => c.method === "editMessageText")!;
    expect(String(detail.payload.text)).toContain("📚 <b>Математический анализ</b>");
    expect(String(detail.payload.text)).toContain("<pre>");
  });
});
