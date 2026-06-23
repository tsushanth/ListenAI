// JNI bridge for eSpeak NG phonemization. Thin wrapper exposing:
//   nativeInit(dataPath)           → int sample_rate  (-1 on error)
//   nativeSetVoice("en-us")        → int 0 on ok
//   nativePhonemize(text)          → IPA string ("həlˈoʊ wˈɜːld")
//   nativeShutdown()               → void
//
// The Pixel-side prebuilt `libespeak-ng.so` (HeyLetsLearnSomething,
// 2026-02-17) provides the espeak C API. This bridge links against
// that .so via CMake's imported-library mechanism — see CMakeLists.txt.

#include <jni.h>
#include <stdlib.h>
#include <string.h>
#include <android/log.h>
#include "espeak-ng/speak_lib.h"

#define TAG "espeak_bridge"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

JNIEXPORT jint JNICALL
Java_com_listenai_systemtts_EspeakBridge_nativeInit(JNIEnv *env, jobject thiz, jstring data_path) {
    const char *path = (*env)->GetStringUTFChars(env, data_path, NULL);
    if (!path) {
        LOGE("nativeInit: GetStringUTFChars returned NULL");
        return -1;
    }
    // espeak_Initialize returns the sample rate (positive) on success
    // or EE_INTERNAL_ERROR (-1) on failure. AUDIO_OUTPUT_SYNCHRONOUS
    // is required because we want espeak_TextToPhonemes to work
    // without a callback. buflength=0 means use default.
    int sr = espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, path, 0);
    LOGI("nativeInit: path=%s sr=%d", path, sr);
    (*env)->ReleaseStringUTFChars(env, data_path, path);
    return sr;
}

JNIEXPORT jint JNICALL
Java_com_listenai_systemtts_EspeakBridge_nativeSetVoice(JNIEnv *env, jobject thiz, jstring voice_name) {
    const char *name = (*env)->GetStringUTFChars(env, voice_name, NULL);
    if (!name) return -1;
    espeak_ERROR rc = espeak_SetVoiceByName(name);
    LOGI("nativeSetVoice: voice=%s rc=%d", name, rc);
    (*env)->ReleaseStringUTFChars(env, voice_name, name);
    return (jint)rc;
}

// IPA mode = bit 1 set + bit 7 (no separator). We omit the
// separator-character flags to keep the output as a single continuous
// stream of UTF-8 IPA characters that Piper's phoneme_id_map expects.
//
// Piper voice configs map each IPA codepoint to an ID. The configs
// also expect a single space between word groups, which espeak emits
// naturally. eSpeak's IPA output already matches Piper's expectations
// when phoneme_mode = 0x02 — confirmed by the agent's 2026-06-22
// reference of `espeak-ng -v en-us -x --ipa`.
#define ESPEAK_PHONEME_MODE_IPA 0x02

JNIEXPORT jstring JNICALL
Java_com_listenai_systemtts_EspeakBridge_nativePhonemize(JNIEnv *env, jobject thiz, jstring text) {
    const char *txt = (*env)->GetStringUTFChars(env, text, NULL);
    if (!txt) {
        return (*env)->NewStringUTF(env, "");
    }
    // espeak_TextToPhonemes returns up to a sentence/comma boundary
    // per call, advancing the textptr to the next chunk. We loop
    // until textptr is NULL (end of input) and concatenate.
    const void *cursor = txt;
    // Cap output to avoid runaway. Real labels are <60 chars input
    // → <300 chars IPA.
    char *out = malloc(8192);
    if (!out) {
        (*env)->ReleaseStringUTFChars(env, text, txt);
        return (*env)->NewStringUTF(env, "");
    }
    size_t out_len = 0;
    out[0] = 0;
    while (cursor != NULL) {
        const char *chunk = espeak_TextToPhonemes(&cursor, espeakCHARS_UTF8, ESPEAK_PHONEME_MODE_IPA);
        if (!chunk) break;
        size_t n = strlen(chunk);
        if (out_len + n + 2 >= 8192) break;  // out-of-room safety
        // Insert single space between successive chunks so word
        // boundaries persist across espeak's sentence-splitting.
        if (out_len > 0) {
            out[out_len++] = ' ';
        }
        memcpy(out + out_len, chunk, n);
        out_len += n;
        out[out_len] = 0;
    }
    (*env)->ReleaseStringUTFChars(env, text, txt);
    jstring result = (*env)->NewStringUTF(env, out);
    free(out);
    return result;
}

JNIEXPORT void JNICALL
Java_com_listenai_systemtts_EspeakBridge_nativeShutdown(JNIEnv *env, jobject thiz) {
    espeak_Terminate();
}
