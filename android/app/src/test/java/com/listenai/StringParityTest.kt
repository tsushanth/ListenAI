package com.listenai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * Every translatable string of values/strings.xml must exist in every shipped locale with the same format
 * specifiers, plurals must carry the CLDR categories of their language, and the per-app language list
 * (locales_config.xml) must be exactly the shipped locale folders. Added after 73 strings had stayed English
 * in all 19 locales for seven months. The translations are machine written and still need a native read.
 */
class StringParityTest {
    private val res: File = listOf(File("src/main/res"), File("app/src/main/res")).first { it.isDirectory }
    private val main: File = res.parentFile

    /** Used only by the separate `voice` build flavor (engine name shown in the system TTS settings): a brand name. */
    private val notTranslated = setOf("system_tts_engine_name")

    private class Entry(val text: String, val plural: Set<String>?)

    private fun parse(file: File): Map<String, Entry> {
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(file)
        val out = LinkedHashMap<String, Entry>()
        val nodes = doc.documentElement.childNodes
        for (i in 0 until nodes.length) {
            val e = nodes.item(i) as? Element ?: continue
            when (e.tagName) {
                "string" -> if (e.getAttribute("translatable") != "false") out[e.getAttribute("name")] = Entry(e.textContent, null)
                "plurals" -> {
                    val items = e.getElementsByTagName("item")
                    val cats = (0 until items.length).map { (items.item(it) as Element).getAttribute("quantity") }.toSet()
                    val text = (0 until items.length).joinToString("\n") { items.item(it).textContent }
                    out[e.getAttribute("name")] = Entry(text, cats)
                }
            }
        }
        return out
    }

    private val base = parse(File(res, "values/strings.xml")).filterKeys { it !in notTranslated }
    private val locales: Map<String, Map<String, Entry>> = res.listFiles { f -> f.isDirectory && f.name.startsWith("values-") && File(f, "strings.xml").exists() }!!
        .sortedBy { it.name }.associate { it.name.removePrefix("values-") to parse(File(it, "strings.xml")) }

    private fun specs(s: String) = Regex("""%(\d+\$)?[sdf]|%%""").findAll(s).map { it.value }.toSet()

    /** CLDR plural categories Android needs per language (https://cldr.unicode.org/index/cldr-spec/plural-rules), at least. */
    private val pluralCategories = mapOf(
        "ar" to setOf("zero", "one", "two", "few", "many", "other"),
        "pl" to setOf("one", "few", "many", "other"),
        "ru" to setOf("one", "few", "many", "other"),
        "ja" to setOf("other"), "ko" to setOf("other"), "zh-rCN" to setOf("other"), "th" to setOf("other"),
        "vi" to setOf("other"), "in" to setOf("other"), "ms" to setOf("other"),
    ).withDefault { setOf("one", "other") }

    @Test fun `there are locales to check`() {
        assertTrue("found ${locales.keys}", locales.size >= 19)
    }

    @Test fun `every locale has every translatable key`() {
        val missing = locales.flatMap { (loc, m) -> base.keys.filter { it !in m }.map { "$loc:$it" } }
        assertEquals("missing translations", emptyList<String>(), missing)
    }

    @Test fun `no locale has a key the default file lacks`() {
        val extra = locales.flatMap { (loc, m) -> m.keys.filter { it !in base }.map { "$loc:$it" } }
        assertEquals("keys without a default", emptyList<String>(), extra)
    }

    @Test fun `format specifiers match the default text`() {
        val bad = locales.flatMap { (loc, m) ->
            base.filter { (k, v) -> m[k] != null && v.plural == null && specs(m.getValue(k).text) != specs(v.text) }.keys.map { "$loc:$it" }
        }
        assertEquals("specifier mismatch", emptyList<String>(), bad)
    }

    @Test fun `plurals cover the categories of their language and are plurals in every locale`() {
        val bad = locales.flatMap { (loc, m) ->
            base.filter { it.value.plural != null }.keys.mapNotNull { k ->
                val got = m[k]?.plural
                val need = pluralCategories.getValue(loc)
                if (got == null || !got.containsAll(need)) "$loc:$k" else null
            }
        }
        assertEquals("plural categories", emptyList<String>(), bad)
    }

    @Test fun `locales_config lists exactly the shipped locales`() {
        // Folder name -> language tag the system uses (id is stored as in, Filipino is fil, regions kept).
        val tags = locales.keys.map {
            when (it) { "in" -> "id"; "pt-rBR" -> "pt-BR"; "zh-rCN" -> "zh-CN"; else -> it }
        }.toSet() + "en"
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File(res, "xml/locales_config.xml"))
        val listed = (0 until doc.getElementsByTagName("locale").length)
            .map { (doc.getElementsByTagName("locale").item(it) as Element).getAttribute("android:name") }
        assertEquals("duplicates in locales_config", listed.size, listed.toSet().size)
        assertEquals("locales_config vs values-* folders", tags.sorted(), listed.sorted())
    }

    @Test fun `app language is remembered below Android 13`() {
        val manifest = File(main, "AndroidManifest.xml").readText()
        assertTrue("AppLocalesMetadataHolderService with autoStoreLocales is missing",
            manifest.contains("AppLocalesMetadataHolderService") && manifest.contains("autoStoreLocales"))
    }
}
