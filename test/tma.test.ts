import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { tmaContext, tmaSubmit, REQUEST_LIMIT } from "../src/bot/tma.js";
import type { LogicalGroup } from "../src/schedule/groups.js";

const TOKEN = "123456:TMA_TEST_TOKEN_abcdefghij";
const GROUPS: LogicalGroup[] = [
  { key: "виш-14-25", title: "ВИШ-14-25", prefix: "ВИШ", number: 14, intake: 25, course: 2, portalIds: [], portalNames: [] },
  { key: "виш-13-23", title: "ВИШ-13-23", prefix: "ВИШ", number: 13, intake: 23, course: 4, portalIds: [], portalNames: [] },
  { key: "person-x", title: "Иванов", prefix: "", number: 0, intake: 0, course: 0, portalIds: [], portalNames: [] },
];
const deps = (repo: Repo) => ({ repo, groups: () => GROUPS, botToken: TOKEN });
const ENV = { v: 1, k: "k".repeat(10), iv: "aXY=", c: "c".repeat(20) };

function initData(userId: number, extra: Record<string, string> = {}): string {
  const fields: Record<string, string> = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, username: "stud" }), ...extra };
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort();
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const hash = createHmac("sha256", secret).update(pairs.join("\n")).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

describe("Mini App: контекст формы", () => {
  it("своя группа подставлена, в списке только учебные, остаток лимита, ключ записывалки", () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "stud", "S");
    repo.updateUser(7, { groupKey: "виш-14-25" });
    repo.setRecorderPublicKey("PUBKEY");
    const r = tmaContext(deps(repo), initData(7));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ recorderReady: true, publicKey: "PUBKEY", myGroupKey: "виш-14-25", userId: 7, remaining: REQUEST_LIMIT });
    expect((r.json.groups as { key: string }[]).map((g) => g.key)).toEqual(["виш-13-23", "виш-14-25"]);
  });

  it("плохая подпись — 401", () => {
    const repo = new Repo(openDatabase(":memory:"));
    expect(tmaContext(deps(repo), "user=%7B%22id%22%3A7%7D&hash=" + "0".repeat(64)).status).toBe(401);
  });
});

describe("Mini App: приём заявки", () => {
  const setup = () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "stud", "S");
    repo.setRecorderPublicKey("PUBKEY");
    return repo;
  };
  it("создаёт заявку pending_verify с конвертом и ником", () => {
    const repo = setup();
    const r = tmaSubmit(deps(repo), { initData: initData(7), groupKey: "виш-13-23", envelope: ENV });
    expect(r.status).toBe(200);
    const req = repo.recRequest((r.json as { requestId: number }).requestId);
    expect(req).toMatchObject({ state: "pending_verify", groupKey: "виш-13-23", groupTitle: "ВИШ-13-23", username: "stud", userId: 7 });
    expect(JSON.parse(req!.envelopeJson!)).toEqual(ENV);
  });

  it("нет ключа записывалки — 409", () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "s", "S");
    expect(tmaSubmit(deps(repo), { initData: initData(7), groupKey: "виш-13-23", envelope: ENV }).status).toBe(409);
  });

  it("группа не из списка (или справочная) — 400", () => {
    const repo = setup();
    expect(tmaSubmit(deps(repo), { initData: initData(7), groupKey: "нет", envelope: ENV }).status).toBe(400);
    expect(tmaSubmit(deps(repo), { initData: initData(7), groupKey: "person-x", envelope: ENV }).status).toBe(400);
  });

  it("битый конверт — 400, заявка не создаётся", () => {
    const repo = setup();
    expect(tmaSubmit(deps(repo), { initData: initData(7), groupKey: "виш-13-23", envelope: { v: 2 } as never }).status).toBe(400);
    expect(repo.recRequestsSince(7, "2000-01-01T00:00:00Z")).toBe(0);
  });

  it("лимит: третья заявка за месяц — 429", () => {
    const repo = setup();
    for (let i = 0; i < REQUEST_LIMIT; i++) expect(tmaSubmit(deps(repo), { initData: initData(7), groupKey: "виш-13-23", envelope: ENV }).status).toBe(200);
    expect(tmaSubmit(deps(repo), { initData: initData(7), groupKey: "виш-13-23", envelope: ENV }).status).toBe(429);
  });

  it("чужая подпись — 401, заявки нет", () => {
    const repo = setup();
    const bad = "user=%7B%22id%22%3A7%7D&auth_date=" + Math.floor(Date.now() / 1000) + "&hash=" + "0".repeat(64);
    expect(tmaSubmit(deps(repo), { initData: bad, groupKey: "виш-13-23", envelope: ENV }).status).toBe(401);
  });
});

describe("Mini App: сквозное шифрование (браузер → бот → записывалка)", () => {
  it("конверт, собранный как в браузере, расшифровывается записывалкой с тем же AAD", async () => {
    const { loadOrCreateKeys, sealCredentials, openEnvelope, envelopeAad } = await import("../recorder/src/crypto.js");
    const { mkdtempSync } = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const keys = loadOrCreateKeys(mkdtempSync(path.join(os.tmpdir(), "tma-")) + "/keys");
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "stud", "S");
    repo.setRecorderPublicKey(keys.publicSpki);
    // Браузер шифрует логин и пароль открытым ключом записывалки и AAD по группе.
    const env = await sealCredentials(keys.publicSpki, { login: "stud@x", password: "пароль 42" }, envelopeAad(7, "ВИШ-13-23"));
    const r = tmaSubmit(deps(repo), { initData: initData(7), groupKey: "виш-13-23", envelope: env });
    expect(r.status).toBe(200);
    const stored = JSON.parse(repo.recRequest((r.json as { requestId: number }).requestId)!.envelopeJson!);
    const creds = await openEnvelope(keys.privatePem, stored, envelopeAad(7, "ВИШ-13-23"));
    expect(creds).toEqual({ login: "stud@x", password: "пароль 42" });
  });
});
