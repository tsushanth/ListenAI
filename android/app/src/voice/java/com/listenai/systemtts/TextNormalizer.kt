package com.listenai.systemtts

import android.text.Spanned
import android.text.style.TtsSpan

/**
 * Prepares the text a calling app sends to the engine before it is spoken.
 *
 * Screen readers lean on three things a plain `toString()` throws away or gets wrong:
 *  - [TtsSpan] markup: TalkBack marks digits, spelled-out text and phone numbers so the engine reads them
 *    character by character instead of as words;
 *  - single characters and symbols: typing echo and "read by character" send one character at a time
 *    ("a", ".", "#") and expect its name, not the sound of the letter or silence;
 *  - SSML: some apps send `<speak>` markup, which must not be read aloud as "less than speak greater than".
 */
object TextNormalizer {

    enum class Kind { VERBATIM, DIGITS, TELEPHONE, ELECTRONIC }

    data class SpanInfo(val start: Int, val end: Int, val kind: Kind)

    /** Returns the text to synthesize. [english] gates the English-only character names. */
    fun normalize(raw: CharSequence?, english: Boolean): String {
        if (raw.isNullOrEmpty()) return ""
        var text = applySpans(raw.toString(), extractSpans(raw), english)
        if (looksLikeSsml(text)) text = stripSsml(text)
        if (english) speakSingleCharacter(text)?.let { return it }
        return text
    }

    // --- spans -------------------------------------------------------------

    private fun extractSpans(raw: CharSequence): List<SpanInfo> {
        if (raw !is Spanned) return emptyList()
        return raw.getSpans(0, raw.length, TtsSpan::class.java).mapNotNull { span ->
            val kind = when (span.type) {
                TtsSpan.TYPE_VERBATIM -> Kind.VERBATIM
                TtsSpan.TYPE_DIGITS -> Kind.DIGITS
                TtsSpan.TYPE_TELEPHONE -> Kind.TELEPHONE
                TtsSpan.TYPE_ELECTRONIC -> Kind.ELECTRONIC
                else -> null
            } ?: return@mapNotNull null
            SpanInfo(raw.getSpanStart(span), raw.getSpanEnd(span), kind)
        }
    }

    internal fun applySpans(text: String, spans: List<SpanInfo>, english: Boolean): String {
        if (spans.isEmpty()) return text
        val sb = StringBuilder(text)
        // Right to left so earlier offsets stay valid while we replace.
        for (s in spans.sortedByDescending { it.start }) {
            val start = s.start.coerceIn(0, sb.length)
            val end = s.end.coerceIn(start, sb.length)
            if (start == end) continue
            sb.replace(start, end, transform(sb.substring(start, end), s.kind, english))
        }
        return sb.toString()
    }

    private fun transform(part: String, kind: Kind, english: Boolean): String = when (kind) {
        Kind.VERBATIM -> part.filterNot { it.isWhitespace() }.map { spellOut(it, english) }.joinToString(" ")
        Kind.DIGITS -> part.filter { it.isDigit() }.map { it.toString() }.joinToString(" ")
        // Digits one by one, with a short pause between groups so "555 123 4567" is not run together.
        Kind.TELEPHONE -> part.split(Regex("[^0-9]+")).filter { it.isNotEmpty() }
            .joinToString(", ") { group -> group.toList().joinToString(" ") }
        Kind.ELECTRONIC -> part.map {
            when (it) {
                '@' -> " at "
                '.' -> " dot "
                '/' -> " slash "
                ':' -> " colon "
                '-' -> " dash "
                '_' -> " underscore "
                else -> it.toString()
            }
        }.joinToString("").replace(Regex("\\s+"), " ").trim()
    }

    private fun spellOut(c: Char, english: Boolean): String =
        if (english) (CHARACTER_NAMES[c.lowercaseChar()] ?: c.toString()) else c.toString()

    // --- single characters ---------------------------------------------------

    /** The spoken name of a lone character ("a" -> "ay", "." -> "dot"), or null if [text] is not one. */
    internal fun speakSingleCharacter(text: String): String? {
        val t = text.trim()
        if (t.isEmpty() || t.codePointCount(0, t.length) != 1) return null
        val c = t[0]
        return CHARACTER_NAMES[c.lowercaseChar()]
    }

    // --- SSML ------------------------------------------------------------------

    private fun looksLikeSsml(text: String) = text.trimStart().startsWith("<speak", ignoreCase = true)

    internal fun stripSsml(text: String): String {
        var t = text
        // A break becomes a comma-sized pause; other tags are dropped, keeping their text.
        t = t.replace(Regex("<break\\b[^>]*/?>", RegexOption.IGNORE_CASE), ", ")
        t = t.replace(Regex("<[^>]+>"), " ")
        t = t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'")
        return t.replace(Regex("\\s+"), " ").trim()
    }

    // Names used when a character is read on its own. English only; other languages use eSpeak's own
    // per-language character names.
    private val CHARACTER_NAMES: Map<Char, String> = mapOf(
        'a' to "ay", 'b' to "bee", 'c' to "see", 'd' to "dee", 'e' to "ee", 'f' to "eff", 'g' to "gee",
        'h' to "aitch", 'i' to "eye", 'j' to "jay", 'k' to "kay", 'l' to "el", 'm' to "em", 'n' to "en",
        'o' to "oh", 'p' to "pee", 'q' to "cue", 'r' to "ar", 's' to "ess", 't' to "tee", 'u' to "you",
        'v' to "vee", 'w' to "double you", 'x' to "ex", 'y' to "why", 'z' to "zee",
        '0' to "zero", '1' to "one", '2' to "two", '3' to "three", '4' to "four", '5' to "five",
        '6' to "six", '7' to "seven", '8' to "eight", '9' to "nine",
        '.' to "dot", ',' to "comma", '?' to "question mark", '!' to "exclamation mark", ':' to "colon",
        ';' to "semicolon", '-' to "dash", '_' to "underscore", '/' to "slash", '\\' to "backslash",
        '@' to "at", '#' to "hash", '$' to "dollar", '%' to "percent", '&' to "and", '*' to "star",
        '(' to "open paren", ')' to "close paren", '[' to "open bracket", ']' to "close bracket",
        '{' to "open brace", '}' to "close brace", '+' to "plus", '=' to "equals", '<' to "less than",
        '>' to "greater than", '\'' to "apostrophe", '"' to "quote", '~' to "tilde", '`' to "grave",
        '^' to "caret", '|' to "bar", ' ' to "space"
    )
}
