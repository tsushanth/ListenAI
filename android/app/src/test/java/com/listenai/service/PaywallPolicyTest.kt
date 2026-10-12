package com.listenai.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PaywallPolicyTest {
    private val hour = 60L * 60L * 1000L
    private val now = 1_000_000_000_000L

    private fun show(
        openCount: Int,
        hasListened: Boolean,
        lastShownAgoHours: Long? = null,
        isPremium: Boolean = false,
        config: PaywallConfig = PaywallConfig()
    ) = PaywallPolicy.shouldShow(
        openCount = openCount,
        hasListened = hasListened,
        lastShownAtMs = lastShownAgoHours?.let { now - it * hour } ?: 0L,
        nowMs = now,
        isPremium = isPremium,
        config = config
    )

    @Test fun neverShownToPremiumUsers() {
        assertFalse(show(openCount = 50, hasListened = true, isPremium = true))
    }

    @Test fun notShownOnFirstSessionEvenAfterListening() {
        assertFalse(show(openCount = 1, hasListened = true))
    }

    @Test fun shownOnSecondSessionAfterFirstListen() {
        assertTrue(show(openCount = 2, hasListened = true))
    }

    @Test fun notShownToSomeoneWhoHasNotListenedUntilTheOpenLimitIsPassed() {
        assertFalse(show(openCount = 2, hasListened = false))
        assertFalse(show(openCount = 3, hasListened = false))
        assertTrue(show(openCount = 4, hasListened = false))
    }

    @Test fun cooldownBlocksARepeatWithinTheWindow() {
        assertFalse(show(openCount = 9, hasListened = true, lastShownAgoHours = 3))
        assertFalse(show(openCount = 9, hasListened = true, lastShownAgoHours = 23))
    }

    @Test fun showsAgainOnceTheCooldownHasPassed() {
        assertTrue(show(openCount = 9, hasListened = true, lastShownAgoHours = 24))
        assertTrue(show(openCount = 9, hasListened = true, lastShownAgoHours = 72))
    }

    @Test fun customConfigIsRespected() {
        val strict = PaywallConfig(minOpensAfterFirstListen = 5, openLimitWithoutListen = 10, cooldownHours = 48)
        assertFalse(show(openCount = 4, hasListened = true, config = strict))
        assertTrue(show(openCount = 5, hasListened = true, config = strict))
        assertFalse(show(openCount = 9, hasListened = false, config = strict))
        assertTrue(show(openCount = 11, hasListened = false, config = strict))
        assertFalse(show(openCount = 9, hasListened = true, lastShownAgoHours = 47, config = strict))
        assertTrue(show(openCount = 9, hasListened = true, lastShownAgoHours = 48, config = strict))
    }

    @Test fun defaultsMatchTheDocumentedValues() {
        val d = PaywallConfig()
        assertEquals(2, d.minOpensAfterFirstListen)
        assertEquals(3, d.openLimitWithoutListen)
        assertEquals(24, d.cooldownHours)
    }
}
