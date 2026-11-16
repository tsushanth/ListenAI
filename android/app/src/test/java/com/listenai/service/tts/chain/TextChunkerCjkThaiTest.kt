package com.listenai.service.tts.chain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.text.BreakIterator
import java.util.Locale

/** Chunking of scripts written without spaces (Chinese, Japanese, Thai) and of Korean, with real sample text. */
class TextChunkerCjkThaiTest {

    private fun cps(s: String) = s.codePointCount(0, s.length)

    private fun joined(chunks: List<String>) = chunks.joinToString("").replace(" ", "")

    /** Offsets (in the text without spaces) where [chunks] end. */
    private fun cutOffsets(chunks: List<String>): List<Int> {
        var n = 0
        return chunks.dropLast(1).map { n += it.replace(" ", "").length; n }
    }

    private fun wordBoundaries(text: String, locale: Locale): Set<Int> {
        val bi = BreakIterator.getWordInstance(locale)
        bi.setText(text)
        val out = HashSet<Int>()
        var b = bi.first()
        while (b != BreakIterator.DONE) { out += b; b = bi.next() }
        return out
    }

    private val chineseNews =
        "今天上午，市政府召开新闻发布会，介绍了今年冬季供暖工作的安排。" +
            "据介绍，全市共有三百多个小区将在十一月十五日前后开始供暖！" +
            "市民如果遇到室内温度偏低的情况，可以拨打服务热线反映问题？" +
            "工作人员表示，他们会在二十四小时内上门检查。"

    private val japaneseStory =
        "昨日、友達と一緒に新しい映画を見に行きました。映画館はとても混んでいましたが、席は前の方に空いていました。" +
            "上映が終わった後、近くの喫茶店でコーヒーを飲みながら感想を話しました。"

    private val koreanNews =
        "오늘 오전 서울시는 기자회견을 열고 올겨울 난방 대책을 발표했다. " +
            "시에 따르면 약 삼백여 개 단지가 십일월 중순부터 난방을 시작한다. " +
            "실내 온도가 낮다고 느끼는 시민은 상담 전화로 신고하면 된다."

    // One sentence, no punctuation, no spaces: the situation where a cut inside a word was unavoidable before.
    private val thaiUnbroken = "ฉันไปตลาดเมื่อวานนี้เพื่อซื้อผลไม้และผักสดสำหรับทำอาหารเย็นให้ครอบครัวและเพื่อนบ้านที่มาเยี่ยมที่บ้านของเรา"

    private val thaiWithSpaces = "สวัสดีครับ วันนี้อากาศดีมาก เราไปเดินเล่นที่สวนสาธารณะกันเถอะ แล้วค่อยไปกินข้าวเย็นด้วยกันที่ร้านอาหารใกล้บ้าน"

    @Test fun `Chinese sentences split at the ideographic full stop without needing a space`() {
        val chunks = TextChunker.split(chineseNews, 40, 20)
        assertTrue(chunks.size >= 4)
        assertTrue(chunks.all { cps(it) <= 40 })
        assertEquals(chineseNews, joined(chunks))
        // every chunk ends at a sentence or clause end, never mid-phrase, because each sentence fits the limit
        assertTrue(chunks.all { it.last() in "。！？，" })
    }

    @Test fun `Chinese fullwidth exclamation and question marks end a sentence`() {
        val chunks = TextChunker.split("你好！你叫什么名字？我叫小明。", 6, 6)
        assertEquals(listOf("你好！", "你叫什么名字？", "我叫小明。"), chunks.let { c ->
            // the second sentence is 7 code points with its mark: it is allowed to stand alone, the others are packed by the limit
            listOf(c[0], c[1], c[2])
        })
    }

    @Test fun `halfwidth ideographic full stop also ends a sentence`() {
        val chunks = TextChunker.split("今日は晴れです｡明日は雨でしょう｡", 8, 8)
        assertEquals(listOf("今日は晴れです｡", "明日は雨でしょう｡"), chunks)
    }

    @Test fun `a long Chinese sentence with no punctuation is cut by code points and loses nothing`() {
        val text = "我们昨天晚上和很多朋友一起在公园里散步聊天唱歌跳舞一直玩到深夜才依依不舍地各自回家休息".repeat(3)
        val chunks = TextChunker.split(text, 30, 20)
        assertTrue(chunks.size > 2)
        assertTrue("every chunk within the limit: ${chunks.map { cps(it) }}", chunks.all { cps(it) <= 30 })
        assertEquals(text, joined(chunks))
    }

