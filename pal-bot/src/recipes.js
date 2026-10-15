// Proactive messages Pal pushes on a schedule. Each returns { text, buttons?, empty? };
// empty means "nothing worth saying", and the scheduler stays quiet.
import { config } from "./config.js";
import { db, upsert, save } from "./store.js";
import { askText } from "./claude.js";
import { inviteLine } from "./mail.js";
import {
  sod, addDays, weekStart, eventsBetween, eventLine, findClashes, isUnanswered, openTasks, isMine, isOverdue, taskLine, dueLabel,
  fmtDay, rm, sum, totals, inRange, findDuplicates, parseLocal, hm,
} from "./domain.js";

const sect = (title, body) => `**${title}**\n${body}`;
const name = () => config.ownerName;

async function polish(raw, instruction) {
  try {
    return await askText({
      system: `You are Pal, chief of staff to ${name()} (GM, Paint Marketing Company (M) Sdn Bhd, Nippon Paint Malaysia). Write Telegram messages: short, **bold** headings, "- " bullets, no tables, no preamble. Never invent facts that are not in the data.`,
      prompt: `${instruction}\nCurrent time: ${hm(new Date())}.\n\nDATA:\n${raw}`,
    });
  } catch (e) {
    console.warn("polish failed, sending raw:", e.message);
    return raw;
  }
}

function feedNote(now) {
  const at = db().agenda.receivedAt;
  if (!at) return "_No calendar feed yet. Set up the iPhone Shortcut (see the setup guide)._";
  const h = Math.round((now - at) / 36e5);
  return h > 26 ? `_Calendar feed is ${h}h old. Check the Shortcut automation on your iPhone._` : "";
}

