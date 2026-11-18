package com.listenai.ui.common

import android.content.Context
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes

/**
 * Text that is turned into the user's language only when it is shown, so view models and services can
 * carry it without holding a Context. [Raw] is for text that already is final (it came from the server).
 */
sealed class UiText {
    data class Res(@param:StringRes val id: Int, val args: List<Any> = emptyList()) : UiText()

    /** A plural string; [count] picks the form, [args] default to just the count. */
    data class Plural(@param:PluralsRes val id: Int, val count: Int, val args: List<Any> = listOf(count)) : UiText()

    data class Raw(val value: String) : UiText()

    data class Join(val parts: List<UiText>, val separator: String = " ") : UiText()

    fun resolve(context: Context): String = when (this) {
        is Res -> context.getString(id, *args.map { it.resolved(context) }.toTypedArray())
        is Plural -> context.resources.getQuantityString(id, count, *args.map { it.resolved(context) }.toTypedArray())
        is Raw -> value
        is Join -> parts.joinToString(separator) { it.resolve(context) }
    }

    private fun Any.resolved(context: Context): Any = if (this is UiText) resolve(context) else this
}
