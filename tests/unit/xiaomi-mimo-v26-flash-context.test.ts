import { after, test } from "node:test";
import assert from "node:assert/strict";

import { resetDbInstance } from "../../src/lib/db/core.ts";
import { getModelContextLimit } from "../../src/lib/modelCapabilities.ts";

after(() => resetDbInstance());

for (const provider of ["xiaomi-mimo", "mimo"]) {
  test(`${provider} resolves mimo-v2.6-flash to its 1M context window`, () => {
    assert.equal(getModelContextLimit(provider, "mimo-v2.6-flash"), 1048576);
  });
}
