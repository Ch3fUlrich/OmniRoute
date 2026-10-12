/**
 * Agents that the generic ACP executor can drive. Each entry is the command line
 * that starts the agent as an Agent Client Protocol server on stdio, plus the few
 * agent-specific hints the executor needs. Adding an agent is one entry here and a
 * provider registry entry that names it.
 */
export interface AcpAgentSpec {
  id: string;
  displayName: string;
  /** Default binary; the environment variable in `binEnv` overrides it. */
  command: string;
  /** Arguments that switch the binary into ACP server mode. */
  args: string[];
  /** Environment variable that overrides `command` (absolute path or alternative name). */
  binEnv: string;
  /**
   * Environment variable the agent reads its access token from. When the connection
   * carries an api key it is passed through this variable and nowhere else.
   */
  tokenEnv?: string;
  /** Extra environment variable names the agent needs from the gateway environment. */
  passEnv?: string[];
  /** Session mode that refuses tool use instead of asking, applied when the agent offers it. */
  sessionMode?: string;
}

export const ACP_AGENTS: Readonly<Record<string, AcpAgentSpec>> = Object.freeze({
  qoder: {
    id: "qoder",
    displayName: "Qoder CLI",
    command: "qodercli",
    args: ["--acp"],
    binEnv: "CLI_QODER_BIN",
    tokenEnv: "QODER_PERSONAL_ACCESS_TOKEN",
    sessionMode: "dontAsk",
  },
  "qwen-code": {
    id: "qwen-code",
    displayName: "Qwen Code",
    command: "qwen",
    args: ["--acp"],
    binEnv: "CLI_QWEN_BIN",
    // Its only ACP auth method is "openai": the key comes from the connection, never from
    // the gateway's own OPENAI_API_KEY.
    tokenEnv: "OPENAI_API_KEY",
    passEnv: ["OPENAI_BASE_URL", "OPENAI_MODEL"],
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    command: "opencode",
    args: ["acp"],
    binEnv: "CLI_OPENCODE_BIN",
  },
});

export function getAcpAgent(id: string): AcpAgentSpec | undefined {
  return Object.prototype.hasOwnProperty.call(ACP_AGENTS, id) ? ACP_AGENTS[id] : undefined;
}
