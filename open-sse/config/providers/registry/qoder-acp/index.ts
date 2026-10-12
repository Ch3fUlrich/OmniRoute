import type { RegistryEntry } from "../../shared.ts";

/**
 * Qoder CLI driven over the Agent Client Protocol (`qodercli --acp`). The agent runs
 * locally as a subprocess; authentication stays in the user's Qoder login, or in an
 * optional Personal Access Token that is handed to the agent through its environment.
 * Model ids are the ones the agent itself offers in `session/new`.
 */
export const qoderAcpProvider: RegistryEntry = {
  id: "qoder-acp",
  alias: "qoacp",
  format: "openai",
  executor: "qoder-acp",
  baseUrl: "acp://qoder/stdio",
  authType: "none",
  authHeader: "none",
  models: [
    { id: "efficient", name: "Qoder Efficient" },
    { id: "qfmodel", name: "Qwen3.8-Flash (Qoder)", supportsReasoning: true },
  ],
};
