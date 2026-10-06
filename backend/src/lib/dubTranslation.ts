// Prompt building / reply parsing for dub translation. Pure, so it is unit-testable without the Anthropic SDK.

import type { DubLanguage } from './dubLanguages.js';

export interface SegmentBudget { maxChars: number; targetChars?: number }
export interface TranslationInputItem { text: string; maxChars: number; targetChars: number }

export const TRANSLATION_BATCH = 40;
export const OVER_BUDGET_FACTOR = 1.3;
export const OVER_BUDGET_MIN_CHARS = 20;

export function buildTranslationSystemPrompt(lang: DubLanguage, sourceName: string): string {
  return `You are a professional dubbing translator. You will receive a JSON array of transcript segments from spoken ${sourceName} audio. Each item is {"text", "max_chars", "target_chars"}.

Translate each segment's "text" into ${lang.name}. Rules:
1. Return a JSON array of strings, same length and same order as the input, with ONLY the translated text for each segment.
2. Keep each translation natural to SPEAK aloud (this is for dubbing, not subtitles) - prefer phrasing a speaker would actually say.
3. LENGTH BUDGET: the dub must fit the time the original speaker took. Aim for about target_chars characters and NEVER exceed max_chars. Shorten by tightening phrasing and dropping filler, not by omitting key facts.
4. Do not merge, split, reorder, or drop segments. If a segment is empty or non-speech (e.g. "[music]"), return an empty string for it.
5. Keep proper names as written. Write numbers the way they are spoken in ${lang.name}.
6. Do not add commentary, numbering, or explanations. Return ONLY the JSON array of strings.`;
}

export function buildTranslationUserPrompt(items: TranslationInputItem[]): string {
  return JSON.stringify(items.map((i) => ({ text: i.text, max_chars: i.maxChars, target_chars: i.targetChars })));
}

export function parseTranslationReply(raw: string, expected: number): string[] {
  let parsed: unknown;
  try {
    // Claude sometimes wraps JSON in a fenced code block despite instructions; strip it defensively.
    const jsonText = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Translation response was not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== expected) {
    throw new Error(`Translation response had ${Array.isArray(parsed) ? parsed.length : 'non-array'} entries, expected ${expected}`);
  }
  return parsed.map((v) => (typeof v === 'string' ? v : ''));
}

/** Indexes whose translation is clearly longer than its budget (so the speed refit would have to clamp). */
export function overBudgetIndexes(translations: string[], budgets: SegmentBudget[]): number[] {
  const out: number[] = [];
  translations.forEach((t, i) => {
    const b = budgets[i];
    if (b && t.length > OVER_BUDGET_MIN_CHARS && t.length > b.maxChars * OVER_BUDGET_FACTOR) out.push(i);
  });
  return out;
}

export function chunkRanges(n: number, size: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i += size) out.push([i, Math.min(i + size, n)]);
  return out;
}
