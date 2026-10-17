/**
 * Mini App «Подключить мою группу к записи» (этап 2B). Логика без HTTP: страница
 * формы шифрует логин и пароль в браузере открытым ключом записывалки и шлёт
 * боту только шифровку. Бот проверяет подпись Telegram, лимит и сохраняет
 * заявку. Расшифровать может лишь записывалка.
 */
import type { Repo } from "../db/repo.js";
import type { LogicalGroup } from "../schedule/groups.js";
import { verifyInitData } from "../http/initData.js";

export interface TmaDeps {
  repo: Repo;
  groups: () => LogicalGroup[];
  botToken: string;
}

/** Сколько заявок в скользящие 30 дней на человека. */
export const REQUEST_LIMIT = 2;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const since30 = (now: number): string => new Date(now - WINDOW_MS).toISOString();

/** Только учебные группы ВИШ (без справочных «нулевых»), по возрастанию. */
function studentGroups(deps: TmaDeps): LogicalGroup[] {
  return deps.groups()
    .filter((g) => g.course > 0)
    .sort((a, b) => a.title.localeCompare(b.title));
}

export interface TmaContext {
  status: number;
  json: Record<string, unknown>;
}

/** Данные для формы: ключ записывалки, список групп, своя группа, остаток лимита. */
export function tmaContext(deps: TmaDeps, initData: string, now = Date.now()): TmaContext {
  const check = verifyInitData(initData, deps.botToken, now);
  if (!check.ok || !check.user) return { status: 401, json: { error: "подпись не подтвердилась" } };
  const publicKey = deps.repo.recorderPublicKey();
  const groups = studentGroups(deps).map((g) => ({ key: g.key, title: g.title }));
  const user = deps.repo.getUser(check.user.id);
  const used = deps.repo.recRequestsSince(check.user.id, since30(now));
  return {
    status: 200,
    json: {
      recorderReady: !!publicKey,
      publicKey,
      groups,
      myGroupKey: user?.groupKey ?? null,
      userId: check.user.id,
      remaining: Math.max(0, REQUEST_LIMIT - used),
    },
  };
}

export interface TmaSubmitBody {
  initData?: string;
  groupKey?: string;
  envelope?: { v?: number; k?: string; iv?: string; c?: string };
}

/** Принять заявку: подпись, лимит, группа, шифровка. Возвращает статус и ответ. */
export function tmaSubmit(deps: TmaDeps, body: TmaSubmitBody, now = Date.now()): TmaContext {
  const check = verifyInitData(String(body.initData ?? ""), deps.botToken, now);
  if (!check.ok || !check.user) return { status: 401, json: { error: "подпись не подтвердилась" } };
  if (!deps.repo.recorderPublicKey()) return { status: 409, json: { error: "сервис записи ещё не подключён" } };
  const group = studentGroups(deps).find((g) => g.key === body.groupKey);
  if (!group) return { status: 400, json: { error: "выбери группу из списка" } };
  const env = body.envelope;
  if (!env || env.v !== 1 || typeof env.k !== "string" || typeof env.iv !== "string" || typeof env.c !== "string") return { status: 400, json: { error: "данные не зашифровались, попробуй ещё раз" } };
  // Великоватую шифровку не храним: защита от мусора в базе.
  if (env.k.length > 4000 || env.c.length > 8000 || env.iv.length > 64) return { status: 400, json: { error: "слишком длинно" } };
  if (deps.repo.recRequestsSince(check.user.id, since30(now)) >= REQUEST_LIMIT) return { status: 429, json: { error: `Можно не больше ${REQUEST_LIMIT} заявок в месяц. Попробуй позже.` } };
  const id = deps.repo.createRecRequest({
    userId: check.user.id,
    username: check.user.username ?? null,
    groupKey: group.key,
    groupTitle: group.title,
    envelopeJson: JSON.stringify({ v: 1, k: env.k, iv: env.iv, c: env.c }),
  });
  return { status: 200, json: { ok: true, requestId: id } };
}
