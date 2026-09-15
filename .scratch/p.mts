import { readFileSync } from "node:fs";
import { parseWebinars } from "chuvsu-js/parsers";
const html = readFileSync("/home/user/vish-bot/test/fixtures/webinar-fac32.html", "utf8");
const ws = parseWebinars(html);
console.log("count", ws.length);
for (const w of ws) {
  console.log(JSON.stringify({sch:w.scheduled, d:w.scheduledDate, slot:w.slotNumber, t:w.time, subj:w.subject, ty:w.type, teacher:w.teacher, groups:w.groups, sg:w.subgroup, title:w.title}));
}
