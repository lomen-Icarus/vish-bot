import { PortalClient, PORTAL_BASE } from "./src/portal/client.js";
const c = new PortalClient({ proxyUrl: process.env.HTTPS_PROXY, insecureTls: true });
await c.login();
const home = await c.http.postFollow(`${PORTAL_BASE}/`, { hfac: "0", pertt: "1" });
// Что вообще предлагает стартовая страница гостю: формы и ссылки.
const forms = [...home.body.matchAll(/<input[^>]*name="([^"]+)"/g)].map((m) => m[1]);
const links = [...new Set([...home.body.matchAll(/(?:href|action)="([^"]*index\/[^"]*)"/g)].map((m) => m[1]))];
console.log("поля форм:", [...new Set(forms)].join(", "));
console.log("ссылки index/*:", links.slice(0, 20).join("  "));
