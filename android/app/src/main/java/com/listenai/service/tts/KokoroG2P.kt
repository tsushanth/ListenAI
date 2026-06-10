package com.listenai.service.tts

import android.content.Context
import android.util.Log
import com.listenai.R
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * G2P + tokenizer + voice-pack lookup for Kokoro on-device synthesis.
 *
 * Three responsibilities:
 *
 * 1. **Tokenize a phoneme string into token IDs** using the real Kokoro
 *    vocab bundled at `res/raw/kokoro_vocab.json` (115 IPA-ish symbols).
 *    The model expects tokens framed with the special `$` id=0 at both
 *    ends, so we emit `[0, ...phonemes, 0]`.
 *
 * 2. **English → phonemes**. Quality bar for v1: produce a *valid* IPA
 *    phoneme sequence the tokenizer accepts. We do a coarse rules-based
 *    letter-to-sound conversion. This sounds robotic and gets uncommon
 *    words wrong, but the pipeline runs end-to-end. Replacing this with
 *    espeak-ng or a CMUdict + LTS engine is the next-iteration upgrade.
 *
 * 3. **Voice pack loading**. Kokoro voice files are 522,240 bytes —
 *    that's **510 length-indexed style vectors of 256 fp32 each**. For
 *    a phoneme sequence of length N, the runtime picks
 *    `voicePack[N * 256 : (N+1) * 256]` as the style input. This is
 *    critical: a fixed 256-dim vector won't work because the model
 *    expects length-conditioned style.
 */
class KokoroG2P(private val context: Context) {

    /**
     * Bundled voices keyed by their Kokoro voice ID. The Kotlin name has
     * to be a valid Android resource identifier (no dots), so the .bin
     * files live in res/raw as `kokoro_voice_<id>` with no extension.
     */
    private val voiceResources = mapOf(
        "af_heart" to R.raw.kokoro_voice_af_heart,
        "af_bella" to R.raw.kokoro_voice_af_bella,
        "am_michael" to R.raw.kokoro_voice_am_michael,
        "bm_george" to R.raw.kokoro_voice_bm_george,
        "bf_emma" to R.raw.kokoro_voice_bf_emma,
    )

    // Lazily loaded — vocab is small (~1 KB), voice packs are 500 KB each.
    private val vocab: Map<String, Int> by lazy { loadVocab() }
    private val voiceCache = mutableMapOf<String, FloatArray>()

    // Word → IPA lookup table for the most frequent English words. Drops
    // straight into the phoneme stream; OOV words fall through to the crude
    // letter-to-sound rules. Gives a large quality bump on function words
    // and high-frequency content words at zero runtime cost.
    private val lexicon: Map<String, String> by lazy { loadLexicon() }

