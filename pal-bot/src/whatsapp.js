// Read-only WhatsApp link. Pal joins as a linked device (like WhatsApp Web) and only listens:
// it never sends messages, never sends read receipts (no blue ticks) and never shows "online",
// so Lye's phone keeps notifying as normal.
import fs from "node:fs";
import path from "node:path";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, downloadMediaMessage } from "@whiskeysockets/baileys";
import { config } from "./config.js";
import { askJSON, askText } from "./claude.js";
import { transcribe } from "./transcribe.js";
import { normDue, hm } from "./domain.js";
import { emptyWa, normalize, ingest, prune, triageCandidates, digestGroups, unanswered, line } from "./wa-logic.js";

const AUTH_DIR = path.join(config.dataDir, "wa-auth");
const FILE = path.join(config.dataDir, "whatsapp.json");

let wa = emptyWa();
let sock = null;
let state = "off"; // off | unlinked | linking | connecting | connected | logged_out
let notify = async () => {};
let meIds = [];
let retry = 0;
let saveTimer = null;
const groupNames = {};

const silent = { level: "silent", child() { return silent; }, trace() {}, debug() {}, info() {}, warn() {}, error() {} };

export const waData = () => wa;
export const waState = () => state;
export const waLinkedBefore = () => fs.existsSync(path.join(AUTH_DIR, "creds.json"));

function load() {
  try { if (fs.existsSync(FILE)) wa = { ...emptyWa(), ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch (e) { console.error("whatsapp.json unreadable, starting fresh:", e.message); }
}
// WhatsApp is chatty: write at most every 5 seconds.
export function saveWa() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(FILE + ".tmp", JSON.stringify(wa));
    fs.renameSync(FILE + ".tmp", FILE);
  }, 5000);
}

/** Starts the link. With `phone`, asks WhatsApp for a pairing code and sends it to Telegram. */
export async function startWhatsApp({ onNotify, phone } = {}) {
  if (onNotify) notify = onNotify;
  load();
  const { state: auth, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  if (!auth.creds.registered && !phone) { state = "unlinked"; return state; }
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch {}
  try { sock?.end?.(undefined); } catch {}
  state = phone ? "linking" : "connecting";
  let codeSent = false;
  sock = makeWASocket({
    auth, version, logger: silent, browser: Browsers.macOS("Pal"),
    markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false,
    generateHighQualityLinkPreview: false, emitOwnEvents: true,
  });
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", async (u) => {
    if (u.qr && phone && !codeSent) {
      codeSent = true;
      try {
        const code = await sock.requestPairingCode(String(phone).replace(/\D/g, ""));
        await notify(`🔗 **WhatsApp pairing code: ${code.match(/.{1,4}/g).join("-")}**\n\nOn your phone: WhatsApp → **Settings → Linked devices → Link a device → Link with phone number instead** → enter the code.\n_Pal will only read. It never sends, never marks messages as read, and never shows you online._`);
      } catch (e) { await notify("Couldn't get a pairing code: " + e.message + ". Check the number (country code first, e.g. 60123456789) and try /whatsapp link again."); }
    }
    if (u.connection === "open") {
      retry = 0; state = "connected";
      meIds = [sock.user?.id, sock.user?.lid].filter(Boolean);
      if (phone) await notify("✅ WhatsApp linked (read-only). I'll flag messages that need you and send digests. /wa shows who's waiting on you.");
      try { const groups = await sock.groupFetchAllParticipating(); for (const [jid, g] of Object.entries(groups)) groupNames[jid] = g.subject; } catch {}
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        state = "logged_out"; sock = null;
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        await notify("WhatsApp unlinked Pal (removed from Linked devices or logged out). Send /whatsapp link <your number> to link again.");
        return;
      }
      state = "connecting";
      const wait = Math.min(60000, 2000 * 2 ** Math.min(retry++, 5));
      setTimeout(() => startWhatsApp().catch((e) => console.error("WhatsApp reconnect failed:", e.message)), wait);
    }
  });
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify" && type !== "append") return;
    for (const raw of messages) {
      const msg = normalize(raw, meIds);
      if (!msg) continue;
      if (msg.isGroup && !groupNames[msg.chat]) {
        try { groupNames[msg.chat] = (await sock.groupMetadata(msg.chat)).subject; } catch { groupNames[msg.chat] = ""; }
      }
      if (ingest(wa, msg, msg.isGroup ? groupNames[msg.chat] : undefined)) {
        saveWa();
        // Voice notes sent to Lye directly (or aimed at him) get transcribed so they can be triaged and searched.
        if (msg.voiceSeconds && msg.voiceSeconds <= 180 && !msg.fromMe && (!msg.isGroup || msg.mentionsMe || msg.repliesToMe) && config.openaiKey) {
          transcribeVoice(raw, msg).catch((e) => console.warn("WA voice transcription failed:", e.message));
        }
      }
    }
  });
  return state;
}

