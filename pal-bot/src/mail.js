// Gmail is Pal's inbox. Two things arrive there:
//  1. "PAL AGENDA" emails from the iPhone Shortcut: every calendar on the phone, Lotus Notes included.
//  2. Lotus Notes mail, auto-forwarded by a Notes rule to you+notes@gmail.com.
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { config } from "./config.js";
import { db, save } from "./store.js";
import { askJSON } from "./claude.js";
import { parseAgenda, eventsBetween, normDue, newId, parseLocal, fmtDay, fmtTime, hm } from "./domain.js";

export const mailEnabled = () => !!(config.gmail.user && config.gmail.appPassword);
export const notesAddress = () => config.gmail.user.replace("@", `${config.gmail.notesTag}@`);

let running = false;

export async function pollMail() {
  if (!mailEnabled() || running) return { agenda: false, mail: [] };
  running = true;
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: config.gmail.user, pass: config.gmail.appPassword }, logger: false });
  const found = [];
  try {
    await client.connect();
    const boxes = await client.list();
    const box = boxes.find((b) => b.specialUse === "\\All")?.path || "INBOX"; // "All Mail" in any UI language
    const lock = await client.getMailboxLock(box);
    try {
      const d = db();
      const validity = String(client.mailbox.uidValidity);
      if (d.meta.uidValidity !== validity) { d.meta.uidValidity = validity; d.mailSeenUid = 0; }
      const addr = notesAddress();
      const q = `newer_than:3d {deliveredto:${addr} to:${addr} subject:"${config.gmail.agendaSubject}"}`;
      const uids = ((await client.search({ gmraw: q }, { uid: true })) || []).filter((u) => u > (d.mailSeenUid || 0)).sort((a, b) => a - b);
      if (uids.length) {
        for await (const msg of client.fetch(uids.slice(-40), { uid: true, source: true }, { uid: true })) {
          const p = await simpleParser(msg.source);
          found.push({ uid: msg.uid, subject: p.subject || "", from: p.from?.text || "", date: (p.date || new Date()).getTime(),
            text: (p.text || String(p.html || "").replace(/<[^>]+>/g, " ")).replace(/\n{3,}/g, "\n\n").slice(0, 15000) });
        }
        d.mailSeenUid = Math.max(d.mailSeenUid || 0, ...uids);
      }
    } finally { lock.release(); }
    await client.logout();
  } catch (e) {
    console.error("Mail poll failed:", e.message);
    try { await client.logout(); } catch {}
    running = false;
    return { agenda: false, mail: [], error: e.message };
  }
  running = false;

  const isAgenda = (m) => m.subject.toUpperCase().includes(config.gmail.agendaSubject.toUpperCase());
  let agenda = false;
  const agendaMsgs = found.filter(isAgenda).sort((a, b) => a.date - b.date);
  if (agendaMsgs.length) {
    const latest = agendaMsgs[agendaMsgs.length - 1], events = parseAgenda(latest.text);
    db().agenda = { events, receivedAt: latest.date, count: events.length };
    agenda = true;
  }
  const notes = found.filter((m) => !isAgenda(m));
  const triaged = notes.length ? await triage(notes.slice(-15)) : [];
  save();
  return { agenda, mail: triaged };
}

const str = { type: "string" };
const TRIAGE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["items"],
  properties: { items: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["index", "from", "subject", "summary", "urgency", "actions", "reply_needed", "suggested_reply", "is_invite", "invite_title", "invite_start", "invite_end"],
    properties: {
      index: { type: "integer" }, from: str, subject: str, summary: str,
      urgency: { type: "string", enum: ["urgent", "today", "fyi", "ignore"] },
      actions: { type: "array", items: { type: "object", additionalProperties: false, required: ["task", "due"], properties: { task: str, due: str } } },
      reply_needed: { type: "boolean" }, suggested_reply: str,
      is_invite: { type: "boolean" }, invite_title: str, invite_start: str, invite_end: str,
    } } } },
};

async function triage(msgs) {
  const now = new Date();
  let items = [];
  try {
    const out = await askJSON({
      schema: TRIAGE_SCHEMA, effort: "low",
      system: `You triage Lotus Notes email for ${config.ownerName} (Lye Jenq Jiang), GM of Paint Marketing Company (M) Sdn Bhd (Nippon Paint Malaysia's marketing and distribution arm). Emails were auto-forwarded, so the real sender and subject are often inside the body's forwarded header.`,
      prompt: `Current time: ${hm(now)}. For each email return one item:
- from: the original sender's name; subject: original subject.
- summary: one or two English sentences on what it means for Lye.
- urgency: "urgent" = needs Lye within hours (boss, key customer, escalation, deadline today); "today" = needs action today or tomorrow; "fyi" = read when free; "ignore" = newsletters, system notices, auto-replies.
- actions: what Lye must do, English imperative, due as YYYY-MM-DD or YYYY-MM-DDTHH:MM or "".
- reply_needed, and suggested_reply: a short reply in the email's language and tone, or "".
- is_invite: true for a meeting invitation or reschedule; then invite_title, invite_start and invite_end as YYYY-MM-DDTHH:MM local time, else "".
Emails may be in English, Chinese or Malay.

${msgs.map((m, i) => `=== EMAIL ${i} ===\nHeader From: ${m.from}\nHeader Subject: ${m.subject}\nReceived: ${hm(new Date(m.date))}\n${m.text.slice(0, 6000)}`).join("\n\n")}`,
    });
    items = out.items || [];
  } catch (e) {
    console.error("Triage failed:", e.message);
  }
  const d = db(), saved = [];
  msgs.forEach((m, i) => {
    const t = items.find((x) => x.index === i) || {};
    const entry = {
      id: newId(), uid: m.uid, date: m.date, from: t.from || m.from, subject: t.subject || m.subject.replace(/^(fw|fwd|re):\s*/i, ""),
      summary: t.summary || m.text.slice(0, 200), urgency: t.urgency || "today", actions: (t.actions || []).map((a) => ({ task: a.task, due: normDue(a.due) })),
      reply_needed: !!t.reply_needed, suggested_reply: t.suggested_reply || "", is_invite: !!t.is_invite,
      invite_title: t.invite_title || "", invite_start: normDue(t.invite_start), invite_end: normDue(t.invite_end), text: m.text.slice(0, 8000), digested: false,
    };
    d.mail.push(entry);
    saved.push(entry);
  });
  return saved;
}

export function inviteClash(m) {
  const a = parseLocal(m.invite_start); if (!a) return null;
  const b = parseLocal(m.invite_end) || new Date(a.getTime() + 36e5);
  const clashes = eventsBetween(db().agenda.events, a, b).filter((e) => !e.allDay && !e.title.toLowerCase().includes(m.invite_title.toLowerCase().slice(0, 12) || "\u0000"));
  return { start: a, end: b, clashes };
}

export function inviteLine(m) {
  const c = inviteClash(m);
  if (!c) return `- **${m.invite_title || m.subject}** (time unclear, check the invite)`;
  const when = `${fmtDay(c.start)} ${fmtTime(c.start)}–${fmtTime(c.end)}`;
  return c.clashes.length ? `- **${m.invite_title || m.subject}** · ${when}\n  Clashes with: ${c.clashes.map((e) => e.title).join(", ")}` : `- **${m.invite_title || m.subject}** · ${when} · you're free`;
}
