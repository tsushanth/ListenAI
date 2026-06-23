# AOSP string scrape — 2026-06-22

Source-of-truth for the expanded `assets/talkback_cache/` corpus
(v61 onwards).

## What this does

Fetches AOSP's `strings.xml` from four sources:
- `frameworks/base/core/res/res/values/strings.xml` (Android framework)
- `frameworks/base/packages/SettingsLib/res/values/strings.xml`
- `packages/apps/Settings/res/values/strings.xml`
- `frameworks/base/packages/SystemUI/res/values/strings.xml`

Filters to cache-eligible labels (short, no format placeholders, no
HTML markup, no all-caps technical IDs) and dedupes against the
already-shipped 111-label seed list (`spike/piper-2026-06-22/talkback_labels.txt`).

Result: ~5900 new labels covering most of what TalkBack actually
reads on a stock Pixel.

## Regenerate

```bash
mkdir -p /tmp/aosp_strings
for s in \
  "framework_strings.xml|https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/core/res/res/values/strings.xml" \
  "settingslib_strings.xml|https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/packages/SettingsLib/res/values/strings.xml" \
  "settings_strings.xml|https://raw.githubusercontent.com/aosp-mirror/platform_packages_apps_Settings/main/res/values/strings.xml" \
  "systemui_strings.xml|https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/packages/SystemUI/res/values/strings.xml"; do
  fn=$(echo $s | cut -d'|' -f1)
  url=$(echo $s | cut -d'|' -f2)
  curl -sL "$url" -o "/tmp/aosp_strings/$fn"
done

python3 extract_labels.py
# → writes /tmp/aosp_strings/new_labels.txt and full_labels.txt
```

Then feed `full_labels.txt` to
`../piper-2026-06-22/render_cache_parallel.py` to render PCM, then
`../piper-2026-06-22/compress_to_opus.sh` to compress.

## Why static AOSP scrape rather than instrumentation

The "real" answer to coverage would be to telemeter actual TalkBack
utterances on a fleet of devices and rank by frequency. That needs a
privacy review, a server, a fleet, and weeks of data. The static
scrape is a 10-minute approximation that covers the most common
labels well enough for a tonight-shippable cache.
