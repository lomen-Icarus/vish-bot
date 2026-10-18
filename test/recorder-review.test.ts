import { afterAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "../recorder/src/accounts.js";
import { runLiveness, type LiveTarget } from "../recorder/src/liveness.js";
import { deliver } from "../recorder/src/deliver.js";
import { runTask, syncOnce, type Task } from "../recorder/src/sync.js";
import type { LoginCheck } from "../recorder/src/lk.js";

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

/** Фальшивый бот: считает запросы и отвечает заданным статусом. */
async function fakeBot(status: number): Promise<{ url: string; hits: () => number }> {
  let n = 0;
  const server = createServer((req, res) => {
    n++;
    req.resume();
    req.on("end", () => res.writeHead(status).end("x"));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/slides`, hits: () => n };
}

const meta = { date: "2026-10-17", subject: "Физика", teacher: "", groups: ["ВИШ-14-25"], title: "", startMinutes: 600, endMinutes: 690 };

describe("доставка слайдов: запасной адрес — только если бот недоступен", () => {
  it("основной ответил отказом — на запасной не идём (тот же бот, иначе дубль)", async () => {
    const main = await fakeBot(403);
    const reserve = await fakeBot(200);
    expect(await deliver({ urls: [main.url, reserve.url], token: "t", pdf: Buffer.from("%PDF-1.7 x"), meta, slides: 1 })).toBe(false);
    expect(reserve.hits()).toBe(0);
  });

  it("до основного не достучались — запасной принимает", async () => {
    const reserve = await fakeBot(200);
    // Порт 9 на localhost никто не слушает — соединение отклонено.
    expect(await deliver({ urls: ["http://127.0.0.1:9/slides", reserve.url], token: "t", pdf: Buffer.from("%PDF-1.7 x"), meta, slides: 1 })).toBe(true);
    expect(reserve.hits()).toBe(1);
  }, 30_000);
});

describe("слоты: итог проверки не ложится на заменённый слот", () => {
  const entry = (requestId: number) => ({ group: "ВИШ-14-25", codes: ["14-25"], login: `l${requestId}`, password: "p", requestId, userId: requestId });

  it("update с чужим installedAt ничего не меняет", () => {
    const store = AccountStore.inDir(mkdtempSync(path.join(os.tmpdir(), "rev-")));
    const old = store.install(entry(1), 1000);
    store.install(entry(2), 2000);
    store.update("ВИШ-14-25", { status: "lost", failures: 2 }, old.installedAt);
    expect(store.get("ВИШ-14-25")).toMatchObject({ requestId: 2, status: "ok", failures: 0 });
  });

  it("проверка шла, а слот заменили — новый не становится «не пускает»", async () => {
    const store = AccountStore.inDir(mkdtempSync(path.join(os.tmpdir(), "rev-")));
    const s = store.install(entry(1), 0);
    store.update(s.group, { failures: 1, nextCheckAt: 0 });
    const cur = store.get(s.group)!;
    const target: LiveTarget = {
      key: "slot:x",
      login: cur.login,
      password: cur.password,
      state: { status: cur.status, failures: cur.failures, lastOkAt: cur.lastOkAt, nextCheckAt: cur.nextCheckAt },
      save: (patch) => store.update(cur.group, patch, cur.installedAt),
      fresh: () => {
        const c = store.get(cur.group);
        return c && c.installedAt === cur.installedAt ? { status: c.status, failures: c.failures, lastOkAt: c.lastOkAt, nextCheckAt: c.nextCheckAt } : null;
      },
    };
    const res = await runLiveness([target], {
      check: async (): Promise<LoginCheck> => {
        store.install(entry(2), 5000); // одобрили замену, пока шла проверка
        return { verdict: "bad" };
      },
      alive: async () => true,
      now: () => 10_000,
      sleep: async () => undefined,
    });
    expect(res.transitions).toEqual([]);
    expect(store.get("ВИШ-14-25")).toMatchObject({ requestId: 2, status: "ok" });
  });

  it("удачный заход на пару во время проверки — «неверный пароль» не засчитывается", async () => {
    const store = AccountStore.inDir(mkdtempSync(path.join(os.tmpdir(), "rev-")));
    const s = store.install(entry(1), 0);
    store.update(s.group, { failures: 1, nextCheckAt: 0 });
    const cur = store.get(s.group)!;
    const target: LiveTarget = {
      key: "slot:x",
      login: cur.login,
      password: cur.password,
      state: { status: cur.status, failures: cur.failures, lastOkAt: cur.lastOkAt, nextCheckAt: 0 },
      save: (patch) => store.update(cur.group, patch, cur.installedAt),
      fresh: () => {
        const c = store.get(cur.group)!;
        return { status: c.status, failures: c.failures, lastOkAt: c.lastOkAt, nextCheckAt: c.nextCheckAt };
      },
    };
    await runLiveness([target], {
      check: async (): Promise<LoginCheck> => {
        store.update(cur.group, { status: "ok", failures: 0, lastOkAt: new Date(9000).toISOString() }, cur.installedAt);
        return { verdict: "bad" };
      },
      alive: async () => true,
      now: () => 10_000,
      sleep: async () => undefined,
    });
    expect(store.get("ВИШ-14-25")).toMatchObject({ status: "ok", failures: 0 });
  });
});

describe("большой PDF частями: повторная отправка не дублирует идущую", () => {
  it("retryPending во время отправки частей их не трогает", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const { deliverDeck, retryPending } = await import("../recorder/src/deliver.js");
    const { writeFileSync } = await import("node:fs");
    const doc = await PDFDocument.create();
    for (let i = 0; i < 6; i++) doc.addPage().drawText(`страница ${i}`.replace(/[^\x20-\x7e]/g, "p"));
    const pdf = Buffer.from(await doc.save());
    let hits = 0;
    const server = createServer((req, res) => {
      hits++;
      req.resume();
      req.on("end", () => setTimeout(() => res.writeHead(200).end("ok"), 300));
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/slides`;
    const dir = mkdtempSync(path.join(os.tmpdir(), "parts-"));
    const pdfPath = path.join(dir, "deck.pdf");
    writeFileSync(pdfPath, pdf);
    const sending = deliverDeck({ urls: [url], token: "t", pdfPath, pdf, meta, slides: 6, limit: Math.ceil(pdf.length * 0.7) });
    await new Promise((r) => setTimeout(r, 100));
    const resent = await retryPending(dir, [url], "t");
    const sent = await sending;
    expect(sent).toBeGreaterThan(1);
    expect(resent).toBe(0);
    expect(hits).toBe(sent);
  }, 30_000);
});

