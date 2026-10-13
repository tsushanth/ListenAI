package com.listenai.systemtts

/**
 * Estimates when each word of an utterance is spoken, so the engine can report word positions with
 * `SynthesisCallback.rangeStart` and reading apps (Play Books, Kindle, any reader that highlights) can
 * follow along.
 *
 * The engines do not report word timings, so each word gets a share of the audio proportional to its
 * length, with extra time after sentence and clause punctuation. It is an approximation, but it keeps the
 * highlight within a word or two of the voice, which is what readers need.
 */
object WordTimeline {

    data class Word(val startChar: Int, val endChar: Int, val startFrame: Int)

    /**
     * Words of [text] with start frames spread across [totalFrames] of audio.
     * [textOffset] shifts character positions (for a chunk inside a longer text).
     */
    fun compute(text: String, totalFrames: Int, textOffset: Int = 0): List<Word> {
        if (text.isBlank() || totalFrames <= 0) return emptyList()
        val spans = mutableListOf<IntRange>()
        var i = 0
        while (i < text.length) {
            while (i < text.length && text[i].isWhitespace()) i++
            if (i >= text.length) break
            val start = i
            while (i < text.length && !text[i].isWhitespace()) i++
            spans += start until i
        }
        if (spans.isEmpty()) return emptyList()

        val weights = spans.map { r ->
            val word = text.substring(r.first, r.last + 1)
            val pause = when (word.last()) {
                '.', '!', '?' -> 5.0
                ',', ';', ':' -> 2.5
                else -> 0.0
            }
            word.length + 1.0 + pause
        }
        val total = weights.sum()
        var acc = 0.0
        return spans.mapIndexed { idx, r ->
            val frame = (acc / total * totalFrames).toInt().coerceIn(0, totalFrames - 1)
            acc += weights[idx]
            Word(textOffset + r.first, textOffset + r.last + 1, frame)
        }
    }

    /**
     * Words of a synthesized [chunk] positioned in the [original] text the caller sent. Chunks are cut
     * from the original (sometimes with punctuation dropped), so each word is searched for in order
     * starting at [from]. Returns the located words (startFrame spread over [totalFrames]) and the
     * position to continue from for the next chunk.
     */
    fun locate(original: String, chunk: String, totalFrames: Int, from: Int): Pair<List<Word>, Int> {
        var cursor = from.coerceIn(0, original.length)
        val located = ArrayList<Word>()
        for (w in compute(chunk, totalFrames)) {
            val word = chunk.substring(w.startChar, w.endChar)
            val idx = original.indexOf(word, cursor)
            if (idx < 0) continue
            located += Word(idx, idx + word.length, w.startFrame)
            cursor = idx + word.length
        }
        return located to cursor
    }
}
