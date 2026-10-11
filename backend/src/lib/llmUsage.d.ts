export interface Usage { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }; server_tool_use?: { web_search_requests?: number } }
export interface LlmUsageOptions { app: string; url?: string; key?: string; flushMs?: number; maxPending?: number; enabled?: boolean; fetch?: typeof fetch; now?: () => number; log?: (msg: string) => void }
export interface LlmUsage {
  record(r: { model: string; usage?: Usage; feature?: string; ok?: boolean }): void;
  instrument(client: unknown): () => void;
  withFeature<T>(name: string, fn: () => T): T;
  flush(): Promise<void>;
  enabled: boolean;
  costOf(model: string, usage?: Usage): { usd: number; estimated: boolean };
  pending(): number;
}
export function createLlmUsage(opts: LlmUsageOptions): LlmUsage;
export function costOf(model: string, usage?: Usage): { usd: number; estimated: boolean };
export function priceFor(model: string): { in: number; out: number; cw5: number; cw1: number; cr: number; known: boolean };
export function readUsage(u?: Usage): { input: number; output: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; webSearches: number };
export function normalizeModel(model: string): string;
export const PRICES: Record<string, unknown>;