    @Test fun `a Chinese clause mark is preferred over a hard cut`() {
        val text = "因为今天的天气实在是太好了，所以我们决定一起去海边玩一整天直到太阳下山才回家"
        val chunks = TextChunker.split(text, 20, 20)
        assertEquals("因为今天的天气实在是太好了，", chunks.first())
        assertEquals(text, joined(chunks))
    }

    @Test fun `Japanese splits at the full stop and at the comma`() {
        val chunks = TextChunker.split(japaneseStory, 30, 20)
        assertTrue(chunks.all { cps(it) <= 30 })
        assertEquals(japaneseStory, joined(chunks))
        assertTrue(chunks.first().endsWith("。") || chunks.first().endsWith("、"))
        // no chunk is only punctuation or starts with a closing mark
        assertTrue(chunks.none { it.first() in "。、」』" })
    }

    @Test fun `Japanese with no punctuation is cut at word boundaries`() {
        val text = "私は昨日友達と一緒に新しい映画を見に行きましたそして帰りに近くのお店で温かいお茶を飲みました"
        val chunks = TextChunker.split(text, 14, 14)
        assertTrue(chunks.size >= 2)
        assertTrue(chunks.all { cps(it) <= 14 })
        assertEquals(text, joined(chunks))
        val ok = wordBoundaries(text, Locale.JAPANESE)
        val bad = cutOffsets(chunks).filter { it !in ok }
        assertTrue("cuts inside a word at $bad", bad.isEmpty())
    }

    @Test fun `Korean is cut at spaces so no word is split`() {
        val chunks = TextChunker.split(koreanNews, 30, 20)
        assertTrue(chunks.all { cps(it) <= 30 })
        val words = koreanNews.split(" ").toSet()
        for (c in chunks) for (w in c.split(" ")) assertTrue("'$w' is a whole word", w in words)
        assertEquals(koreanNews.replace(" ", ""), joined(chunks))
    }

    @Test fun `unbroken Thai is cut at Thai word boundaries, never inside a word`() {
        val chunks = TextChunker.split(thaiUnbroken, 30, 30)
        assertTrue(chunks.size >= 2)
        assertTrue("every chunk within the limit: ${chunks.map { cps(it) }}", chunks.all { cps(it) <= 30 })
        assertEquals(thaiUnbroken, joined(chunks))
        val ok = wordBoundaries(thaiUnbroken, Locale("th"))
        val bad = cutOffsets(chunks).filter { it !in ok }
        assertTrue("cuts inside a word at $bad", bad.isEmpty())
        // a Thai chunk never starts with a vowel sign or tone mark (they belong to the letter before)
        assertTrue(chunks.none { Character.getType(it.first()) == Character.NON_SPACING_MARK.toInt() })
    }

    @Test fun `Thai with spaces between phrases is cut at a space when one is in reach`() {
        val chunks = TextChunker.split(thaiWithSpaces, 40, 25)
        assertTrue(chunks.all { cps(it) <= 40 })
        val phrases = thaiWithSpaces.split(" ").toSet()
        // every chunk is built of whole phrases (the longest phrase here is shorter than the limit)
        for (c in chunks) for (p in c.split(" ")) assertTrue("'$p' is a whole phrase", p in phrases)
        assertEquals(thaiWithSpaces.replace(" ", ""), joined(chunks))
    }

    @Test fun `the limit counts code points, so supplementary-plane ideographs are not counted twice`() {
        val text = "𠀀".repeat(100) // U+20000, 100 code points, 200 UTF-16 units
        val chunks = TextChunker.split(text, 60, 60)
        assertEquals(2, chunks.size)
        assertEquals(60, cps(chunks[0]))
        assertEquals(40, cps(chunks[1]))
        assertEquals(text, joined(chunks))
    }

    @Test fun `the first chunk of Chinese text is short so audio starts early`() {
        val chunks = TextChunker.split(chineseNews, 90, 60)
        assertTrue(cps(chunks.first()) <= 60)
        assertEquals(chineseNews, joined(chunks))
    }

    @Test fun `Arabic comma is a clause mark`() {
        val text = "ذهبت إلى السوق أمس، واشتريت الفواكه والخضروات الطازجة لأعد عشاء لعائلتي وأصدقائي الذين زاروني"
        val chunks = TextChunker.split(text, 40, 40)
        assertTrue(chunks.first().endsWith("،"))
        assertEquals(text.replace(" ", ""), joined(chunks))
    }
}
