// Turns a meeting, call debrief, long chat or forwarded thread into minutes, actions and a draft reply.
import { db, upsert, save } from "./store.js";
import { askJSON } from "./claude.js";
import { config } from "./config.js";
import { makeTask, normDue, dueLabel, newId, hm } from "./domain.js";

const str = { type: "string" }, arr = (items) => ({ type: "array", items });
const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["title", "languages", "people", "summary", "decisions", "actions", "open_questions", "reply", "quotes"],
  properties: {
    title: str, languages: arr(str), people: arr(str), summary: arr(str), decisions: arr(str), open_questions: arr(str),
    actions: arr({ type: "object", additionalProperties: false, required: ["task", "owner", "due", "mine"],
      properties: { task: str, owner: str, due: str, mine: { type: "boolean" } } }),
    reply: { type: "object", additionalProperties: false, required: ["language", "text"], properties: { language: str, text: str } },
    quotes: arr({ type: "object", additionalProperties: false, required: ["original", "english"], properties: { original: str, english: str } }),
  },
};

export const KINDS = {
  meeting: { label: "Meeting", hint: "This is a meeting transcript or notes, possibly with speaker labels. Make the summary read like minutes (topics discussed) and capture every decision and owner. Leave reply.text empty unless a follow-up message is clearly needed." },
  voice: { label: "Voice note", hint: "This is a long voice note: either Lye's own spoken debrief after a call or meeting ('I' means Lye), or a recording of the meeting itself. Work out which from the content." },
  whatsapp: { label: "WhatsApp", hint: "This is WhatsApp text (an export with 'date, time - Name: message' lines, or messages Lye copied). Focus on what was asked of Lye and what others committed to. Draft a reply Lye could send in the group." },
  thread: { label: "Thread", hint: "This is a pasted or forwarded thread (WhatsApp, Teams or email). Focus on what was asked of Lye. Draft a reply if one is needed." },
  photo: { label: "Photo", hint: "This is a photo Lye took: a whiteboard, slide, document or name card. Extract what matters. Leave reply.text empty." },
};

export async function processCapture({ kind, text, caption = "", images = [] }) {
  const k = KINDS[kind] || KINDS.thread;
  let body = String(text || "");
  let note = "";
  if (body.length > 400000) { body = body.slice(-400000); note = "It was very long, so I read the most recent part."; }
  const now = new Date();
  const result = await askJSON({
    schema: SCHEMA, effort: "medium", images,
    system: `You are Pal, chief of staff to ${config.ownerName} (Lye Jenq Jiang), GM of Paint Marketing Company (M) Sdn Bhd, the marketing and distribution arm of Nippon Paint Malaysia (retail and projects). Content may mix Malaysian English/Manglish, Malaysian Chinese (Mandarin, Cantonese or Hokkien phrasing) and Bahasa Melayu.`,
    prompt: `${k.hint}
Current time: ${now.toLocaleString("en-MY")} (${hm(now)}).
${caption ? `Lye's note: ${caption}\n` : ""}
Fill the JSON fields:
- title: max 8 words, English.
- languages: languages used (English, Chinese, Malay...).
- summary: 3-7 short English bullet strings.
- decisions: English; [] if none.
- actions: one per commitment. task in English, imperative. owner: "Lye" or the person's name, "?" if unclear. due: YYYY-MM-DD or YYYY-MM-DDTHH:MM resolved against the current time ("lusa", "minggu depan", "下礼拜", "明天" included), or "". mine: true only if Lye must do it.
- open_questions: English; [] if none.
- reply: language = the language the thread mostly uses; text = a short, natural reply Lye could send, in that language and Malaysian business tone; "" if no reply is needed.
- quotes: up to 4 important lines that were NOT in English, with an English translation; [] if none.
Never invent facts, names, amounts or dates.

CONTENT:
${body}`,
  });
  const cap = {
    id: newId(), created: now.getTime(), kind, title: String(result.title || "Untitled").slice(0, 80), note, added: { mine: false, others: false },
    result: {
      ...result,
      actions: (result.actions || []).filter((a) => a.task).map((a) => ({ ...a, due: normDue(a.due) })),
    },
  };
  upsert("captures", cap);
  return cap;
}

export function renderCapture(cap) {
  const r = cap.result, mine = r.actions.filter((a) => a.mine), others = r.actions.filter((a) => !a.mine);
  const list = (xs) => xs.map((x) => `- ${x}`).join("\n");
  const act = (a) => `- ${a.mine ? "" : (a.owner === "?" ? "Someone" : a.owner) + ": "}${a.task}${a.due ? " · " + dueLabel(a.due) : ""}`;
  const parts = [`**${cap.title}**\n_${(KINDS[cap.kind] || KINDS.thread).label}${r.languages.length ? " · " + r.languages.join(", ") : ""}_`];
  if (cap.note) parts.push(`_${cap.note}_`);
  if (r.summary.length) parts.push("**Summary**\n" + list(r.summary));
  if (r.decisions.length) parts.push("**Decisions**\n" + list(r.decisions));
  if (mine.length) parts.push("**Your actions**\n" + mine.map(act).join("\n"));
  if (others.length) parts.push("**Waiting on others**\n" + others.map(act).join("\n"));
  if (r.open_questions.length) parts.push("**Open questions**\n" + list(r.open_questions));
  if (r.quotes.length) parts.push("**Key lines**\n" + r.quotes.map((q) => `> ${q.original}\n_${q.english}_`).join("\n"));
  const buttons = [];
  const row = [];
  if (mine.length) row.push({ text: `Add my ${mine.length} action${mine.length > 1 ? "s" : ""}`, callback_data: `cap:${cap.id}:mine` });
  if (others.length) row.push({ text: `Track ${others.length} from others`, callback_data: `cap:${cap.id}:others` });
  if (row.length) buttons.push(row);
  return { text: parts.join("\n\n"), buttons: buttons.length ? buttons : undefined, reply: r.reply?.text ? r.reply : null };
}

export function addCaptureActions(capId, which) {
  const d = db(), cap = d.captures.find((c) => c.id === capId);
  if (!cap) return "That capture is gone.";
  if (cap.added?.[which]) return "Already added.";
  const list = cap.result.actions.filter((a) => (which === "mine" ? a.mine : !a.mine));
  for (const a of list) {
    upsert("tasks", makeTask({ title: a.task, due: a.due, owner: a.mine ? "" : (a.owner === "?" ? "Someone" : a.owner), notes: `From: ${cap.title}`, source: cap.id }));
  }
  cap.added = { ...(cap.added || {}), [which]: true };
  save();
  return `Added ${list.length} ${which === "mine" ? "to your reminders" : "to Waiting on others"}.`;
}

// WhatsApp "Export chat" text starts lines with a date stamp like "15/10/2026, 9:41 am - Name:" or "[15/10/26, 9:41:03 AM] Name:".
export const looksLikeWhatsApp = (s) => (String(s).match(/^\[?\d{1,2}\/\d{1,2}\/\d{2,4},? \d{1,2}:\d{2}/gm) || []).length >= 3;
