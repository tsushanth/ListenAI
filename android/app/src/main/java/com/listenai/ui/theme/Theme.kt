package com.listenai.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val LightColorScheme = lightColorScheme(
    primary = Blue,
    onPrimary = SurfaceLight,
    primaryContainer = Blue.copy(alpha = 0.15f),
    onPrimaryContainer = Blue,
    secondary = Green,
    onSecondary = SurfaceLight,
    secondaryContainer = Green.copy(alpha = 0.15f),
    onSecondaryContainer = Green,
    tertiary = Purple,
    onTertiary = SurfaceLight,
    tertiaryContainer = Purple.copy(alpha = 0.15f),
    onTertiaryContainer = Purple,
    error = Red,
    onError = SurfaceLight,
    errorContainer = Red.copy(alpha = 0.15f),
    onErrorContainer = Red,
    background = BackgroundLight,
    onBackground = TextPrimaryLight,
    surface = SurfaceLight,
    onSurface = TextPrimaryLight,
    surfaceVariant = CardLight,
    onSurfaceVariant = TextSecondaryLight,
    outline = DividerLight,
    outlineVariant = TextTertiaryLight
)

private val DarkColorScheme = darkColorScheme(
    primary = Blue,
    onPrimary = SurfaceDark,
    primaryContainer = Blue.copy(alpha = 0.25f),
    onPrimaryContainer = BlueLight,
    secondary = Green,
    onSecondary = SurfaceDark,
    secondaryContainer = Green.copy(alpha = 0.25f),
    onSecondaryContainer = GreenLight,
    tertiary = Purple,
    onTertiary = SurfaceDark,
    tertiaryContainer = Purple.copy(alpha = 0.25f),
    onTertiaryContainer = Purple,
    error = Red,
    onError = SurfaceDark,
    errorContainer = Red.copy(alpha = 0.25f),
    onErrorContainer = Red,
    background = BackgroundDark,
    onBackground = TextPrimaryDark,
    surface = SurfaceDark,
    onSurface = TextPrimaryDark,
    surfaceVariant = CardDark,
    onSurfaceVariant = TextSecondaryDark,
    outline = DividerDark,
    outlineVariant = TextTertiaryDark
)

@Composable
fun ListenAITheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit
) {
    val colorScheme = if (darkTheme) DarkColorScheme else LightColorScheme

    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = colorScheme.background.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = !darkTheme
        }
    }

    MaterialTheme(
        colorScheme = colorScheme,
        typography = Typography,
        content = content
    )
}
