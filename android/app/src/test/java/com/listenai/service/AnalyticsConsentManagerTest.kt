package com.listenai.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AnalyticsConsentManagerTest {
    private class MemStore(var value: Int = 0) : ConsentStore {
        override fun read() = value
        override fun write(value: Int) { this.value = value }
    }

    @Test fun unsetMeansOffAndAppliesFalseAtStartup() {
        val applied = mutableListOf<Boolean>()
        val m = AnalyticsConsentManager(MemStore()) { applied += it }
        m.applyStored()
        assertEquals(ConsentState.UNSET, m.state.value)
        assertFalse(m.isGranted)
        assertEquals(listOf(false), applied)
    }

    @Test fun allowTurnsCollectionOnAndPersists() {
        val store = MemStore()
        val applied = mutableListOf<Boolean>()
        val m = AnalyticsConsentManager(store) { applied += it }
        m.setGranted(true)
        assertTrue(m.isGranted)
        assertEquals(1, store.value)
        assertEquals(listOf(true), applied)
        // A fresh manager (next launch) restores the choice.
        val next = AnalyticsConsentManager(store) { applied += it }
        assertEquals(ConsentState.GRANTED, next.state.value)
        next.applyStored()
        assertEquals(listOf(true, true), applied)
    }

    @Test fun declineTurnsCollectionOffAndIsNotAskedAgain() {
        val store = MemStore()
        val applied = mutableListOf<Boolean>()
        val m = AnalyticsConsentManager(store) { applied += it }
        m.setGranted(true)
        m.setGranted(false)
        assertEquals(ConsentState.DECLINED, m.state.value)
        assertEquals(2, store.value)
        assertEquals(listOf(true, false), applied)
        assertEquals(ConsentState.DECLINED, AnalyticsConsentManager(store) {}.state.value)
    }
}
