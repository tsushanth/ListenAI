package com.listenai.systemtts

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.listenai.service.settings.SettingsManager

/**
 * Test helper — sets the in-app selected voice id (the one normally
 * picked via TTSEngineSettingsActivity) via an adb broadcast, so
 * automated routing tests don't need touch input on the voice picker.
 *
 *   adb shell am broadcast -a com.listenai.SET_VOICE \
 *     --es voice josh --receiver-include-background
 *
 * Pass `--es voice ""` to reset to default.
 */
class SetVoiceReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val voice = intent.getStringExtra("voice") ?: ""
        // SettingsManager uses apply() which is async — a follow-up
        // force-stop can land before the write flushes. Test loops
        // need synchronous commit, so write directly here too.
        val prefs = context.getSharedPreferences("listenai_settings", Context.MODE_PRIVATE)
        val editor = prefs.edit()
        if (voice.isBlank()) editor.remove("selected_voice_id") else editor.putString("selected_voice_id", voice)
        val ok = editor.commit()
        SettingsManager.getInstance(context).setSelectedVoiceId(if (voice.isBlank()) null else voice)
        Log.i(TAG, "selectedVoiceId := '$voice' (commit=$ok)")
    }
    companion object { private const val TAG = "SetVoiceReceiver" }
}
