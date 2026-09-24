import { describe, expect, it, vi } from "vitest";
import { Api } from "grammy";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";

// Сеть в тесте не нужна: источник «возвращает» один и тот же свежий пост.
vi.mock("../src/news/fetchers.js", () => ({
  fetchSource: async () => [{ externalId: "p1", url: "https://t.me/x/1", publishedAt: new Date().toISOString(), text: "Конкурс грантов для студентов, заявки до пятницы", photoUrl: null }],
}));

const { NewsScanner } = await import("../src/news/scanner.js");

describe("новости: сбой классификации не теряет пост", () => {
  it("пост, который ИИ не разложил, разбирается и доставляется на следующем скане", async () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.addNewsSource("tg", "x", "t.me/x");
    repo.touchUser(7, "u", "U");
    repo.updateUser(7, { topics: ["contests"] });
    const sent: string[] = [];
    const api = new Api("123:FAKE");
    api.config.use(async (_prev, _method, payload) => {
      sent.push(String((payload as { text?: string }).text ?? ""));
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 7, type: "private" } } as never };
    });
    const scanner = new NewsScanner("sk-test", repo, api, { lookbackHours: 32, maxPerTopic: 8, model: "claude-sonnet-5" });
    let fail = true;
    (scanner as unknown as { client: unknown }).client = {
      messages: {
        parse: async (req: { messages: Array<{ content: string }> }) => {
          if (fail) throw new Error("overloaded");
          const id = Number(/id=(\d+)/.exec(req.messages[0]!.content)![1]);
          return { stop_reason: "end_turn", parsed_output: { items: [{ id, topic: "contests", title: "Гранты" }] } };
        },
      },
    };
    const first = await scanner.scan();
    expect(first.fresh).toBe(1);
    expect(first.sent).toBe(0);
    fail = false;
    const second = await scanner.scan();
    expect(second.fresh).toBe(0);
    expect(second.sent).toBe(1);
    expect(sent.join("\n")).toContain("Гранты");
  });
});
