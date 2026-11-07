/**
 * Рассылка без звука: переключатель «🔔/🔕 Уведомление» на экране подтверждения.
 * По умолчанию — со звуком, как было; «без звука» уходит в copyMessage как
 * disable_notification (в МАКС мост превращает его в notify: false).
 */
import { describe, expect, it } from "vitest";
import { Api, Composer, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { openDatabase } from "../src/db/index.js";
import { Repo } from "../src/db/repo.js";
import { adminHandlers } from "../src/bot/handlers/admin.js";
import type { BotContext, Deps, PendingState } from "../src/bot/context.js";

const ME: UserFromGetMe = { id: 1, is_bot: true, first_name: "vish", username: "vish_bot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: true, can_connect_to_business: false, has_main_web_app: false };
const ADMIN = 900;
type Call = { method: string; payload: Record<string, unknown> };

function makeDeps(): Deps {
  const repo = new Repo(openDatabase(":memory:"));
  repo.touchUser(ADMIN, "admin_u", "Админ");
  repo.touchUser(11, "u11", "А");
  repo.touchUser(12, "u12", "Б");
  return {
    repo,
    config: { ADMIN_IDS: [ADMIN] },
    service: { groups: () => [] },
    pending: new Map<number, PendingState>(),
  } as unknown as Deps;
}

let uid = 1;
const press = (data: string): Update => ({
  update_id: uid++,
  callback_query: { id: "1", from: { id: ADMIN, is_bot: false, first_name: "A" }, chat_instance: "1", data, message: { message_id: 3, date: 0, chat: { id: ADMIN, type: "private", first_name: "A" }, text: "x" } as never },
});

async function run(deps: Deps, update: Update): Promise<Call[]> {
  const calls: Call[] = [];
  const api = new Api("123:FAKE");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: { message_id: 600, date: 0, chat: { id: ADMIN, type: "private" } } as never };
  });
  const ctx = new Context(update, api, ME) as BotContext;
  ctx.deps = deps;
  ctx.user = deps.repo.getUser(ADMIN)!;
  ctx.isAdmin = true;
  const all = new Composer<BotContext>();
  all.use(adminHandlers);
  await all.middleware()(ctx, async () => undefined);
  return calls;
}

const confirmState = (extra: Partial<PendingState> = {}): PendingState => ({ kind: "broadcast-confirm", chatId: ADMIN, messageId: 5, target: "all", text: "Пары завтра дистанционно", expiresAt: Date.now() + 60_000, ...extra });
const buttons = (c: Call | undefined): string[] => ((c?.payload.reply_markup as { inline_keyboard?: Array<Array<{ text: string }>> })?.inline_keyboard ?? []).flat().map((b) => b.text);

describe("рассылка без звука", () => {
  it("по умолчанию — со звуком: copyMessage без disable_notification", async () => {
    const deps = makeDeps();
    deps.pending.set(ADMIN, confirmState());
    const calls = await run(deps, press("bc:go:5"));
    const copies = calls.filter((c) => c.method === "copyMessage");
    expect(copies.length).toBe(3);
    for (const c of copies) expect(c.payload.disable_notification).toBeUndefined();
    expect(String(calls.at(-1)!.payload.text)).toBe("Рассылка всем завершена: доставлено 3, не доставлено 0.");
  });

  it("«🔔 Уведомление» переключает на «🔕 без звука», и рассылка уходит тихо", async () => {
    const deps = makeDeps();
    deps.pending.set(ADMIN, confirmState());
    const screen = (await run(deps, press("bc:silent"))).find((c) => c.method === "editMessageText");
    expect(buttons(screen)).toContain("🔕 Уведомление: без звука");
    expect(String(screen!.payload.text)).toContain("Придёт без звука");
    expect(deps.pending.get(ADMIN)?.silent).toBe(true);
    // Доска не сбилась от переключения звука.
    expect(deps.pending.get(ADMIN)?.board).toBe(false);

    const calls = await run(deps, press("bc:go:5"));
    const copies = calls.filter((c) => c.method === "copyMessage");
    expect(copies.length).toBe(3);
    for (const c of copies) expect(c.payload.disable_notification).toBe(true);
    expect(String(calls.at(-1)!.payload.text)).toContain("всем (без звука) завершена");
  });

  it("второе нажатие возвращает звук; доска переключается независимо", async () => {
    const deps = makeDeps();
    deps.pending.set(ADMIN, confirmState({ silent: true }));
    const screen = (await run(deps, press("bc:board"))).find((c) => c.method === "editMessageText");
    expect(buttons(screen)).toEqual(expect.arrayContaining(["🔕 Уведомление: без звука", "📌 На доску объявлений: да, 24 ч"]));
    await run(deps, press("bc:silent"));
    expect(deps.pending.get(ADMIN)).toMatchObject({ silent: false, board: true });
  });

  it("«◀️ Другая аудитория» не теряет выбор «без звука»", async () => {
    const deps = makeDeps();
    deps.pending.set(ADMIN, confirmState({ silent: true }));
    await run(deps, press("bc:back"));
    expect(deps.pending.get(ADMIN)).toMatchObject({ kind: "broadcast-target", silent: true });
    const screen = (await run(deps, press("bc:all"))).find((c) => c.method === "editMessageText");
    expect(buttons(screen)).toContain("🔕 Уведомление: без звука");
  });
});
