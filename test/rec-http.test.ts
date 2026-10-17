import { afterAll, describe, expect, it } from "vitest";
import { request, type Server } from "node:http";
import { once } from "node:events";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { createHttpServer } from "../src/http/server.js";
import type { ScheduleService } from "../src/schedule/service.js";
import type { RecReportEffect } from "../src/bot/recorder.js";

const TOKEN = "slides-token-at-least-16-chars";
const ENV = JSON.stringify({ v: 1, k: "k", iv: "iv", c: "c" });
const servers: Server[] = [];

async function start(repo: Repo, onRecorderReport?: (e: RecReportEffect) => void) {
  const server = createHttpServer({ repo, service: { groups: () => [] } as unknown as ScheduleService, port: 0, host: "127.0.0.1", slidesToken: TOKEN, botToken: "123:TT", onRecorderReport });
  servers.push(server);
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}
afterAll(() => servers.forEach((s) => s.close()));

function call(port: number, method: string, path: string, opts: { auth?: string; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { ...(opts.auth ? { Authorization: opts.auth } : {}), ...(opts.body ? { "Content-Type": "application/json" } : {}) } }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe("ручки /rec/sync и /rec/report", () => {
  it("без токена — 403; с токеном — задания из состояния", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const id = repo.createRecRequest({ userId: 1, username: "a", groupKey: "виш-14-25", groupTitle: "ВИШ-14-25", envelopeJson: ENV });
    const port = await start(repo);
    expect((await call(port, "GET", "/rec/sync")).status).toBe(403);
    const ok = await call(port, "GET", "/rec/sync", { auth: `Bearer ${TOKEN}` });
    expect(ok.status).toBe(200);
    const tasks = (JSON.parse(ok.body) as { tasks: { requestId: number; kind: string }[] }).tasks;
    expect(tasks).toEqual([{ id: `${id}:verify`, kind: "verify", requestId: id, userId: 1, group: "ВИШ-14-25", codes: ["14-25"], envelope: JSON.parse(ENV) }]);
  });

  it("отчёт двигает состояние и зовёт колбэк; /health показывает записывалку", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    const id = repo.createRecRequest({ userId: 1, username: "a", groupKey: "виш-14-25", groupTitle: "ВИШ-14-25", envelopeJson: ENV });
    let effect: RecReportEffect | null = null;
    const port = await start(repo, (e) => (effect = e));
    const body = JSON.stringify({ publicKey: "KEY1", results: [{ id: `${id}:verify`, requestId: id, code: "login_ok", actualGroup: "ВИШ-14-25" }], slots: [], portal: "ok" });
    const r = await call(port, "POST", "/rec/report", { auth: `Bearer ${TOKEN}`, body });
    expect(r.status).toBe(200);
    expect(repo.recRequest(id)).toMatchObject({ state: "verified" });
    expect(effect).toMatchObject({ firstConnect: true });
    const health = JSON.parse((await call(port, "GET", "/health")).body) as { recorder: { portal: string; slots: number } };
    expect(health.recorder.portal).toBe("ok");
  });

  it("отчёт без токена — 403", async () => {
    const port = await start(new Repo(openDatabase(":memory:")));
    expect((await call(port, "POST", "/rec/report", { body: "{}" })).status).toBe(403);
  });
});
