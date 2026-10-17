import { describe, expect, it } from "vitest";
import { PublicUrl, publicBase } from "../src/http/publicUrl.js";

const MAIN = "https://slides.example.ru";
const SPARE = "https://spare.example.ru";

describe("публичный адрес: основной и запасной", () => {
  it("основной отвечает — ссылки через него; лёг — через запасной; ожил — обратно", async () => {
    const up = new Map([[MAIN, true], [SPARE, true]]);
    const url = new PublicUrl(MAIN, SPARE, async (u) => up.get(u) ?? false);
    await url.refresh();
    expect(url.current()).toBe(MAIN);
    up.set(MAIN, false);
    await url.refresh();
    expect(url.current()).toBe(SPARE);
    expect(url.which()).toBe("fallback");
    up.set(MAIN, true);
    await url.refresh();
    expect(url.current()).toBe(MAIN);
  });

  it("не отвечает никто — остаётся основной (как настроено), а не запасной", async () => {
    const url = new PublicUrl(MAIN, SPARE, async () => false);
    await url.refresh();
    expect(url.current()).toBe(MAIN);
  });

  it("запасного нет — проверок нет, всегда основной; основного нет — запасной", async () => {
    let calls = 0;
    const only = new PublicUrl(MAIN, undefined, async () => (calls++, false));
    await only.refresh();
    expect(calls).toBe(0);
    expect(only.current()).toBe(MAIN);
    expect(new PublicUrl(undefined, SPARE).current()).toBe(SPARE);
    expect(new PublicUrl(undefined, undefined).current()).toBeUndefined();
  });

  it("publicBase: без переключателя берёт адрес из конфига (основной, потом запасной)", () => {
    expect(publicBase({ config: { PUBLIC_URL: MAIN, PUBLIC_URL_FALLBACK: SPARE } })).toBe(MAIN);
    expect(publicBase({ config: { PUBLIC_URL_FALLBACK: SPARE } })).toBe(SPARE);
    expect(publicBase({ config: {} })).toBeUndefined();
  });
});

describe("публичный DNS вместо кеша хостинга", () => {
  const fake = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
  it("имя не резолвится публично (SERVFAIL) — false; резолвится — true; DNS недоступен — null", async () => {
    const { publicDnsOk } = await import("../src/http/publicUrl.js");
    expect(await publicDnsOk("calendar.secretvish.ru", fake({ Status: 2 }))).toBe(false);
    expect(await publicDnsOk("ok.example", fake({ Status: 0, Answer: [{ data: "1.2.3.4" }] }))).toBe(true);
    expect(await publicDnsOk("empty.example", fake({ Status: 0, Answer: [] }))).toBe(false);
    const down = (async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    expect(await publicDnsOk("x.example", down)).toBeNull();
  });
});
