/** Cloudflare Worker entry point for the vinext application. */
import { createHash } from "node:crypto";
import { DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES, handleImageOptimization } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  isTelegramAdmin,
  parseMaxAgeSeconds,
  parseTelegramCommand,
  parseTelegramUpdate,
  secureEqual,
  validateTelegramInitData,
  type TelegramBotUser,
} from "../lib/telegram";
import {
  journeyProgressStages,
  totalProgressStages,
  totalProgressTasks,
  validateProgressIds,
} from "../lib/progress";

interface Env {
  ASSETS: Fetcher;
  DB?: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_ADMIN_IDS?: string;
  TELEGRAM_INIT_DATA_MAX_AGE_SECONDS?: string;
  MINI_APP_URL?: string;
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

type JsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; error: string };

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

async function readJson(request: Request, maxBytes: number): Promise<JsonReadResult> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, status: 413, error: "Payload too large" };
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return { ok: false, status: 413, error: "Payload too large" };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

let schemaReady: Promise<void> | null = null;

async function prepareSchema(db: D1Database): Promise<void> {
  await db.prepare(`CREATE TABLE IF NOT EXISTS telegram_usage (
    telegram_id INTEGER PRIMARY KEY,
    bot_started_at TEXT,
    last_seen_at TEXT NOT NULL,
    miniapp_first_opened_at TEXT,
    miniapp_last_opened_at TEXT,
    miniapp_open_count INTEGER NOT NULL DEFAULT 0,
    last_launch_hash TEXT
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_telegram_usage_bot_started_at ON telegram_usage(bot_started_at)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_telegram_usage_miniapp_last_opened_at ON telegram_usage(miniapp_last_opened_at)").run();

  await db.prepare(`CREATE TABLE IF NOT EXISTS telegram_progress (
    telegram_id INTEGER PRIMARY KEY,
    completed_stage_count INTEGER NOT NULL DEFAULT 0,
    completed_task_count INTEGER NOT NULL DEFAULT 0,
    first_progress_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS telegram_completed_stages (
    telegram_id INTEGER NOT NULL,
    stage_id TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (telegram_id, stage_id)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS telegram_completed_tasks (
    telegram_id INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    PRIMARY KEY (telegram_id, task_id)
  )`).run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_telegram_progress_updated_at ON telegram_progress(updated_at)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_telegram_completed_stages_stage_id ON telegram_completed_stages(stage_id)").run();

  const legacyTable = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'telegram_users'")
    .first<{ name: string }>();

  if (legacyTable) {
    await db.prepare(`INSERT OR IGNORE INTO telegram_usage (
      telegram_id, bot_started_at, last_seen_at, miniapp_first_opened_at, miniapp_last_opened_at, miniapp_open_count
    )
    SELECT
      telegram_id,
      started_at,
      COALESCE(last_seen_at, started_at, miniapp_opened_at, datetime('now')),
      miniapp_opened_at,
      miniapp_opened_at,
      CASE WHEN miniapp_opened_at IS NULL THEN 0 ELSE 1 END
    FROM telegram_users`).run();

    await db.prepare(`UPDATE telegram_users
      SET first_name = NULL, username = NULL
      WHERE first_name IS NOT NULL OR username IS NOT NULL`).run();
  }
}

async function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = prepareSchema(db).catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

async function upsertBotUser(db: D1Database, user: TelegramBotUser, markStarted: boolean): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO telegram_usage (telegram_id, bot_started_at, last_seen_at)
    VALUES (?1, ?2, ?3)
    ON CONFLICT(telegram_id) DO UPDATE SET
      bot_started_at = COALESCE(telegram_usage.bot_started_at, excluded.bot_started_at),
      last_seen_at = excluded.last_seen_at`)
    .bind(user.id, markStarted ? now : null, now)
    .run();
}

async function markMiniAppOpen(db: D1Database, telegramId: number, launchHash: string): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO telegram_usage (
      telegram_id, last_seen_at, miniapp_first_opened_at, miniapp_last_opened_at, miniapp_open_count, last_launch_hash
    )
    VALUES (?1, ?2, ?2, ?2, 1, ?3)
    ON CONFLICT(telegram_id) DO UPDATE SET
      last_seen_at = excluded.last_seen_at,
      miniapp_first_opened_at = COALESCE(telegram_usage.miniapp_first_opened_at, excluded.miniapp_first_opened_at),
      miniapp_last_opened_at = CASE
        WHEN telegram_usage.last_launch_hash = excluded.last_launch_hash THEN telegram_usage.miniapp_last_opened_at
        ELSE excluded.miniapp_last_opened_at
      END,
      miniapp_open_count = CASE
        WHEN telegram_usage.last_launch_hash = excluded.last_launch_hash THEN telegram_usage.miniapp_open_count
        ELSE telegram_usage.miniapp_open_count + 1
      END,
      last_launch_hash = excluded.last_launch_hash`)
    .bind(telegramId, now, launchHash)
    .run();
}

async function getUserCounts(db: D1Database) {
  const [botUsers, miniAppUsers, miniAppOpens, activeMiniAppUsers] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM telegram_usage WHERE bot_started_at IS NOT NULL").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM telegram_usage WHERE miniapp_first_opened_at IS NOT NULL").first<{ count: number }>(),
    db.prepare("SELECT COALESCE(SUM(miniapp_open_count), 0) AS count FROM telegram_usage").first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM telegram_usage WHERE miniapp_last_opened_at >= datetime('now', '-1 day')").first<{ count: number }>(),
  ]);

  return {
    totalBotUsers: botUsers?.count ?? 0,
    uniqueMiniAppUsers: miniAppUsers?.count ?? 0,
    totalMiniAppOpens: miniAppOpens?.count ?? 0,
    activeMiniAppUsers24h: activeMiniAppUsers?.count ?? 0,
  };
}

async function syncTelegramProgress(
  db: D1Database,
  telegramId: number,
  completedStages: string[],
  completedTasks: string[],
) {
  if (completedStages.length === 0 && completedTasks.length === 0) {
    return { completedStages: 0, completedTasks: 0 };
  }

  const now = new Date().toISOString();
  const statements = [
    db.prepare(`INSERT INTO telegram_progress (
      telegram_id, completed_stage_count, completed_task_count, first_progress_at, updated_at
    ) VALUES (?1, 0, 0, ?2, ?2)
    ON CONFLICT(telegram_id) DO UPDATE SET updated_at = excluded.updated_at`).bind(telegramId, now),
    ...completedStages.map(stageId => db.prepare(`INSERT OR IGNORE INTO telegram_completed_stages (
      telegram_id, stage_id, completed_at
    ) VALUES (?1, ?2, ?3)`).bind(telegramId, stageId, now)),
    ...completedTasks.map(taskId => db.prepare(`INSERT OR IGNORE INTO telegram_completed_tasks (
      telegram_id, task_id, completed_at
    ) VALUES (?1, ?2, ?3)`).bind(telegramId, taskId, now)),
  ];
  await db.batch(statements);

  const [stageCount, taskCount] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS count FROM telegram_completed_stages WHERE telegram_id = ?1")
      .bind(telegramId).first<{ count: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM telegram_completed_tasks WHERE telegram_id = ?1")
      .bind(telegramId).first<{ count: number }>(),
  ]);
  const stagesCompleted = stageCount?.count ?? 0;
  const tasksCompleted = taskCount?.count ?? 0;

  await db.prepare(`UPDATE telegram_progress SET
      completed_stage_count = ?2,
      completed_task_count = ?3,
      updated_at = ?4,
      completed_at = CASE
        WHEN ?2 >= ?5 AND ?3 >= ?6 THEN COALESCE(completed_at, ?4)
        ELSE completed_at
      END
    WHERE telegram_id = ?1`)
    .bind(telegramId, stagesCompleted, tasksCompleted, now, totalProgressStages, totalProgressTasks)
    .run();

  return { completedStages: stagesCompleted, completedTasks: tasksCompleted };
}

async function resetTelegramProgress(db: D1Database, telegramId: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM telegram_completed_stages WHERE telegram_id = ?1").bind(telegramId),
    db.prepare("DELETE FROM telegram_completed_tasks WHERE telegram_id = ?1").bind(telegramId),
    db.prepare("DELETE FROM telegram_progress WHERE telegram_id = ?1").bind(telegramId),
  ]);
}

async function getProgressSummary(db: D1Database): Promise<string> {
  const [summary, stageRows] = await Promise.all([
    db.prepare(`SELECT
      COUNT(*) AS users,
      COALESCE(SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS completed_users,
      COALESCE(AVG(completed_task_count), 0) AS average_tasks
    FROM telegram_progress`).first<{ users: number; completed_users: number; average_tasks: number }>(),
    db.prepare(`SELECT stage_id, COUNT(*) AS users
      FROM telegram_completed_stages
      GROUP BY stage_id`).all<{ stage_id: string; users: number }>(),
  ]);
  const countsByStage = new Map((stageRows.results ?? []).map(row => [row.stage_id, row.users]));
  const stageLines = journeyProgressStages.map((stage, index) =>
    `${index + 1}. ${stage.title}: ${countsByStage.get(stage.id) ?? 0}`,
  );

  return [
    `Пользователей с прогрессом: ${summary?.users ?? 0}`,
    `Прошли весь путь: ${summary?.completed_users ?? 0}`,
    `Среднее число шагов: ${Number(summary?.average_tasks ?? 0).toFixed(1)} из ${totalProgressTasks}`,
    "",
    "Завершили этапы:",
    ...stageLines,
  ].join("\n");
}

async function getUserProgress(db: D1Database, telegramId: number): Promise<string> {
  const progress = await db.prepare(`SELECT
      completed_stage_count, completed_task_count, updated_at, completed_at
    FROM telegram_progress
    WHERE telegram_id = ?1`)
    .bind(telegramId)
    .first<{
      completed_stage_count: number;
      completed_task_count: number;
      updated_at: string;
      completed_at: string | null;
    }>();

  if (!progress) return `Для Telegram ID ${telegramId} прогресс пока не зафиксирован.`;
  return [
    `Telegram ID: ${telegramId}`,
    `Этапов: ${progress.completed_stage_count} из ${totalProgressStages}`,
    `Шагов: ${progress.completed_task_count} из ${totalProgressTasks}`,
    `Последняя синхронизация: ${progress.updated_at}`,
    `Весь путь пройден: ${progress.completed_at ? "да" : "нет"}`,
  ].join("\n");
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

function getMiniAppUrl(requestUrl: string, configuredUrl?: string): string {
  const fallback = new URL("/", requestUrl);
  if (!configuredUrl) return fallback.toString();

  try {
    const url = new URL(configuredUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost") return fallback.toString();
    return url.toString();
  } catch {
    return fallback.toString();
  }
}

async function sendTelegramStartMessage(botToken: string, chatId: number, appBaseUrl: string, firstName?: string) {
  const safeName = (firstName || "").trim();
  const greeting = safeName ? `Добро пожаловать, ${safeName}!` : "Добро пожаловать!";
  return callTelegramApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: `${greeting} Нажми кнопку ниже, чтобы открыть мини-апп.`,
    reply_markup: { inline_keyboard: [[{ text: "Открыть мини-апп", web_app: { url: appBaseUrl } }]] },
  });
}

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return jsonResponse({ ok: false, error: "Telegram webhook is not configured" }, 503);
  }

  const receivedSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secureEqual(receivedSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const body = await readJson(request, 65_536);
  if (!body.ok) return jsonResponse({ ok: false, error: body.error }, body.status);
  const update = parseTelegramUpdate(body.value);
  if (!update) return jsonResponse({ ok: false, error: "Invalid Telegram update" }, 400);

  await ensureSchema(env.DB);
  const from = update.message?.from;
  const chatId = update.message?.chat?.id;
  const { command, arguments: commandArguments } = parseTelegramCommand(update.message?.text);

  if (from?.id) await upsertBotUser(env.DB, from, command === "/start");

  if (chatId && command === "/start") {
    await sendTelegramStartMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      getMiniAppUrl(request.url, env.MINI_APP_URL),
      from?.first_name,
    );
  }

  if (chatId && command === "/users_count") {
    if (!isTelegramAdmin(from?.id, env.TELEGRAM_ADMIN_IDS)) {
      await callTelegramApi(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "Команда недоступна." });
      return jsonResponse({ ok: true });
    }

    const counts = await getUserCounts(env.DB);
    await callTelegramApi(env.TELEGRAM_BOT_TOKEN, "sendMessage", {
      chat_id: chatId,
      text: `Запустили бота: ${counts.totalBotUsers}\nУникальных пользователей Mini App: ${counts.uniqueMiniAppUsers}\nВсего подтверждённых открытий: ${counts.totalMiniAppOpens}\nАктивных пользователей за 24 часа: ${counts.activeMiniAppUsers24h}`,
    });
  }

  if (chatId && command === "/progress") {
    if (!isTelegramAdmin(from?.id, env.TELEGRAM_ADMIN_IDS)) {
      await callTelegramApi(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: chatId, text: "Команда недоступна." });
      return jsonResponse({ ok: true });
    }

    let text: string;
    if (commandArguments.length === 0) {
      text = await getProgressSummary(env.DB);
    } else if (/^\d{1,16}$/.test(commandArguments[0])) {
      const telegramId = Number(commandArguments[0]);
      text = Number.isSafeInteger(telegramId) ? await getUserProgress(env.DB, telegramId) : "Некорректный Telegram ID.";
    } else {
      text = "Использование: /progress или /progress <telegram_id>";
    }
    await callTelegramApi(env.TELEGRAM_BOT_TOKEN, "sendMessage", { chat_id: chatId, text });
  }

  return jsonResponse({ ok: true });
}

async function validateProgressRequest(request: Request, env: Env) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) {
    return { response: jsonResponse({ ok: false, error: "Telegram progress is not configured" }, 503) } as const;
  }
  const body = await readJson(request, 32_768);
  if (!body.ok) return { response: jsonResponse({ ok: false, error: body.error }, body.status) } as const;
  if (!isRecord(body.value) || typeof body.value.initData !== "string") {
    return { response: jsonResponse({ ok: false, error: "Missing initData" }, 400) } as const;
  }
  const validation = validateTelegramInitData(body.value.initData, env.TELEGRAM_BOT_TOKEN, {
    maxAgeSeconds: parseMaxAgeSeconds(env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS),
  });
  if (!validation.ok) return { response: jsonResponse({ ok: false, error: validation.error }, 401) } as const;
  return { db: env.DB, body: body.value, user: validation.user } as const;
}

async function handleTelegramIdentify(request: Request, env: Env): Promise<Response> {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN) {
    return jsonResponse({ ok: false, error: "Telegram identification is not configured" }, 503);
  }
  const body = await readJson(request, 20_000);
  if (!body.ok) return jsonResponse({ ok: false, error: body.error }, body.status);
  if (!isRecord(body.value) || typeof body.value.initData !== "string") {
    return jsonResponse({ ok: false, error: "Missing initData" }, 400);
  }
  const validation = validateTelegramInitData(body.value.initData, env.TELEGRAM_BOT_TOKEN, {
    maxAgeSeconds: parseMaxAgeSeconds(env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS),
  });
  if (!validation.ok) return jsonResponse({ ok: false, error: validation.error }, 401);

  await ensureSchema(env.DB);
  const launchHash = createHash("sha256").update(body.value.initData).digest("hex");
  await markMiniAppOpen(env.DB, validation.user.id, launchHash);
  return jsonResponse({ ok: true, verified: true });
}

async function handleTelegramProgress(request: Request, env: Env): Promise<Response> {
  const validated = await validateProgressRequest(request, env);
  if ("response" in validated) return validated.response;

  await ensureSchema(validated.db);
  if (validated.body.reset === true) {
    await resetTelegramProgress(validated.db, validated.user.id);
    return jsonResponse({ ok: true, reset: true });
  }

  const validProgress = validateProgressIds(validated.body.completedStages, validated.body.completedTasks);
  if (!validProgress) return jsonResponse({ ok: false, error: "Invalid progress" }, 400);
  const synced = await syncTelegramProgress(
    validated.db,
    validated.user.id,
    validProgress.completedStages,
    validProgress.completedTasks,
  );
  return jsonResponse({ ok: true, synced });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/telegram/webhook" && request.method === "POST") return await handleTelegramWebhook(request, env);
      if (url.pathname === "/api/telegram/identify" && request.method === "POST") return await handleTelegramIdentify(request, env);
      if (url.pathname === "/api/telegram/progress" && request.method === "POST") return await handleTelegramProgress(request, env);
    } catch (error) {
      console.error("Telegram request failed", error instanceof Error ? error.message : "Unknown error");
      return jsonResponse({ ok: false, error: "Internal server error" }, 500);
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: path => env.ASSETS.fetch(new Request(new URL(path, request.url))),
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
