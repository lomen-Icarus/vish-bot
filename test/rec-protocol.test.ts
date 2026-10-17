import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { applyRecorderReport, groupCode, recorderTasks } from "../src/bot/recorder.js";
import { verifyInitData } from "../src/http/initData.js";

const repo = (): Repo => new Repo(openDatabase(":memory:"));
const ENV = JSON.stringify({ v: 1, k: "k", iv: "iv", c: "c" });

describe("initData: подпись Telegram Mini App", () => {
  const TOKEN = "123456:TEST_TOKEN_abcdefghijklmnop";
  const sign = (fields: Record<string, string>): string => {
    const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort();
    const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
    const hash = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
    return new URLSearchParams({ ...fields, hash }).toString();
  };
  const fresh = (): Record<string, string> => ({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 42, username: "stud" }) });

  it("верная подпись и свежесть — ok с пользователем", () => {
    const r = verifyInitData(sign(fresh()), TOKEN);
    expect(r.ok).toBe(true);
    expect(r.user).toEqual({ id: 42, username: "stud", first_name: undefined });
  });
  it("подделанная подпись — bad_hash", () => {
    const data = sign(fresh()).replace(/hash=[a-f0-9]+/, "hash=" + "0".repeat(64));
    expect(verifyInitData(data, TOKEN)).toMatchObject({ ok: false, reason: "bad_hash" });
  });
  it("чужой токен — bad_hash", () => {
    expect(verifyInitData(sign(fresh()), "999:OTHER_TOKEN_xxxxxxxxxxxxxx")).toMatchObject({ ok: false, reason: "bad_hash" });
  });
  it("устаревшее auth_date — stale", () => {
    const old = { auth_date: String(Math.floor(Date.now() / 1000) - 3600), user: JSON.stringify({ id: 42 }) };
    expect(verifyInitData(sign(old), TOKEN)).toMatchObject({ ok: false, reason: "stale" });
  });
  it("64 не-hex символа в hash — malformed, без исключения", () => {
    const data = sign(fresh()).replace(/hash=[a-f0-9]+/, "hash=" + "z".repeat(64));
    expect(verifyInitData(data, TOKEN)).toMatchObject({ ok: false, reason: "malformed" });
  });
  it("нет user — no_user", () => {
    const f = { auth_date: String(Math.floor(Date.now() / 1000)) };
    expect(verifyInitData(sign(f), TOKEN)).toMatchObject({ ok: false, reason: "no_user" });
  });
});

describe("код группы для сверки", () => {
  it("из названия вынимает номер, склеивает пробел перед скобкой", () => {
    expect(groupCode("ВИШ-14-25")).toBe("14-25");
    expect(groupCode("ВИШ-11-23 (ЭиЭА)")).toBe("11-23(эиэа)");
    expect(groupCode("ОЗВИШ-12-25")).toBe("12-25");
  });
});

describe("задания записывалке из состояния заявок", () => {
  it("revoking → remove первым, затем pending_verify → verify с конвертом, approved → install", () => {
    const r = repo();
    const a = r.createRecRequest({ userId: 1, username: "a", groupKey: "виш-14-25", groupTitle: "ВИШ-14-25", envelopeJson: ENV });
    const b = r.createRecRequest({ userId: 2, username: "b", groupKey: "виш-13-23", groupTitle: "ВИШ-13-23", envelopeJson: ENV });
    r.setRecRequestState(b, "approved");
    const c = r.createRecRequest({ userId: 3, username: "c", groupKey: "виш-12-23", groupTitle: "ВИШ-12-23", envelopeJson: ENV });
    r.setRecRequestState(c, "revoking", { dropEnvelope: true });
    const tasks = recorderTasks(r).map((t) => [t.kind, t.requestId, t.codes.join(","), !!t.envelope]);
    expect(tasks).toEqual([
      ["remove", c, "12-23", false],
      ["verify", a, "14-25", true],
      ["install", b, "13-23", true],
    ]);
  });
});

