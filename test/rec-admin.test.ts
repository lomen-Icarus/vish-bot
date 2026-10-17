import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { applyRecorderReport, approveRecRequest, recorderTasks, rejectRecRequest, requestRecheck, revokeRecRequest, revokeSlotWithoutRequest, REQUEST_TTL_DAYS } from "../src/bot/recorder.js";
import { notifyRecorderEffect, requestCard, type SendApi } from "../src/bot/recNotify.js";
import { myRecordingScreen, slotsScreen } from "../src/bot/handlers/recSlots.js";
import type { LogicalGroup } from "../src/schedule/groups.js";

const ENV = JSON.stringify({ v: 1, k: "k", iv: "iv", c: "c" });
const repo = (): Repo => new Repo(openDatabase(":memory:"));
const GROUPS: LogicalGroup[] = [
  { key: "виш-14-25", title: "ВИШ-14-25", prefix: "ВИШ", number: 14, intake: 25, course: 2, portalIds: [], portalNames: [] },
  { key: "виш-13-23", title: "ВИШ-13-23", prefix: "ВИШ", number: 13, intake: 23, course: 4, portalIds: [], portalNames: [] },
  { key: "person-x", title: "Иванов", prefix: "", number: 0, intake: 0, course: 0, portalIds: [], portalNames: [] },
];

function req(r: Repo, userId: number, group = "ВИШ-14-25", state = "pending_verify"): number {
  const id = r.createRecRequest({ userId, username: `u${userId}`, groupKey: group.toLowerCase(), groupTitle: group, envelopeJson: ENV });
  if (state !== "pending_verify") r.setRecRequestState(id, state);
  return id;
}

function fakeApi(): SendApi & { sent: Array<{ to: number; text: string; buttons: string[] }> } {
  const sent: Array<{ to: number; text: string; buttons: string[] }> = [];
  return {
    sent,
    async sendMessage(to, text, other) {
      const rows = (other?.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined)?.inline_keyboard ?? [];
      sent.push({ to, text, buttons: rows.flat().map((b) => b.callback_data ?? "") });
    },
  };
}

describe("замена учётки группы", () => {
  it("одобрение на занятую группу: прежняя — на отзыв, и remove уходит раньше install", () => {
    const r = repo();
    const old = req(r, 1, "ВИШ-14-25", "active");
    const fresh = req(r, 2, "ВИШ-14-25", "verified");
    const res = approveRecRequest(r, fresh, 99);
    expect(res).toMatchObject({ ok: true, replaced: { id: old } });
    expect(r.recRequest(old)!.state).toBe("revoking");
    expect(r.recRequest(fresh)!.state).toBe("approved");
    const kinds = recorderTasks(r).map((t) => `${t.kind}:${t.requestId}`);
    expect(kinds).toEqual([`remove:${old}`, `install:${fresh}`]);
  });

  it("повторное нажатие «Одобрить» и одобрение без шифровки — отказ, состояние не трогаем", () => {
    const r = repo();
    const id = req(r, 1, "ВИШ-14-25", "verified");
    expect(approveRecRequest(r, id, 99).ok).toBe(true);
    expect(approveRecRequest(r, id, 99)).toEqual({ ok: false, reason: "state" });
    const bare = req(r, 2, "ВИШ-13-23", "verified");
    r.setRecRequestState(bare, "verified", { dropEnvelope: true });
    expect(approveRecRequest(r, bare, 99)).toEqual({ ok: false, reason: "no_envelope" });
    expect(r.recRequest(bare)!.state).toBe("verified");
    expect(approveRecRequest(r, 12345, 99)).toEqual({ ok: false, reason: "gone" });
  });
});