async function transcribeVoice(raw, msg) {
  const buf = await downloadMediaMessage(raw, "buffer", {}, { logger: silent, reuploadRequest: sock.updateMediaMessage });
  const text = await transcribe(buf, "voice.ogg");
  if (text) { msg.text = `[voice] ${text}`.slice(0, 1500); msg.nameHit = msg.nameHit || /\b(lye|boss)\b|老板/i.test(text); saveWa(); }
}

export async function unlinkWhatsApp() {
  try { await sock?.logout(); } catch {}
  sock = null; state = "unlinked";
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
}

/* ---------- triage: what needs Lye ---------- */
const str = { type: "string" };
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: { items: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["index", "important", "summary", "ask", "due", "suggested_reply", "reply_language"],
    properties: { index: { type: "integer" }, important: { type: "boolean" }, summary: str, ask: str, due: str, suggested_reply: str, reply_language: str } } } },
};

/** Returns alerts worth pushing now. Each candidate is triaged once. */
export async function triageWhatsApp(now = Date.now()) {
  const cands = triageCandidates(wa, now);
  if (!cands.length) return [];
  let items = [];
  try {
    const out = await askJSON({
      schema: SCHEMA, effort: "low",
      system: `You triage WhatsApp messages for ${config.ownerName} (Lye Jenq Jiang), GM of Paint Marketing Company (M) Sdn Bhd (Nippon Paint Malaysia's marketing and distribution arm). Messages mix Malaysian English/Manglish, Malaysian Chinese and Bahasa Melayu. "Lye" in a context line means Lye himself.`,
      prompt: `Current time: ${hm(new Date(now))}. For each numbered message decide:
- important: true only if Lye personally needs to answer, decide, approve or act (questions to him, approvals, escalations, customer or dealer issues, deadlines, his boss). False for greetings, FYIs, banter, forwards, "ok/noted", group chatter.
- summary: one English line: who wants what.
- ask: what Lye must do, English imperative, or "".
- due: YYYY-MM-DD or YYYY-MM-DDTHH:MM if a deadline is stated or implied ("by Friday", "esok", "明天"), else "".
- suggested_reply: a short reply Lye could send, in the chat's language and Malaysian business tone; "" if none needed.
- reply_language: the language of that reply.

${cands.map((c, i) => `=== MESSAGE ${i} · ${c.isGroup ? "group \"" + c.chatName + "\"" : "direct chat with " + c.chatName} ===\nContext:\n${c.context.map(line).join("\n")}\n>>> ${line(c.msg)}`).join("\n\n")}`,
    });
    items = out.items || [];
  } catch (e) {
    console.error("WhatsApp triage failed:", e.message);
    return [];
  }
  const alerts = [];
  cands.forEach((c, i) => {
    c.msg.triaged = true;
    const t = items.find((x) => x.index === i);
    if (!t?.important) return;
    const a = { id: c.msg.id, ts: c.msg.ts, chat: c.chatName, isGroup: c.isGroup, from: c.msg.fromName, text: c.msg.text, summary: t.summary,
      ask: t.ask, due: normDue(t.due), reply: t.suggested_reply, replyLang: t.reply_language };
    wa.alerts[a.id] = a;
    alerts.push(a);
  });
  saveWa();
  return alerts;
}

/** Midday / evening digest of busy groups plus who is still waiting on Lye. */
export async function whatsappDigest(now = Date.now()) {
  const groups = digestGroups(wa, wa.lastDigest || now - 12 * 36e5);
  const waiting = unanswered(wa, now);
  wa.lastDigest = now; saveWa();
  if (!groups.length && !waiting.length) return { empty: true };
  let groupText = "";
  if (groups.length) {
    try {
      groupText = await askText({
        system: `You summarise WhatsApp group chats for ${config.ownerName}, GM of PMC (Nippon Paint Malaysia). Telegram style: **bold** group names, "- " bullets, English, no preamble. Never invent facts.`,
        prompt: `For each group: 1-3 bullets on what matters (decisions, numbers, problems, competitor moves), and flag anything asked of Lye with "→ You:". Skip banter. Groups with nothing important: one line "nothing important".\n\n${groups.map((g) => `### ${g.name} (${g.messages.length} new)\n${g.messages.slice(-60).map(line).join("\n")}`).join("\n\n")}`,
      });
    } catch (e) { groupText = groups.map((g) => `**${g.name}**: ${g.messages.length} new messages`).join("\n"); }
  }
  const wait = waiting.slice(0, 10).map((w) => `- **${w.name}**${w.isGroup ? " (group)" : ""}: ${w.last.text.replace(/\s+/g, " ").slice(0, 90)} · waiting since ${new Date(w.since).toLocaleTimeString("en-MY", { hour: "numeric", minute: "2-digit" })}`);
  return { text: ["**WhatsApp digest**", wait.length ? "**Waiting on you**\n" + wait.join("\n") : "", groupText].filter(Boolean).join("\n\n") };
}

export function waMaintenance() { prune(wa); saveWa(); }