describe("применение отчёта записывалки", () => {
  it("login_ok → verified (конверт цел), login_failed → rejected_auth (конверт стёрт), portal_down — без изменений", () => {
    const r = repo();
    const ok = r.createRecRequest({ userId: 1, username: "a", groupKey: "виш-14-25", groupTitle: "ВИШ-14-25", envelopeJson: ENV });
    const bad = r.createRecRequest({ userId: 2, username: "b", groupKey: "виш-13-23", groupTitle: "ВИШ-13-23", envelopeJson: ENV });
    const down = r.createRecRequest({ userId: 3, username: "c", groupKey: "виш-12-23", groupTitle: "ВИШ-12-23", envelopeJson: ENV });
    const eff = applyRecorderReport(r, {
      publicKey: "KEY1",
      results: [
        { id: `${ok}:verify`, requestId: ok, code: "login_ok", actualGroup: "ВИШ-14-25" },
        { id: `${bad}:verify`, requestId: bad, code: "login_failed" },
        { id: `${down}:verify`, requestId: down, code: "portal_down" },
      ],
    });
    expect(eff.firstConnect).toBe(true);
    expect(r.recRequest(ok)).toMatchObject({ state: "verified", actualGroup: "ВИШ-14-25", envelopeJson: ENV });
    expect(r.recRequest(bad)).toMatchObject({ state: "rejected_auth", envelopeJson: null });
    expect(r.recRequest(down)).toMatchObject({ state: "pending_verify" });
  });

  it("login_ok с чужой группой — verified, но помечено несовпадение", () => {
    const r = repo();
    const id = r.createRecRequest({ userId: 1, username: "a", groupKey: "виш-14-25", groupTitle: "ВИШ-14-25", envelopeJson: ENV });
    const eff = applyRecorderReport(r, { results: [{ id: `${id}:verify`, requestId: id, code: "login_ok", actualGroup: "ВИШ-12-25" }] });
    expect(eff.transitions).toEqual([{ requestId: id, from: "pending_verify", to: "verified", mismatch: true, actualGroup: "ВИШ-12-25", userId: 1, username: "a", groupKey: "виш-14-25", groupTitle: "ВИШ-14-25" }]);
  });

  it("installed → active (конверт стёрт); removed → revoked и слот убран", () => {
    const r = repo();
    const inst = r.createRecRequest({ userId: 1, username: "a", groupKey: "виш-14-25", groupTitle: "ВИШ-14-25", envelopeJson: ENV });
    r.setRecRequestState(inst, "approved");
    const rev = r.createRecRequest({ userId: 2, username: "b", groupKey: "виш-13-23", groupTitle: "ВИШ-13-23", envelopeJson: ENV });
    r.setRecRequestState(rev, "revoking", { dropEnvelope: true });
    r.upsertRecSlot({ groupKey: "виш-13-23", groupTitle: "ВИШ-13-23", requestId: rev, status: "ok", lastOkAt: null });
    applyRecorderReport(r, {
      results: [
        { id: `${inst}:install`, requestId: inst, code: "installed" },
        { id: `${rev}:remove`, requestId: rev, code: "removed" },
      ],
    });
    expect(r.recRequest(inst)).toMatchObject({ state: "active", envelopeJson: null });
    expect(r.recRequest(rev)).toBeNull();
    expect(r.recSlots()).toEqual([]);
  });

  it("установка не прошла (bad_envelope/login_failed у approved) — заявка не застревает, слот убран", () => {
    const r = repo();
    for (const code of ["bad_envelope", "login_failed"] as const) {
      const id = r.createRecRequest({ userId: 1, username: "a", groupKey: "виш-14-25", groupTitle: "ВИШ-14-25", envelopeJson: ENV });
      r.setRecRequestState(id, "approved");
      r.upsertRecSlot({ groupKey: "виш-14-25", groupTitle: "ВИШ-14-25", requestId: id, status: "ok", lastOkAt: null });
      applyRecorderReport(r, { results: [{ id: `${id}:install`, requestId: id, code }] });
      expect(r.recRequest(id)!.state).toBe(code === "bad_envelope" ? "rejected_bad_envelope" : "rejected_auth");
      expect(r.recSlots()).toEqual([]);
    }
  });

  it("битый конверт в базе не ломает выдачу заданий", () => {
    const r = repo();
    r.createRecRequest({ userId: 1, username: "a", groupKey: "виш-14-25", groupTitle: "ВИШ-14-25", envelopeJson: "{не json" });
    const good = r.createRecRequest({ userId: 2, username: "b", groupKey: "виш-13-23", groupTitle: "ВИШ-13-23", envelopeJson: ENV });
    const tasks = recorderTasks(r);
    expect(tasks.map((t) => t.requestId)).toEqual([good]);
  });

  it("смена ключа после первого отчёта — keyChanged", () => {
    const r = repo();
    applyRecorderReport(r, { publicKey: "KEY1" });
    const eff = applyRecorderReport(r, { publicKey: "KEY2" });
    expect(eff).toMatchObject({ firstConnect: false, keyChanged: true });
    expect(r.recorderPublicKey()).toBe("KEY2");
  });

  it("зеркало слотов и portal пишутся из отчёта", () => {
    const r = repo();
    applyRecorderReport(r, { slots: [{ group: "ВИШ-14-25", status: "ok", lastOkAt: "2026-10-17T00:00:00Z" }], portal: "down" });
    expect(r.recSlots()).toEqual([{ groupKey: "виш-14-25", groupTitle: "ВИШ-14-25", requestId: null, status: "ok", lastOkAt: "2026-10-17T00:00:00Z", updatedAt: expect.any(String) }]);
    expect(r.recorderMarkValue("portal")).toBe("down");
  });
});

describe("лимит заявок и /soon", () => {
  it("считает всё, кроме снятых системой", () => {
    const r = repo();
    const mk = (state: string) => {
      const id = r.createRecRequest({ userId: 5, username: "x", groupKey: "виш-14-25", groupTitle: "ВИШ-14-25", envelopeJson: ENV });
      if (state !== "pending_verify") r.setRecRequestState(id, state);
      return id;
    };
    mk("pending_verify");
    mk("rejected_auth");
    mk("rejected_bad_envelope");
    mk("expired");
    const since = "2000-01-01T00:00:00Z";
    expect(r.recRequestsSince(5, since)).toBe(2);
  });

  it("forgetUser: активную заявку помечает на отзыв, остальные удаляет", () => {
    const r = repo();
    r.touchUser(5, "x", "X");
    const active = r.createRecRequest({ userId: 5, username: "x", groupKey: "виш-14-25", groupTitle: "ВИШ-14-25", envelopeJson: ENV });
    r.setRecRequestState(active, "active", { dropEnvelope: true });
    const old = r.createRecRequest({ userId: 5, username: "x", groupKey: "виш-13-23", groupTitle: "ВИШ-13-23", envelopeJson: ENV });
    r.setRecRequestState(old, "rejected_auth");
    r.forgetUser(5);
    expect(r.recRequest(active)).toMatchObject({ state: "revoking" });
    expect(r.recRequest(old)).toBeNull();
  });
});
