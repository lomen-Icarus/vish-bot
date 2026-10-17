/**
 * Проверка подписи Telegram Mini App (initData). Telegram подписывает данные о
 * том, кто открыл форму; бот проверяет подпись своим токеном — так заявку
 * нельзя подделать от чужого имени и нельзя переслать старую.
 *
 * Схема (Bot API): secret = HMAC_SHA256("WebAppData", BOT_TOKEN);
 * data_check_string — строки «ключ=значение» всех полей, кроме hash,
 * отсортированы и склеены через \n; подпись = HMAC_SHA256(secret,
 * data_check_string), сравнивается с полем hash. Плюс auth_date не старше
 * 10 минут — иначе перехваченный initData можно было бы переслать позже.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface InitDataUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface InitDataResult {
  ok: boolean;
  user?: InitDataUser;
  reason?: "bad_hash" | "stale" | "no_user" | "malformed";
}

const MAX_AGE_SEC = 10 * 60;

export function verifyInitData(initData: string, botToken: string, now = Date.now()): InitDataResult {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: "malformed" };
  const pairs: string[] = [];
  for (const [k, v] of params) if (k !== "hash") pairs.push(`${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const got = hash.toLowerCase();
  if (!timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"))) return { ok: false, reason: "bad_hash" };
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || now / 1000 - authDate > MAX_AGE_SEC) return { ok: false, reason: "stale" };
  let user: InitDataUser;
  try {
    const parsed = JSON.parse(params.get("user") ?? "") as Partial<InitDataUser>;
    if (typeof parsed.id !== "number") return { ok: false, reason: "no_user" };
    user = { id: parsed.id, username: parsed.username, first_name: parsed.first_name };
  } catch {
    return { ok: false, reason: "no_user" };
  }
  return { ok: true, user };
}
