import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { envelopeAad, loadOrCreateKeys, openEnvelope, sealCredentials } from "../recorder/src/crypto.js";
import { AccountStore } from "../recorder/src/accounts.js";
import { runLiveness, type LiveTarget } from "../recorder/src/liveness.js";
import type { LoginCheck } from "../recorder/src/lk.js";

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
