// Top-level build file for ListenAI Android
plugins {
    id("com.android.application") version "9.2.1" apply false
    // Kept explicit (android.builtInKotlin=false in gradle.properties) —
    // shared library modules used by 7 other AGP-8.x apps still apply this
    // plugin directly, so we can't rely on AGP 9's built-in Kotlin here.
    id("org.jetbrains.kotlin.android") version "2.3.10" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.3.10" apply false
    id("com.google.devtools.ksp") version "2.3.10" apply false
    id("com.google.gms.google-services") version "4.4.2" apply false
}

tasks.register("clean", Delete::class) {
    delete(rootProject.layout.buildDirectory)
}
