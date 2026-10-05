// Parsing of the STT "keyterms" / "dictionary" request parameter (domain vocabulary to bias the
// transcript toward). Accepts the shapes real clients send: a repeated field (Deepgram `keyterm=a&keyterm=b`,
// ElevenLabs-style), a comma or newline separated list, or a JSON array string (the only unambiguous way to
// send a term that itself contains a comma). Pure function, no I/O.

const MAX_TERM_CHARS = 100;

export type KeytermsResult = { terms: string[] } | { error: string };

function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TERM_CHARS);
}

function splitValue(v: string): string[] {
  const t = v.trim();
  if (t.startsWith('[')) {
    try {
      const arr: unknown = JSON.parse(t);
      if (Array.isArray(arr)) return arr.filter((x): x is string => typeof x === 'string');
    } catch { /* not JSON: fall through to list splitting */ }
  }
  return t.split(/[,\n]/);
}

export function parseKeyterms(values: unknown[], opts: { maxTerms: number }): KeytermsResult {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const v of values) {
    if (typeof v !== 'string') continue;
    for (const raw of splitValue(v)) {
      const term = clean(raw);
      if (!term || seen.has(term)) continue;
      seen.add(term);
      terms.push(term);
      if (terms.length > opts.maxTerms) return { error: `Too many keyterms (max ${opts.maxTerms}).` };
    }
  }
  return { terms };
}
