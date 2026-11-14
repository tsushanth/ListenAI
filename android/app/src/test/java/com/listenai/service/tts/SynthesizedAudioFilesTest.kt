package com.listenai.service.tts

import com.listenai.service.LanguageAnalytics
import com.listenai.service.tts.chain.SourceId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class SynthesizedAudioFilesTest {
    @get:Rule val tmp = TemporaryFolder()

    @Test fun `voice kind is remembered next to the audio`() {
        val audio = File(tmp.root, "tts_1.wav").apply { writeBytes(ByteArray(10)) }
        assertNull(SynthesizedAudioFiles.readVoiceKind(audio.path))
        SynthesizedAudioFiles.writeVoiceKind(audio, SynthesizedAudioFiles.kindOf(SourceId.API))
        assertEquals("cloud", SynthesizedAudioFiles.readVoiceKind(audio.path))
        SynthesizedAudioFiles.writeVoiceKind(audio, SynthesizedAudioFiles.kindOf(SourceId.SYSTEM))
        assertEquals("system", SynthesizedAudioFiles.readVoiceKind(audio.path))
        assertEquals("system", SynthesizedAudioFiles.kindOf(SourceId.ON_DEVICE))
        assertNull(SynthesizedAudioFiles.kindOf(null))
        assertNull(SynthesizedAudioFiles.readVoiceKind(null))
    }

    @Test fun `deleting removes the audio and its sidecars, only inside the cache dir`() {
        val cache = tmp.newFolder("cache")
        val audio = File(cache, "tts_1.wav").apply { writeBytes(ByteArray(10)) }
        File(audio.path + ".words.json").writeText("{}")
        SynthesizedAudioFiles.writeVoiceKind(audio, "cloud")
        SynthesizedAudioFiles.deleteIfOurs(audio.path, cache)
        assertFalse(audio.exists())
        assertFalse(File(audio.path + ".words.json").exists())
        assertFalse(File(audio.path + ".voice").exists())

        val elsewhere = File(tmp.newFolder("exports"), "keep.wav").apply { writeBytes(ByteArray(10)) }
        SynthesizedAudioFiles.deleteIfOurs(elsewhere.path, cache)
        assertTrue(elsewhere.exists())
        SynthesizedAudioFiles.deleteIfOurs("https://example.com/a.mp3", cache) // not a local file in the cache dir: untouched, no crash
        SynthesizedAudioFiles.deleteIfOurs(null, cache)
    }

    @Test fun `playback params carry only a fixed voice kind and a language code`() {
        assertEquals(mapOf("voice_source" to "cloud", "content_language" to "es"), LanguageAnalytics.playbackParams("cloud", "es-MX"))
        assertEquals(mapOf("voice_source" to "system", "content_language" to "en"), LanguageAnalytics.playbackParams("system", "en"))
        // anything else (a voice name, an id, text) collapses to the fixed values
        assertEquals(mapOf("voice_source" to "unknown", "content_language" to "unknown"), LanguageAnalytics.playbackParams("es-es-x-eea-local", "Hola, esto es privado"))
        assertEquals("unknown", LanguageAnalytics.playbackParams(null, null)["voice_source"])
    }
}
