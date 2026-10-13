package com.listenai.systemtts

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Writes the Kokoro execution provider preference synchronously, so a
 * test harness can switch EPs without racing the service's auto-warmup
 * path.
 *
 * Usage:
 *   adb shell am broadcast -a com.listenai.SET_EP --es ep NNAPI_FP16
 *
 * After the broadcast returns, force-stop the app and launch the
 * benchmark — the new EP is durably on disk before ReadAloudTTSService's
 * onCreate fires.
 */
class SetEpReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val ep = intent.getStringExtra("ep") ?: run {
            Log.w(TAG, "SET_EP broadcast received without --es ep <name>")
            return
        }
        // commit() (not apply()) — caller will force-stop next, so we
        // need the write to flush before the process dies.
        val ok = context.getSharedPreferences("kokoro_ep", Context.MODE_PRIVATE)
            .edit()
            .putString("ep", ep)
            .commit()
        Log.i(TAG, "kokoro_ep.ep := $ep (commit=$ok)")
    }

    companion object {
        private const val TAG = "SetEpReceiver"
    }
}
