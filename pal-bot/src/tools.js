// Tools Claude can call during chat. Definitions stay fixed for the life of the process
// (a changing tool list would invalidate the conversation's cache and thinking).
import { db, upsert, remove, save } from "./store.js";
import { waData, waState } from "./whatsapp.js";
import { search as waSearch, unanswered } from "./wa-logic.js";
import {
  makeTask, completeTask, normDue, openTasks, makeExpense, CATS, sum, totals, inRange, findDuplicates,
  sod, addDays, parseLocal, eventsBetween, hm, ymd,
} from "./domain.js";

const obj = (properties, required = []) => ({ type: "object", properties, required });
const REPEAT = { type: "string", enum: ["none", "daily", "weekly", "monthly"] };

export const TOOLS = [
  { name: "add_reminder", description: "Create a reminder for Lye, or a 'waiting on' item when someone else owes something (set owner). Returns the saved item with its id.",
    input_schema: obj({ title: { type: "string" }, due: { type: "string", description: "Local YYYY-MM-DDTHH:MM, or YYYY-MM-DD, or empty" }, repeat: REPEAT,
      owner: { type: "string", description: "Empty = Lye. A person's name = Lye is waiting on them." }, notes: { type: "string" } }, ["title"]) },
  { name: "list_reminders", description: "List reminders. Returns id, title, due, repeat, owner, done.", input_schema: obj({ include_done: { type: "boolean" } }) },
  { name: "complete_reminder", description: "Mark a reminder done. Repeating ones roll to the next date.", input_schema: obj({ id: { type: "string" } }, ["id"]) },
  { name: "update_reminder", description: "Change a reminder's title, due, repeat, owner or notes.",
    input_schema: obj({ id: { type: "string" }, title: { type: "string" }, due: { type: "string" }, repeat: REPEAT, owner: { type: "string" }, notes: { type: "string" } }, ["id"]) },
  { name: "delete_reminder", description: "Delete a reminder for good.", input_schema: obj({ id: { type: "string" } }, ["id"]) },
  { name: "log_expense", description: "Record money Lye spent, in RM. Returns the saved expense.",
    input_schema: obj({ amount: { type: "number" }, merchant: { type: "string" }, category: { type: "string", enum: CATS }, account: { type: "string", enum: ["personal", "business"] },
      date: { type: "string", description: "YYYY-MM-DD, default today" }, note: { type: "string" } }, ["amount", "merchant"]) },
  { name: "spending_summary", description: "Totals by category for the last N days (default 7) and the N days before, business total, and possible double charges.", input_schema: obj({ days: { type: "number" } }) },
  { name: "list_expenses", description: "List expenses from the last N days (default 14), newest first, max 80.", input_schema: obj({ days: { type: "number" }, category: { type: "string" } }) },
  { name: "delete_expense", description: "Delete an expense by id.", input_schema: obj({ id: { type: "string" } }, ["id"]) },
  { name: "get_calendar", description: "Read Lye's calendar (iPhone Calendar incl. Lotus Notes, synced each morning by an iPhone Shortcut) between two local dates. Returns events and when the feed last arrived.",
    input_schema: obj({ from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD, exclusive" } }, ["from", "to"]) },
  { name: "search_notes_mail", description: "Search Lotus Notes emails Lye forwarded to Pal (sender, subject, summary, urgency, actions). Empty query = most recent.",
    input_schema: obj({ query: { type: "string" }, days: { type: "number" } }) },
  { name: "search_captures", description: "Search past meeting minutes, call debriefs and chat summaries Pal made. Returns title, date, summary, decisions and actions.",
    input_schema: obj({ query: { type: "string" } }) },
  { name: "search_whatsapp", description: "Search Lye's WhatsApp messages (read-only link, last 7 days). Filter by text and/or chat/group name. Returns chat, sender, time, text.",
    input_schema: obj({ query: { type: "string" }, chat: { type: "string", description: "Part of a contact or group name" }, days: { type: "number" } }) },
  { name: "whatsapp_waiting", description: "WhatsApp chats where someone is waiting on Lye's reply (unanswered DMs and group messages aimed at him).", input_schema: obj({}) },
  { name: "set_preference", description: "Remember a lasting preference or fact Lye tells you (e.g. 'my EA is Mei Ling', 'brief me at 7am'). Use sparingly.",
    input_schema: obj({ key: { type: "string" }, value: { type: "string" } }, ["key", "value"]) },
];

const findTask = (id) => { const t = db().tasks.find((x) => x.id === String(id)); if (!t) throw new Error(`No reminder with id ${id}. Call list_reminders.`); return t; };
const match = (q, ...fields) => !q || fields.join(" ").toLowerCase().includes(String(q).toLowerCase());

export async function executeTool(name, i) {
  const d = db();
  switch (name) {
    case "add_reminder": {
      const t = upsert("tasks", makeTask(i));
      return { id: t.id, title: t.title, due: t.due, repeat: t.repeat, owner: t.owner };
    }
    case "list_reminders":
      return d.tasks.filter((t) => i.include_done || !t.done).map(({ id, title, due, repeat, owner, done }) => ({ id, title, due, repeat, owner, done }));
    case "complete_reminder": { const t = findTask(i.id); upsert("tasks", completeTask(t)); return "Done: " + t.title; }
    case "update_reminder": {
      const t = structuredClone(findTask(i.id));
      if (i.title) t.title = String(i.title);
      if (i.due !== undefined) { t.due = normDue(i.due); t.pinged = ""; }
      if (i.repeat) t.repeat = i.repeat;
      if (i.owner !== undefined) t.owner = String(i.owner);
      if (i.notes !== undefined) t.notes = String(i.notes);
      t.nags = 0;
      return upsert("tasks", t);
    }
    case "delete_reminder": { const t = findTask(i.id); remove("tasks", t.id); return "Deleted: " + t.title; }
    case "log_expense": return upsert("expenses", makeExpense(i));
    case "spending_summary": {
      const n = Math.min(Math.max(Number(i.days) || 7, 1), 366), b = addDays(sod(new Date()), 1), a = addDays(b, -n), p = addDays(a, -n);
      const cur = d.expenses.filter((e) => inRange(e, a, b)), prev = d.expenses.filter((e) => inRange(e, p, a));
      return { days: n, total: sum(cur), previous_total: sum(prev), by_category: totals(cur), previous_by_category: totals(prev),
        business_total: sum(cur.filter((e) => e.account === "business")),
        possible_double_charges: findDuplicates(d.expenses, n).map(([x, y]) => ({ merchant: x.merchant, amount: x.amount, dates: [x.date, y.date] })) };
    }
    case "list_expenses": {
      const a = addDays(sod(new Date()), -(Number(i.days) || 14));
      return d.expenses.filter((e) => parseLocal(e.date) >= a && (!i.category || e.category === i.category)).sort((x, y) => y.date.localeCompare(x.date)).slice(0, 80);
    }
    case "delete_expense": {
      if (!d.expenses.some((e) => e.id === String(i.id))) throw new Error("No expense with that id");
      remove("expenses", String(i.id)); return "Deleted";
    }
    case "get_calendar": {
      const a = parseLocal(i.from) || sod(new Date()), b = parseLocal(i.to) || addDays(a, 1);
      const evs = eventsBetween(d.agenda.events, a, b).map((e) => ({ title: e.title, start: hm(new Date(e.start)), end: hm(new Date(e.end)), all_day: e.allDay, location: e.location, calendar: e.calendar }));
      const age = d.agenda.receivedAt ? Math.round((Date.now() - d.agenda.receivedAt) / 36e5) : null;
      return { events: evs, feed_received_hours_ago: age, note: age === null ? "No calendar feed received yet. The iPhone Shortcut may not be set up." : age > 26 ? "Feed is stale; events may have changed." : "" };
    }
    case "search_notes_mail": {
      const since = Date.now() - (Number(i.days) || 14) * 864e5;
      return d.mail.filter((m) => m.date >= since && match(i.query, m.from, m.subject, m.summary, m.text?.slice(0, 2000))).slice(-25).reverse()
        .map((m) => ({ from: m.from, subject: m.subject, date: hm(new Date(m.date)), summary: m.summary, urgency: m.urgency, actions: m.actions, invite: m.is_invite ? { title: m.invite_title, start: m.invite_start, end: m.invite_end } : undefined }));
    }
    case "search_captures":
      return d.captures.filter((c) => match(i.query, c.title, c.result.summary.join(" "), c.result.decisions.join(" "), c.result.actions.map((a) => a.task + " " + a.owner).join(" "))).slice(-10).reverse()
        .map((c) => ({ title: c.title, date: ymd(new Date(c.created)), kind: c.kind, summary: c.result.summary, decisions: c.result.decisions, actions: c.result.actions }));
    case "search_whatsapp":
      if (waState() !== "connected" && !Object.keys(waData().chats).length) return "WhatsApp isn't linked. Lye can link it with /whatsapp link <number>.";
      return waSearch(waData(), { query: i.query, chat: i.chat, days: Number(i.days) || 7 });
    case "whatsapp_waiting":
      return unanswered(waData()).slice(0, 20).map((w) => ({ chat: w.name, group: w.isGroup, waiting_since: hm(new Date(w.since)), messages: w.count, last: w.last.text.slice(0, 300) }));
    case "set_preference": {
      d.meta.prefs = { ...(d.meta.prefs || {}), [String(i.key).slice(0, 60)]: String(i.value).slice(0, 300) };
      save(); return "Saved";
    }
    default: throw new Error("Unknown tool " + name);
  }
}

export function openSummary(now = new Date()) {
  const ot = openTasks(db().tasks);
  return ot.slice(0, 15).map((t) => `- [${t.id}] ${t.title}${t.due ? " | due " + t.due : ""}${t.repeat !== "none" ? " | " + t.repeat : ""}${t.owner ? " | owner " + t.owner : ""}`).join("\n") +
    (ot.length > 15 ? `\n(+${ot.length - 15} more; call list_reminders)` : "");
}
