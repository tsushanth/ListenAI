package com.listenai.service.tts

import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * Hand-port of the chatterbox `tokenizer.json` BPE tokenizer.
 *
 * Why we don't pull in `ai.djl.huggingface:tokenizers`:
 *   - The chatterbox tokenizer is unusually small — 704 base vocab,
 *     265 merges, ASCII-character entries.
 *   - djl-tokenizers ships ~6 MB of native binaries we'd never use beyond
 *     this single TTS path.
 *   - The whole algorithm is ~150 lines of Kotlin.
 *
 * Conforms exactly to `tokenizer.json`:
 *   - normalizer: replace `\s+` with a single space
 *   - pre_tokenizer: none (BPE runs over the whole normalized string)
 *   - model: BPE with vocab dict + ordered merges
 *   - post_processor: TemplateProcessing — wraps the content with
 *       `[EXAGGERATION] [START] ...content... [STOP] [START_SPEECH] [START_SPEECH]`
 *
 * Special token IDs (from the `added_tokens` list in tokenizer.json):
 *   [STOP]           = 0
 *   [UNK]            = 1
 *   [START]          = 255
 *   [START_SPEECH]   = 6561  (also ChatterboxConfig.START_SPEECH_TOKEN)
 *   [STOP_SPEECH]    = 6562  (also ChatterboxConfig.STOP_SPEECH_TOKEN)
 *   [EXAGGERATION]   = 6563
 */
class ChatterboxBpeTokenizer private constructor(
    private val vocab: Map<String, Int>,
    /** map: pair-of-strings → merge rank (lower = applied first) */
    private val mergeRanks: Map<Pair<String, String>, Int>,
    private val specialTokens: Map<String, Int>,
) : ChatterboxTokenizer {

    private val unkId: Int = specialTokens["[UNK]"] ?: 1
    private val whitespaceRegex = Regex("\\s+")

    /**
     * Encode [text] following the tokenizer.json pipeline:
     *   1. normalize
     *   2. BPE-encode
     *   3. wrap with the post-processor template tokens
     */
    override fun encode(text: String): IntArray {
        val normalized = whitespaceRegex.replace(text, " ").trim()
        val bpe = bpeEncode(normalized)
        return wrapWithTemplate(bpe)
    }

    /** BPE: start from individual characters, then merge until no more merges fire. */
    private fun bpeEncode(text: String): List<Int> {
        if (text.isEmpty()) return emptyList()

        // Start with single-character tokens. The chatterbox vocab is ASCII-
        // ish so each character is its own starting token.
        val parts = ArrayList<String>(text.length)
        for (ch in text) parts.add(ch.toString())

        // Iteratively pick the merge with the lowest rank (i.e. earliest in
        // the merges list = most frequent in training).
        while (parts.size > 1) {
            var bestIdx = -1
            var bestRank = Int.MAX_VALUE
            for (i in 0 until parts.size - 1) {
                val rank = mergeRanks[Pair(parts[i], parts[i + 1])] ?: continue
                if (rank < bestRank) {
                    bestRank = rank
                    bestIdx = i
                }
            }
            if (bestIdx < 0) break

            // Apply the merge in-place.
            val merged = parts[bestIdx] + parts[bestIdx + 1]
            parts[bestIdx] = merged
            parts.removeAt(bestIdx + 1)
        }

        return parts.map { vocab[it] ?: unkId }
    }

    /**
     * Reproduces the `TemplateProcessing` single-sequence wrapping from
     * tokenizer.json:
     *   `[EXAGGERATION] [START] <content> [STOP] [START_SPEECH] [START_SPEECH]`
     *
     * Note the two trailing [START_SPEECH] tokens — that's intentional in
     * the upstream config.
     */
    private fun wrapWithTemplate(content: List<Int>): IntArray {
        val exag = specialTokens["[EXAGGERATION]"] ?: error("missing [EXAGGERATION]")
        val start = specialTokens["[START]"] ?: error("missing [START]")
        val stop = specialTokens["[STOP]"] ?: error("missing [STOP]")
        val startSpeech = specialTokens["[START_SPEECH]"] ?: error("missing [START_SPEECH]")

        val out = IntArray(content.size + 5)
        out[0] = exag
        out[1] = start
        for (i in content.indices) out[2 + i] = content[i]
        out[2 + content.size] = stop
        out[3 + content.size] = startSpeech
        out[4 + content.size] = startSpeech
        return out
    }

    companion object {
        private const val TAG = "ChatterboxBpeTokenizer"

        /**
         * Load + parse `tokenizer.json` from disk. Returns a tokenizer ready
         * to call [encode] on. Throws if the file is malformed.
         */
        fun loadFromFile(file: File): ChatterboxBpeTokenizer {
            val json = JSONObject(file.readText())

            // -------- vocab --------
            val modelObj = json.getJSONObject("model")
            val vocabObj = modelObj.getJSONObject("vocab")
            val vocab = HashMap<String, Int>(vocabObj.length() * 2)
            val keys = vocabObj.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                vocab[k] = vocabObj.getInt(k)
            }

            // -------- merges --------
            val mergesArr = modelObj.getJSONArray("merges")
            val mergeRanks = HashMap<Pair<String, String>, Int>(mergesArr.length() * 2)
            for (i in 0 until mergesArr.length()) {
                // Each entry is a single string like "th e" — two tokens
                // separated by a space.
                val raw = mergesArr.getString(i)
                val sp = raw.indexOf(' ')
                if (sp <= 0 || sp == raw.length - 1) continue
                val a = raw.substring(0, sp)
                val b = raw.substring(sp + 1)
                mergeRanks[Pair(a, b)] = i
            }

            // -------- special tokens --------
            val specialTokens = HashMap<String, Int>()
            val added = json.optJSONArray("added_tokens")
            if (added != null) {
                for (i in 0 until added.length()) {
                    val tok = added.getJSONObject(i)
                    val content = tok.getString("content")
                    val id = tok.getInt("id")
                    specialTokens[content] = id
                }
            }
            // Belt-and-suspenders: ensure the IDs we need are present even
            // if added_tokens was incomplete in a future export.
            specialTokens.putIfAbsent("[EXAGGERATION]", ChatterboxConfig.START_SPEECH_TOKEN + 2) // 6563
            specialTokens.putIfAbsent("[START_SPEECH]", ChatterboxConfig.START_SPEECH_TOKEN)     // 6561
            specialTokens.putIfAbsent("[STOP_SPEECH]", ChatterboxConfig.STOP_SPEECH_TOKEN)        // 6562
            specialTokens.putIfAbsent("[STOP]", 0)
            specialTokens.putIfAbsent("[START]", 255)
            specialTokens.putIfAbsent("[UNK]", 1)

            Log.i(TAG, "loaded tokenizer.json: ${vocab.size} vocab, " +
                "${mergeRanks.size} merges, ${specialTokens.size} special tokens")

            return ChatterboxBpeTokenizer(vocab, mergeRanks, specialTokens)
        }
    }
}
