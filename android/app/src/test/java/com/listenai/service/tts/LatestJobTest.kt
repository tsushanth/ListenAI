package com.listenai.service.tts

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class LatestJobTest {

    @Test fun `starting a second job cancels the first and the first cannot write late`() = runTest {
        val job = LatestJob()
        val writes = ArrayList<String>()
        val firstStarted = CompletableDeferred<Unit>()
        // The first job ignores cancellation for its last step, like a slow write that is already underway.
        job.launch(this) { isCurrent ->
            firstStarted.complete(Unit)
            withContext(NonCancellable) { delay(1_000) }
            if (isCurrent()) writes += "old: completed with the wrong language"
        }
        firstStarted.await()
        job.launch(this) { isCurrent ->
            delay(500)
            if (isCurrent()) writes += "new: completed"
        }
        advanceUntilIdle()
        assertEquals(listOf("new: completed"), writes)
    }

    @Test fun `only one job runs at a time`() = runTest {
        val job = LatestJob()
        var running = 0
        var most = 0
        repeat(3) {
            job.launch(this) { _ ->
                running++; most = maxOf(most, running)
                try { delay(1_000) } finally { running-- }
            }
            testScheduler.runCurrent() // the job is now suspended in delay(); the next launch must cancel it
        }
        advanceUntilIdle()
        assertEquals(1, most)
        assertEquals(0, running)
    }

    @Test fun `cancel stops the running job and its isCurrent turns false`() = runTest {
        val job = LatestJob()
        var current = true
        var finished = false
        job.launch(this) { isCurrent ->
            try { delay(1_000); finished = true } finally { current = isCurrent() }
        }
        testScheduler.runCurrent()
        job.cancel()
        advanceUntilIdle()
        assertFalse(finished)
        assertFalse(current)
    }

    @Test fun `a job that is never replaced stays current`() = runTest {
        val job = LatestJob()
        var current = false
        job.launch(this) { isCurrent -> delay(10); current = isCurrent() }
        advanceUntilIdle()
        assertTrue(current)
    }
}
