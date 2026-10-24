/**
 * Шифрование токенов календарей (refresh token Google) в базе: AES-256-GCM.
 * Утечка файла базы без ключа не даёт доступа к календарям людей. Ключ —
 * CAL_TOKEN_KEY из .env, а без него выводится из BOT_TOKEN (HKDF): тогда
 * смена токена бота делает старые токены нечитаемыми, и людям нужно
 * подключиться заново — бот это видит и просит.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export function tokenKey(cfg: { CAL_TOKEN_KEY?: string; BOT_TOKEN: string }): Buffer {
  const raw = cfg.CAL_TOKEN_KEY;
  if (raw) {
    const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (key.length === 32) return key;
    throw new Error("CAL_TOKEN_KEY должен быть 32 байта: 64 hex-символа или base64");
  }
  return Buffer.from(hkdfSync("sha256", cfg.BOT_TOKEN, "vish-bot", "calendar tokens v1", 32));
}

/** «v1.iv.tag.шифровка» (base64url). */
export function seal(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

/** Расшифровать; чужой ключ или испорченная строка — исключение. */
export function unseal(key: Buffer, sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || body === undefined) throw new Error("bad sealed token");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
}
