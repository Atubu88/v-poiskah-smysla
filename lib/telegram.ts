import { createHmac, timingSafeEqual } from "node:crypto";

export type TelegramMiniAppUser = {
  id: number;
  first_name?: string;
  username?: string;
};

export type TelegramBotUser = TelegramMiniAppUser;

export type TelegramUpdate = {
  update_id?: number;
  message?: {
    chat?: { id?: number };
    from?: TelegramBotUser;
    text?: string;
  };
};

export type TelegramInitDataError =
  | "missing_init_data"
  | "init_data_too_large"
  | "missing_hash"
  | "invalid_hash"
  | "missing_auth_date"
  | "invalid_auth_date"
  | "future_auth_date"
  | "expired_init_data"
  | "invalid_signature"
  | "missing_user"
  | "invalid_user";

export type TelegramInitDataResult =
  | { ok: true; user: TelegramMiniAppUser; authDate: number }
  | { ok: false; error: TelegramInitDataError };

const MAX_INIT_DATA_BYTES = 16_384;
const MAX_FUTURE_CLOCK_SKEW_SECONDS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTelegramUser(value: unknown): value is TelegramMiniAppUser {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || Number(value.id) <= 0) return false;
  if (value.first_name !== undefined && typeof value.first_name !== "string") return false;
  if (value.username !== undefined && typeof value.username !== "string") return false;
  return true;
}

function equalBuffers(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function secureEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return equalBuffers(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function validateTelegramInitData(
  initDataRaw: string,
  botToken: string,
  options: { nowMs?: number; maxAgeSeconds?: number } = {},
): TelegramInitDataResult {
  if (!initDataRaw || !botToken) return { ok: false, error: "missing_init_data" };
  if (Buffer.byteLength(initDataRaw, "utf8") > MAX_INIT_DATA_BYTES) {
    return { ok: false, error: "init_data_too_large" };
  }

  const params = new URLSearchParams(initDataRaw);
  const hash = params.get("hash");
  if (!hash) return { ok: false, error: "missing_hash" };
  if (!/^[a-f\d]{64}$/i.test(hash)) return { ok: false, error: "invalid_hash" };

  const authDateRaw = params.get("auth_date");
  if (!authDateRaw) return { ok: false, error: "missing_auth_date" };
  if (!/^\d{1,12}$/.test(authDateRaw)) return { ok: false, error: "invalid_auth_date" };

  const authDate = Number(authDateRaw);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) return { ok: false, error: "invalid_auth_date" };

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const maxAgeSeconds = Math.max(60, options.maxAgeSeconds ?? 3_600);
  if (authDate > nowSeconds + MAX_FUTURE_CLOCK_SKEW_SECONDS) return { ok: false, error: "future_auth_date" };
  if (nowSeconds - authDate > maxAgeSeconds) return { ok: false, error: "expired_init_data" };

  const dataCheckString = Array.from(params.entries())
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest();
  const receivedHash = Buffer.from(hash, "hex");
  if (!equalBuffers(receivedHash, expectedHash)) return { ok: false, error: "invalid_signature" };

  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, error: "missing_user" };

  try {
    const user = JSON.parse(userRaw) as unknown;
    return isTelegramUser(user) ? { ok: true, user, authDate } : { ok: false, error: "invalid_user" };
  } catch {
    return { ok: false, error: "invalid_user" };
  }
}

export function parseTelegramUpdate(value: unknown): TelegramUpdate | null {
  if (!isRecord(value)) return null;
  const update: TelegramUpdate = {};

  if (value.update_id !== undefined) {
    if (!Number.isSafeInteger(value.update_id)) return null;
    update.update_id = Number(value.update_id);
  }

  if (value.message !== undefined) {
    if (!isRecord(value.message)) return null;
    const message: NonNullable<TelegramUpdate["message"]> = {};

    if (value.message.chat !== undefined) {
      if (!isRecord(value.message.chat)) return null;
      if (value.message.chat.id !== undefined && !Number.isSafeInteger(value.message.chat.id)) return null;
      message.chat = { id: value.message.chat.id === undefined ? undefined : Number(value.message.chat.id) };
    }

    if (value.message.from !== undefined) {
      if (!isTelegramUser(value.message.from)) return null;
      message.from = value.message.from;
    }

    if (value.message.text !== undefined) {
      if (typeof value.message.text !== "string") return null;
      message.text = value.message.text;
    }

    update.message = message;
  }

  return update;
}

export function isTelegramAdmin(userId: number | undefined, configuredIds: string | undefined): boolean {
  if (!userId || !configuredIds) return false;
  return configuredIds.split(",").map(value => value.trim()).filter(value => /^\d+$/.test(value)).includes(String(userId));
}

export function parseTelegramCommand(text: string | undefined): { command: string; arguments: string[] } {
  const parts = (text ?? "").trim().split(/\s+/).filter(Boolean);
  const command = (parts.shift() ?? "").split("@", 1)[0].toLowerCase();
  return { command, arguments: parts };
}

export function parseMaxAgeSeconds(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 3_600;
  return Math.min(86_400, Math.max(60, Number(value)));
}