describe("решения и отзыв", () => {
  it("отклонение стирает шифровку и засчитывается в лимит", () => {
    const r = repo();
    const id = req(r, 1, "ВИШ-14-25", "verified");
    expect(rejectRecRequest(r, id, 99).ok).toBe(true);
    expect(r.recRequest(id)).toMatchObject({ state: "rejected", envelopeJson: null });
    expect(r.recRequestsSince(1, "2000-01-01T00:00:00Z")).toBe(1);
    expect(rejectRecRequest(r, id, 99)).toEqual({ ok: false, reason: "state" });
  });

  it("отзыв: стоящая в слоте — на отзыв (задание remove), неодобренная — снимается без задания", () => {
    const r = repo();
    const active = req(r, 1, "ВИШ-14-25", "active");
    const waiting = req(r, 2, "ВИШ-13-23", "verified");
    expect(revokeRecRequest(r, active).ok).toBe(true);
    expect(revokeRecRequest(r, waiting).ok).toBe(true);
    expect(r.recRequest(active)!.state).toBe("revoking");
    expect(r.recRequest(waiting)).toMatchObject({ state: "revoked_early", envelopeJson: null });
    expect(recorderTasks(r).map((t) => t.kind)).toEqual(["remove"]);
    expect(revokeRecRequest(r, active)).toEqual({ ok: false, reason: "state" });
  });
});

describe("слоты: потеря и возврат доступа", () => {
  it("ok → lost → lost → ok: одна весть о потере и одна о возврате", () => {
    const r = repo();
    const id = req(r, 1, "ВИШ-14-25", "active");
    const slot = (status: string) => ({ slots: [{ group: "ВИШ-14-25", status, lastOkAt: "2026-10-17T09:00:00Z" }] });
    expect(applyRecorderReport(r, slot("ok")).lost).toEqual([]);
    const e1 = applyRecorderReport(r, slot("lost"));
    expect(e1.lost).toEqual([{ groupKey: "виш-14-25", groupTitle: "ВИШ-14-25", requestId: id, userId: 1, username: "u1" }]);
    expect(applyRecorderReport(r, slot("lost")).lost).toEqual([]);
    const e3 = applyRecorderReport(r, slot("ok"));
    expect(e3.recovered).toHaveLength(1);
    expect(e3.lost).toEqual([]);
  });

  it("слот, которого нет в отчёте, пропадает из зеркала", () => {
    const r = repo();
    applyRecorderReport(r, { slots: [{ group: "ВИШ-14-25", status: "ok" }, { group: "ВИШ-13-23", status: "ok" }] });
    applyRecorderReport(r, { slots: [{ group: "ВИШ-13-23", status: "ok" }] });
    expect(r.recSlots().map((s) => s.groupKey)).toEqual(["виш-13-23"]);
    // Отчёт без поля slots зеркало не трогает.
    applyRecorderReport(r, { results: [] });
    expect(r.recSlots()).toHaveLength(1);
  });

  it("«Проверить снова»: задание recheck с id метки; метка снимается при любом ответе, даже portal_down", () => {
    const r = repo();
    const id = req(r, 1, "ВИШ-14-25", "active");
    applyRecorderReport(r, { slots: [{ group: "ВИШ-14-25", status: "lost" }] });
    expect(requestRecheck(r, "виш-14-25")).toBe(true);
    expect(requestRecheck(r, "виш-нет")).toBe(false);
    const tasks = recorderTasks(r);
    expect(tasks).toEqual([{ id: "recheck:виш-14-25", kind: "recheck", requestId: id, userId: 1, group: "ВИШ-14-25", codes: ["14-25"] }]);
    applyRecorderReport(r, { results: [{ id: "recheck:виш-14-25", requestId: id, code: "portal_down" }] });
    expect(recorderTasks(r)).toEqual([]);
    expect(r.recRequest(id)!.state).toBe("active");
  });

  it("«Проверить снова» — админу ровно одно сообщение при любом исходе", async () => {
    const r = repo();
    const id = req(r, 1, "ВИШ-14-25", "active");
    applyRecorderReport(r, { slots: [{ group: "ВИШ-14-25", status: "lost" }] });
    const cases: Array<[string, string, string]> = [
      ["login_failed", "lost", "всё ещё не пускает"],
      ["portal_down", "lost", "не отвечает"],
      ["login_ok", "ok", "снова пускает"],
    ];
    for (const [code, status, expected] of cases) {
      requestRecheck(r, "виш-14-25");
      const eff = applyRecorderReport(r, { results: [{ id: "recheck:виш-14-25", requestId: id, code: code as "login_ok" }], slots: [{ group: "ВИШ-14-25", status }] });
      const api = fakeApi();
      await notifyRecorderEffect(api, r, [100], eff);
      const toAdmin = api.sent.filter((m) => m.to === 100);
      expect(toAdmin).toHaveLength(1);
      expect(toAdmin[0]!.text).toContain(expected);
    }
  });
});

