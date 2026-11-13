package com.listenai

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every shipped locale must carry every string of the language and speech-voice flow, with the same placeholders as
 * the English text (a lost %1$s turns into a crash or a sentence with a hole). These strings are machine translated.
 * New strings of this flow use the `lang_` or `speech_` prefix and are covered automatically.
 */
class LocalizationTest {
    private val res: File = listOf(File("src/main/res"), File("app/src/main/res")).first { it.isDirectory }

    private val explicitKeys = setOf(
        "player_install_voice_data", "player_install_tts_engine", "voice_request_cta", "voice_request_thanks",
    )

    private fun strings(file: File): Map<String, String> =
        Regex("""<string\s+name="([^"]+)"[^>]*>(.*?)</string>""", RegexOption.DOT_MATCHES_ALL)
            .findAll(file.readText()).associate { it.groupValues[1] to it.groupValues[2] }

    private val base = strings(File(res, "values/strings.xml"))
    private val required = base.keys.filter { it.startsWith("lang_") || it.startsWith("speech_") || it in explicitKeys }.sorted()
    private val locales = res.listFiles { f -> f.isDirectory && f.name.startsWith("values-") && File(f, "strings.xml").exists() }!!
        .sortedBy { it.name }

    private fun placeholders(s: String) = Regex("""%(\d+\$)?[sdf]""").findAll(s).map { it.value }.sorted().toList()

    @Test fun `the flow has strings and there are locales to check`() {
        assertTrue("expected the language flow strings, found ${required.size}", required.size >= 18)
        assertTrue("expected the shipped locales, found ${locales.size}", locales.size >= 19)
    }

    @Test fun `every locale has every key of the language and voice flow`() {
        val missing = locales.flatMap { dir ->
            val have = strings(File(dir, "strings.xml")).keys
            required.filter { it !in have }.map { "${dir.name}:$it" }
        }
        assertEquals("missing translations", emptyList<String>(), missing)
    }

    @Test fun `placeholders match the English text in every locale`() {
        val bad = locales.flatMap { dir ->
            val have = strings(File(dir, "strings.xml"))
            required.filter { have[it] != null && placeholders(have[it]!!) != placeholders(base.getValue(it)) }.map { "${dir.name}:$it" }
        }
        assertEquals("placeholder mismatch", emptyList<String>(), bad)
    }

    @Test fun `translations are not left in English`() {
        // The two short labels that can legitimately match across languages are exempt.
        val exempt = setOf("lang_chip_auto")
        val same = locales.flatMap { dir ->
            val have = strings(File(dir, "strings.xml"))
            required.filter { it !in exempt && have[it] == base[it] }.map { "${dir.name}:$it" }
        }
        assertEquals("still English", emptyList<String>(), same)
    }
}
