package com.listenai.service.tts

/**
 * Pure text-splitting helpers for the on-device engines. Every piece is voiced by a separate model
 * call, so a piece boundary is audible as a pause and restarted intonation. These helpers therefore
 * only ever cut at sentence ends, commas or spaces; a cut inside a word ("r" + "eply") is allowed
 * solely for a single unbroken run longer than the cap, and never between the halves of a surrogate pair.
 */
object SpeechTextSplitter {

    private val SENTENCE_SPLIT = Regex("(?<=[.!?])\\s+")
    private val ESPEAK_SPLIT = Regex("(?<=[.!?])\\s+|(?<=[。！？])|\\n+")

    /**
     * Breaks [text] into pieces of at most [charCap] characters for the neural model: sentence ends
     * first, then commas, then spaces. Short sentences are packed together up to the cap.
     */
    fun chunkForModel(text: String, charCap: Int): List<String> {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return emptyList()
        val sentences = SENTENCE_SPLIT.split(trimmed).map { it.trim() }.filter { it.isNotEmpty() }
        val chunks = ArrayList<String>()
        val current = StringBuilder()
        fun flushCurrent() {
            if (current.isNotEmpty()) {
                chunks.add(current.toString().trim())
                current.clear()
            }
        }
        for (s in sentences) {
            val pieces = if (s.length > charCap) splitOverlongSentence(s, charCap) else listOf(s)
            for (piece in pieces) {
                if (current.length + piece.length + 1 > charCap) flushCurrent()
                if (current.isNotEmpty()) current.append(' ')
                current.append(piece)
            }
        }
        flushCurrent()
        return chunks
    }

    private fun splitOverlongSentence(s: String, charCap: Int): List<String> {
        val byComma = s.split(",").map { it.trim() }.filter { it.isNotEmpty() }
        val out = ArrayList<String>()
        val cur = StringBuilder()
        for (part in byComma) {
            if (cur.length + part.length + 2 > charCap) {
                if (cur.isNotEmpty()) {
                    out.add(cur.toString().trim())
                    cur.clear()
                }
                if (part.length > charCap) {
                    out.addAll(splitAtWords(part, charCap))
                    continue
                }
            }
            if (cur.isNotEmpty()) cur.append(", ")
            cur.append(part)
        }
        if (cur.isNotEmpty()) out.add(cur.toString().trim())
        return out
    }

    /**
     * Splits [text] into sentence-sized pieces for eSpeak so the first sentence plays quickly and a
     * stop request takes effect between sentences. Decimals ("3.14") are not split because a split
     * needs whitespace after the punctuation (CJK full stops need none). A sentence longer than
     * [maxPiece] is cut at a space.
     */
    fun splitForEspeak(text: String, maxPiece: Int): List<String> {
        val pieces = ArrayList<String>()
        for (sentence in text.split(ESPEAK_SPLIT).map { it.trim() }.filter { it.isNotEmpty() }) {
            pieces += splitAtWords(sentence, maxPiece)
        }
        return pieces
    }

    /** Cuts [text] into pieces of at most [cap] characters, at whitespace whenever the piece has any. */
    internal fun splitAtWords(text: String, cap: Int): List<String> {
        require(cap > 0)
        val out = ArrayList<String>()
        var rest = text.trim()
        while (rest.length > cap) {
            var cut = -1
            for (i in cap downTo 1) {
                if (rest[i].isWhitespace()) { cut = i; break }
            }
            if (cut <= 0) {
                // One unbroken run longer than the cap: the only case where a word may be cut.
                cut = cap
                if (cut > 1 && Character.isHighSurrogate(rest[cut - 1])) cut--
            }
            out += rest.substring(0, cut).trim()
            rest = rest.substring(cut).trim()
        }
        if (rest.isNotEmpty()) out += rest
        return out
    }
}
