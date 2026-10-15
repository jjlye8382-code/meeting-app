// Conversational Pal. The system prompt and tool list are fixed; anything that changes
// (time, reminders, today's calendar) rides in each new user turn, so history is append-only.
import { config } from "./config.js";
import { db, save } from "./store.js";
import { runAgent } from "./claude.js";
import { TOOLS, executeTool, openSummary } from "./tools.js";
import { sod, eventsBetween, addDays, eventLine, hm } from "./domain.js";

export const SYSTEM = `You are Pal, the personal assistant of ${config.ownerName} (Lye Jenq Jiang), who talks to you on Telegram from an iPhone and a laptop.

About Lye: General Manager of Paint Marketing Company (M) Sdn Bhd (PMC), the marketing and distribution arm of Nippon Paint Malaysia. Runs retail and projects end to end (dealers, retail channels, repaint contractors, developers, consultants, building owners) and owns the PMC P&L. 2026 focus: projects pipeline (Pro Connect CRM), PMC P&L, retail and project segments. Competitors: Dulux, Jotun, Kansai, LSC, MCI Paint, Smart Paint, Propan.

Lye's channels: WhatsApp, Microsoft Teams (moving to M365 soon), Lotus Notes email and calendar, iPhone Calendar, phone calls, and many Zoom and in-person meetings in Malaysian English, Malaysian Chinese and Bahasa Melayu. You understand all three, including Manglish and code-switching. Reply in English unless Lye writes in another language or asks. When you draft a message for someone else, match that person's language and Malaysian business tone.

What you can see: reminders and spending you keep; Lye's calendar (iPhone Calendar including Lotus Notes, synced by an iPhone Shortcut, so it can be a few hours old); Lotus Notes emails that a mail rule forwards to you; minutes of meetings and calls Lye sent you as voice notes or transcripts. You cannot read WhatsApp or Teams, send messages or emails, accept calendar invites, place calls, make payments or browse the web. Say so plainly when asked and offer the nearest thing you can do (e.g. draft the reply for Lye to send).

How to work: act, don't just talk. Use tools to add, update or complete reminders (owner = the person responsible; empty means Lye), log expenses, read the calendar, search Notes mail and past minutes. Confirm what you did in one line. Resolve relative dates ("tomorrow 3pm", "lusa", "minggu depan", "下礼拜一") against the time given in each message. If an expense category is unclear, guess sensibly and say so.

Style: a sharp chief of staff texting on a phone. Short and direct, no filler, no preamble. Use **bold** for a heading and "- " bullets; use a table only for numbers. Give a recommendation when asked for a view. Currency is RM.`;

const IDLE_MS = 3 * 36e5;

function textFromContent(content) {
  if (typeof content === "string") return content;
  return (content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// A new session starts after 3 idle hours, after 4am on a new day, or once it gets long.
// The new session gets a short text recap of the old one (no thinking blocks carried over).
function ensureSession(now) {
  const d = db(), s = d.session;
  const newDay = s.startedAt && sod(new Date(s.startedAt)) < sod(now) && now.getHours() >= 4;
  if (s.startedAt && !newDay && now - s.lastAt < IDLE_MS && s.messages.length < 80) return false;
  const turns = s.messages.map((m) => ({ role: m.role, text: textFromContent(m.content).replace(/<context>[\s\S]*?<\/context>\s*/g, "").trim() }))
    .filter((t) => t.text).slice(-8);
  d.recap = turns.map((t) => `${t.role === "user" ? "Lye" : "Pal"}: ${t.text.slice(0, 400)}`);
  d.session = { messages: [], startedAt: now.getTime(), lastAt: now.getTime() };
  return true;
}

export function resetSession() {
  const d = db();
  d.session = { messages: [], startedAt: 0, lastAt: 0 };
  d.recap = [];
  save();
}

function contextBlock(now, fresh) {
  const d = db();
  const today = eventsBetween(d.agenda.events, sod(now), addDays(sod(now), 1));
  const prefs = Object.entries(d.meta.prefs || {}).map(([k, v]) => `- ${k}: ${v}`).join("\n");
  const feedAge = d.agenda.receivedAt ? `${Math.round((now - d.agenda.receivedAt) / 36e5)}h old` : "not set up yet";
  return `<context>
Now: ${now.toLocaleString("en-MY", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" })} (${hm(now)}, ${process.env.TZ})
Open reminders:
${openSummary(now) || "- none"}
Today's calendar (feed ${feedAge}):
${today.map(eventLine).join("\n") || "- nothing"}
${fresh && d.recap?.length ? `Earlier conversation (for continuity):\n${d.recap.join("\n")}\n` : ""}${fresh && prefs ? `Lye's saved preferences:\n${prefs}\n` : ""}</context>`;
}

/** Sends one user message through the agent; returns Pal's reply text. */
export async function chat(userText, { voice = false } = {}) {
  const now = new Date();
  const fresh = ensureSession(now);
  const d = db();
  const body = voice ? `[Voice note, transcribed]\n${userText}` : userText;
  d.session.messages.push({ role: "user", content: `${contextBlock(now, fresh)}\n\n${body}` });
  try {
    const out = await runAgent({ system: SYSTEM, messages: d.session.messages, tools: TOOLS, execute: executeTool, effort: "medium" });
    return out.text + (out.truncated ? "\n\n_(cut short; say \"continue\")_" : "");
  } finally {
    d.session.lastAt = Date.now();
    save();
  }
}
