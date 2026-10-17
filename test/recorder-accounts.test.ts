import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelopeAad, loadOrCreateKeys, openEnvelope, sealCredentials } from "../recorder/src/crypto.js";
import { AccountStore } from "../recorder/src/accounts.js";
import { runLiveness, type LiveTarget } from "../recorder/src/liveness.js";
import type { LoginCheck } from "../recorder/src/lk.js";
import { groupCode as recGroupCode, profileToSlot } from "../recorder/src/envslot.js";
import { GeneralWatch, GENERAL_SLOT } from "../recorder/src/general.js";
import { GENERAL_SLOT_TITLE } from "../src/bot/recorder.js";
import { groupCode as botGroupCode } from "../src/bot/recorder.js";

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), "rec-acc-"));

describe("шифрование заявок (как в браузере, расшифровка у записывалки)", () => {
  it("конверт браузера раскрывается ключом записывалки; чужой AAD или порча — отказ", async () => {
    const keys = loadOrCreateKeys(path.join(tmp(), "keys"));
    const aad = envelopeAad(42, "ВИШ-14-25");
    const env = await sealCredentials(keys.publicSpki, { login: "stud@chuvsu.ru", password: "пароль Пример 123" }, aad);
    expect(JSON.stringify(env)).not.toContain("пароль");
    expect(await openEnvelope(keys.privatePem, env, aad)).toEqual({ login: "stud@chuvsu.ru", password: "пароль Пример 123" });
    // Тот же конверт, но выданный за другого студента или другую группу — не открывается.
    await expect(openEnvelope(keys.privatePem, env, envelopeAad(43, "ВИШ-14-25"))).rejects.toThrow();
    await expect(openEnvelope(keys.privatePem, env, envelopeAad(42, "ВИШ-13-25"))).rejects.toThrow();
    // Порча шифротекста.
    await expect(openEnvelope(keys.privatePem, { ...env, c: env.c.slice(0, -4) + "AAAA" }, aad)).rejects.toThrow();
    // Чужой закрытый ключ.
    const other = loadOrCreateKeys(path.join(tmp(), "keys2"));
    await expect(openEnvelope(other.privatePem, env, aad)).rejects.toThrow();
  });

  it("ключ создаётся один раз и переживает перезапуск", () => {
    const dir = path.join(tmp(), "keys");
    const a = loadOrCreateKeys(dir);
    const b = loadOrCreateKeys(dir);
    expect(a.privatePem).toBe(b.privatePem);
    expect(a.publicSpki).toBe(b.publicSpki);
  });
});

describe("слоты записи (файл, не .env)", () => {
  it("установка, профили только живых, отзыв, перечитывание с диска", () => {
    const file = path.join(tmp(), "accounts.json");
    const store = new AccountStore(file);
    store.install({ group: "ВИШ-14-25", codes: ["14-25"], login: "a@x", password: "p", requestId: 1, userId: 10 });
    store.install({ group: "ВИШ-13-23", codes: ["13-23"], login: "b@x", password: "q", requestId: 2, userId: 11 });
    expect(store.profiles().map((p) => [p.name, p.groups.join(",")])).toEqual([
      ["slot:ВИШ-13-23", "13-23"],
      ["slot:ВИШ-14-25", "14-25"],
    ]);
    // Потерянный слот не идёт в профили (на пары не пробуем), но из файла не исчезает.
    store.update("ВИШ-13-23", { status: "lost" });
    expect(store.profiles().map((p) => p.name)).toEqual(["slot:ВИШ-14-25"]);
    expect(new AccountStore(file).list()).toHaveLength(2);
    // Повтор той же заявки не плодит дублей и не сбрасывает статус.
    const before = store.get("ВИШ-13-23")!.installedAt;
    store.install({ group: "ВИШ-13-23", codes: ["13-23"], login: "b@x", password: "q", requestId: 2, userId: 11 });
    expect(store.get("ВИШ-13-23")!.installedAt).toBe(before);
    expect(store.remove("ВИШ-14-25")).toBe(true);
    expect(new AccountStore(file).list().map((s) => s.group)).toEqual(["ВИШ-13-23"]);
    expect(JSON.stringify(store.list())).not.toContain("\"p\"");
  });
});

