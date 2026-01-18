package com.listenai.receiver

import androidx.media3.session.MediaButtonReceiver

/**
 * Receiver for hardware media button events (headphones, car controls, etc.)
 * Extends Media3's MediaButtonReceiver to handle media button intents
 * and forward them to the active MediaSession.
 */
class MediaButtonReceiver : MediaButtonReceiver()