describe("срок жизни заявки", () => {
  it(`через ${REQUEST_TTL_DAYS} дней неодобренная истекает, шифровка стёрта, в лимит не идёт`, () => {
    const r = repo();
    const id = req(r, 1, "ВИШ-14-25", "verified");
    const active = req(r, 2, "ВИШ-13-23", "active");
    const later = Date.now() + (REQUEST_TTL_DAYS + 1) * 24 * 60 * 60 * 1000;
    const eff = applyRecorderReport(r, {}, later);
    expect(eff.transitions).toEqual([expect.objectContaining({ requestId: id, from: "verified", to: "expired" })]);
    expect(r.recRequest(id)).toMatchObject({ state: "expired", envelopeJson: null });
    expect(r.recRequest(active)!.state).toBe("active");
    expect(r.recRequestsSince(1, "2000-01-01T00:00:00Z")).toBe(0);
  });
});

describe("уведомления", () => {
  it("проверенная заявка — админам карточка с кнопками; студенту ничего", async () => {
    const r = repo();
    r.touchUser(1, "u1", "U");
    const id = req(r, 1);
    const eff = applyRecorderReport(r, { results: [{ id: `${id}:verify`, requestId: id, code: "login_ok", actualGroup: "ВИШ-12-25" }] });
    const api = fakeApi();
    await notifyRecorderEffect(api, r, [100, 101], eff);
    expect(api.sent.map((m) => m.to)).toEqual([100, 101]);
    expect(api.sent[0]!.text).toContain("⚠️ не совпадает");
    expect(api.sent[0]!.buttons).toEqual([`rq:ok:${id}`, `rq:no:${id}`]);
  });

  it("вход не прошёл — студенту, с остатком лимита; админу молчок", async () => {
    const r = repo();
    r.touchUser(1, "u1", "U");
    const id = req(r, 1);
    const eff = applyRecorderReport(r, { results: [{ id: `${id}:verify`, requestId: id, code: "login_failed" }] });
    const api = fakeApi();
    await notifyRecorderEffect(api, r, [100], eff);
    expect(api.sent.map((m) => m.to)).toEqual([1]);
    expect(api.sent[0]!.text).toContain("осталось: 1");
  });

  it("слот поставлен — студенту «подключена» с кнопкой отзыва, админу коротко", async () => {
    const r = repo();
    r.touchUser(1, "u1", "U");
    const id = req(r, 1, "ВИШ-14-25", "approved");
    const eff = applyRecorderReport(r, { results: [{ id: `${id}:install`, requestId: id, code: "installed" }] });
    const api = fakeApi();
    await notifyRecorderEffect(api, r, [100], eff);
    expect(api.sent.find((m) => m.to === 1)).toMatchObject({ buttons: ["rqme:rv"] });
    expect(api.sent.find((m) => m.to === 100)!.text).toContain("поставлен");
  });

  it("потеря доступа — админу с «Проверить снова/Отозвать», студенту нейтрально; после /soon студенту не пишем", async () => {
    const r = repo();
    r.touchUser(1, "u1", "U");
    const id = req(r, 1, "ВИШ-14-25", "active");
    applyRecorderReport(r, { slots: [{ group: "ВИШ-14-25", status: "ok" }] });
    const eff = applyRecorderReport(r, { slots: [{ group: "ВИШ-14-25", status: "lost" }] });
    const api = fakeApi();
    await notifyRecorderEffect(api, r, [100], eff);
    expect(api.sent.find((m) => m.to === 100)!.buttons).toEqual([`rq:rc:${id}`, `rq:rv:${id}`]);
    expect(api.sent.find((m) => m.to === 1)!.text).toContain("приостановлена");

    const r2 = repo();
    r2.touchUser(5, "x", "X");
    const gone = req(r2, 5, "ВИШ-14-25", "active");
    r2.forgetUser(5);
    const eff2 = applyRecorderReport(r2, { results: [{ id: `${gone}:remove`, requestId: gone, code: "removed" }] });
    const api2 = fakeApi();
    await notifyRecorderEffect(api2, r2, [100], eff2);
    expect(api2.sent).toEqual([]);
  });

  it("ошибка отправки одному не мешает остальным", async () => {
    const r = repo();
    const sent: number[] = [];
    const api: SendApi = { async sendMessage(to) { if (to === 100) throw new Error("blocked"); sent.push(to); } };
    await notifyRecorderEffect(api, r, [100, 101], { firstConnect: true, keyChanged: false, transitions: [], lost: [], recovered: [], rechecked: [] });
    expect(sent).toEqual([101]);
  });
});

