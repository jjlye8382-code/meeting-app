// Claude calls: an agent loop for chat, and structured JSON calls for minutes and mail triage.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

const client = new Anthropic();

// fallbacks:"default" re-runs a safety-declined request on Anthropic's recommended fallback model.
// drop_block keeps a conversation going if a replayed thinking block no longer matches its history.
const CHAT_BETAS = ["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01"];
const JSON_BETAS = ["server-side-fallback-2026-07-01"];

const textOf = (content) => content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

function logTransforms(res) {
  const t = res.input_transformations;
  if (Array.isArray(t) && t.length) console.warn("input_transformations:", JSON.stringify(t));
}

/**
 * Runs the tool loop. `messages` is the live session history: this function only appends to it,
 * and on failure rolls back to where it was before the caller's user turn, so history stays valid.
 */
export async function runAgent({ system, messages, tools, execute, effort = "medium", maxIters = 10 }) {
  const rollbackTo = messages.length - 1;
  try {
    for (let i = 0; i < maxIters; i++) {
      const res = await client.beta.messages.create({
        model: config.model, max_tokens: 16000, betas: CHAT_BETAS, fallbacks: "default",
        thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } },
        output_config: { effort }, cache_control: { type: "ephemeral" },
        system, tools, messages,
      });
      logTransforms(res);
      if (res.stop_reason === "refusal") {
        messages.length = rollbackTo;
        return { text: "I can't help with that one.", refused: true };
      }
      messages.push({ role: "assistant", content: res.content });
      if (res.stop_reason === "pause_turn") continue;
      if (res.stop_reason !== "tool_use") return { text: textOf(res.content), truncated: res.stop_reason === "max_tokens" };

      const uses = res.content.filter((b) => b.type === "tool_use");
      const results = await Promise.all(uses.map(async (u) => {
        try {
          const out = await execute(u.name, u.input || {});
          return { type: "tool_result", tool_use_id: u.id, content: typeof out === "string" ? out : JSON.stringify(out) };
        } catch (e) {
          return { type: "tool_result", tool_use_id: u.id, content: "Error: " + e.message, is_error: true };
        }
      }));
      messages.push({ role: "user", content: results });
    }
    return { text: "That took too many steps. Try asking in a simpler way." };
  } catch (e) {
    messages.length = Math.max(0, rollbackTo);
    throw e;
  }
}

/** One structured call: returns parsed JSON matching `schema`. */
export async function askJSON({ system, prompt, schema, effort = "medium", images = [] }) {
  const content = [
    ...images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } })),
    { type: "text", text: prompt },
  ];
  const res = await client.beta.messages.create({
    model: config.model, max_tokens: 16000, betas: JSON_BETAS, fallbacks: "default",
    output_config: { effort, format: { type: "json_schema", schema } },
    system, messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal") throw new Error("Claude declined to process this content.");
  if (res.stop_reason === "max_tokens") throw new Error("The answer was too long. Send a shorter part.");
  return JSON.parse(textOf(res.content));
}

/** Plain one-shot text, used by recipes to turn raw data into a readable message. */
export async function askText({ system, prompt, effort = "low" }) {
  const res = await client.beta.messages.create({
    model: config.model, max_tokens: 8000, betas: JSON_BETAS, fallbacks: "default",
    output_config: { effort }, system, messages: [{ role: "user", content: prompt }],
  });
  if (res.stop_reason === "refusal") throw new Error("Claude declined this one.");
  return textOf(res.content);
}

export function claudeErrorText(e) {
  if (e instanceof Anthropic.AuthenticationError) return "My Claude API key was rejected. Check ANTHROPIC_API_KEY on the server.";
  if (e instanceof Anthropic.PermissionDeniedError) return "This Claude API key can't use that model. Check CLAUDE_MODEL or your Anthropic plan.";
  if (e instanceof Anthropic.RateLimitError) return "Claude is busy (rate limit). Try again in a minute.";
  if (e instanceof Anthropic.BadRequestError) return "Claude couldn't take that request: " + String(e.message).slice(0, 200);
  if (e instanceof Anthropic.APIConnectionError) return "I couldn't reach Claude. Check the server's internet connection.";
  if (e instanceof Anthropic.APIError) return `Claude had a problem (error ${e.status}). Try again shortly.`;
  return "Something went wrong: " + String(e?.message || e).slice(0, 200);
}
