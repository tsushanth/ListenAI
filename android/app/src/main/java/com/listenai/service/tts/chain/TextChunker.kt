package com.listenai.service.tts.chain

/** Splits text into sentence-aligned pieces: a short first piece (fast first audio), then pieces up to a maximum. */
object TextChunker {

    // Full stops of Japanese and Chinese text are not followed by a space, so they split without needing one.
    private val SENTENCE_END = Regex("(?<=[.!?।؟])\\s+|(?<=[。！？])\\s*|\\n+")
    private val CLAUSE_END = Regex("(?<=[,;:—])\\s+|(?<=[、，；：])\\s*")

    // Closing marks that end up at the start of the next sentence after a split ("Va. » Il" or "Go." he said): they belong to the sentence before.
    private const val CLOSERS = "\u201D\u2019\u00BB\u203A)]}\u300D\u300F\u3011\u3009\u300B"

    fun split(text: String, maxChars: Int, firstChars: Int = maxChars): List<String> {
        val sentences = glueStrays(text.split(SENTENCE_END).map { it.trim() }.filter { it.isNotEmpty() })
        val out = ArrayList<String>()
        val cur = StringBuilder()
        fun limit() = if (out.isEmpty()) firstChars else maxChars
        fun flush() {
            if (cur.isNotBlank()) out += cur.toString().trim()
            cur.setLength(0)
        }
        for (s in sentences) {
            for (piece in breakLong(s, maxOf(limit(), 1), maxChars)) {
                if (cur.isNotEmpty() && cur.length + 1 + piece.length > limit()) flush()
                if (cur.isNotEmpty()) cur.append(' ')
                cur.append(piece)
                // The first chunk goes out as soon as it holds one full sentence.
                if (out.isEmpty() && cur.length >= firstChars / 2) flush()
            }
        }
        flush()
        return out
    }

    /** A sentence longer than [limit] is cut at clause boundaries, then at spaces, then hard. */
    private fun breakLong(s: String, limit: Int, maxChars: Int): List<String> {
        if (s.length <= limit) return listOf(s)
        val pieces = ArrayList<String>()
        var rest = s
        var lim = limit
        while (rest.length > lim) {
            val window = rest.substring(0, lim)
            var cut = CLAUSE_END.findAll(window).lastOrNull()?.range?.last ?: -1
            if (cut < lim / 3) cut = window.lastIndexOf(' ')
            if (cut < lim / 3) cut = lim - 1
            val end = safeEnd(rest, cut + 1)
            pieces += rest.substring(0, end).trim()
            rest = rest.substring(end).trim()
            lim = maxChars
        }
        if (rest.isNotEmpty()) pieces += rest
        return pieces.filter { it.isNotEmpty() }
    }

    /**
     * Sentences that are only punctuation, or start with a closing mark, are glued to the sentence before so no chunk is only
     * punctuation and no chunk starts with a closing quote. A straight double quote counts as closing only when the sentence
     * before has an unmatched one (otherwise it opens the next sentence). Text that starts with such marks keeps them.
     */
    internal fun glueStrays(sentences: List<String>): List<String> {
        val out = ArrayList<String>()
        var pending = ""
        for (raw in sentences) {
            var s = raw
            val prev = out.lastOrNull()
            if (prev != null) {
                val lead = s.takeWhile { it in CLOSERS || (it == '"' && prev.count { c -> c == '"' } % 2 == 1) }
                if (lead.isNotEmpty()) { out[out.size - 1] = prev + lead; s = s.substring(lead.length).trim() }
            }
            if (s.isEmpty()) continue
            if (s.none { it.isLetterOrDigit() }) {
                // only punctuation or symbols: attach to the sentence before, else to the next one
                if (out.isNotEmpty()) out[out.size - 1] = out.last() + " " + s else pending += s
                continue
            }
            out += if (pending.isEmpty()) s else pending + s
            pending = ""
        }
        if (pending.isNotEmpty()) out += pending
        return out
    }

    /** True when cutting [s] before index [p] would split a character: a surrogate pair, a combining mark, a joiner or variation selector, or an emoji skin tone. */
    private fun insideCluster(s: String, p: Int): Boolean {
        if (p <= 0 || p >= s.length) return false
        val before = s[p - 1]
        val after = s[p]
        if (Character.isHighSurrogate(before) && Character.isLowSurrogate(after)) return true
        if (before == '\u200D' || after == '\u200D' || after == '\u200C') return true
        if (after in '\uFE00'..'\uFE0F') return true
        when (Character.getType(after)) {
            Character.NON_SPACING_MARK.toInt(), Character.COMBINING_SPACING_MARK.toInt(), Character.ENCLOSING_MARK.toInt() -> return true
        }
        if (Character.isHighSurrogate(after) && p + 1 < s.length) {
            val cp = Character.toCodePoint(after, s[p + 1])
            if (cp in 0x1F3FB..0x1F3FF || cp in 0xE0020..0xE007F) return true // skin tone modifiers, tag characters
        }
        return false
    }

    /** The cut point (exclusive end) nearest before [end] that does not split a character; after it if there is none before. Always at least 1. */
    private fun safeEnd(s: String, end: Int): Int {
        var e = end.coerceIn(1, s.length)
        while (e > 1 && insideCluster(s, e)) e--
        if (insideCluster(s, e) || e < 1) { e = end.coerceIn(1, s.length); while (e < s.length && insideCluster(s, e)) e++ }
        return e
    }
}
