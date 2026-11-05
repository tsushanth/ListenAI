package com.listenai.service.tts.chain

/**
 * Which callers of the ReadAloud system TTS engine may have their text sent to the ReadAloud API.
 *
 * Text that other apps ask the engine to speak can be private (messages, mail, form fields read aloud by a screen
 * reader). The API route is therefore refused for screen readers and accessibility services, and **fails closed**:
 * a caller we cannot identify is treated as not allowed. Pure Kotlin so it can be unit tested without Android.
 */
object EngineCallerPolicy {
    /** Packages that are known screen readers or accessibility readers. Never routed, even with the flag on. */
    val BLOCKED_PACKAGES: Set<String> = setOf(
        "com.google.android.marvin.talkback",
        "com.samsung.android.accessibility.talkback",
        "com.samsung.android.app.talkback",
        "com.android.talkback",
        "com.google.android.accessibility.selecttospeak",
        "com.google.android.accessibility.switchaccess",
        "com.google.android.accessibility.accessibilitymenu",
        "com.android.switchaccess",
        "com.nirenr.talkman",
        "com.dianming.phoneapp",
        "com.baidu.accessibility",
    )

    /** Anything whose package name looks like an accessibility reader, for readers not on the list. */
    private val BLOCKED_FRAGMENTS = listOf("talkback", "screenreader", "screen_reader", "accessibility", "voiceover", "selecttospeak")

    fun isBlockedPackage(pkg: String): Boolean {
        val p = pkg.lowercase()
        return p in BLOCKED_PACKAGES || BLOCKED_FRAGMENTS.any { p.contains(it) }
    }

    /**
     * @param callerPackages packages that share the caller's uid (empty if it could not be resolved)
     * @param enabledAccessibilityPackages packages of the accessibility services enabled on this device
     */
    fun mayRouteToApi(callerPackages: Collection<String>, enabledAccessibilityPackages: Collection<String>): Boolean {
        if (callerPackages.isEmpty()) return false // unidentified caller: fail closed
        val a11y = enabledAccessibilityPackages.toSet()
        return callerPackages.none { it in a11y || isBlockedPackage(it) }
    }
}