describe("проверка «аккаунт жив»", () => {
  const target = (over: Partial<LiveTarget["state"]> = {}): { t: LiveTarget; saved: Partial<LiveTarget["state"]>[] } => {
    const saved: Partial<LiveTarget["state"]>[] = [];
    const t: LiveTarget = { key: "slot:ВИШ-14-25", login: "a@x", password: "p", state: { status: "ok", failures: 0, lastOkAt: null, nextCheckAt: 0, ...over }, save: (p) => saved.push(p) };
    return { t, saved };
  };
  const deps = (verdict: LoginCheck["verdict"], alive = true) => ({ check: async (): Promise<LoginCheck> => ({ verdict }), alive: async () => alive, now: () => 1_000_000, sleep: async () => undefined });

  it("портал лежит — ничего не проверяем, тревог нет, проверку отодвигаем", async () => {
    const { t, saved } = target();
    const res = await runLiveness([t], deps("bad", false));
    expect(res.ran).toBe(false);
    expect(res.transitions).toEqual([]);
    expect(saved[0]).toMatchObject({ nextCheckAt: expect.any(Number) });
    expect(saved[0]!.status).toBeUndefined();
  });

  it("одна осечка — ещё не «потеряно», переспрос скоро; вторая подряд — «потеряно» и ровно одно сообщение", async () => {
    const first = target();
    expect((await runLiveness([first.t], deps("bad"))).transitions).toEqual([]);
    expect(first.saved[0]).toMatchObject({ failures: 1 });
    const second = target({ failures: 1 });
    const res = await runLiveness([second.t], deps("bad"));
    expect(res.transitions).toEqual([{ key: "slot:ВИШ-14-25", to: "lost" }]);
    expect(second.saved[0]).toMatchObject({ status: "lost", failures: 2 });
  });

  it("удачный вход обнуляет осечки и ставит lastOkAt", async () => {
    const { t, saved } = target({ failures: 1 });
    await runLiveness([t], deps("ok"));
    expect(saved[0]).toMatchObject({ status: "ok", failures: 0 });
    expect(saved[0]!.lastOkAt).toBeTruthy();
  });

  it("слот, которому ещё не пора, не проверяется", async () => {
    const { t, saved } = target({ nextCheckAt: 9_999_999 });
    expect((await runLiveness([t], deps("bad"))).ran).toBe(false);
    expect(saved).toEqual([]);
  });
});

describe("обмен с ботом: адрес и задания без сети", () => {
  it("syncBase убирает /slides, базовый адрес не трогает", async () => {
    const { syncBase } = await import("../recorder/src/sync.js");
    expect(syncBase("https://slides.secretvish.ru/slides")).toBe("https://slides.secretvish.ru");
    expect(syncBase("https://slides.secretvish.ru/slides/")).toBe("https://slides.secretvish.ru");
    expect(syncBase("http://host:40070/slides")).toBe("http://host:40070");
  });

  it("runTask: install ставит слот, remove убирает, битый конверт — bad_envelope (без сети)", async () => {
    const { runTask } = await import("../recorder/src/sync.js");
    const { loadOrCreateKeys, sealCredentials, envelopeAad } = await import("../recorder/src/crypto.js");
    const { AccountStore } = await import("../recorder/src/accounts.js");
    const keys = loadOrCreateKeys(tmp() + "/keys");
    const store = new AccountStore(tmp() + "/accounts.json");
    const deps = { botUrl: "http://x/slides", token: "t", store, privatePem: keys.privatePem, publicSpki: keys.publicSpki };
    const env = await sealCredentials(keys.publicSpki, { login: "a@x", password: "p" }, envelopeAad(10, "ВИШ-14-25"));
    const inst = await runTask({ id: "1", kind: "install", requestId: 5, userId: 10, group: "ВИШ-14-25", codes: ["14-25"], envelope: env }, deps);
    expect(inst.code).toBe("installed");
    expect(store.get("ВИШ-14-25")?.login).toBe("a@x");
    const rm = await runTask({ id: "2", kind: "remove", requestId: 5, userId: 10, group: "ВИШ-14-25", codes: [] }, deps);
    expect(rm.code).toBe("removed");
    expect(store.get("ВИШ-14-25")).toBeUndefined();
    // Конверт с чужим AAD не раскрыть — install не ставит слот.
    const wrong = await sealCredentials(keys.publicSpki, { login: "b@x", password: "q" }, envelopeAad(99, "ВИШ-14-25"));
    const bad = await runTask({ id: "3", kind: "install", requestId: 6, userId: 10, group: "ВИШ-14-25", codes: ["14-25"], envelope: wrong }, deps);
    expect(bad.code).toBe("bad_envelope");
    expect(store.get("ВИШ-14-25")).toBeUndefined();
  });
});

