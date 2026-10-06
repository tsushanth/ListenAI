// Consent verification: the user records a server-issued phrase in-session. We check
//   1. ASR transcript matches the phrase (WER within bound AND the random code words in order), and
//   2. the consent clip's speaker embedding matches the reference audio's (cosine >= threshold).
// Both services are injected. This does NOT prove consent: a live voice changer, a coerced speaker,
// or a real-time TTS clone of the victim could pass. It raises the cost of casual abuse (REPORT.md).
import type { AsrClient, CloneServiceClient } from './types.js';
import type { ClonePolicy } from './policy.js';
import { scoreTranscript } from './consentPhrase.js';

export type ConsentFailureCode = 'phrase_mismatch' | 'speaker_mismatch' | 'asr_unavailable';

export interface ConsentEvaluation {
  ok: boolean;
  failure?: ConsentFailureCode;
  transcript: string;
  phraseWer: number;
  codeWordsInOrder: boolean;
  /** null if the ASR step failed first (similarity not computed). */
  speakerSimilarity: number | null;
  borderline: boolean;
}

export interface ConsentInputs {
  phrase: string;
  codeWords: string[];
  consentAudio: Buffer;
  consentMime: string;
  referenceAudio: Buffer;
}

export async function evaluateConsent(
  inp: ConsentInputs,
  deps: { asr: AsrClient; service: Pick<CloneServiceClient, 'similarity'>; policy: ClonePolicy }
): Promise<ConsentEvaluation> {
  const { asr, service, policy } = deps;
  let transcript: string;
  try {
    transcript = await asr.transcribe(inp.consentAudio, inp.consentMime, 'en');
  } catch {
    return { ok: false, failure: 'asr_unavailable', transcript: '', phraseWer: 1, codeWordsInOrder: false, speakerSimilarity: null, borderline: false };
  }
  const { wer, codeWordsInOrder } = scoreTranscript(inp.phrase, inp.codeWords, transcript);
  if (!codeWordsInOrder || wer > policy.maxPhraseWer) {
    return { ok: false, failure: 'phrase_mismatch', transcript, phraseWer: wer, codeWordsInOrder, speakerSimilarity: null, borderline: false };
  }
  const sim = await service.similarity(inp.consentAudio, inp.referenceAudio);
  if (!(sim >= policy.similarityThreshold)) {
    return { ok: false, failure: 'speaker_mismatch', transcript, phraseWer: wer, codeWordsInOrder, speakerSimilarity: sim, borderline: false };
  }
  return {
    ok: true,
    transcript,
    phraseWer: wer,
    codeWordsInOrder,
    speakerSimilarity: sim,
    borderline: sim < policy.similarityThreshold + policy.borderlineMargin,
  };
}
