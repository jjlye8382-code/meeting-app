// Minimal Telegram Bot API client over fetch (long polling, no webhook needed).
import { config } from "./config.js";
import { toTelegramHTML, splitMessage } from "./format.js";

const BASE = () => (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/$/, "");
const API = () => `${BASE()}/bot${config.telegramToken}`;

async function call(method, body, { timeoutMs = 30000 } = {}) {
  const res = await fetch(`${API()}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!json.ok) { const e = new Error(`${method}: ${json.description}`); e.code = json.error_code; e.retryAfter = json.parameters?.retry_after; throw e; }
  return json.result;
}

export async function getUpdates(offset) {
  return call("getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] }, { timeoutMs: 65000 });
}

// Sends Claude-style markdown as Telegram HTML; falls back to plain text if Telegram rejects the markup.
export async function send(chatId, text, { buttons, replyTo } = {}) {
  const parts = splitMessage(String(text || "").trim() || "…");
  let last;
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    const base = { chat_id: chatId, disable_web_page_preview: true };
    if (isLast && buttons) base.reply_markup = { inline_keyboard: buttons };
    if (i === 0 && replyTo) base.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    try { last = await call("sendMessage", { ...base, text: toTelegramHTML(parts[i]), parse_mode: "HTML" }); }
    catch (e) {
      if (e.code === 429 && e.retryAfter) { await new Promise((r) => setTimeout(r, e.retryAfter * 1000)); i--; continue; }
      last = await call("sendMessage", { ...base, text: parts[i] });
    }
  }
  return last;
}

export const typing = (chatId, action = "typing") => call("sendChatAction", { chat_id: chatId, action }).catch(() => {});
export const answerCallback = (id, text) => call("answerCallbackQuery", { callback_query_id: id, text: text?.slice(0, 190) }).catch(() => {});
export const clearButtons = (chatId, messageId) => call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }).catch(() => {});
export const deleteWebhook = () => call("deleteWebhook", { drop_pending_updates: false }).catch((e) => console.warn("deleteWebhook", e.message));
export const setCommands = (commands) => call("setMyCommands", { commands }).catch((e) => console.warn("setMyCommands", e.message));

// Telegram serves bot downloads up to 20 MB.
export async function download(fileId) {
  const f = await call("getFile", { file_id: fileId });
  const res = await fetch(`${BASE()}/file/bot${config.telegramToken}/${f.file_path}`, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  return { buffer: Buffer.from(await res.arrayBuffer()), path: f.file_path };
}
