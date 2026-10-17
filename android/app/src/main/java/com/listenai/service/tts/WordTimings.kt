package com.listenai.service.tts

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Word timings for one synthesized text, from the realtime-tts alignment worker.
 *
 * The worker answers a `synthesize` message that carries `"alignment": true` with one `chunk_meta` per sentence;
 * each has `t0` (seconds of audio sent before that chunk) and `words: [{start_char, end_char, start, end}]` with
 * `start`/`end` relative to the chunk. [Collector] turns those into absolute times over the whole audio; the char
 * offsets index [spokenText], the exact string that was sent to the server.
 *
 * Persisted next to the audio file as `<audio>.words.json` so a cached article keeps its word highlighting
 * without a database migration. Everything here is plain Kotlin (org.json only) so it is unit-testable on the JVM.
 */
class WordTimings(val spokenText: String, val words: List<Word>) {

    data class Word(val startChar: Int, val endChar: Int, val start: Double, val end: Double)

    /**
     * The word being spoken at [timeSec]: the last word whose start is at or before the time. Before the first
     * word (the voice's lead-in silence) this is the first word, so the highlight does not flicker off at 0:00.
     * Null only when there are no words.
     */
    fun indexAt(timeSec: Double): Int? {
        if (words.isEmpty()) return null
        var lo = 0
        var hi = words.size - 1
        var ans = 0
        while (lo <= hi) {
            val mid = (lo + hi) ushr 1
            if (words[mid].start <= timeSec) { ans = mid; lo = mid + 1 } else hi = mid - 1
        }
        return ans
    }

    /** The same data in the app's existing result model. [sectionStarts] are the start offsets of each section in [spokenText]. */
    fun toWordTimestamps(sectionStarts: List<Int>): List<WordTimestamp> = words.map { w ->
        val section = sectionStarts.indexOfLast { it <= w.startChar }.coerceAtLeast(0)
        WordTimestamp(
            word = spokenText.substring(w.startChar.coerceIn(0, spokenText.length), w.endChar.coerceIn(0, spokenText.length)),
            startTime = w.start,
            endTime = w.end,
            sectionIndex = section,
            characterRange = w.startChar until w.endChar
        )
    }

    fun toJson(): String {
        val arr = JSONArray()
        for (w in words) arr.put(JSONArray().put(w.startChar).put(w.endChar).put(w.start).put(w.end))
        return JSONObject().put("v", 1).put("text", spokenText).put("words", arr).toString()
    }

    /** Accumulates `chunk_meta` messages while a synthesis streams in. */
    class Collector {
        private val out = ArrayList<Word>()

        fun add(chunkMeta: JSONObject) {
            val arr = chunkMeta.optJSONArray("words") ?: return
            val t0 = chunkMeta.optDouble("t0", Double.NaN)
            if (t0.isNaN() || t0 < 0) return
            for (i in 0 until arr.length()) {
                val w = arr.optJSONObject(i) ?: continue
                if (w.isNull("start") || w.isNull("end") || !w.has("start_char") || !w.has("end_char")) continue
                val s = w.optDouble("start", Double.NaN)
                val e = w.optDouble("end", Double.NaN)
                val cs = w.optInt("start_char", -1)
                val ce = w.optInt("end_char", -1)
                if (s.isNaN() || e.isNaN() || cs < 0 || ce <= cs || e < s) continue
                out.add(Word(cs, ce, t0 + s, t0 + e))
            }
        }

        /** Null when nothing usable arrived or the offsets do not fit [spokenText] (then the app keeps paragraph highlighting). */
        fun build(spokenText: String): WordTimings? {
            if (out.isEmpty()) return null
            if (out.any { it.endChar > spokenText.length }) return null
            val sorted = out.sortedBy { it.start }
            return WordTimings(spokenText, sorted)
        }
    }

    companion object {
        fun sidecarFor(audio: File): File = File(audio.path + ".words.json")

        fun fromJson(json: String): WordTimings? = try {
            val o = JSONObject(json)
            if (o.optInt("v", 0) != 1) null else {
                val text = o.getString("text")
                val arr = o.getJSONArray("words")
                val list = ArrayList<Word>(arr.length())
                for (i in 0 until arr.length()) {
                    val a = arr.getJSONArray(i)
                    list.add(Word(a.getInt(0), a.getInt(1), a.getDouble(2), a.getDouble(3)))
                }
                if (list.any { it.endChar > text.length || it.startChar < 0 || it.endChar <= it.startChar }) null
                else WordTimings(text, list)
            }
        } catch (e: Exception) {
            null
        }

        fun save(audio: File, timings: WordTimings) {
            try { sidecarFor(audio).writeText(timings.toJson()) } catch (_: Exception) { /* highlighting is optional */ }
        }

        fun load(audioPath: String): WordTimings? = try {
            val f = sidecarFor(File(audioPath))
            if (f.isFile && f.length() in 1..2_000_000) fromJson(f.readText()) else null
        } catch (e: Exception) {
            null
        }
    }
}