describe("экраны", () => {
  it("карточка: занятый слот предупреждает о замене; решённая — без кнопок", () => {
    const r = repo();
    req(r, 1, "ВИШ-14-25", "active");
    const id = req(r, 2, "ВИШ-14-25", "verified");
    const card = requestCard(r, r.recRequest(id)!);
    expect(card.text).toContain("занят @u1");
    expect(card.kb).toBeDefined();
    approveRecRequest(r, id, 99);
    expect(requestCard(r, r.recRequest(id)!).kb).toBeUndefined();
  });

  it("/slots: все учебные группы, слот со статусом и кнопками, ждущие заявки", () => {
    const r = repo();
    const id = req(r, 1, "ВИШ-14-25", "active");
    applyRecorderReport(r, { slots: [{ group: "ВИШ-14-25", status: "lost", lastOkAt: "2026-10-17T09:00:00Z" }], portal: "ok" });
    req(r, 2, "ВИШ-13-23", "verified");
    const { text, kb } = slotsScreen(r, GROUPS);
    expect(text).toContain("1 из 2 групп");
    expect(text).toContain("⚠️ ВИШ-14-25 — @u1 · не пускает (последний вход 17.10 12:00)");
    expect(text).toContain("▫️ ВИШ-13-23");
    expect(text).not.toContain("Иванов");
    expect(text).toContain("Ждут решения: 1");
    const data = kb.inline_keyboard.flat().map((b) => (b as { callback_data?: string }).callback_data);
    expect(data).toEqual([`rq:rc:${id}`, `rq:rv:${id}`, "rq:list", "rq:slots"]);
  });

  it("экран студента: стоит в слоте — «Отозвать учётку»; ждёт — «Снять заявку»; убирается — без кнопок", () => {
    const r = repo();
    const a = req(r, 1, "ВИШ-14-25", "active");
    expect(myRecordingScreen(r, r.recRequest(a)!).kb?.inline_keyboard.flat()[0]!.text).toBe("🗑 Отозвать учётку");
    const v = req(r, 2, "ВИШ-13-23", "verified");
    expect(myRecordingScreen(r, r.recRequest(v)!).kb?.inline_keyboard.flat()[0]!.text).toBe("🗑 Снять заявку");
    r.setRecRequestState(a, "revoking");
    expect(myRecordingScreen(r, r.recRequest(a)!).kb).toBeUndefined();
    expect(r.liveRecRequest(1)!.state).toBe("revoking");
  });
});

