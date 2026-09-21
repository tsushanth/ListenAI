// Ported from realtime-tts/call-loop-poc/sentenceChunker.js (read-only
// reference repo — reimplemented here rather than imported so this package
// has no cross-repo dependency). Splits an LLM reply into TTS-sized chunks
// at sentence/clause boundaries. This MVP's AnswerEngine.reply() returns
// the full text at once (no token streaming - see llm.js), so in practice
// this only ever gets one flush() call per turn today; it's kept as a
// class (rather than a one-line split) so a streaming LLM can be dropped in
// later without touching session.js.
const BOUNDARY_RE = /[.!?]+[\s"')\]]*$/;
const MIN_CHUNK_CHARS = 30;

export class SentenceChunker {
  constructor(onChunk) {
    this.buffer = '';
    this.onChunk = onChunk;
  }

  push(token) {
    this.buffer += token;
    if (this.buffer.length >= MIN_CHUNK_CHARS && BOUNDARY_RE.test(this.buffer)) {
      this.flush();
    }
  }

  flush() {
    const text = this.buffer.trim();
    this.buffer = '';
    if (text) this.onChunk(text);
  }
}
