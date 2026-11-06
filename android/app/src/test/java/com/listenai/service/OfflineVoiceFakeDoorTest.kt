package com.listenai.service

import com.listenai.service.fakedoor.FakeDoorController
import com.listenai.service.fakedoor.FakeDoorEventSink
import com.listenai.service.fakedoor.InterestStore
import com.listenai.service.fakedoor.OfflineVoiceFakeDoor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class OfflineVoiceFakeDoorTest {
    private class MemStore(var v: Boolean = false) : InterestStore {
        override fun isInterested() = v
        override fun setInterested(value: Boolean) { v = value }
    }

    private class Rig(consent: Boolean) {
        var granted = consent
        val events = mutableListOf<String>()
        val store = MemStore()
        val c = FakeDoorController(store, { granted }, FakeDoorEventSink { events += it })
    }

    @Test fun hiddenByDefault() {
        assertFalse(OfflineVoiceFakeDoor.isVisible(buildFlag = false, remoteFlag = false, isVoiceFlavor = false))
    }

    @Test fun eitherFlagShowsItInReaderFlavor() {
        assertTrue(OfflineVoiceFakeDoor.isVisible(true, false, false))
        assertTrue(OfflineVoiceFakeDoor.isVisible(false, true, false))
    }

    @Test fun neverInVoiceFlavor() {
        assertFalse(OfflineVoiceFakeDoor.isVisible(true, true, true))
    }

    @Test fun noEventsWithoutAnalyticsConsent() {
        val r = Rig(consent = false)
        r.c.onOpened()
        r.c.onNotifyMe()
        assertTrue(r.events.isEmpty())
    }

    @Test fun notifyMeStillSetsLocalFlagWithoutConsent() {
        val r = Rig(consent = false)
        r.c.onNotifyMe()
        assertTrue(r.c.interested)
        assertTrue(r.store.v)
    }

    @Test fun eventsLoggedWhenConsented() {
        val r = Rig(consent = true)
        r.c.onOpened()
        r.c.onNotifyMe()
        assertEquals(listOf(OfflineVoiceFakeDoor.EVENT_OPENED, OfflineVoiceFakeDoor.EVENT_NOTIFY), r.events)
    }

    @Test fun consentWithdrawnLaterStopsEventsImmediately() {
        val r = Rig(consent = true)
        r.c.onOpened()
        r.granted = false
        r.c.onOpened()
        assertEquals(listOf(OfflineVoiceFakeDoor.EVENT_OPENED), r.events)
    }

    @Test fun notifyEventCountedOncePerOptIn() {
        val r = Rig(consent = true)
        r.c.onNotifyMe()
        r.c.onNotifyMe()
        assertEquals(1, r.events.count { it == OfflineVoiceFakeDoor.EVENT_NOTIFY })
        r.c.onWithdraw()
        assertFalse(r.c.interested)
    }
}
