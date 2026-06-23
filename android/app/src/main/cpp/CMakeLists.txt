# Build the eSpeak NG JNI bridge. Links against the prebuilt
# libespeak-ng.so dropped in jniLibs/<ABI>/ by the integration
# pipeline (HeyLetsLearnSomething 2026-02-17 build, arm64-v8a only).
#
# The bridge itself is small (~100 lines of C) — produces
# libespeak_bridge.so that EspeakBridge.kt loads via System.loadLibrary.

cmake_minimum_required(VERSION 3.22.1)
project(espeak_bridge LANGUAGES C)

# Prebuilt eSpeak NG library as an imported target.
# CMake resolves the .so path from jniLibs/${ANDROID_ABI}/.
add_library(espeak-ng SHARED IMPORTED)
set_target_properties(espeak-ng PROPERTIES
    IMPORTED_LOCATION ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libespeak-ng.so)

# Our JNI shim
add_library(espeak_bridge SHARED espeak_bridge.c)

target_include_directories(espeak_bridge PRIVATE ${CMAKE_SOURCE_DIR}/include)

# Link against Android log + the prebuilt espeak-ng. The prebuilt
# itself depends on libc++_shared which is also in jniLibs/.
find_library(log-lib log)
target_link_libraries(espeak_bridge espeak-ng ${log-lib})
