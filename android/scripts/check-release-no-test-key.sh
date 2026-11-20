#!/usr/bin/env bash
# Fails when the TTS tester key is found in a release artifact (APK or AAB).
# The key is read from the macOS Keychain item `readaloud-tts-test-bypass` (account `owner`) or from $TTS_TEST_KEY, and is never printed.
# Usage: scripts/check-release-no-test-key.sh path/to/app-release.aab [more artifacts...]
set -u
KEY="${TTS_TEST_KEY:-$(security find-generic-password -s readaloud-tts-test-bypass -a owner -w 2>/dev/null || true)}"
if [ -z "$KEY" ]; then echo "no key available to look for (Keychain item missing and TTS_TEST_KEY unset)"; exit 2; fi
status=0
for art in "$@"; do
  dir="$(mktemp -d)"
  unzip -qq -o "$art" -d "$dir" || { echo "cannot unzip $art"; rm -rf "$dir"; exit 2; }
  # dex files, resources and manifests all sit unencoded (dex strings are UTF-8) inside the archive
  hits=$(grep -rlaF -- "$KEY" "$dir" 2>/dev/null | wc -l | tr -d ' ')
  rm -rf "$dir"
  if [ "$hits" != "0" ]; then echo "FAIL: the test key is present in $art ($hits files)"; status=1; else echo "ok: the test key is not in $art"; fi
done
exit $status
