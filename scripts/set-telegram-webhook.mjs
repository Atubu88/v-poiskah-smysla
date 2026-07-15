const botToken = process.env.TELEGRAM_BOT_TOKEN;
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
const miniAppUrl = process.env.MINI_APP_URL;

if (!botToken || !webhookSecret || !miniAppUrl) {
  throw new Error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and MINI_APP_URL first.");
}

const baseUrl = new URL(miniAppUrl);
if (baseUrl.protocol !== "https:") throw new Error("MINI_APP_URL must use HTTPS.");

const webhookUrl = new URL("/telegram/webhook", baseUrl).toString();
const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ["message"],
    drop_pending_updates: false,
  }),
});

const result = await response.json();
if (!response.ok || !result?.ok) {
  throw new Error(result?.description || "Telegram rejected the webhook configuration.");
}

console.log(`Telegram webhook configured for ${webhookUrl.origin}.`);