describe("перенос профилей .env в слоты", () => {
  it("слот — своя группа владельца первой, затем группы профиля как были (без дубля своей)", () => {
    expect(profileToSlot({ groups: ["11-23", "12-23", "13-23", "14-23"] }, "ВИШ-13-23")).toEqual({ group: "ВИШ-13-23", codes: ["13-23", "11-23", "12-23", "14-23"] });
    expect(profileToSlot({ groups: [] }, "ВИШ-11-23 (ЭиЭА)")).toEqual({ group: "ВИШ-11-23 (ЭиЭА)", codes: ["11-23(эиэа)"] });
  });

  it("код группы у записывалки и у бота один и тот же", () => {
    for (const t of ["ВИШ-14-25", "ВИШ-11-23 (ЭиЭА)", "ОЗВИШ-12-25", "ВИШ-11-23 (РЗиАЭС)"]) expect(recGroupCode(t)).toBe(botGroupCode(t));
  });

  it("слот с этими кодами ловит поточную пару, как ловил профиль", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "slots-"));
    const store = AccountStore.inDir(dir);
    store.install({ ...profileToSlot({ groups: ["11-23", "12-23"] }, "ВИШ-13-23"), login: "l", password: "p", requestId: 0, userId: 0 });
    expect(store.profiles()[0]!.groups).toEqual(["13-23", "11-23", "12-23"]);
  });
});

describe("общая учётка (профиль 1) под присмотром", () => {
  const profile = { name: "1", authMode: "1" as const, login: "l", password: "p", groups: [] };

  it("название строки одинаковое у записывалки и бота", () => {
    expect(GENERAL_SLOT).toBe(GENERAL_SLOT_TITLE);
  });

  it("только для «обучающегося»; состояние переживает перезапуск, логина в файле нет", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "general-"));
    expect(GeneralWatch.forProfile(dir, { ...profile, authMode: "2" })).toBeNull();
    const g = GeneralWatch.forProfile(dir, profile)!;
    expect(g.summary()).toEqual({ group: GENERAL_SLOT, status: "ok", lastOkAt: null });
    g.target().save({ status: "lost", failures: 2 });
    const again = GeneralWatch.forProfile(dir, profile)!;
    expect(again.current).toMatchObject({ status: "lost", failures: 2 });
    again.noteJoin(Date.parse("2026-10-17T10:00:00Z"));
    expect(again.summary()).toEqual({ group: GENERAL_SLOT, status: "ok", lastOkAt: "2026-10-17T10:00:00.000Z" });
    expect(readFileSync(path.join(dir, "general.json"), "utf8")).not.toContain("\"l\"");
  });

  it("проверка «жива ли» вместе со слотами: два «неверный пароль» подряд — lost", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "general-"));
    const g = GeneralWatch.forProfile(dir, profile)!;
    let t = 0;
    const deps = { check: async (): Promise<LoginCheck> => ({ verdict: "bad" }), alive: async () => true, now: () => t, sleep: async () => undefined };
    await runLiveness([g.target()], deps);
    t += 16 * 60 * 1000;
    const res = await runLiveness([g.target()], deps);
    expect(res.transitions).toEqual([{ key: "general", to: "lost" }]);
    expect(g.summary().status).toBe("lost");
  });
});
