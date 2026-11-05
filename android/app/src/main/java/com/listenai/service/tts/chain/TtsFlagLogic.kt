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

    /** The order of sources for the app's own reader. */
    fun inAppOrder(apiEnabled: Boolean, language: String): List<SourceId> {
        val english = language.substringBefore('-').lowercase() == "en"
        val list = ArrayList<SourceId>(3)
        if (apiEnabled) list += SourceId.API
        if (!apiEnabled && english) list += SourceId.ON_DEVICE
        list += SourceId.SYSTEM
        if (apiEnabled && english) list += SourceId.ON_DEVICE
        return list
    }
}
