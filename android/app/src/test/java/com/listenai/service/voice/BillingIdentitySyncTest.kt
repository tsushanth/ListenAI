package com.listenai.service.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class BillingIdentitySyncTest {
    private class Fake : BillingIdentity {
        val calls = mutableListOf<String>()
        override fun logIn(userId: String) { calls += "in:$userId" }
        override fun logOut() { calls += "out" }
    }

    private val uuid = "11111111-2222-3333-4444-555555555555"

    @Test
    fun `logs in with the supabase uuid once`() {
        val f = Fake(); val s = BillingIdentitySync(f)
        s.onUser(uuid); s.onUser(uuid); s.onUser(uuid.uppercase())
        assertEquals(listOf("in:$uuid"), f.calls)
    }

    @Test
    fun `never logs in with null or non-uuid ids`() {
        val f = Fake(); val s = BillingIdentitySync(f)
        s.onUser(null); s.onUser("device-123"); s.onUser("\$RCAnonymousID:abc"); s.onUser("")
        assertEquals(emptyList<String>(), f.calls)
    }

    @Test
    fun `sign out logs out and allows the same user to log in again`() {
        val f = Fake(); val s = BillingIdentitySync(f)
        s.onUser(uuid); s.onSignedOut(); s.onUser(uuid)
        assertEquals(listOf("in:$uuid", "out", "in:$uuid"), f.calls)
    }

    @Test
    fun `switching users logs in the new one`() {
        val f = Fake(); val s = BillingIdentitySync(f)
        val other = "aaaaaaaa-2222-3333-4444-555555555555"
        s.onUser(uuid); s.onUser(other)
        assertEquals(listOf("in:$uuid", "in:$other"), f.calls)
    }
}