export const RECIPES = [
  { id: "morning-brief", name: "Morning brief", sched: { freq: "daily", time: "07:30" }, on: true,
    async run(now) {
      const d = db(), a = sod(now), b = addDays(a, 1);
      const evs = eventsBetween(d.agenda.events, a, b), clashes = findClashes(evs);
      const mine = openTasks(d.tasks).filter((t) => isMine(t) && t.due && parseLocal(t.due) < b);
      const waiting = openTasks(d.tasks).filter((t) => !isMine(t) && isOverdue(t, now));
      const mail = d.mail.filter((m) => m.date > now - 18 * 36e5 && ["urgent", "today"].includes(m.urgency));
      const invites = d.mail.filter((m) => m.is_invite && m.date > now - 3 * 864e5 && parseLocal(m.invite_start) > now);
      const pending = eventsBetween(d.agenda.events, now, addDays(a, 8)).filter(isUnanswered);
      const raw = [
        `Good morning, ${name()}. ${fmtDay(now)}`, feedNote(now),
        sect("Calendar", evs.map(eventLine).join("\n") || "- Nothing scheduled"),
        clashes.length ? sect("Clashes", clashes.map(([x, y]) => `- ${x.title} overlaps ${y.title}`).join("\n")) : "",
        sect("Lotus Notes needing you", mail.map((m) => `- ${m.from}: ${m.subject} — ${m.summary}`).join("\n") || "- Nothing urgent overnight"),
        invites.length ? sect("Invites to answer", invites.map(inviteLine).join("\n")) : "",
        pending.length ? sect("Unanswered in your calendar", pending.map((e) => `${eventLine(e).replace("- ", "- " + fmtDay(new Date(e.start)) + " ")}`).join("\n")) : "",
        sect("Your reminders", mine.map((t) => taskLine(t, now)).join("\n") || "- None due"),
        waiting.length ? sect("Overdue from others", waiting.map((t) => taskLine(t, now)).join("\n")) : "",
      ].filter(Boolean).join("\n\n");
      return { text: await polish(raw, "Turn this into the morning brief. Open with one line on the shape of the day, then **Top 3 today** (numbered), then compact sections. Keep invites and clashes. Max 180 words.") };
    } },
  { id: "notes-digest", name: "Lotus Notes digest", sched: { freq: "weekdays", time: "12:30" }, on: true,
    async run() { return notesDigest(); } },
  { id: "notes-digest-pm", name: "Lotus Notes digest (5:30pm)", sched: { freq: "weekdays", time: "17:30" }, on: true,
    async run() { return notesDigest(); } },
  { id: "friendly-nag", name: "Friendly nag", sched: { freq: "daily", time: "09:00" }, on: true,
    async run(now) { return nag(now); } },
  { id: "friendly-nag-pm", name: "Friendly nag (3pm)", sched: { freq: "weekdays", time: "15:00" }, on: true,
    async run(now) { return nag(now); } },
  { id: "follow-up", name: "Follow-up chaser", sched: { freq: "weekdays", time: "10:00" }, on: true,
    async run(now) {
      const late = openTasks(db().tasks).filter((t) => !isMine(t) && isOverdue(t, now));
      if (!late.length) return { empty: true };
      const raw = late.map((t) => `- ${t.owner} owes: ${t.title} (due ${dueLabel(t.due, now)})${t.notes ? " · " + t.notes : ""}`).join("\n");
      return { text: await polish(raw, "**Follow-up chaser**: for each item, one line (owner – item – how late), then a short polite WhatsApp nudge Lye can copy, in quotes. Malaysian business tone; if the item is in Chinese or Malay, write the nudge in that language.") };
    } },
  { id: "evening-wrap", name: "Evening wrap", sched: { freq: "weekdays", time: "21:00" }, on: false,
    async run(now) {
      const d = db(), a = sod(now), c = addDays(a, 2);
      const done = d.tasks.filter((t) => (t.history || []).some((h) => h >= a.getTime()));
      const tmr = openTasks(d.tasks).filter((t) => t.due && parseLocal(t.due) < c);
      const evs = eventsBetween(d.agenda.events, addDays(a, 1), c);
      if (!done.length && !tmr.length && !evs.length) return { empty: true };
      return { text: ["**Evening wrap**", sect(`Done today (${done.length})`, done.map((t) => "- " + t.title).join("\n") || "- Nothing ticked off"),
        sect("Tomorrow's calendar", evs.map(eventLine).join("\n") || "- Clear"), sect("Due by tomorrow", tmr.map((t) => taskLine(t, now)).join("\n") || "- Nothing")].join("\n\n") };
    } },
  { id: "week-ahead", name: "Week ahead", sched: { freq: "weekly", dow: 1, time: "07:45" }, on: true,
    async run(now) {
      const a = sod(now), b = addDays(a, 7), evs = eventsBetween(db().agenda.events, a, b), byDay = {};
      for (const e of evs) (byDay[fmtDay(new Date(e.start))] = byDay[fmtDay(new Date(e.start))] || []).push(e);
      const clashes = findClashes(evs), due = openTasks(db().tasks).filter((t) => t.due && parseLocal(t.due) < b);
      return { text: ["**Week ahead**", feedNote(now), Object.entries(byDay).map(([k, v]) => `**${k}**\n${v.map(eventLine).join("\n")}`).join("\n\n") || "No meetings in the feed.",
        clashes.length ? sect("Clashes", clashes.map(([x, y]) => `- ${fmtDay(new Date(x.start))}: ${x.title} overlaps ${y.title}`).join("\n")) : "",
        due.length ? sect("Deadlines", due.map((t) => taskLine(t, now)).join("\n")) : ""].filter(Boolean).join("\n\n") };
    } },
  { id: "spending-recap", name: "Weekly spending recap", sched: { freq: "weekly", dow: 0, time: "20:00" }, on: true,
    async run(now) {
      const ws = weekStart(now), end = addDays(ws, 7), pws = addDays(ws, -7), ex = db().expenses;
      const tw = ex.filter((e) => inRange(e, ws, end)), lw = ex.filter((e) => inRange(e, pws, ws));
      if (!tw.length) return { empty: true };
      const a = totals(tw), b = totals(lw), cats = Object.keys({ ...a, ...b }).sort((x, y) => (a[y] || 0) - (a[x] || 0));
      const rows = cats.map((c) => `| ${c} | ${(a[c] || 0).toFixed(2)} | ${(b[c] || 0).toFixed(2)} |`);
      const dups = findDuplicates(ex, 7, now).map(([x, y]) => `- Possible double charge: ${x.merchant} ${rm(x.amount)} on ${x.date} and ${y.date}`);
      const jumps = cats.filter((c) => (a[c] || 0) > 50 && (a[c] || 0) > 1.5 * (b[c] || 0)).map((c) => `- ${c} up ${b[c] ? Math.round(((a[c] - b[c]) / b[c]) * 100) + "%" : "from zero"}`);
      return { text: [`**Weekly spending** · ${rm(sum(tw))} (last week ${rm(sum(lw))})`, "| Category | This wk | Last wk |\n|---|---|---|\n" + rows.join("\n"),
        jumps.length || dups.length ? sect("Worth a look", [...jumps, ...dups].join("\n")) : "Nothing unusual.",
        tw.some((e) => e.account === "business") ? `Business: ${rm(sum(tw.filter((e) => e.account === "business")))}` : ""].filter(Boolean).join("\n\n") };
    } },
  { id: "sunday-recap", name: "Sunday recap", sched: { freq: "weekly", dow: 0, time: "19:00" }, on: true,
    async run(now) {
      const d = db(), ws = weekStart(now).getTime();
      const done = d.tasks.filter((t) => (t.history || []).some((h) => h >= ws));
      const caps = d.captures.filter((c) => c.created >= ws), mail = d.mail.filter((m) => m.date >= ws);
      const raw = [`Week of ${fmtDay(new Date(ws))}`, sect(`Reminders done (${done.length})`, done.slice(0, 10).map((t) => "- " + t.title).join("\n") || "- none"),
        sect("Still overdue", openTasks(d.tasks).filter((t) => isOverdue(t, now)).map((t) => taskLine(t, now)).join("\n") || "- none"),
        sect("Meetings and calls captured", caps.map((c) => "- " + c.title).join("\n") || "- none"),
        `Lotus Notes mail: ${mail.length} (${mail.filter((m) => m.urgency === "urgent").length} urgent)`].join("\n\n");
      return { text: await polish(raw, "Write the **Sunday recap**: the week in 4-6 bullets, what's still open, then **One routine to try**: one small weekly habit based on the data, ending with 'Reply yes and I'll set it up.'") };
    } },
  { id: "feed-check", name: "Calendar feed check", sched: { freq: "daily", time: "09:15" }, on: true,
    async run(now) {
      const at = db().agenda.receivedAt;
      if (at && now - at < 26 * 36e5) return { empty: true };
      return { text: at ? `Your calendar feed hasn't arrived since ${fmtDay(new Date(at))}. On your iPhone: Shortcuts → Automation → check "Pal agenda" is on and set to Run Immediately.`
        : "I haven't received your calendar yet. Set up the \"Pal agenda\" Shortcut on your iPhone (setup guide, step 4) and I'll see your iPhone and Lotus calendars." };
    } },
];