describe("remove убирает только слот своей заявки", () => {
  const deps = (store: AccountStore) => ({ botUrls: [], token: "t", store, privatePem: "", publicSpki: "" });
  const remove = (requestId: number, expect?: number): Task => ({ id: `${requestId}:remove`, kind: "remove", requestId, userId: requestId, group: "ВИШ-14-25", codes: ["14-25"], ...(expect !== undefined ? { expect } : {}) });

  it("отзыв ещё не поставленной заявки не трогает учётку из .env; ответ всё равно «removed»", async () => {
    const store = AccountStore.inDir(mkdtempSync(path.join(os.tmpdir(), "rev-")));
    store.install({ group: "ВИШ-14-25", codes: ["14-25"], login: "env", password: "p", requestId: 0, userId: 0 });
    expect(await runTask(remove(5, 5), deps(store))).toMatchObject({ code: "removed" });
    expect(store.get("ВИШ-14-25")).toMatchObject({ login: "env" });
    // Служебный отзыв учётки из .env — expect 0 — убирает.
    await runTask(remove(9, 0), deps(store));
    expect(store.get("ВИШ-14-25")).toBeUndefined();
  });

  it("повтор старого remove после замены не сносит новую учётку; свой — сносит", async () => {
    const store = AccountStore.inDir(mkdtempSync(path.join(os.tmpdir(), "rev-")));
    store.install({ group: "ВИШ-14-25", codes: ["14-25"], login: "new", password: "p", requestId: 2, userId: 2 });
    await runTask(remove(1), deps(store)); // бот старой версии: expect нет — сверка по номеру заявки
    expect(store.get("ВИШ-14-25")).toMatchObject({ requestId: 2 });
    await runTask(remove(2), deps(store));
    expect(store.get("ВИШ-14-25")).toBeUndefined();
  });
});

describe("отчёт записывалки: чья учётка в слоте", () => {
  it("в каждой строке слота — номер заявки (0 — учётка из .env): по нему бот отзывает слот без заявки", async () => {
    let report: { slots?: Array<Record<string, unknown>> } = {};
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/rec/report") report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "Content-Type": "application/json" }).end(req.url === "/rec/sync" ? '{"tasks":[]}' : "{}");
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const store = AccountStore.inDir(mkdtempSync(path.join(os.tmpdir(), "rev-")));
    store.install({ group: "ВИШ-14-25", codes: ["14-25"], login: "s", password: "p", requestId: 5, userId: 7 });
    store.install({ group: "ВИШ-13-23", codes: ["13-23"], login: "env", password: "p", requestId: 0, userId: 0 });
    await syncOnce({ botUrls: [`http://127.0.0.1:${(server.address() as { port: number }).port}/slides`], token: "t", store, privatePem: "", publicSpki: "" });
    expect(report.slots?.map((s) => [s.group, s.requestId]).sort()).toEqual([
      ["ВИШ-13-23", 0],
      ["ВИШ-14-25", 5],
    ]);
    expect(JSON.stringify(report)).not.toContain('"p"');
  });
});
