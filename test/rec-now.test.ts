import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { parseWebinarRows, type WebinarRow } from "../recorder/src/portal.js";
import { keyOf, liveSnapshot, planRecording, type RecordState } from "../recorder/src/plan.js";
import { applyRecorderReport, readLive, sanitizeLive } from "../src/bot/recorder.js";
import { liveScreen } from "../src/bot/handlers/recSlots.js";

const base = parseWebinarRows(readFileSync(path.resolve("test/fixtures/webinar-fac32.html"), "utf8"))[0]!;
const row = (subject: string, groups: string[], extra: Partial<WebinarRow> = {}): WebinarRow => ({ ...base, subject, groups, teacher: `Преподаватель ${subject}`, startMinutes: 590, endMinutes: 670, joinId: "j", ...extra });
const at = { date: "2026-10-24", minutes: 600 };

describe("записывалка: снимок «что идёт сейчас»", () => {
  it("пишу / нет места / жду комнату / записал / без слайдов / не в настройках; без фамилий", () => {
    const cfg = { subjects: [], groups: ["11-25", "12-25", "13-25", "14-25", "11-24"], skipSubjects: ["Физическая культура"], leadMinutes: 7, maxParallel: 2 };
    const state: RecordState = { done: new Set(), active: new Set(), retryAt: new Map() };
    const rows = [
      row("Физика", ["ВИШ-11-25"]),
      row("Химия", ["ВИШ-12-25"]),
      row("История", ["ВИШ-13-25"]),
      row("Информатика", ["ВИШ-14-25"], { joinId: "" }),
      row("Физическая культура", ["ВИШ-11-24"]),
      row("Чужая", ["ВИШ-15-22"]),
      row("Завтрашняя", ["ВИШ-11-25"], { startMinutes: 800, endMinutes: 880 }),
      row("Закрытая встреча", ["ВИШ-11-25"], { scheduled: false }),
      row("Утренняя", ["ВИШ-12-25"], { startMinutes: 500, endMinutes: 580 }),
    ];
    state.done.add(keyOf(at.date, row("Записанная", ["ВИШ-11-24"])));
    rows.push(row("Записанная", ["ВИШ-11-24"]));
    const plan = planRecording(rows, at, cfg, state, 0);
    for (const r of plan.start) state.active.add(keyOf(at.date, r));
    const snap = liveSnapshot(rows, at, cfg, state, plan, new Date("2026-10-24T07:00:00Z"));
    expect(snap.maxParallel).toBe(2);
    expect(snap.pairs.map((p) => [p.subject, p.status])).toEqual([
      ["Физика", "recording"],
      ["Химия", "recording"],
      ["История", "queued"],
      ["Информатика", "waiting"],
      ["Записанная", "done"],
      ["Физическая культура", "no_slides"],
      ["Чужая", "not_ours"],
    ]);
    expect(snap.pairs[0]).toMatchObject({ start: "09:50", end: "11:10", groups: ["ВИШ-11-25"] });
    expect(JSON.stringify(snap)).not.toContain("Преподаватель");
  });
});

describe("бот: /rec_now", () => {
  const live = (pairs: unknown[], atIso = new Date().toISOString()) => ({ at: atIso, maxParallel: 2, pairs });

  it("снимок из отчёта хранится; мусор отбрасывается", () => {
    const r = new Repo(openDatabase(":memory:"));
    expect(readLive(r)).toBeNull();
    applyRecorderReport(r, { live: live([{ start: "09:50", end: "11:10", subject: "Физика", groups: ["ВИШ-11-25"], status: "recording" }, { subject: "x", groups: [], status: "hacked" }, null]) });
    expect(readLive(r)!.pairs).toEqual([{ start: "09:50", end: "11:10", subject: "Физика", groups: ["ВИШ-11-25"], status: "recording" }]);
    // Отчёт без снимка (старая записывалка) прежний не стирает.
    applyRecorderReport(r, {});
    expect(readLive(r)!.pairs).toHaveLength(1);
    expect(sanitizeLive({ at: "не дата", pairs: [] })).toBeNull();
    expect(sanitizeLive({ at: new Date().toISOString(), pairs: [{ start: "<b>", end: null, subject: "S", groups: ["G", 5], status: "queued" }] })!.pairs[0]).toMatchObject({ start: null, groups: ["G"] });
  });

  it("кого пишу, кто не влез в лимит, и можно ли мёржить", () => {
    const r = new Repo(openDatabase(":memory:"));
    const now = Date.parse("2026-10-24T07:02:00Z");
    applyRecorderReport(r, {
      live: live(
        [
          { start: "09:50", end: "11:10", subject: "Физика", groups: ["ВИШ-11-25", "ВИШ-12-25"], status: "recording" },
          { start: "09:50", end: "11:10", subject: "Химия & <био>", groups: ["ВИШ-13-25"], status: "recording" },
          { start: "09:50", end: "11:10", subject: "История", groups: ["ВИШ-14-25"], status: "queued" },
          { start: "09:50", end: "11:10", subject: "Физическая культура", groups: ["ВИШ-11-24"], status: "no_slides" },
        ],
        "2026-10-24T07:00:00Z",
      ),
    });
    const text = liveScreen(r, now);
    expect(text).toContain("Мест для записи: 2, занято: 2");
    expect(text).toContain("⏺ <b>Пишу (2)</b>");
    expect(text).toContain("• 09:50–11:10 Физика — ВИШ-11-25, ВИШ-12-25");
    expect(text).toContain("Химия &amp; &lt;био&gt;");
    expect(text).toContain("⏳ <b>Не пишу: нет свободного места (1)</b>");
    expect(text).toContain("лимит одновременной записи — 2 (MAX_PARALLEL)");
    expect(text).toContain("• 09:50–11:10 История — ВИШ-14-25");
    expect(text).toContain("2 мин назад");
    expect(text).toContain("Идёт запись — мёрж и деплой сейчас перезапустят записывалку.");
    expect(text).not.toContain("Жду комнату");

    applyRecorderReport(r, { live: live([], "2026-10-24T07:00:00Z") });
    const quiet = liveScreen(r, now);
    expect(quiet).toContain("Сейчас вебинаров по расписанию нет.");
    expect(quiet).toContain("Записи нет — мёржить можно.");
    // Давно не докладывала — совета «можно мёржить» нет, есть предупреждение.
    const stale = liveScreen(r, now + 20 * 60_000);
    expect(stale).toContain("не докладывала 22 мин");
    expect(stale).not.toContain("мёржить можно");
  });

  it("без снимка — подсказка, что записывалку надо обновить", () => {
    expect(liveScreen(new Repo(openDatabase(":memory:")))).toContain("нужна её новая версия");
  });
});
