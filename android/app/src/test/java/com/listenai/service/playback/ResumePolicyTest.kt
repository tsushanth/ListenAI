package com.listenai.service.playback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ResumePolicyTest {
    @Test fun resumesInTheMiddle() {
        assertEquals(72.5, ResumePolicy.startPositionSeconds(72_500, false, 164.0)!!, 0.001)
    }

    @Test fun startsFromTheBeginningWhenAlreadyCompleted() {
        assertNull(ResumePolicy.startPositionSeconds(72_500, true, 164.0))
    }

    @Test fun ignoresAPositionInTheFirstFewSeconds() {
        assertNull(ResumePolicy.startPositionSeconds(0, false, 164.0))
        assertNull(ResumePolicy.startPositionSeconds(2_999, false, 164.0))
        assertEquals(3.0, ResumePolicy.startPositionSeconds(3_000, false, 164.0)!!, 0.001)
    }

    @Test fun ignoresAPositionAtTheVeryEnd() {
        assertNull(ResumePolicy.startPositionSeconds(163_000, false, 164.0))
        assertEquals(160.9, ResumePolicy.startPositionSeconds(160_900, false, 164.0)!!, 0.001)
    }

    @Test fun ignoresWhenTheAudioLengthIsUnknown() {
        assertNull(ResumePolicy.startPositionSeconds(72_500, false, 0.0))
    }

    @Test fun savedPositionBeyondTheNewAudioStartsOver() {
        // e.g. the article was re-synthesized shorter
        assertNull(ResumePolicy.startPositionSeconds(200_000, false, 164.0))
    }
}
