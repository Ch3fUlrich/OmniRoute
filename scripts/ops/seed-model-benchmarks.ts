/** Explicitly seed default benchmarks: npx tsx scripts/ops/seed-model-benchmarks.ts */
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core";
import { seedDefaultModelBenchmarks } from "../../src/lib/db/modelBenchmarks";

try {
  const count = seedDefaultModelBenchmarks(getDbInstance());
  console.log(`seeded ${count} rows`);
} finally {
  resetDbInstance();
}
