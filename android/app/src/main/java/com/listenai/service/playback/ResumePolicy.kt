package com.listenai.service.playback

/** Decides where playback should start when an article that was partly listened to is reopened. */
object ResumePolicy {
    /** Positions earlier than this are treated as "not started". */
    const val MIN_RESUME_MS = 3_000L

    /** A saved position this close to the end is treated as "finished". */
    const val END_MARGIN_SEC = 3.0

    /**
     * Seconds to seek to, or null to start from the beginning.
     * [lastPositionMs] is the saved position, [durationSec] the length of the audio now playing.
     */
    fun startPositionSeconds(lastPositionMs: Long, isCompleted: Boolean, durationSec: Double): Double? {
        if (isCompleted) return null
        if (lastPositionMs < MIN_RESUME_MS) return null
        if (durationSec <= 0.0) return null
        val pos = lastPositionMs / 1000.0
        if (pos >= durationSec - END_MARGIN_SEC) return null
        return pos
    }
}
