// WhatsApp message handling with no network: normalise, store, and work out what needs Lye.
// Pal is read-only on WhatsApp. Nothing here sends, reads (blue ticks) or shows presence.

const MAX_PER_CHAT = 150;
const KEEP_DAYS = 7;
const NAME_HINTS = new RegExp(process.env.WA_NAME_HINTS || "\\b(lye|jj|boss|mr\\.? ?lye|encik lye|tuan lye)\\b|老板|老闆|lye总|lye總", "i");

export const emptyWa = () => ({ chats: {}, lastDigest: 0, alerts: {} });
export const isGroupJid = (jid) => String(jid || "").endsWith("@g.us");
const bare = (jid) => String(jid || "").split(":")[0].split("@")[0];

// WhatsApp wraps content in several envelope types; peel them to the real message.
function unwrap(message) {
  let m = message || {};
  for (let i = 0; i < 5; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message ||
      m.viewOnceMessageV2Extension?.message || m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m;
}

export function extractText(message) {
  const m = unwrap(message);
  if (m.protocolMessage || m.reactionMessage || m.senderKeyDistributionMessage && Object.keys(m).length === 1) return "";
  const t = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption ||
    m.documentMessage?.caption || m.buttonsResponseMessage?.selectedDisplayText || m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText || m.pollCreationMessage?.name || m.pollCreationMessageV3?.name || "";
  if (t) return String(t);
  if (m.audioMessage) return `[voice note ${m.audioMessage.seconds || "?"}s]`;
  if (m.imageMessage) return "[photo]";
  if (m.videoMessage) return "[video]";
  if (m.documentMessage) return `[document: ${m.documentMessage.fileName || "file"}]`;
  if (m.stickerMessage) return "";
  if (m.locationMessage) return "[location]";
  if (m.contactMessage) return `[contact: ${m.contactMessage.displayName || ""}]`;
  return "";
}

function contextOf(message) {
  const m = unwrap(message);
  return m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo ||
    m.documentMessage?.contextInfo || m.audioMessage?.contextInfo || null;
}

/** meIds: Lye's own ids (phone jid and lid), any form. */
export function normalize(raw, meIds = []) {
  const key = raw.key || {}, chat = key.remoteJid || "";
  if (!chat || chat === "status@broadcast" || chat.endsWith("@newsletter")) return null;
  const text = extractText(raw.message);
  if (!text) return null;
  const me = new Set(meIds.filter(Boolean).map(bare));
  const ctx = contextOf(raw.message);
  const mentioned = (ctx?.mentionedJid || []).some((j) => me.has(bare(j)));
  const repliesToMe = !!ctx?.participant && me.has(bare(ctx.participant)) && !key.fromMe;
  const from = key.fromMe ? "me" : (key.participant || key.participantAlt || chat);
  const ts = Number(raw.messageTimestamp?.low ?? raw.messageTimestamp ?? 0) * 1000 || Date.now();
  const audio = unwrap(raw.message).audioMessage;
  return {
    id: key.id, chat, isGroup: isGroupJid(chat), from, fromName: key.fromMe ? "Lye" : (raw.pushName || bare(from)),
    fromMe: !!key.fromMe, text: text.slice(0, 1500), ts, mentionsMe: mentioned, repliesToMe,
    nameHit: !key.fromMe && NAME_HINTS.test(text), voiceSeconds: audio ? Number(audio.seconds || 0) : 0,
    quoted: ctx?.quotedMessage ? extractText(ctx.quotedMessage).slice(0, 200) : "",
  };
}

export function ingest(wa, msg, chatName) {
  if (!msg) return false;
  const c = (wa.chats[msg.chat] = wa.chats[msg.chat] || { name: "", isGroup: msg.isGroup, messages: [] });
  if (chatName) c.name = chatName;
  if (!c.name && !msg.isGroup && !msg.fromMe) c.name = msg.fromName;
  if (c.messages.some((x) => x.id === msg.id)) return false;
  c.messages.push(msg);
  c.messages.sort((a, b) => a.ts - b.ts);
  if (c.messages.length > MAX_PER_CHAT) c.messages = c.messages.slice(-MAX_PER_CHAT);
  return true;
}

export function prune(wa, now = Date.now()) {
  const cutoff = now - KEEP_DAYS * 864e5;
  for (const [jid, c] of Object.entries(wa.chats)) {
    c.messages = c.messages.filter((m) => m.ts > cutoff);
    if (!c.messages.length) delete wa.chats[jid];
  }
  for (const [id, a] of Object.entries(wa.alerts)) if ((a.ts || 0) < cutoff) delete wa.alerts[id];
}

const repliedAfter = (c, ts) => c.messages.some((m) => m.fromMe && m.ts > ts);
const needsLye = (c, m) => !m.fromMe && (!c.isGroup || m.mentionsMe || m.repliesToMe || m.nameHit);

/** Chats where someone is waiting on Lye: unanswered DMs, and group messages aimed at him. */
export function unanswered(wa, now = Date.now(), minAgeMs = 30 * 6e4) {
  const out = [];
  for (const [jid, c] of Object.entries(wa.chats)) {
    const waiting = c.messages.filter((m) => needsLye(c, m) && !repliedAfter(c, m.ts) && now - m.ts >= minAgeMs);
    if (!waiting.length) continue;
    out.push({ jid, name: c.name || bare(jid), isGroup: c.isGroup, since: waiting[0].ts, count: waiting.length, last: waiting[waiting.length - 1] });
  }
  return out.sort((a, b) => a.since - b.since);
}

/** Messages to triage now: aimed at Lye, older than the hold (so he can answer on his phone first), still unanswered. */
export function triageCandidates(wa, now = Date.now(), holdMs = 10 * 6e4, maxAgeMs = 6 * 36e5) {
  const out = [];
  for (const [jid, c] of Object.entries(wa.chats)) {
    for (const m of c.messages) {
      if (m.triaged || !needsLye(c, m)) continue;
      const age = now - m.ts;
      if (age < holdMs) continue;
      if (age > maxAgeMs || repliedAfter(c, m.ts)) { m.triaged = true; continue; }
      const before = c.messages.filter((x) => x.ts <= m.ts).slice(-6);
      out.push({ jid, chatName: c.name || bare(jid), isGroup: c.isGroup, msg: m, context: before });
    }
  }
  return out.slice(0, 20);
}

/** Busy group chats since the last digest, with their new messages. */
export function digestGroups(wa, since, minMessages = 5, maxGroups = 8) {
  return Object.entries(wa.chats)
    .map(([jid, c]) => ({ jid, name: c.name || bare(jid), isGroup: c.isGroup, messages: c.messages.filter((m) => m.ts > since) }))
    .filter((g) => g.isGroup && g.messages.length >= minMessages)
    .sort((a, b) => b.messages.length - a.messages.length)
    .slice(0, maxGroups);
}

export const line = (m) => `${new Date(m.ts).toLocaleTimeString("en-MY", { hour: "numeric", minute: "2-digit" })} ${m.fromName}: ${m.text.replace(/\s+/g, " ").slice(0, 300)}`;

export function search(wa, { query = "", chat = "", days = 7 } = {}, now = Date.now()) {
  const q = String(query).toLowerCase(), cq = String(chat).toLowerCase(), since = now - days * 864e5;
  const hits = [];
  for (const [jid, c] of Object.entries(wa.chats)) {
    if (cq && !(c.name || jid).toLowerCase().includes(cq)) continue;
    for (const m of c.messages) {
      if (m.ts < since) continue;
      if (q && !(m.text + " " + m.fromName).toLowerCase().includes(q)) continue;
      hits.push({ chat: c.name || bare(jid), group: c.isGroup, from: m.fromName, time: new Date(m.ts).toISOString(), text: m.text });
    }
  }
  return hits.sort((a, b) => b.time.localeCompare(a.time)).slice(0, 60);
}
