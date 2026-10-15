process.env.TZ = "Asia/Kuala_Lumpur";
import test from "node:test";
import assert from "node:assert/strict";
import { normalize, ingest, unanswered, triageCandidates, digestGroups, emptyWa, extractText, search } from "../src/wa-logic.js";

const ME = ["60123456789@s.whatsapp.net", "111222333@lid"];
const T0 = 1_792_000_000;
const raw = (o) => ({ key: { remoteJid: o.chat, id: o.id, fromMe: !!o.fromMe, participant: o.participant }, pushName: o.name, messageTimestamp: o.t, message: o.message });

test("extracts text through wrappers and media", () => {
  assert.equal(extractText({ ephemeralMessage: { message: { extendedTextMessage: { text: "hi boss" } } } }), "hi boss");
  assert.equal(extractText({ audioMessage: { seconds: 12 } }), "[voice note 12s]");
  assert.equal(extractText({ reactionMessage: { text: "👍" } }), "");
});

test("detects mentions (incl. LID), replies to me and name hints", () => {
  const m1 = normalize(raw({ chat: "g1@g.us", id: "a", participant: "6019@s.whatsapp.net", name: "Ahmad", t: T0,
    message: { extendedTextMessage: { text: "@Lye pls confirm discount", contextInfo: { mentionedJid: ["111222333@lid"] } } } }), ME);
  assert.equal(m1.mentionsMe, true);
  const m2 = normalize(raw({ chat: "g1@g.us", id: "b", participant: "6019@s.whatsapp.net", name: "Ahmad", t: T0,
    message: { extendedTextMessage: { text: "ok", contextInfo: { participant: "60123456789:12@s.whatsapp.net", quotedMessage: { conversation: "send BQ" } } } } }), ME);
  assert.equal(m2.repliesToMe, true); assert.equal(m2.quoted, "send BQ");
  const m3 = normalize(raw({ chat: "g1@g.us", id: "c", participant: "6018@s.whatsapp.net", name: "Mei", t: T0, message: { conversation: "老板 明天开会吗?" } }), ME);
  assert.equal(m3.nameHit, true);
  assert.equal(normalize(raw({ chat: "status@broadcast", id: "s", t: T0, message: { conversation: "x" } }), ME), null);
});

test("unanswered and triage respect Lye's own replies and the hold", () => {
  const wa = emptyWa(), now = (T0 + 3600) * 1000;
  ingest(wa, normalize(raw({ chat: "6019@s.whatsapp.net", id: "d1", name: "Ahmad", t: T0, message: { conversation: "Boss, approve the Setia quote?" } }), ME));
  ingest(wa, normalize(raw({ chat: "6017@s.whatsapp.net", id: "d2", name: "Tan", t: T0, message: { conversation: "Lunch tmr?" } }), ME));
  ingest(wa, normalize(raw({ chat: "6017@s.whatsapp.net", id: "d3", fromMe: true, t: T0 + 60, message: { conversation: "ok" } }), ME));
  ingest(wa, normalize(raw({ chat: "g1@g.us", id: "g1", participant: "6016@s.whatsapp.net", name: "Siti", t: T0, message: { conversation: "general chatter" } }), ME));
  const u = unanswered(wa, now);
  assert.deepEqual(u.map((x) => x.name), ["Ahmad"]);
  const c = triageCandidates(wa, now);
  assert.equal(c.length, 1); assert.equal(c[0].msg.id, "d1");
  assert.equal(triageCandidates(wa, (T0 + 120) * 1000, 10 * 6e4).length, 0, "held for 10 minutes");
});

test("digest picks busy groups; search finds text", () => {
  const wa = emptyWa();
  for (let i = 0; i < 6; i++) ingest(wa, normalize(raw({ chat: "g2@g.us", id: "x" + i, participant: "60" + i + "@s.whatsapp.net", name: "P" + i, t: T0 + i, message: { conversation: "Kansai price drop " + i } }), ME), "Dealer Northern");
  ingest(wa, normalize(raw({ chat: "g3@g.us", id: "y", participant: "601@s.whatsapp.net", name: "Q", t: T0, message: { conversation: "quiet" } }), ME), "Quiet group");
  const d = digestGroups(wa, 0);
  assert.deepEqual(d.map((g) => g.name), ["Dealer Northern"]);
  assert.equal(search(wa, { query: "kansai" }, (T0 + 100) * 1000).length, 6);
});
