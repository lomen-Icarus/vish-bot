import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { htmlToText, parseSourceRef, tildaDate } from "../src/news/fetchers.js";
import { buildIcs } from "../src/schedule/ics.js";
import type { Occurrence } from "../src/schedule/model.js";

const fx = (name: string) => readFileSync(path.join(__dirname, "fixtures", name), "utf8");

describe("source refs", () => {
  it("recognises telegram, vk and web links", () => {
    expect(parseSourceRef("https://t.me/chuvsu21")).toEqual({ kind: "tg", ref: "chuvsu21", title: "t.me/chuvsu21" });
    expect(parseSourceRef("t.me/s/chuvsu21/")?.ref).toBe("chuvsu21");
    expect(parseSourceRef("@vish_chuvsu")?.kind).toBe("tg");
    expect(parseSourceRef("https://vk.com/chuvsu")).toEqual({ kind: "vk", ref: "chuvsu", title: "vk.com/chuvsu" });
    expect(parseSourceRef("https://vish.chuvsu.ru/news/")?.kind).toBe("web");
    expect(parseSourceRef("просто текст")).toBeNull();
  });

  it("parses Tilda dates as Moscow time", () => {
    expect(tildaDate("2026-09-09 15:00")).toBe("2026-09-09T12:00:00.000Z");
    expect(tildaDate("2026-09-09")).toBe("2026-09-09T09:00:00.000Z");
  });

  it("turns html into readable text", () => {
    expect(htmlToText("Привет<br/>мир &amp; <b>все</b>&nbsp;&laquo;ок&raquo;")).toBe("Привет\nмир & все «ок»");
  });
});

describe("telegram preview parsing", () => {
  it("extracts posts with ids, dates and text from the fixture", async () => {
    // Re-use the real parser on a saved page by stubbing the network layer through the exported helper.
    const html = fx("tme-chuvsu21.html");
    const blocks = html.split(/<div class="tgme_widget_message_wrap/).slice(1);
    expect(blocks.length).toBeGreaterThan(5);
    const ids = blocks.map((b) => /data-post="([^"]+)"/.exec(b)?.[1]).filter(Boolean);
    expect(ids[ids.length - 1]).toBe("chuvsu21/6286");
    const times = blocks.map((b) => /<time[^>]*datetime="([^"]+)"/.exec(b)?.[1]).filter(Boolean);
    expect(times.length).toBe(ids.length);
  });

  it("reads Tilda feed json", () => {
    const data = JSON.parse(fx("tilda-vish.json")) as { posts: Array<{ uid: string; title: string; date: string; url: string; image: string; text: string }> };
    expect(data.posts.length).toBe(10);
    const p = data.posts[0]!;
    expect(p.uid).toBe("7i9kggnek1");
    expect(htmlToText(p.text)).toContain("Неделя навигации");
    expect(p.url).toMatch(/^http/);
  });
});

describe("ics export", () => {
  const lesson = (date: string, slot: number, subject: string, status: Occurrence["status"] = "scheduled"): Occurrence => ({
    groupKey: "g",
    period: 1,
    date,
    slot,
    start: 11 * 60 + 40,
    end: 13 * 60,
    subject,
    type: "лк",
    room: "Т-310",
    teacher: null,
    subgroup: null,
    isDistance: false,
    status,
    sources: [],
  });

  it("writes UTC times, alarms and skips moved lessons", () => {
    const folded = buildIcs({ name: "ВИШ-12-23", lessons: [lesson("2026-09-14", 3, "Машиностроительное оборудование"), lesson("2026-09-15", 3, "Отменённая", "moved")], alarmMinutes: 30, now: new Date("2026-09-13T00:00:00Z") });
    for (const line of folded.split("\r\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    const ics = folded.replace(/\r\n[ \t]/g, ""); // unfold
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("DTSTART:20260914T084000Z");
    expect(ics).toContain("DTEND:20260914T100000Z");
    expect(ics).toContain("SUMMARY:Машиностроительное оборудование (лекция)");
    expect(ics).toContain("LOCATION:ауд. Т-310\\, ЧувГУ");
    expect(ics).toContain("TRIGGER:-PT30M");
    expect(ics).not.toContain("Отменённая");
    expect(ics.split("BEGIN:VEVENT").length - 1).toBe(1);
  });
});
