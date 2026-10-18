/**
 * Пересдачи (ППА): разбор страницы портала, хранение, отметки долгов.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseGroupSchedule } from "chuvsu-js/parsers";
import { isPpaPage, parsePpaPage } from "../src/portal/ppa.js";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("страница ППА портала", () => {
  it("разбирает дату, время, аудиторию, предмет, форму и попытку — и совпадает с общим разборщиком портала", () => {
    const html = fixture("group-8824-ppa.html");
    expect(isPpaPage(html)).toBe(true);
    const items = parsePpaPage(html);
    expect(items).toHaveLength(13);
    expect(items[0]).toEqual({ date: "2026-10-01", start: 16 * 60 + 40, end: 18 * 60, room: "К-304", subject: "Элективные дисциплины (модули) по физической культуре и спорту", kind: "зач", attempt: 1, isDistance: false });
    expect(items.at(-1)).toMatchObject({ date: "2026-10-22", start: 15 * 60, subject: "Философия", kind: "Экз", room: "Г-303" });
    // Базы данных — дважды: курсовой проект и экзамен в разные дни.
    expect(items.filter((i) => i.subject === "Базы данных").map((i) => i.kind)).toEqual(["КП", "Экз"]);
    const theirs = parseGroupSchedule(html).flatMap((d) => d.blocks.flatMap((b) => b.lessons.map((l) => `${d.date}|${b.time.start.hours * 60 + b.time.start.minutes}|${l.subject}`)));
    expect(items.map((i) => `${i.date}|${i.start}|${i.subject}`)).toEqual(theirs);
  });

  it("пустая страница ППА — пусто; страница без отметки периода 11 — не ППА", () => {
    const empty = fixture("group-10145-ppa.html");
    expect(isPpaPage(empty)).toBe(true);
    expect(parsePpaPage(empty)).toEqual([]);
    expect(isPpaPage(fixture("group-8526-p1.html"))).toBe(false);
    expect(isPpaPage(fixture("portal-login.html"))).toBe(false);
  });

  it("две пересдачи в один день; «2 ППА»; дистанционная — как в обычной таблице портала", () => {
    const html = `<script>$("#pertype-"+"11").attr('checked','checked');</script><table id="groupstt"><tbody>
      <tr><td id="trd20270210" class="trfd trdata">10 Февраль 2027<br>Среда</td><td id="td20270210g1" class="trdata"><div id="tdd20270210g1" class="tdd"><table width="100%"><tr><td >В-317 <span style="color: blue;">Физика</span> (Экз) - <span class="red">2 ППА</span><br>08:20 - 09:40</td></tr><tr><td >Дистанционно <span style="color: blue;">Химия</span> (зач) - <span class="red">1 ППА</span><br>09:50 - 11:10 <span style="color: blue;"> (ДОТ)</span></td></tr></table></div></td></tr>
    </tbody></table>`;
    expect(parsePpaPage(html).map((i) => [i.subject, i.attempt, i.kind, i.room, i.isDistance, i.start])).toEqual([
      ["Физика", 2, "Экз", "В-317", false, 8 * 60 + 20],
      ["Химия", 1, "зач", "Дистанционно", true, 9 * 60 + 50],
    ]);
  });
});

describe("хранение и долги", () => {
  it("страница, отметки, должники по предмету; /soon стирает отметки", () => {
    const repo = new Repo(openDatabase(":memory:"));
    repo.touchUser(7, "student_u", "S");
    expect(repo.ppaPage(8824)).toBeNull();
    repo.savePpaPage(8824, "h1", parsePpaPage(fixture("group-8824-ppa.html")));
    expect(repo.ppaPage(8824)!.items).toHaveLength(13);
    repo.setPpaDebt(7, "виш-14-24", "k1", true);
    repo.setPpaDebt(7, "виш-14-24", "k1", true);
    repo.setPpaDebt(7, "виш-14-24", "k2", true);
    expect(repo.ppaDebts(7, "виш-14-24").sort()).toEqual(["k1", "k2"]);
    expect(repo.ppaDebtors("виш-14-24", "k1")).toEqual([7]);
    repo.setPpaDebt(7, "виш-14-24", "k2", false);
    expect(repo.ppaDebts(7, "виш-14-24")).toEqual(["k1"]);
    repo.markPpaAsked(7, "виш-14-24", "2026-осень");
    expect(repo.ppaAskedWave(7, "виш-14-24")).toBe("2026-осень");
    repo.forgetUser(7);
    expect(repo.ppaDebts(7, "виш-14-24")).toEqual([]);
    expect(repo.ppaAskedWave(7, "виш-14-24")).toBeNull();
  });
});
