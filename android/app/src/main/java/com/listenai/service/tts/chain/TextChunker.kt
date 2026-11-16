package com.listenai.service.tts.chain

import java.text.BreakIterator
import java.util.Locale

/**
 * Splits text into sentence-aligned pieces: a short first piece (fast first audio), then pieces up to a maximum.
 * Lengths are counted in code points (what the speech API counts), not UTF-16 units. Chinese, Japanese and Thai have no
 * spaces between words: a piece that must be cut inside a run of such text is cut at a word boundary from the platform's
 * word iterator (dictionary based for these scripts on Android), and only then at a character.
 */
object TextChunker {

    // Full stops of Japanese and Chinese text are not followed by a space, so they split without needing one.
    private val SENTENCE_END = Regex("(?<=[.!?।؟])\\s+|(?<=[。！？｡])\\s*|\\n+")
    private val CLAUSE_END = Regex("(?<=[,;:—،؛])\\s+|(?<=[、，；：､])\\s*")

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
                if (cur.isNotEmpty() && cur.codePointCount(0, cur.length) + 1 + piece.codePointCount(0, piece.length) > limit()) flush()
                if (cur.isNotEmpty()) cur.append(' ')
                cur.append(piece)
                // The first chunk goes out as soon as it holds one full sentence.
                if (out.isEmpty() && cur.codePointCount(0, cur.length) >= firstChars / 2) flush()
            }
        }
        flush()
        return out
    }

    /** A sentence longer than [limit] code points is cut at clause boundaries, then at spaces, then at word boundaries, then at a character. */
    private fun breakLong(s: String, limit: Int, maxChars: Int): List<String> {
        if (s.codePointCount(0, s.length) <= limit) return listOf(s)
        val pieces = ArrayList<String>()
        var rest = s
        var lim = limit
        while (rest.codePointCount(0, rest.length) > lim) {
            val units = rest.offsetByCodePoints(0, lim) // the window, in UTF-16 units
            val window = rest.substring(0, units)
            var cut = CLAUSE_END.findAll(window).lastOrNull()?.range?.last ?: -1
            if (cut < units / 3) cut = window.lastIndexOf(' ')
            if (cut < units / 3) cut = wordBoundary(rest, units) - 1
            if (cut < units / 3) cut = units - 1
            var end = safeEnd(rest, cut + 1)
            // A mark that ends a clause belongs to the text before it, not at the start of the next piece.
            while (end < rest.length && (rest[end] in TRAILING_MARKS || rest[end] in CLOSERS)) end++
            // What would be left is only punctuation (the sentence's last mark): keep it with this piece, a chunk of only "？" is not speakable.
            if (!hasLetterOrDigit(rest, end)) end = rest.length
            pieces += rest.substring(0, end).trim()
            rest = rest.substring(end).trim()
            lim = maxChars
        }
        if (rest.isNotEmpty()) pieces += rest
        return pieces.filter { it.isNotEmpty() }
    }

    /**
     * The last word boundary at or before [units] (a UTF-16 index into [s]) that the platform's word iterator finds, or 0 when
     * there is none. The iterator sees a few characters beyond the window so a boundary exactly at the end is recognised.
     */
    internal fun wordBoundary(s: String, units: Int): Int {
        val end = minOf(s.length, units + LOOKAHEAD)
        val text = s.substring(0, end)
        val bi = try { BreakIterator.getWordInstance(localeOf(text)) } catch (e: Exception) { return 0 }
        bi.setText(text)
        val b = if (units >= text.length) text.length else bi.preceding(units + 1)
        return if (b == BreakIterator.DONE) 0 else b
    }

    private const val LOOKAHEAD = 16

    /** True when [s] from [from] on has a letter or digit; by code point, so supplementary-plane ideographs count. */
    private fun hasLetterOrDigit(s: String, from: Int): Boolean {
        var i = from
        while (i < s.length) {
            val cp = s.codePointAt(i)
            if (Character.isLetterOrDigit(cp)) return true
            i += Character.charCount(cp)
        }
        return false
    }
    private const val TRAILING_MARKS = "、，。！？；：｡､,.!?;:"

    /** The word iterator is language specific for scripts written without spaces; pick it from the characters (kana mean Japanese even when kanji come first). */
    private fun localeOf(text: String): Locale {
        var han = false
        var hangul = false
        var other: Locale? = null
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            i += Character.charCount(cp)
            when (Character.UnicodeScript.of(cp)) {
                Character.UnicodeScript.HIRAGANA, Character.UnicodeScript.KATAKANA -> return Locale.JAPANESE
                Character.UnicodeScript.HAN -> han = true
                Character.UnicodeScript.HANGUL -> hangul = true
                Character.UnicodeScript.THAI -> other = other ?: Locale("th")
                Character.UnicodeScript.LAO -> other = other ?: Locale("lo")
                Character.UnicodeScript.KHMER -> other = other ?: Locale("km")
                Character.UnicodeScript.MYANMAR -> other = other ?: Locale("my")
                else -> {}
            }
        }
        return when {
            hangul -> Locale.KOREAN
            han -> Locale.CHINESE
            else -> other ?: Locale.ROOT
        }
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
            if (!hasLetterOrDigit(s, 0)) {
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
