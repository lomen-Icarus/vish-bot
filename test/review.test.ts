import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { Notifier } from "../src/notify/dispatcher.js";
import { groupCb } from "../src/bot/keyboards.js";
import { decodeEntities } from "../src/news/fetchers.js";
import { ScheduleService } from "../src/schedule/service.js";
import { buildInlineResults, parseInlineQuery } from "../src/bot/inline.js";
import { todayMsk, wallClock, type WallClock } from "../src/time.js";
import type { Deps } from "../src/bot/context.js";
import type { LogicalGroup } from "../src/schedule/groups.js";
import type { Occurrence } from "../src/schedule/model.js";
import type { ScheduleService as ScheduleServiceType } from "../src/schedule/service.js";
import type { User } from "../src/db/repo.js";

const own: LogicalGroup = { key: "виш-12-23", title: "ВИШ-12-23", prefix: "ВИШ", number: 12, intake: 23, course: 4, portalIds: [1], portalNames: ["ВИШ-12-23"] };
const watched: LogicalGroup = { ...own, key: "виш-13-24", title: "ВИШ-13-24", number: 13, intake: 24 };
const today = todayMsk();

function lesson(date: string): Occurrence {
  return { groupKey: watched.key, period: 1, date, slot: 3, start: 11 * 60 + 40, end: 13 * 60, subject: "Физика", type: "лк", room: "Т-310", teacher: null, subgroup: null, isDistance: false, status: "scheduled", sources: [watched.title] };
}

function service(): ScheduleServiceType {
  return {
    group: (key: string) => [own, watched].find((g) => g.key === key) ?? null,
    groups: () => [own, watched],
    weekInfo: () => ({ week: 3, parity: "odd" as const, semester: 1 as const }),
    lessonsOn: () => [],
    materialize: () => [],
    intakes: () => [23, 24],
    stream: () => [own],
    semesterFor: () => 1 as const,
    weekOneMonday: () => "2026-09-01",
    lastPollRun: () => null,
  } as unknown as ScheduleServiceType;
}

/** Ночь по тихим часам 23:00–07:00 и утро сразу после них. */
const night: WallClock = { ...wallClock(), date: today, minutes: 2 * 60 };
const morning: WallClock = { ...wallClock(), date: today, minutes: 7 * 60 + 10 };

function seed(): { repo: Repo; sent: Array<{ chatId: number; text: string }>; api: never } {
  const repo = new Repo(openDatabase(":memory:"));
  repo.setMeta("backlog:since", "2000-01-01T00:00:00.000Z");
  repo.touchUser(7, "u", "U");
  repo.updateUser(7, { groupKey: own.key, notifyChanges: true, quietFrom: "23:00", quietTo: "07:00" });
  repo.toggleWatchGroup(7, watched.key);
  const before = lesson(today);
  repo.insertChangeEvents([{ groupKey: watched.key, date: today, period: 1, kind: "changed", payload: { before, after: { ...before, room: "Т-999" }, fields: ["room"] } }]);
  const sent: Array<{ chatId: number; text: string }> = [];
  const api = {
    sendMessage: async (chatId: number, text: string) => {
      sent.push({ chatId, text });
      return { message_id: 1 };
    },
  } as never;
  return { repo, sent, api };
}

describe("изменения в тихие часы", () => {
  it("утром доходят и по группе, за которой человек просто следит", async () => {
    const { repo, sent, api } = seed();
    const n = new Notifier(api, repo, service(), null);
    // Ночью уведомление откладывается…
    expect(await n.dispatchChangeEvents(night)).toBe(0);
    expect(sent).toEqual([]);
    // …а утром приходит: раньше чужая группа терялась навсегда.
    expect(await n.flushQuietBacklog(morning)).toBe(1);
    expect(sent[0]!.text).toContain("Т-999");
    // Второй раз не повторяется.
    expect(await n.flushQuietBacklog(morning)).toBe(0);
  });

  it("неудачная отправка не съедает изменение: утром будет ещё попытка", async () => {
    const { repo } = seed();
    let fail = true;
    const api = {
      sendMessage: async () => {
        if (fail) throw new Error("Bad Gateway");
        return { message_id: 1 };
      },
    } as never;
    const n = new Notifier(api, repo, service(), null);
    await n.dispatchChangeEvents(night);
    expect(await n.flushQuietBacklog(morning)).toBe(0); // отправка упала
    fail = false;
    expect(await n.flushQuietBacklog(morning)).toBe(1); // повтор дошёл
  });
});

describe("кнопки с ключом группы", () => {
  it("укладываются в 64 байта даже с длинным названием", () => {
    const long = "виш-11-23 (радиотехника, телекоммуникации и связь на транспорте)";
    const data = groupCb("pdn", long, "2026-09-21");
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(data.startsWith("pdn:")).toBe(true);
    expect(data.endsWith(":2026-09-21")).toBe(true);
  });

  it("обрезанный ключ всё равно находит свою группу", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const svc = new ScheduleService(repo, { getFacultyGroups: async () => [] } as never, { facultyId: 32, hiddenPrefixes: [] });
    repo.upsertPortalGroups([{ id: 1, name: "ВИШ-11-23 (Радиотехника и телекоммуникации)", groupKey: "виш-11-23 (радиотехника и телекоммуникации)" }]);
    const key = svc.groups()[0]!.key;
    const cb = groupCb("pdn", key, today);
    const cut = cb.slice("pdn:".length, cb.length - today.length - 1);
    expect(cut.length).toBeLessThan(key.length + 1);
    expect(svc.group(cut)?.key).toBe(key);
    expect(svc.group("виш-99-99")).toBeNull();
  });
});

describe("разбор новостей", () => {
  it("кривая числовая сущность не роняет разбор источника", () => {
    expect(decodeEntities("а&#9999999999;б")).toBe("а&#9999999999;б");
    expect(decodeEntities("&#1055;&#x440;&amp;")).toBe("Пр&");
  });
});

describe("inline", () => {
  it("длинный текст обрезается по-человечески, без разорванного тега", () => {
    const repo = new Repo(openDatabase(":memory:"));
    const deps = {
      config: { POISK: false } as unknown as Deps["config"],
      repo,
      service: {
        ...service(),
        // Длинный день: формат сам вставляет <b>…</b> в каждую строку.
        lessonsOn: () => Array.from({ length: 60 }, () => ({ ...lesson(today), subject: "Проектирование средств технологического оснащения и автоматизации" })),
        materialize: () => [],
      } as unknown as ScheduleServiceType,
      renderer: null,
      ask: null,
      teachers: null,
      webinars: null,
      students: null,
      news: null,
      http: null,
      inline: true,
      botUsername: "vish_bot",
      pending: new Map(),
      startedAt: new Date(),
    } as Deps;
    const user = { id: 7, groupKey: own.key, subgroup: null } as unknown as User;
    const req = parseInlineQuery(deps, "12-23", user);
    for (const r of buildInlineResults(deps, req, user)) {
      const text = String(r.input_message_content && "message_text" in r.input_message_content ? r.input_message_content.message_text : "");
      expect(text.length).toBeLessThanOrEqual(4096);
      // Сколько тегов открыли, столько и закрыли.
      expect((text.match(/<b>/g) ?? []).length).toBe((text.match(/<\/b>/g) ?? []).length);
      expect(text.endsWith("<")).toBe(false);
    }
  });
});
