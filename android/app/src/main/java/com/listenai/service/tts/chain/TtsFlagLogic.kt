package com.listenai.service.tts.chain

/** Pure part of the source flags: precedence and the remote config shape. */
object TtsFlagLogic {
    /** Local override (debug/bench) beats the remote value, which beats the build default. */
    fun resolve(override: Boolean?, remote: Boolean?, buildDefault: Boolean): Boolean = override ?: remote ?: buildDefault

    /** `{"tts":{"apiEnabled":true,"engineApiEnabled":false}}` from GET /api/config. Absent or non-boolean fields give null. */
    data class Remote(val apiEnabled: Boolean?, val engineApiEnabled: Boolean?)

    fun parseRemote(json: String): Remote {
        val tts = Regex("\"tts\"\\s*:\\s*\\{([^}]*)\\}").find(json)?.groupValues?.get(1) ?: return Remote(null, null)
        fun inner(name: String): Boolean? =
            Regex("\"$name\"\\s*:\\s*(true|false)").find(tts)?.groupValues?.get(1)?.let { it == "true" }
        return Remote(inner("apiEnabled"), inner("engineApiEnabled"))
    }

    /**
     * The order of sources for the app's own reader. A language other than English goes to the cloud first only when the
     * cloud source accepts it (it declines languages the API does not list a voice for, see CloudVoicePolicy), then the
     * phone's engine. [preferSystem] (the user chose a phone voice) puts the phone's engine first.
     */
    fun inAppOrder(apiEnabled: Boolean, language: String, preferSystem: Boolean = false): List<SourceId> {
        val english = language.substringBefore('-').lowercase() == "en"
        if (preferSystem && !english) return if (apiEnabled) listOf(SourceId.SYSTEM, SourceId.API) else listOf(SourceId.SYSTEM)
        val list = ArrayList<SourceId>(3)
        if (apiEnabled) list += SourceId.API
        if (!apiEnabled && english) list += SourceId.ON_DEVICE
        list += SourceId.SYSTEM
        if (apiEnabled && english) list += SourceId.ON_DEVICE
        return list
    }
}
