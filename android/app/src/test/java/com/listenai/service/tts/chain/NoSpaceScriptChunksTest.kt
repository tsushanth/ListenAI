package com.listenai.service.tts.chain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the chain sends to the cloud for scripts written without spaces (Chinese, Thai) and for Arabic: never a blank chunk, never a
 * one-character chunk, never a cut inside a character, and nothing lost. Uses the chunk sizes the chain really uses for a cloud read.
 */
class NoSpaceScriptChunksTest {

    private val chain = TtsSourceChain(emptyMap(), { emptyList() })

    private val zh = "今天上午，市政府召开了新闻发布会，介绍今年冬季供暖工作的安排。全市共有300多个小区将在11月15日前后开始供暖。市民如果遇到室内温度偏低的情况，可以拨打服务热线反映问题。"
    private val zhNoPunct = "我们昨天晚上和很多朋友一起在公园里散步聊天唱歌跳舞一直玩到深夜才依依不舍地各自回家休息".repeat(4)
    private val th = "วันนี้ฉันไปตลาดตอนเช้าเพื่อซื้อผลไม้และผักสดสำหรับทำอาหารเย็น ราคามะม่วงกิโลกรัมละ 45 บาท ฉันซื้อไปทั้งหมด 3 กิโลกรัม แล้วกลับบ้านตอนเที่ยง"
    private val thNoSpace = "ฉันไปตลาดเมื่อวานนี้เพื่อซื้อผลไม้และผักสดสำหรับทำอาหารเย็นให้ครอบครัวและเพื่อนบ้านที่มาเยี่ยมที่บ้านของเรา".repeat(3)
    private val ar = "ذهبت اليوم إلى السوق في الصباح لشراء الفواكه والخضروات الطازجة. كان سعر المانجو 45 ريالا للكيلوغرام الواحد. اشتريت ثلاثة كيلوغرامات ثم عدت إلى البيت عند الظهر."

    private fun letters(s: String) = s.codePoints().filter { Character.isLetterOrDigit(it) }.count()

    private fun check(lang: String, text: String, label: String) {
        val chunks = chain.chunkPlan(text, TtsRequest("bella", lang), cloudWillRead = true, mergeTinyChunks = true)
        assertTrue("$label: no chunks", chunks.isNotEmpty())
        for (c in chunks) {
            assertTrue("$label: blank chunk", c.isNotBlank())
            assertTrue("$label: chunk with fewer than 2 letters '${c.length}'", letters(c) >= 2)
            assertTrue("$label: chunk splits a surrogate pair", !Character.isLowSurrogate(c.first()) && !Character.isHighSurrogate(c.last()))
        }
        assertEquals("$label: text lost or changed", text.filterNot { it.isWhitespace() }, chunks.joinToString("").filterNot { it.isWhitespace() })
    }

    @Test fun `real Chinese, Thai and Arabic text is never cut into blank or one-character chunks`() {
        check("zh", zh, "zh"); check("zh", zhNoPunct, "zh no punctuation")
        check("th", th, "th"); check("th", thNoSpace, "th no spaces")
        check("ar", ar, "ar")
    }

    @Test fun `every prefix length of the samples gives sane chunks (no tiny tail)`() {
        for ((lang, text) in listOf("zh" to zh, "zh" to zhNoPunct, "th" to th, "th" to thNoSpace, "ar" to ar)) {
            for (n in 12..text.length) {
                val t = text.take(n).let { if (it.length > 1 && Character.isHighSurrogate(it.last())) it.dropLast(1) else it }
                // a prefix can end mid-word or mid-cluster of the source text; only chunks made from whole prefixes are judged
                val chunks = chain.chunkPlan(t, TtsRequest("bella", lang), cloudWillRead = true, mergeTinyChunks = true)
                for (c in chunks) assertTrue("$lang n=$n: '${c.length}' chars, ${letters(c)} letters", c.isNotBlank() && (letters(c) >= 2 || chunks.size == 1))
            }
        }
    }

    @Test fun `a one-character sentence left over joins the chunk before it, and other plans are not changed`() {
        val long = zh.take(31) // exactly the first sentence, which is flushed as the first chunk
        assertEquals(listOf(long, "全"), chain.chunkPlan(long + "全", TtsRequest("bella", "zh"), cloudWillRead = true))
        assertEquals(listOf("$long 全"), chain.chunkPlan(long + "全", TtsRequest("bella", "zh"), cloudWillRead = true, mergeTinyChunks = true))
        assertEquals(listOf("全 市场很大。"), TextChunker.mergeTiny(listOf("全", "市场很大。")))
        assertEquals(listOf("你好。", "我是小明。"), TextChunker.mergeTiny(listOf("你好。", "我是小明。")))
    }

    @Test fun `a short chunk plan has no more chunks than it needs`() {
        assertEquals(1, chain.chunkPlan("你好，今天天气很好。", TtsRequest("bella", "zh"), cloudWillRead = true, mergeTinyChunks = true).size)
        assertEquals(1, chain.chunkPlan("สวัสดีครับ วันนี้อากาศดีมาก", TtsRequest("bella", "th"), cloudWillRead = true, mergeTinyChunks = true).size)
    }
}
