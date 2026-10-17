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
