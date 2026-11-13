package com.listenai.service.tts

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * Runs one job at a time: starting a new one, or calling [cancel], cancels the previous one. The block also receives
 * `isCurrent`, which turns false as soon as the job has been replaced or cancelled, so work that does not stop on
 * cancellation (a database write, a callback that fires late) can check it before it changes state.
 * Used from one thread (the UI's).
 */
class LatestJob {
    private var job: Job? = null
    @Volatile private var generation = 0

    fun launch(scope: CoroutineScope, block: suspend CoroutineScope.(isCurrent: () -> Boolean) -> Unit): Job {
        cancel()
        val mine = generation
        return scope.launch { block { generation == mine } }.also { job = it }
    }

    fun cancel() {
        generation++
        job?.cancel()
        job = null
    }
}
