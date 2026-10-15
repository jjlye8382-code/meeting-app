process.env.TZ = "Asia/Kuala_Lumpur";
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAgenda, parseShortcutDate, isUnanswered, completeTask, makeTask, isRecipeDue, findDuplicates, makeExpense, findClashes, isOverdue, normDue,
} from "../src/domain.js";
import { toTelegramHTML, splitMessage } from "../src/format.js";
import { looksLikeWhatsApp } from "../src/capture.js";
import { subtitlesToText } from "../src/transcribe.js";

test("parses Shortcut dates in ISO and default formats", () => {
  assert.equal(parseShortcutDate("2026-10-16T09:30:00+08:00").getHours(), 9);
  const d = parseShortcutDate("16 Oct 2026 at 3:15 PM");
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()], [2026, 9, 16, 15, 15]);
  assert.equal(parseShortcutDate("Oct 16, 2026 at 12:05 AM").getHours(), 0);
});

test("parses the agenda email, dedupes and sorts", () => {
  const evs = parseAgenda(`header line
2026-10-16T14:00:00+08:00|2026-10-16T15:00:00+08:00|Dealer review|HQ Shah Alam|Lotus Notes|No
2026-10-16T09:00:00+08:00|2026-10-16T10:00:00+08:00|Pipeline call||Calendar|No
2026-10-16T09:00:00+08:00|2026-10-16T10:00:00+08:00|Pipeline call||Calendar|No
16 Oct 2026|17 Oct 2026|Deepavali||Holidays|Yes`);
  assert.equal(evs.length, 3);
  assert.equal(evs[1].title, "Pipeline call");
  assert.equal(evs.find((e) => e.title === "Deepavali").allDay, true);
});

test("flags calendar clashes", () => {
  const evs = parseAgenda(`2026-10-16T09:00:00+08:00|2026-10-16T10:00:00+08:00|A||c|No
2026-10-16T09:30:00+08:00|2026-10-16T10:30:00+08:00|B||c|No`);
  assert.equal(findClashes(evs).length, 1);
});

test("repeating reminder rolls forward; one-off closes", () => {
  const now = new Date(2026, 9, 15, 10, 0);
  const w = completeTask({ ...makeTask({ title: "Pipeline review", due: "2026-10-12T08:00", repeat: "weekly" }) }, now);
  assert.equal(w.due, "2026-10-19T08:00"); assert.equal(w.done, false);
  const o = completeTask(makeTask({ title: "Call Ahmad" }), now);
  assert.equal(o.done, true);
});

test("overdue respects date-only vs timed", () => {
  const now = new Date(2026, 9, 15, 10, 0);
  assert.equal(isOverdue({ due: "2026-10-15" }, now), false);
  assert.equal(isOverdue({ due: "2026-10-15T09:00" }, now), true);
  assert.equal(normDue("2026-10-16 15:00"), "2026-10-16T15:00");
});

test("recipe due window", () => {
  const sched = { freq: "daily", time: "07:30" };
  assert.equal(isRecipeDue(sched, 0, new Date(2026, 9, 15, 7, 31)), true);
  assert.equal(isRecipeDue(sched, new Date(2026, 9, 15, 7, 31).getTime(), new Date(2026, 9, 15, 8, 0)), false);
  assert.equal(isRecipeDue(sched, 0, new Date(2026, 9, 15, 12, 0)), false, "stale slot is skipped");
  assert.equal(isRecipeDue({ freq: "weekdays", time: "12:30" }, 0, new Date(2026, 9, 17, 12, 40)), false, "Saturday skipped");
});

test("expenses: category guess and double-charge detection", () => {
  const now = new Date(2026, 9, 15);
  const a = makeExpense({ amount: "RM 18.40", merchant: "GRAB*RIDE", date: "2026-10-14" }, now);
  const b = makeExpense({ amount: 18.4, merchant: "Grab ride", date: "2026-10-15" }, now);
  assert.equal(a.category, "Transport & fuel");
  assert.equal(findDuplicates([a, b], 14, now).length, 1);
  assert.throws(() => makeExpense({ amount: "abc", merchant: "x" }));
});

test("Telegram formatting and splitting", () => {
  const html = toTelegramHTML("**Top 3**\n- a < b\n| A | B |\n|---|---|\n| 1 | 2 |");
  assert.match(html, /<b>Top 3<\/b>/); assert.match(html, /• a &lt; b/); assert.match(html, /<pre>A  B\n1  2<\/pre>/);
  assert.ok(splitMessage("x\n".repeat(5000)).every((p) => p.length <= 3500));
});

test("detects WhatsApp exports and cleans VTT", () => {
  assert.equal(looksLikeWhatsApp("15/10/2026, 9:41 am - Ahmad: ok\n15/10/2026, 9:42 am - Lye: noted\n[15/10/26, 9:43:01 AM] Mei: 好的"), true);
  assert.equal(subtitlesToText("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nAhmad: boleh lah\n"), "Ahmad: boleh lah");
});

test("reads My Status to find unanswered invites", () => {
  const [e] = parseAgenda("2026-10-20T10:00:00+08:00|2026-10-20T11:00:00+08:00|Kansai benchmark review|Rm 3|Lotus Notes|No|Pending");
  assert.equal(isUnanswered(e), true);
  assert.equal(isUnanswered({ status: "Accepted" }), false);
});
