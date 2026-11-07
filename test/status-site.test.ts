import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Страница статуса (status.secretvish.ru) строится из status/data/roadmap.json.
// Правило проекта: каждое решение из docs/DECISIONS.md — строка в дорожной карте.
describe("страница статуса", () => {
  const roadmap = JSON.parse(readFileSync("status/data/roadmap.json", "utf8")) as {
    items: { id: string; adr?: number; status: string; review: Record<string, string> }[];
  };

  it("данные проходят проверку сборщика", () => {
    const out = execFileSync(process.execPath, ["status/build.mjs", "--check"], { encoding: "utf8" });
    expect(out).toMatch(/данные в порядке/);
  });

  it("у каждого решения из DECISIONS.md есть строка в дорожной карте", () => {
    const decisions = readFileSync("docs/DECISIONS.md", "utf8");
    const numbers = [...decisions.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1]));
    const inRoadmap = new Set(roadmap.items.map((i) => i.adr).filter((n): n is number => typeof n === "number"));
    const missing = numbers.filter((n) => !inRoadmap.has(n));
    expect(missing, `добавь в status/data/roadmap.json решения: ${missing.join(", ")}`).toEqual([]);
  });

  it("у планов нет отметок ревью, у сделанного автор отметился", () => {
    for (const it of roadmap.items) {
      if (it.status === "plan") expect(Object.values(it.review)).toEqual(["na", "na", "na"]);
      if (it.status === "done") expect(it.review.author, it.id).not.toBe("na");
    }
  });
});
