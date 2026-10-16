/**
 * Шифрование заявок студентов на запись. Логин и пароль шифруются прямо в
 * браузере студента (мини-приложение бота) открытым ключом записывалки;
 * расшифровать их может только записывалка — закрытый ключ лежит у неё на
 * диске и больше нигде. Бот хранит и передаёт только шифровку.
 *
 * Конверт v1: случайный ключ AES-256-GCM шифрует JSON {login, password}, а
 * сам ключ шифруется RSA-OAEP-SHA256 (3072 бит). RSA напрямую вмещает около
 * 300 байт — длинный пароль с логином могли бы не влезть. Дополнительные
 * данные GCM — «vish-rec|<telegram id>|<группа>»: шифровку одной заявки
 * нельзя выдать за заявку другого человека или в другую группу.
 *
 * Всё — через WebCrypto (globalThis.crypto.subtle): те же вызовы, что в
 * браузере, поэтому формат один и проверяется тестом с обеих сторон.
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface Envelope {
  v: 1;
  /** Ключ AES, зашифрованный RSA-OAEP-SHA256, base64. */
  k: string;
  /** Вектор GCM (12 байт), base64. */
  iv: string;
  /** Шифротекст с тегом GCM, base64. */
  c: string;
}

export interface Credentials {
  login: string;
  password: string;
}

export const envelopeAad = (userId: number, group: string): string => `vish-rec|${userId}|${group}`;

const b64 = (buf: ArrayBuffer | Uint8Array): string => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64");
const unb64 = (s: string): ArrayBuffer => ab(new Uint8Array(Buffer.from(s, "base64")));
/** Свежий ArrayBuffer из байтов: WebCrypto в типах не принимает SharedArrayBuffer-подложку. */
const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
const enc = (s: string): ArrayBuffer => ab(new TextEncoder().encode(s));

/** Пара ключей записывалки: закрытый — PEM на диске (0600), открытый — SPKI base64 для бота и браузера. */
export interface KeyPair {
  privatePem: string;
  publicSpki: string;
}

/** Загрузить ключи или создать при первом запуске. Запись через временный файл: обрыв не оставит половину ключа. */
export function loadOrCreateKeys(dir: string): KeyPair {
  const file = path.join(dir, "accounts.key");
  let privatePem: string;
  if (existsSync(file)) privatePem = readFileSync(file, "utf8");
  else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
    privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, privatePem, { mode: 0o600 });
    renameSync(tmp, file);
  }
  const publicSpki = createPublicKey(createPrivateKey(privatePem)).export({ type: "spki", format: "der" }).toString("base64");
  return { privatePem, publicSpki };
}

/** Зашифровать — так же, как это сделает браузер. В записывалке нужно только тестам и проверкам. */
export async function sealCredentials(publicSpki: string, creds: Credentials, aad: string): Promise<Envelope> {
  const subtle = globalThis.crypto.subtle;
  const rsa = await subtle.importKey("spki", unb64(publicSpki), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
  const aes = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ivBuf = ab(iv);
  const c = await subtle.encrypt({ name: "AES-GCM", iv: ivBuf, additionalData: enc(aad) }, aes, enc(JSON.stringify(creds)));
  const k = await subtle.encrypt({ name: "RSA-OAEP" }, rsa, await subtle.exportKey("raw", aes));
  return { v: 1, k: b64(k), iv: b64(iv), c: b64(c) };
}

/** Расшифровать конверт. Подделка, чужие AAD или чужой ключ — исключение. */
export async function openEnvelope(privatePem: string, env: Envelope, aad: string): Promise<Credentials> {
  if (env?.v !== 1 || !env.k || !env.iv || !env.c) throw new Error("неизвестный формат конверта");
  const subtle = globalThis.crypto.subtle;
  const der = createPrivateKey(privatePem).export({ type: "pkcs8", format: "der" });
  const rsa = await subtle.importKey("pkcs8", ab(new Uint8Array(der)), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
  const raw = await subtle.decrypt({ name: "RSA-OAEP" }, rsa, unb64(env.k));
  const aes = await subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64(env.iv), additionalData: enc(aad) }, aes, unb64(env.c));
  const data = JSON.parse(new TextDecoder().decode(plain)) as Partial<Credentials>;
  if (typeof data.login !== "string" || typeof data.password !== "string" || !data.login.trim() || !data.password) throw new Error("в конверте нет логина или пароля");
  return { login: data.login.trim(), password: data.password };
}
