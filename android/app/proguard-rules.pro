# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.

# Keep OkHttp and Okio
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-keep class okio.** { *; }

# Keep Retrofit
-dontwarn retrofit2.**
-keep class retrofit2.** { *; }

# Keep Kotlin Serialization
-keepattributes *Annotation*
-keep class kotlinx.serialization.** { *; }

# Keep PDFBox classes
-dontwarn com.gemalto.jp2.JP2Decoder
-dontwarn com.gemalto.jp2.JP2Encoder
-dontwarn com.gemalto.jp2.**
-dontwarn org.bouncycastle.**
-dontwarn org.apache.**
-keep class com.tom_roush.pdfbox.** { *; }

# Keep Room
-keep class * extends androidx.room.RoomDatabase
-keep @androidx.room.Entity class *
-dontwarn androidx.room.paging.**

# Keep Koin
-keep class org.koin.** { *; }

# Keep model classes for JSON parsing
-keep class com.listenai.data.models.** { *; }
-keep class com.listenai.service.voice.VoiceCloningService$* { *; }

# Keep Compose
-keep class androidx.compose.** { *; }

# Google Auth
-keep class com.google.android.gms.auth.** { *; }
-keep class com.google.api.** { *; }
