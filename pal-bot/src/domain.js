// Pure helpers: dates, reminders, money. No I/O, so they are unit-tested.

export const pad = (n) => String(n).padStart(2, "0");
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = (d) => `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const sod = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const weekStart = (d) => addDays(sod(d), -((d.getDay() + 6) % 7));
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export function parseLocal(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) { const d = new Date(s); return isNaN(d) ? null : d; }
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
}
export const hasTime = (due) => /T\d{2}:\d{2}/.test(String(due || ""));
export function normDue(v) {
  if (!v) return "";
  const d = parseLocal(v); if (!d) return "";
  return /T\d{2}:\d{2}|\s\d{2}:\d{2}/.test(String(v)) ? hm(d) : ymd(d);
}

export const fmtTime = (d) => d.toLocaleTimeString("en-MY", { hour: "numeric", minute: "2-digit" });
export const fmtDay = (d) => d.toLocaleDateString("en-MY", { weekday: "short", day: "numeric", month: "short" });
export function dueLabel(due, now = new Date()) {
  const d = parseLocal(due); if (!d) return "";
  const diff = Math.round((sod(d) - sod(now)) / 864e5);
  const t = hasTime(due) ? " " + fmtTime(d) : "";
  if (diff === 0) return "today" + t;
  if (diff === 1) return "tomorrow" + t;
  if (diff === -1) return "yesterday" + t;
  return fmtDay(d) + t;
}
export const rm = (n) => "RM " + Number(n || 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ---------- reminders ---------- */
export const isMine = (t) => !t.owner || /^(me|lye|myself|i)$/i.test(String(t.owner).trim());
export const openTasks = (tasks) => tasks.filter((t) => !t.done);
export function isOverdue(t, now = new Date()) {
  if (!t.due || t.done) return false;
  return parseLocal(t.due) < (hasTime(t.due) ? now : sod(now));
}
export function makeTask(i) {
  const repeat = ["daily", "weekly", "monthly"].includes(i.repeat) ? i.repeat : "none";
  return {
    id: newId(), title: String(i.title || "").trim().slice(0, 300), due: normDue(i.due), repeat,
    notes: String(i.notes || "").slice(0, 1000), owner: String(i.owner || "").trim().slice(0, 60),
    source: i.source || "", done: false, created: Date.now(), nags: 0, history: [], pinged: "",
  };
}
// Done on a repeating reminder rolls it to the next future date instead of closing it.
export function completeTask(t, now = new Date()) {
  const x = structuredClone(t);
  x.history = [...(x.history || []), now.getTime()].slice(-30);
  x.nags = 0; x.pinged = "";
  if (x.repeat !== "none" && x.due) {
    let d = parseLocal(x.due);
    const step = { daily: 1, weekly: 7 }[x.repeat];
    do { if (step) d = addDays(d, step); else d.setMonth(d.getMonth() + 1); } while (d <= now);
    x.due = hasTime(x.due) ? hm(d) : ymd(d);
  } else { x.done = true; x.doneAt = now.getTime(); }
  return x;
}
export function snoozeTask(t, minutes, now = new Date()) {
  const x = structuredClone(t);
  x.due = hm(new Date(now.getTime() + minutes * 6e4)); x.pinged = "";
  return x;
}
export function taskLine(t, now = new Date()) {
  return `- ${t.title}${t.due ? " · " + dueLabel(t.due, now) : ""}${!isMine(t) ? " · " + t.owner : ""}`;
}

/* ---------- money ---------- */
export const CATS = ["Food & drink", "Groceries", "Transport & fuel", "Bills & utilities", "Shopping", "Health", "Family", "Entertainment", "Travel", "Business", "Other"];
const CAT_RULES = [
  [/grab|gojek|maxim|touch ?n ?go|tng|toll|plus |petronas|shell|petron|caltex|bhpetrol|parking|mrt|lrt|ktm|rapid/i, "Transport & fuel"],
  [/aeon|lotus|tesco|mydin|jaya grocer|village grocer|giant|econsave|nsk|99 speedmart|family ?mart|7-?eleven|cold storage/i, "Groceries"],
  [/tnb|tenaga|unifi|tm net|maxis|celcom|digi|u mobile|air selangor|syabas|indah water|astro|cukai|assessment|time internet/i, "Bills & utilities"],
  [/starbucks|zus|tealive|mcd|mcdonald|kfc|kopitiam|old town|secret recipe|domino|pizza|foodpanda|grabfood|restoran|restaurant|cafe|nasi|mamak|dim sum|sushi|chagee|lunch|dinner|breakfast|makan/i, "Food & drink"],
  [/shopee|lazada|uniqlo|ikea|mr ?diy|zalora|amazon|taobao|apple store|machines|courts|harvey norman/i, "Shopping"],
  [/guardian|watsons|caring|klinik|clinic|hospital|pharmacy|farmasi|dental|gym/i, "Health"],
  [/netflix|spotify|disney|youtube|apple\.com|icloud|gsc|tgv|mbo/i, "Entertainment"],
  [/airasia|malaysia airlines|batik|firefly|agoda|booking\.com|hotel|airbnb|trip\.com/i, "Travel"],
  [/school|tuition|tadika|toys|baby/i, "Family"],
];
export const guessCat = (m) => (CAT_RULES.find(([re]) => re.test(m || "")) || [0, "Other"])[1];
export const normMerchant = (m) => String(m || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(sdn|bhd|berhad|my|kl|com)\b/g, "").trim().split(" ").slice(0, 2).join(" ");
export const sum = (list) => list.reduce((a, e) => a + Number(e.amount || 0), 0);
export function totals(list) { const t = {}; for (const e of list) t[e.category || "Other"] = (t[e.category || "Other"] || 0) + Number(e.amount || 0); return t; }
export const inRange = (e, a, b) => { const d = parseLocal(e.date); return d && d >= a && d < b; };
export function findDuplicates(expenses, days = 14, now = new Date()) {
  const since = addDays(sod(now), -days), list = expenses.filter((e) => parseLocal(e.date) >= since && !e.dupOk);
  const pairs = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (Math.abs(a.amount - b.amount) < 0.005 && normMerchant(a.merchant) === normMerchant(b.merchant) &&
        Math.abs(parseLocal(a.date) - parseLocal(b.date)) <= 3 * 864e5) pairs.push([a, b]);
  }
  return pairs;
}
export function makeExpense(i, now = new Date()) {
  const amount = Math.abs(Number(String(i.amount ?? "").replace(/[^0-9.]/g, "")));
  if (!amount) throw new Error("Amount must be a number above 0");
  return {
    id: newId(), amount: Math.round(amount * 100) / 100, merchant: String(i.merchant || "Unknown").slice(0, 80),
    category: CATS.includes(i.category) ? i.category : guessCat(i.merchant), account: i.account === "business" ? "business" : "personal",
    date: normDue(i.date) ? normDue(i.date).slice(0, 10) : ymd(now), note: String(i.note || "").slice(0, 200), created: now.getTime(),
  };
}

/* ---------- calendar feed from the iPhone Shortcut ---------- */
// One event per line: start|end|title|location|calendar|allDay. Dates may be ISO 8601
// ("2026-10-16T09:30:00+08:00") or Shortcuts' default ("16 Oct 2026 at 9:30 AM").
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export function parseShortcutDate(s) {
  s = String(s || "").trim().replace(/ | /g, " ");
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? new Date(s) : parseLocal(s);
    return d && !isNaN(d) ? d : null;
  }
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})(?:,?\s*(?:at\s*)?(\d{1,2}):(\d{2})\s*([AaPp][Mm])?)?/);
  if (m && MON[m[2].toLowerCase()] !== undefined) {
    let h = +(m[4] || 0); const ap = (m[6] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
    return new Date(+m[3], MON[m[2].toLowerCase()], +m[1], h, +(m[5] || 0));
  }
  m = s.match(/^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})(?:,?\s*(?:at\s*)?(\d{1,2}):(\d{2})\s*([AaPp][Mm])?)?/);
  if (m && MON[m[1].toLowerCase()] !== undefined) {
    let h = +(m[4] || 0); const ap = (m[6] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0;
    return new Date(+m[3], MON[m[1].toLowerCase()], +m[2], h, +(m[5] || 0));
  }
  const d = new Date(s); return isNaN(d) ? null : d;
}
export function parseAgenda(text) {
  const events = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim(); if (!line || !line.includes("|")) continue;
    const [s, e, title, location = "", calendar = "", allDay = "", status = ""] = line.split("|").map((x) => x.trim());
    const start = parseShortcutDate(s); if (!start) continue;
    const end = parseShortcutDate(e) || new Date(start.getTime() + 36e5);
    events.push({ start: start.toISOString(), end: end.toISOString(), title: title || "(no title)", location, calendar, allDay: /^(yes|true|1)$/i.test(allDay), status });
  }
  const seen = new Set();
  return events.filter((ev) => { const k = ev.start + ev.title; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a.start.localeCompare(b.start));
}
export function eventsBetween(events, a, b) {
  return (events || []).filter((e) => { const s = new Date(e.start), en = new Date(e.end); return s < b && en > a; });
}
// "My Status" from the Shortcut: invites you haven't answered show as Pending / Needs Action / Tentative.
export const isUnanswered = (e) => /pending|needs|tentative|unknown/i.test(e.status || "") && !/accepted|confirmed/i.test(e.status || "");
export function findClashes(events) {
  const timed = (events || []).filter((e) => !e.allDay).sort((a, b) => a.start.localeCompare(b.start)), out = [];
  for (let i = 1; i < timed.length; i++) if (timed[i].start < timed[i - 1].end) out.push([timed[i - 1], timed[i]]);
  return out;
}
export function eventLine(e) {
  const s = new Date(e.start);
  return `- ${e.allDay ? "All day" : fmtTime(s)} · ${e.title}${e.location ? " (" + e.location + ")" : ""}`;
}

/* ---------- recipe schedule ---------- */
export function lastOccurrence(s, now = new Date()) {
  if (!s || s.freq === "manual" || !s.time) return null;
  const [h, m] = s.time.split(":").map(Number);
  const d = new Date(now); d.setHours(h, m, 0, 0);
  if (s.freq === "daily") { if (d > now) d.setDate(d.getDate() - 1); }
  else if (s.freq === "weekdays") { while (d > now || d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1); }
  else if (s.freq === "weekly") { d.setDate(d.getDate() - ((d.getDay() - (s.dow ?? 0) + 7) % 7)); if (d > now) d.setDate(d.getDate() - 7); }
  return d;
}
// Due when its latest slot has passed, it hasn't run since, and the slot isn't stale (bot was down for hours).
export function isRecipeDue(sched, lastRun, now = new Date(), graceMs = 2 * 36e5) {
  const occ = lastOccurrence(sched, now);
  return !!occ && (lastRun || 0) < occ.getTime() && now - occ < graceMs;
}