    private fun loadVocab(): Map<String, Int> {
        val bytes = context.resources.openRawResource(R.raw.kokoro_vocab).use { it.readBytes() }
        val obj = JSONObject(String(bytes, Charsets.UTF_8))
        val map = HashMap<String, Int>(obj.length() * 2)
        val keys = obj.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            map[k] = obj.getInt(k)
        }
        Log.i(TAG, "loadVocab: ${map.size} entries")
        return map
    }

    private fun loadLexicon(): Map<String, String> {
        return try {
            val startMs = System.currentTimeMillis()
            val bytes = context.resources.openRawResource(R.raw.kokoro_lexicon).use { it.readBytes() }
            val obj = JSONObject(String(bytes, Charsets.UTF_8))
            // 1.4x sizing to keep load factor down — CMUdict is ~126K entries.
            val map = HashMap<String, String>((obj.length() * 1.4).toInt())
            val keys = obj.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                map[k] = obj.getString(k)
            }
            val elapsed = System.currentTimeMillis() - startMs
            Log.i(TAG, "loadLexicon: ${map.size} entries in ${elapsed}ms")
            map
        } catch (e: Exception) {
            Log.w(TAG, "loadLexicon: failed — ${e.message}; falling back to letter-to-sound only")
            emptyMap()
        }
    }

    /**
     * Force lazy loaders to fire. Called from session warmup so the first
     * real synth doesn't pay the lexicon-parse latency on the hot path.
     */
    fun prewarm() {
        // Touch the by-lazy delegates.
        vocab.size
        lexicon.size
    }

    /**
     * Convert raw text → list of token IDs for the model. Result includes
     * the leading + trailing `$` (id 0) the post-processor expects.
     */
    fun tokenize(text: String): IntArray {
        if (text.isBlank()) return IntArray(0)

        val cleaned = preprocessForKokoro(text)
        val phonemes = englishToPhonemes(cleaned)
        if (phonemes.isEmpty()) {
            Log.w(TAG, "tokenize: empty phoneme sequence for ${text.take(40)}…")
            return IntArray(0)
        }

        val tokens = ArrayList<Int>(phonemes.length + 2)
        tokens.add(0) // leading $
        var dropped = 0
        for (ch in phonemes) {
            val id = vocab[ch.toString()]
            if (id != null) {
                tokens.add(id)
            } else {
                dropped++
            }
            if (tokens.size >= MAX_TOKENS - 1) break
        }
        tokens.add(0) // trailing $
        if (dropped > 0) {
            Log.w(TAG, "tokenize: dropped $dropped chars not in vocab")
        }
        return tokens.toIntArray()
    }

    /**
     * Look up the length-conditioned style vector for `voiceId`.
     *
     * `phonemeCount` is the number of TOKENS we'll feed the model
     * **excluding the trailing $** — i.e. the leading `$` + the phonemes.
     * Empirically that's how the kokoro-onnx Python pipeline indexes the
     * voice pack: `voice_pack[len(tokens) - 1]`.
     */
    fun voiceEmbedding(voiceId: String, phonemeCount: Int): FloatArray {
        // Clamp index to the voice pack's range (510 entries).
        val idx = phonemeCount.coerceIn(0, VOICE_PACK_LENGTHS - 1)
        val full = loadVoicePack(voiceId)
        if (full.size < (idx + 1) * STYLE_DIM) {
            Log.w(TAG, "voiceEmbedding: voice pack too small for idx=$idx, falling back to idx=0")
            return full.copyOfRange(0, STYLE_DIM)
        }
        return full.copyOfRange(idx * STYLE_DIM, (idx + 1) * STYLE_DIM)
    }

    private fun loadVoicePack(voiceId: String): FloatArray {
        voiceCache[voiceId]?.let { return it }

        val resId = voiceResources[voiceId] ?: voiceResources["af_heart"]!!
        val bytes = context.resources.openRawResource(resId).use { it.readBytes() }
        val floatCount = bytes.size / 4
        val out = FloatArray(floatCount)
        val buf = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        for (i in 0 until floatCount) out[i] = buf.float
        voiceCache[voiceId] = out
        Log.i(TAG, "loadVoicePack: $voiceId loaded ($floatCount floats = ${floatCount / STYLE_DIM} length-indexed vectors)")
        return out
    }

    // ---- Crude English → IPA letter-to-sound rules -------------------------

    /**
     * Text-level cleanup applied **before** G2P. Ported directly from the
     * Python cloud worker's `preprocess_text_for_kokoro` (tts-service/main.py)
     * so the on-device path behaves the same way on the same input.
     *
     * Notable rules:
     *  - Paragraph breaks → "." so prosody treats them as sentence ends.
     *  - Soft line breaks → " " (otherwise the G2P sees mid-word breaks).
     *  - `in` (standalone, not after a digit) → `inn`: prevents misaki/G2P
     *    from interpreting bare "in" as the abbreviation for "inches".
     *  - `6 inn` → `6 inches`: restore actual inch usages we just broke.
     *  - Common abbreviations spelled out so the model doesn't say "v-s",
     *    "w-slash", etc.
     *  - Ensure text ends in `.!?` so the model produces a falling
     *    intonation contour instead of cutting mid-sentence.
     */
    private fun preprocessForKokoro(input: String): String {
        var t = input
        t = MULTI_NEWLINE.replace(t, ". ")
        t = SINGLE_NEWLINE.replace(t, " ")
        t = MULTI_PERIOD.replace(t, ".")
        t = MULTI_SPACE.replace(t, " ")

        // "in" → "inn" when NOT preceded by a digit; matches the cloud rule.
        t = IN_NOT_AFTER_DIGIT.replace(t, "inn")
        // Restore inches usages we just broke: "6 inn" → "6 inches".
        t = DIGIT_INN.replace(t) { m -> "${m.groupValues[1]} inches" }

        // Abbreviation expansions.
        t = VS_RE.replace(t, "versus")
        t = W_SLASH_RE.replace(t, "with ")
        t = W_SLASH_O_RE.replace(t, "without")
        t = APPROX_RE.replace(t, "approximately")
        t = GOVT_RE.replace(t, "government")
        t = DEPT_RE.replace(t, "department")

        t = MULTI_SPACE.replace(t, " ").trim()
        if (t.isNotEmpty() && t.last() !in ".!?") {
            t += "."
        }
        return t
    }

    /**
     * Map English text to a string of Kokoro IPA phoneme characters.
     *
     * Strategy:
     *   1. **Word-level lexicon** — most common ~500 English words have
     *      hand-curated IPA in `kokoro_lexicon.json`. This handles function
     *      words and high-frequency content words at native quality.
     *   2. **Letter-to-sound fallback** for OOV — same crude digraph + single
     *      char rules as before. Sounds robotic but at least intelligible.
     *
     * Real production G2P (CMUdict full coverage + LTS rules + stress
     * prediction) is the next-iteration lift.
     */
    private fun englishToPhonemes(text: String): String {
        val sb = StringBuilder(text.length * 2)
        // Walk word-by-word so the lexicon can match whole tokens.
        // Punctuation and whitespace are passed through (filtered later by
        // the vocab gate).
        var i = 0
        val len = text.length
        while (i < len) {
            val c = text[i]
            if (c.isLetter() || c == '\'') {
                // Collect a word (letters + apostrophes for contractions).
                val start = i
                while (i < len && (text[i].isLetter() || text[i] == '\'')) i++
                val word = text.substring(start, i).lowercase()
                val mapped = lexicon[word]
                if (mapped != null) {
                    sb.append(mapped)
                } else {
                    // Word not in lexicon — fall back to letter-to-sound.
                    sb.append(letterToSound(word))
                }
            } else if (c == ' ' || c == '\t' || c == '\n') {
                sb.append(' ')
                i++
            } else if (c in ".,?!;:") {
                sb.append(c)
                i++
            } else if (c.isDigit()) {
                // Letter-to-sound covers digits via SINGLE_CHAR mapping.
                sb.append(letterToSound(c.toString()))
                i++
            } else {
                // Unknown character — skip.
                i++
            }
        }
        return sb.toString()
    }

    /**
     * Letter-to-sound for OOV words.
     *
     * Lookup order at each position: 4-char suffix → 3-char pattern →
     * 2-char digraph → single char. The multi-char patterns matter for
     * English suffixes like `-tion` (/ʃən/), `-sion`, `-ture`, `-cious`,
     * etc. — without them words like "subscription" come out as
     * "sub-skrip-tee-on".
     */
    private fun letterToSound(word: String): String {
        val sb = StringBuilder(word.length * 2)
        var i = 0
        while (i < word.length) {
            // 4-char patterns (mostly suffixes that need a fixed mapping).
            if (i + 4 <= word.length) {
                val q = word.substring(i, i + 4)
                val mapped = QUADGRAPHS[q]
                if (mapped != null) {
                    sb.append(mapped)
                    i += 4
                    continue
                }
            }
            // 3-char patterns.
            if (i + 3 <= word.length) {
                val tri = word.substring(i, i + 3)
                val mapped = TRIGRAPHS[tri]
                if (mapped != null) {
                    sb.append(mapped)
                    i += 3
                    continue
                }
            }
            // 2-char digraphs.
            if (i + 2 <= word.length) {
                val di = word.substring(i, i + 2)
                val mapped = DIGRAPHS[di]
                if (mapped != null) {
                    sb.append(mapped)
                    i += 2
                    continue
                }
            }
            val c = word[i]
            val mapped = SINGLE_CHAR[c]
            if (mapped != null) sb.append(mapped)
            i++
        }
        return sb.toString()
    }

    companion object {
        private const val TAG = "KokoroG2P"

        // Cloud-aligned text preprocessing patterns. Mirrors
        // `preprocess_text_for_kokoro` in tts-service/main.py.
        private val MULTI_NEWLINE = Regex("\\n\\s*\\n+")
        private val SINGLE_NEWLINE = Regex("\\n")
        private val MULTI_PERIOD = Regex("\\.+")
        private val MULTI_SPACE = Regex("\\s+")
        private val IN_NOT_AFTER_DIGIT = Regex("(?<![0-9])\\bin\\b", RegexOption.IGNORE_CASE)
        private val DIGIT_INN = Regex("(\\d)\\s*inn\\b", RegexOption.IGNORE_CASE)
        private val VS_RE = Regex("\\bvs\\.?\\b", RegexOption.IGNORE_CASE)
        private val W_SLASH_RE = Regex("\\bw/(?!o\\b)")
        private val W_SLASH_O_RE = Regex("\\bw/o\\b")
        private val APPROX_RE = Regex("\\bapprox\\.?\\b", RegexOption.IGNORE_CASE)
        private val GOVT_RE = Regex("\\bgovt\\.?\\b", RegexOption.IGNORE_CASE)
        private val DEPT_RE = Regex("\\bdept\\.?\\b", RegexOption.IGNORE_CASE)

        // Kokoro's max context is ~510 tokens for the v1.0 export.
        private const val MAX_TOKENS = 500
        private const val STYLE_DIM = 256
        private const val VOICE_PACK_LENGTHS = 510

        /**
         * Four-letter patterns → IPA. Mostly common English suffixes that
         * have non-obvious pronunciations and would otherwise expand into
         * something like "tee-on" or "tee-us".
         */
        private val QUADGRAPHS = mapOf(
            "tion" to "ʃən",   // subscrip-tion, func-tion, ac-tion
            "sion" to "ʒən",   // ver-sion, deci-sion (default voiced; "ssion"→"ʃən" via TRIGRAPHS)
            "tial" to "ʃəl",   // par-tial, ini-tial
            "cial" to "ʃəl",   // spe-cial, so-cial
            "ture" to "tʃəɹ",  // fea-ture, na-ture
            "sure" to "ʒəɹ",   // mea-sure, lei-sure
            "ough" to "ɔ",     // th-ough, bro-ught — varies; ɔ is a reasonable default
            "augh" to "æf",    // l-augh, dr-aught
            "eigh" to "eɪ",    // w-eight, n-eighbor
            "ould" to "ʊd",    // c-ould, w-ould, sh-ould
        )

        /**
         * Three-letter patterns → IPA. Covers common consonant clusters and
         * vowel groups where the two-letter digraphs would mis-fire.
         */
        private val TRIGRAPHS = mapOf(
            "tch" to "tʃ",     // ca-tch, ma-tch
            "dge" to "dʒ",     // bri-dge, ju-dge
            "ssi" to "ʃ",      // mi-ssi-on, pa-ssi-on → after voiceless gets "sh"
            "tio" to "ʃoʊ",    // backup if "tion" didn't match (e.g. "ratio")
            "scr" to "skɹ",
            "spr" to "spɹ",
            "str" to "stɹ",
            "spl" to "spl",
            "thr" to "θɹ",
            "shr" to "ʃɹ",
            "phr" to "fɹ",
            "chr" to "kɹ",
            "rrh" to "ɹ",      // di-arrh-ea
            "wri" to "ɹaɪ",    // wri-te, wri-ter
            "kno" to "noʊ",    // kno-w, kno-t, kno-b
            "gho" to "ɡoʊ",    // gho-st
            "ing" to "ɪŋ",     // walk-ing, runn-ing
            "air" to "ɛɹ",     // h-air, ch-air
            "ear" to "ɪɹ",     // h-ear, n-ear (mostly; "earn"→"ɝn" via the 'ear' default works)
            "eer" to "ɪɹ",     // b-eer, ch-eer
            "oor" to "ɔɹ",     // d-oor, p-oor
            "our" to "aʊəɹ",   // h-our, fl-our
            "ire" to "aɪəɹ",   // f-ire, h-ire
            "are" to "ɛɹ",     // c-are, sh-are
            "ore" to "ɔɹ",     // m-ore, st-ore
            "ure" to "jʊɹ",    // p-ure, c-ure (when not preceded by t/s — those go via QUAD)
            "ace" to "eɪs",    // f-ace, pl-ace
            "ice" to "aɪs",    // n-ice, pr-ice
            "ute" to "jut",    // c-ute, m-ute
            "ate" to "eɪt",    // d-ate, l-ate (common verb/noun suffix; mis-fires on "are" before — but we run 'are' first; wait 'ate' starts at different idx)
            "ite" to "aɪt",    // wr-ite, k-ite
            "ote" to "oʊt",    // n-ote, qu-ote
            "ake" to "eɪk",    // m-ake, t-ake, c-ake
            "ike" to "aɪk",    // l-ike, b-ike
            "oke" to "oʊk",    // sp-oke, br-oke
            "uke" to "juk",    // d-uke, n-uke
            "ame" to "eɪm",    // n-ame, g-ame
            "ime" to "aɪm",    // t-ime, l-ime
            "ome" to "oʊm",    // h-ome, d-ome (often /ʌ/ in "some/come" — those should be in lexicon)
            "ade" to "eɪd",    // m-ade, tr-ade
            "ide" to "aɪd",    // s-ide, r-ide
            "ode" to "oʊd",    // c-ode, m-ode
            "ude" to "jud",    // d-ude, r-ude (often /ud/; close enough)
            "ave" to "eɪv",    // h-ave (no — exception, in lexicon); s-ave, g-ave
            "ive" to "ɪv",     // l-ive (verb), g-ive, dr-ive should be /aɪ/ — heteronymic; defaulting short
            "ove" to "ʌv",     // l-ove, gl-ove, m-ove should be /uv/ — mixed; defaulting /ʌv/ for the most common case
            "ase" to "eɪs",    // c-ase, b-ase
            "ose" to "oʊz",    // r-ose, ch-ose
            "use" to "juz",    // u-se (verb), f-use
        )

        /** Two-letter digraphs → IPA phoneme strings. */
        private val DIGRAPHS = mapOf(
            "sh" to "ʃ",
            "ch" to "tʃ",
            "th" to "θ",     // hard "th" as in "think"; soft "ð" requires real G2P
            "ph" to "f",
            "ng" to "ŋ",
            "ck" to "k",
            "qu" to "kw",
            "wh" to "w",
            "ee" to "i",
            "oo" to "u",
            "ou" to "aʊ",
            "ow" to "aʊ",
            "ai" to "eɪ",
            "ay" to "eɪ",
            "oa" to "oʊ",
            "ea" to "i",
            "ie" to "aɪ",
        )

        /** Single-letter fallback IPA mapping. */
        private val SINGLE_CHAR = mapOf(
            'a' to "æ", 'b' to "b", 'c' to "k", 'd' to "d",
            'e' to "ɛ", 'f' to "f", 'g' to "ɡ", 'h' to "h",
            'i' to "ɪ", 'j' to "dʒ", 'k' to "k", 'l' to "l",
            'm' to "m", 'n' to "n", 'o' to "ɑ", 'p' to "p",
            'q' to "k", 'r' to "ɹ", 's' to "s", 't' to "t",
            'u' to "ʌ", 'v' to "v", 'w' to "w", 'x' to "ks",
            'y' to "j", 'z' to "z",
            '0' to "z ɪ ɹ oʊ", '1' to "w ʌ n", '2' to "t u",
            '3' to "θ ɹ i", '4' to "f ɔ ɹ", '5' to "f aɪ v",
            '6' to "s ɪ k s", '7' to "s ɛ v ɛ n", '8' to "eɪ t", '9' to "n aɪ n",
        )
    }
}
