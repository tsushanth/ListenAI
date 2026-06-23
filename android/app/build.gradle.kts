import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.devtools.ksp")
    id("com.google.gms.google-services")
}

// Load keystore properties from local file (not committed to git)
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(keystorePropertiesFile.inputStream())
}

android {
    namespace = "com.listenai"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.listenai"
        minSdk = 26
        targetSdk = 35
        versionCode = 70
        versionName = "2.14.27"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        vectorDrawables {
            useSupportLibrary = true
        }

        ndk {
            // The prebuilt libespeak-ng.so is arm64-v8a only. Limit
            // our native bridge build to the same ABI; for other ABIs
            // the eSpeak feature is silently absent (System.loadLibrary
            // returns UnsatisfiedLinkError on x86 emulators etc).
            abiFilters += listOf("arm64-v8a")
        }

        externalNativeBuild {
            cmake {
                arguments += listOf("-DANDROID_STL=c++_shared")
            }
        }
    }

    // 2026-06-23: two product flavors out of the same codebase.
    //   reader — the full ReadAloud AI ebook reader (default; ships as
    //            com.listenai, current Play listing).
    //   voice  — a standalone TTS engine app (com.listenai.voice). Same
    //            APK content (the reader code is dead code from this
    //            flavor's perspective) but launches into the system TTS
    //            voice picker instead of the reader.
    //
    // This is the cheap path to a separate Play listing for the BVI
    // audience. Real source-set stripping comes later as Option B/C.
    flavorDimensions += "product"
    productFlavors {
        create("reader") {
            dimension = "product"
            // Inherits the default applicationId "com.listenai".
        }
        create("voice") {
            dimension = "product"
            applicationIdSuffix = ".voice"
            versionNameSuffix = "-voice"
            manifestPlaceholders["appNameOverride"] = "ReadAloud Voice"
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
        // 16 KB page-size support — required by Google Play for new uploads.
        // We don't ship any of our own NDK libs but we want to keep
        // legacy packaging off so AGP doesn't fall back to the 4 KB path
        // for any AAR-bundled .so we pull in.
        jniLibs {
            useLegacyPackaging = false
        }
    }
}

dependencies {
    // ONNX Runtime for on-device Kokoro TTS inference (Android v2 path).
    // Use `onnxruntime-android` ≥ 1.22.0 — earlier 1.20.x and 1.21.x ship
    // `libonnxruntime.so` 16 KB-aligned but the JNI bridge
    // `libonnxruntime4j_jni.so` is still 4 KB-aligned, which trips the
    // Android PageSizeMismatchDialog on 16 KB-page devices (Pixel 9 family)
    // and blocks Play Store uploads. 1.22.0 is the first release that
    // ships *both* .so files 16 KB-aligned.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.22.0")

    // WorkManager — used to run the ~80 MB Kokoro model download as a
    // foreground-promoted background task so it survives app
    // backgrounding, process death, network changes, and screen-off.
    implementation("androidx.work:work-runtime-ktx:2.9.1")

    // Core Android
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.7.0")
    implementation("androidx.activity:activity-compose:1.8.2")

    // Compose BOM
    implementation(platform("androidx.compose:compose-bom:2024.02.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.animation:animation")

    // Navigation
    implementation("androidx.navigation:navigation-compose:2.7.6")

    // Dependency Injection - Koin
    implementation("io.insert-koin:koin-android:3.5.3")
    implementation("io.insert-koin:koin-androidx-compose:3.5.3")

    // Networking - Retrofit & OkHttp
    implementation("com.squareup.retrofit2:retrofit:2.9.0")
    implementation("com.squareup.retrofit2:converter-gson:2.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")

    // Media3 - ExoPlayer
    implementation("androidx.media3:media3-exoplayer:1.2.1")
    implementation("androidx.media3:media3-session:1.2.1")
    implementation("androidx.media3:media3-ui:1.2.1")

    // Room Database
    implementation("androidx.room:room-runtime:2.6.1")
    implementation("androidx.room:room-ktx:2.6.1")
    ksp("androidx.room:room-compiler:2.6.1")

    // DataStore Preferences
    implementation("androidx.datastore:datastore-preferences:1.0.0")

    // PDF parsing
    implementation("com.tom-roush:pdfbox-android:2.0.27.0")

    // EPUB parsing
    implementation("com.positiondev.epublib:epublib-core:3.1") {
        exclude(group = "xmlpull")
        exclude(group = "org.slf4j")
    }
    implementation("org.slf4j:slf4j-android:1.7.25")

    // HTML parsing
    implementation("org.jsoup:jsoup:1.17.2")

    // Image loading
    implementation("io.coil-kt:coil-compose:2.5.0")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // Google Sign-In / Auth
    implementation("com.google.android.gms:play-services-auth:21.0.0")

    // ML Kit Text Recognition — used by the Read Text screen for on-device
    // OCR. Play-Services-hosted variant (model shared across apps via Play
    // Services, ~0 APK overhead) rather than the bundled variant which
    // would add ~3 MB. Latin script only for v0; can layer Chinese /
    // Devanagari / Japanese / Korean modules later if Warren / BAU asks.
    implementation("com.google.android.gms:play-services-mlkit-text-recognition:19.0.1")
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")

    // Google Play In-App Review
    implementation("com.google.android.play:review:2.0.1")
    implementation("com.google.android.play:review-ktx:2.0.1")

    // RevenueCat (In-App Purchases & Subscriptions)
    implementation("com.revenuecat.purchases:purchases:9.22.2")
    implementation("com.revenuecat.purchases:purchases-ui:9.22.2")

    // PaywallKit
    implementation(project(":paywallkit"))
    implementation(project(":crosspromokit"))

    // RatingKit
    implementation(project(":ratingkit"))

    // TikTok Events SDK (install attribution & event tracking)
    implementation("com.github.tiktok:tiktok-business-android-sdk:1.6.0")

    // Meta / Facebook SDK (app events for Meta Ads attribution)
    implementation("com.facebook.android:facebook-android-sdk:17.0.1")

    // Chrome Custom Tabs for OAuth
    implementation("androidx.browser:browser:1.8.0")

    // Security (for encrypted preferences)
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    // Testing
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.7.3")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.1")
    androidTestImplementation(platform("androidx.compose:compose-bom:2024.02.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")

    // Debug
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    // Firebase Analytics (for Google Ads conversion tracking)
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-analytics")
}


// The voice flavor (com.listenai.voice) doesn't have a Firebase
// client entry in google-services.json — and the standalone TTS
// engine doesn't need Firebase Analytics anyway. Skip the
// process*GoogleServices task for any voice* variant so the build
// doesn't fail at config time.
afterEvaluate {
    tasks.matching {
        it.name.startsWith("processVoice") &&
            it.name.endsWith("GoogleServices")
    }.configureEach { enabled = false }
}
