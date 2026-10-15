process.env.TZ = "Asia/Kuala_Lumpur";
process.env.DATA_DIR = process.env.DATA_DIR || "/tmp/pal-test-data";
import test, { mock } from "node:test";
import assert from "node:assert/strict";

const calls = [];
mock.module("../src/claude.js", { namedExports: {
  askJSON: async ({ prompt }) => { calls.push(prompt); return { items: [
    { index: 0, important: true, summary: "Ahmad wants approval for the Setia quote", ask: "Approve the Setia quote", due: "2026-10-16", suggested_reply: "Ok Ahmad, saya approve petang ni.", reply_language: "Malay" },
  ] }; },
  askText: async () => "**Dealer Northern**\n- Kansai cut prices 8%\n- → You: confirm counter-offer",
} });

const { waData, triageWhatsApp, whatsappDigest } = await import("../src/whatsapp.js");
const { ingest, normalize } = await import("../src/wa-logic.js");

test("triage flags what needs Lye once, digest summarises busy groups", async () => {
  const T0 = 1_792_000_000, now = (T0 + 1800) * 1000, wa = waData();
  ingest(wa, normalize({ key: { remoteJid: "6019@s.whatsapp.net", id: "m1" }, pushName: "Ahmad", messageTimestamp: T0, message: { conversation: "Boss, can approve Setia quote by tomorrow?" } }, []));
  for (let i = 0; i < 6; i++) ingest(wa, normalize({ key: { remoteJid: "g9@g.us", id: "g" + i, participant: "60" + i + "@s.whatsapp.net" }, pushName: "D" + i, messageTimestamp: T0 + i, message: { conversation: "Kansai price drop" } }, []), "Dealer Northern");
  const alerts = await triageWhatsApp(now);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].reply, "Ok Ahmad, saya approve petang ni.");
  assert.equal(alerts[0].due, "2026-10-16");
  assert.match(calls[0], /direct chat with Ahmad/);
  assert.equal((await triageWhatsApp(now)).length, 0, "not triaged twice");
  const d = await whatsappDigest(now);
  assert.match(d.text, /Waiting on you/); assert.match(d.text, /Ahmad/); assert.match(d.text, /Kansai cut prices/);
});