async function notesDigest() {
  const d = db(), list = d.mail.filter((m) => !m.digested && !m.pushed && m.urgency !== "ignore");
  for (const m of d.mail) if (!m.digested && !m.pushed) m.digested = true;
  save();
  if (!list.length) return { empty: true };
  const today = list.filter((m) => m.urgency === "today" || m.urgency === "urgent"), fyi = list.filter((m) => m.urgency === "fyi");
  const invites = list.filter((m) => m.is_invite);
  return { text: [`**Lotus Notes** · ${list.length} new`,
    today.length ? sect("Act today", today.map((m) => `- **${m.from}**: ${m.subject}\n  ${m.summary}`).join("\n")) : "",
    invites.length ? sect("Invites", invites.map(inviteLine).join("\n")) : "",
    fyi.length ? sect("FYI", fyi.map((m) => `- ${m.from}: ${m.subject}`).join("\n")) : ""].filter(Boolean).join("\n\n") };
}

function nag(now) {
  const list = openTasks(db().tasks).filter((t) => isMine(t) && isOverdue(t, now)).slice(0, 6);
  if (!list.length) return { empty: true };
  const lines = list.map((t) => {
    const n = (t.nags || 0) + 1; upsert("tasks", { ...t, nags: n });
    const tone = n >= 5 ? "keeps slipping. Do it, move it or drop it?" : n >= 3 ? "is still open." : "is overdue.";
    return `- **${t.title}** ${tone} (due ${dueLabel(t.due, now)})`;
  });
  const buttons = list.map((t) => [{ text: `Done: ${t.title.slice(0, 24)}`, callback_data: `done:${t.id}` }, { text: "Tomorrow", callback_data: `tmr:${t.id}` }]);
  return { text: "**Friendly nag**\n" + lines.join("\n"), buttons };
}

export function recipeState(r) {
  const s = db().recipes[r.id] || {};
  return { on: s.on ?? r.on, lastRun: s.lastRun || 0 };
}
export function setRecipe(id, patch) {
  const d = db(); d.recipes[id] = { ...(d.recipes[id] || {}), ...patch }; save();
}
