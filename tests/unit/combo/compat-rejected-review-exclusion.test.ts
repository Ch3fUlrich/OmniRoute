import test from "node:test";
import assert from "node:assert/strict";
import { computeCompatRejectedTargets } from "../../../open-sse/services/combo/comboStructure.ts";

// The #6238 last-resort tier probes targets the compat pre-filter dropped. A target dropped by the
// hard cross-family review exclusion must never come back through that tier.
const target = (provider: string, modelStr: string) =>
  ({ provider, providerId: provider, modelStr, connectionId: null }) as never;

const claude = target("claude", "claude-opus-5-5");
const gpt = target("openai", "gpt-6.1-sol");

test("review request: envelope-excluded author family is not a compat-rejected fallback", () => {
  const body = {
    messages: [{ role: "user", content: "review this" }],
    _omnirouteEnvelope: { taskRole: "review", authorModel: "claude-opus-5-5" },
  };
  const rejected = computeCompatRejectedTargets([claude, gpt], [], body) as Array<{
    modelStr: string;
  }>;
  assert.deepEqual(
    rejected.map((t) => t.modelStr),
    ["gpt-6.1-sol"]
  );
});

test("non-review request: compat-rejected tier is unchanged by an envelope", () => {
  const body = {
    messages: [{ role: "user", content: "write this" }],
    _omnirouteEnvelope: { taskRole: "implement", authorModel: "claude-opus-5-5" },
  };
  const rejected = computeCompatRejectedTargets([claude, gpt], [], body) as Array<{
    modelStr: string;
  }>;
  assert.equal(rejected.length, 2);
});
