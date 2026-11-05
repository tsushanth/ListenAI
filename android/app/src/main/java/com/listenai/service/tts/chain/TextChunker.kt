package com.listenai.service.tts.chain

/** Splits text into sentence-aligned pieces: a short first piece (fast first audio), then pieces up to a maximum. */
object TextChunker {

    private val SENTENCE_END = Regex("(?<=[.!?。！？।])\\s+|\\n+")
    private val CLAUSE_END = Regex("(?<=[,;:—、，])\\s+")

    fun split(text: String, maxChars: Int, firstChars: Int = maxChars): List<String> {
        val sentences = text.split(SENTENCE_END).map { it.trim() }.filter { it.isNotEmpty() }
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
            pieces += rest.substring(0, cut + 1).trim()
            rest = rest.substring(cut + 1).trim()
            lim = maxChars
        }
        if (rest.isNotEmpty()) pieces += rest
        return pieces.filter { it.isNotEmpty() }
    }
}