describe("слот без заявки (учётка перенесена из .env)", () => {
  it("/slots: «учётка из .env» и кнопки по группе", () => {
    const r = repo();
    applyRecorderReport(r, { slots: [{ group: "ВИШ-13-23", status: "lost", lastOkAt: null }] });
    const { text, kb } = slotsScreen(r, GROUPS);
    expect(text).toContain("⚠️ ВИШ-13-23 — учётка из .env");
    const data = kb.inline_keyboard.flat().map((b) => (b as { callback_data?: string }).callback_data);
    expect(data.slice(0, 2)).toEqual(["rq:rcg:виш-13-23", "rq:rvg:виш-13-23"]);
  });

  it("отзыв: служебная заявка на отзыв → remove → removed убирает слот, студенту писать некому", async () => {
    const r = repo();
    applyRecorderReport(r, { slots: [{ group: "ВИШ-13-23", status: "ok" }] });
    expect(revokeSlotWithoutRequest(r, "виш-13-23", 99)).toBe(true);
    expect(revokeSlotWithoutRequest(r, "виш-13-23", 99)).toBe(true); // повтор — без второй заявки
    const tasks = recorderTasks(r);
    expect(tasks).toEqual([expect.objectContaining({ kind: "remove", group: "ВИШ-13-23", userId: 0 })]);
    const eff = applyRecorderReport(r, { results: [{ id: tasks[0]!.id, requestId: tasks[0]!.requestId, code: "removed" }], slots: [] });
    expect(r.recSlots()).toEqual([]);
    const api = fakeApi();
    await notifyRecorderEffect(api, r, [100], eff);
    expect(api.sent).toEqual([]);
    expect(revokeSlotWithoutRequest(r, "виш-13-23", 99)).toBe(false);
  });

  it("потеря доступа у такого слота — кнопки по группе", async () => {
    const r = repo();
    applyRecorderReport(r, { slots: [{ group: "ВИШ-13-23", status: "ok" }] });
    const eff = applyRecorderReport(r, { slots: [{ group: "ВИШ-13-23", status: "lost" }] });
    const api = fakeApi();
    await notifyRecorderEffect(api, r, [100], eff);
    expect(api.sent).toEqual([expect.objectContaining({ to: 100, buttons: ["rq:rcg:виш-13-23", "rq:rvg:виш-13-23"] })]);
    expect(api.sent[0]!.text).toContain("учётка из .env");
  });
});

describe("общая учётка (.env) в /slots", () => {
  const GEN = "Общая учётка (.env)";

  it("строка сверху, не считается слотом группы, без «Отозвать»", () => {
    const r = repo();
    applyRecorderReport(r, { slots: [{ group: GEN, status: "ok", lastOkAt: "2026-10-17T09:00:00Z" }] });
    const { text, kb } = slotsScreen(r, GROUPS);
    expect(text).toContain("0 из 2 групп");
    expect(text).toContain("🔑 Общая учётка (.env) — для групп без своей: ✅ пускало 17.10 12:00");
    const data = kb.inline_keyboard.flat().map((b) => (b as { callback_data?: string }).callback_data);
    expect(data).toEqual(["rq:slots"]);
  });

  it("не пускает — кнопка «Проверить снова», весть админу про WEBINAR_PASSWORD; отозвать нельзя", async () => {
    const r = repo();
    applyRecorderReport(r, { slots: [{ group: GEN, status: "ok" }] });
    const eff = applyRecorderReport(r, { slots: [{ group: GEN, status: "lost" }] });
    const api = fakeApi();
    await notifyRecorderEffect(api, r, [100], eff);
    expect(api.sent).toHaveLength(1);
    expect(api.sent[0]!.text).toContain("WEBINAR_PASSWORD");
    expect(api.sent[0]!.buttons).toEqual(["rq:rcg:общая учётка (.env)"]);
    const { kb } = slotsScreen(r, GROUPS);
    expect(kb.inline_keyboard.flat().map((b) => (b as { callback_data?: string }).callback_data)).toEqual(["rq:rcg:общая учётка (.env)", "rq:slots"]);
    expect(revokeSlotWithoutRequest(r, "общая учётка (.env)", 99)).toBe(false);
    expect(requestRecheck(r, "общая учётка (.env)")).toBe(true);
    expect(recorderTasks(r)).toEqual([expect.objectContaining({ kind: "recheck", group: GEN })]);
  });
});
