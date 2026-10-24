/**
 * Public Artificial Analysis (AA) figures, index v4.3.2, read 2026-10-24.
 * qwen3.8-flash is AA's 'Qwen3.8-Flash-Next', deepseek-v4.1-flash is
 * 'DeepSeek V4.1 Flash 1017 (Max)', and kimi-k3 is 'Kimi K3.1 Pro':
 * closest AA labels, not exact name matches. Other metrics are deliberately
 * absent, never filled from siblings. longcat-2.5-preview-free has no public
 * figure and no sibling, so no row.
 */
type PublicRow = readonly [
  modelId: string,
  family: string,
  aaIntelligence: number,
  verifiedTokPerS: number,
  ttftS: number,
  costPerTaskUsd: number,
  url: string,
];

export const PUBLIC_BENCHMARK_ROWS: readonly PublicRow[] = [
  ["gpt-6.1-sol","gpt",52,57.3,162.1,0.72,"gpt-6-1-sol"],
  ["gpt-6.1-sol-max","gpt",52,57.3,162.1,0.72,"gpt-6-1-sol"],
  ["gpt-6.1-sol-xhigh","gpt",51,51.3,60.09,0.39,"gpt-6-1-sol-xhigh"],
  ["gpt-6.1-sol-high","gpt",50,50.7,31.33,0.32,"gpt-6-1-sol-high"],
  ["gpt-6.1-sol-medium","gpt",48,48.6,3.96,0.21,"gpt-6-1-sol-medium"],
  ["gpt-6.1-sol-low","gpt",42,47.8,1.78,0.13,"gpt-6-1-sol-low"],
  ["claude-haiku-5-5","claude",43,235.6,301.64,0.21,"claude-haiku-5-5"],
  ["gemini-3.8-flash","gemini",41,141.4,25.7,1.24,"gemini-3-8-flash"],
  ["qwen3.8-flash","qwen",40,51.5,2.16,0.37,"qwen3-8-flash-next"],
  ["deepseek-v4.1-flash","deepseek",45,195.2,1.14,0.26,"deepseek-v4-1-flash-1017"],
  ["glm-5.3-flash","glm",42,68.9,3.29,0.28,"glm-5-3-flash"],
  ["kimi-k3","kimi",55,73.5,2.97,2.11,"kimi-k3-1-pro"],
  ["minimax-m3","minimax",29,88.7,1.3,0.51,"minimax-m3"],
  ["qwen3.8-27b","qwen",34,43.5,3.88,1.01,"qwen3-8-27b"],
  ["nemotron-3-ultra-free","nvidia",23,154.2,1.24,0.47,"nvidia-nemotron-3-ultra-550b-a55b"],
];

export const PRIOR_BENCHMARK_ROWS: readonly (readonly [
  modelId: string,
  family: string | null,
  sibling: string,
])[] = [
  ["gpt-6.1-sol-ultra",null,"gpt-6.1-sol-max"],
  ["mimo-v2.6-flash-free",null,"mimo-v2.6-flash"],
  ["muse-spark-1.3-contributor-free",null,"muse-spark-1.3-contributor"],
];
