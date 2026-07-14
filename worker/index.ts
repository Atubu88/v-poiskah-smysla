/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface TelegramUserRow {
  telegram_id: number;
  first_name: string | null;
  username: string | null;
  started_at: string | null;
  last_seen_at: string | null;
  miniapp_opened_at: string | null;
}


type TelegramMiniAppUser = {
  id: number;
  first_name?: string;
  username?: string;
};

function parseTelegramInitData(initDataRaw: string, botToken: string): TelegramMiniAppUser | null {
  if (!initDataRaw || !botToken) return null;

  const params = new URLSearchParams(initDataRaw);
  const hash = params.get("hash");
  if (!hash) return null;

  const dataCheckString = Array.from(params.entries())
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const hashBuffer = Buffer.from(hash, "hex");
  const computedBuffer = Buffer.from(computedHash, "hex");
  if (hashBuffer.length !== computedBuffer.length || !timingSafeEqual(hashBuffer, computedBuffer)) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;

  try {
    const user = JSON.parse(userRaw) as TelegramMiniAppUser;
    return user?.id ? user : null;
  } catch {
    return null;
  }
}





let schemaReady: Promise<void> | null = null;

async function ensureSchema(env: Env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS telegram_users (
        telegram_id INTEGER PRIMARY KEY,
        first_name TEXT,
        username TEXT,
        started_at TEXT,
        last_seen_at TEXT,
        miniapp_opened_at TEXT
      )`).run();
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_telegram_users_started_at ON telegram_users(started_at)").run();
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_telegram_users_miniapp_opened_at ON telegram_users(miniapp_opened_at)").run();
    })();
  }

  await schemaReady;
}

async function upsertBotUser(env: Env, user: { id: number; first_name?: string; username?: string }, markStarted = false) {
  const now = new Date().toISOString();
  const startedAt = markStarted ? now : null;

  await env.DB.prepare(`
    INSERT INTO telegram_users (telegram_id, first_name, username, started_at, last_seen_at, miniapp_opened_at)
    VALUES (?1, ?2, ?3, ?4, ?5, NULL)
    ON CONFLICT(telegram_id) DO UPDATE SET
      first_name = excluded.first_name,
      username = excluded.username,
      started_at = COALESCE(telegram_users.started_at, excluded.started_at),
      last_seen_at = excluded.last_seen_at
  `)
    .bind(user.id, user.first_name || null, user.username || null, startedAt, now)
    .run();
}

async function markMiniAppOpen(env: Env, user: { id: number; first_name?: string; username?: string }) {
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO telegram_users (telegram_id, first_name, username, started_at, last_seen_at, miniapp_opened_at)
    VALUES (?1, ?2, ?3, NULL, ?4, ?5)
    ON CONFLICT(telegram_id) DO UPDATE SET
      first_name = excluded.first_name,
      username = excluded.username,
      last_seen_at = excluded.last_seen_at,
      miniapp_opened_at = COALESCE(telegram_users.miniapp_opened_at, excluded.miniapp_opened_at)
  `)
    .bind(user.id, user.first_name || null, user.username || null, now, now)
    .run();
}

async function getUserCounts(env: Env) {
  const total = await env.DB.prepare('SELECT COUNT(*) AS count FROM telegram_users WHERE started_at IS NOT NULL').first() as Promise<{ count: number } | null>;
  const miniapp = await env.DB.prepare('SELECT COUNT(*) AS count FROM telegram_users WHERE miniapp_opened_at IS NOT NULL').first() as Promise<{ count: number } | null>;
  return { totalBotUsers: total?.count || 0, totalMiniAppUsers: miniapp?.count || 0 };
}

async function callTelegramApi(botToken: string, method: string, payload: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json() as { ok?: boolean; description?: string };
  if (!response.ok || !data.ok) throw new Error(data.description || `Telegram ${method} failed`);
  return data;
}

async function sendTelegramStartMessage(botToken: string, chatId: number, appBaseUrl: string, firstName?: string) {
  const safeName = (firstName || "").trim();
  const greeting = safeName ? `Добро пожаловать, ${safeName}!` : "Добро пожаловать!";

  return callTelegramApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: `${greeting} Нажми кнопку ниже, чтобы открыть мини-апп.`,
    reply_markup: {
      inline_keyboard: [[{ text: "Открыть мини-апп", web_app: { url: appBaseUrl } }]],
    },
  });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/telegram/webhook" && request.method === "POST") {
      if (!env.TELEGRAM_BOT_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: "Bot token is not configured" }), {
          status: 500,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }

      await ensureSchema(env);

      const update = await request.json().catch(() => ({})) as any;
      const chatId = update?.message?.chat?.id;
      const text = (update?.message?.text || "").trim();
      const from = update?.message?.from;

      if (from?.id) {
        await upsertBotUser(env, from, text === "/start");
      }

      if (chatId && text === "/start") {
        await sendTelegramStartMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "https://v-poiskah-smysla.atubu2000.workers.dev/",
          from?.first_name,
        );
      }

      if (chatId && text === "/users_count") {
        const counts = await getUserCounts(env);
        await callTelegramApi(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
          chat_id: chatId,
          text: `Всего пользователей бота: ${counts.totalBotUsers}
Открывали mini app: ${counts.totalMiniAppUsers}` ,
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/telegram/identify" && request.method === "POST") {
      if (!env.DB) {
        return new Response(JSON.stringify({ ok: false, error: "DB is not configured" }), { status: 500, headers: { "content-type": "application/json; charset=utf-8" } });
      }

      await ensureSchema(env);
      const body = await request.json().catch(() => ({})) as any;
      const initDataRaw = typeof body?.initData === "string" ? body.initData : "";
      const verifiedUser = env.TELEGRAM_BOT_TOKEN ? parseTelegramInitData(initDataRaw, env.TELEGRAM_BOT_TOKEN) : null;
      const fallbackUser = body?.user;
      const user = verifiedUser ?? fallbackUser;

      if (user?.id) {
        await markMiniAppOpen(env, user);
        return new Response(JSON.stringify({ ok: true, verified: Boolean(verifiedUser) }), { headers: { "content-type": "application/json; charset=utf-8" } });
      }

      return new Response(JSON.stringify({ ok: false, error: "Missing Telegram user" }), { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
