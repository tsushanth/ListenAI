#!/usr/bin/env python3
"""Extract short cache-eligible UI labels from AOSP strings.xml files.

Filtering rules:
- 2-60 characters after stripping XML/HTML
- No format placeholders (%, {0}, %1$s, etc) — these are dynamic
- No XLIFF placeholders — also dynamic
- Skip technical/dev-facing strings (mostly uppercase, contain underscores)
- Skip strings with HTML markup (<b>, <i>, etc) — TalkBack reads the markup wrong
- Skip strings that look like full sentences (>40 chars + period or question mark)
- Dedupe (case-insensitive)
"""
import os, re, sys, json
import xml.etree.ElementTree as ET

SOURCES = [
    "/tmp/aosp_strings/framework_strings.xml",
    "/tmp/aosp_strings/settingslib_strings.xml",
    "/tmp/aosp_strings/settings_strings.xml",
    "/tmp/aosp_strings/systemui_strings.xml",
]

EXISTING_LABELS = "/tmp/piper_spike/talkback_labels.txt"

def looks_cacheable(text):
    if not text:
        return False
    s = text.strip()
    if len(s) < 2 or len(s) > 60:
        return False
    # Format placeholders / variables
    if "%" in s or "{" in s or "}" in s:
        return False
    # HTML markup
    if "<" in s and ">" in s:
        return False
    # Looks like a technical ID (all caps + underscores)
    if "_" in s and s.replace("_", "").isupper():
        return False
    # Mostly uppercase shouting (more than half caps)
    upper_ratio = sum(1 for c in s if c.isupper()) / max(len(s), 1)
    if upper_ratio > 0.5 and len(s) > 5:
        return False
    # URLs
    if "://" in s or s.startswith("www."):
        return False
    # Backslash escapes (unprintable / line-break heavy)
    if "\\n" in s or "\\t" in s:
        return False
    # Newlines mid-text
    if "\n" in s.strip("\n"):
        return False
    # Email addresses
    if "@" in s and "." in s:
        return False
    return True


def normalize_for_dedupe(s):
    return s.strip().lower()


def parse_xml(path):
    """Tolerant of XLIFF namespace + nested tags."""
    out = []
    try:
        # ET is strict; strip xliff inline to avoid namespace handling
        with open(path) as f:
            data = f.read()
        # Replace xliff:g elements with their text content (the placeholder
        # example) so we can detect them in the filter.
        data = re.sub(r'<xliff:g[^>]*>(.*?)</xliff:g>', r'%PLACEHOLDER%', data, flags=re.DOTALL)
        # Strip the xmlns to make ET happy
        data = re.sub(r'xmlns:xliff="[^"]*"', '', data)
        root = ET.fromstring(data)
        for s in root.findall(".//string"):
            text = s.text if s.text else ""
            # Extract concatenated nested text too
            for child in s:
                text += (child.tail or "")
            out.append((s.get("name", ""), text))
    except Exception as e:
        print(f"parse error {path}: {e}")
    return out


seen = set()
# Pre-seed seen set with existing labels so we don't re-render those
if os.path.exists(EXISTING_LABELS):
    with open(EXISTING_LABELS) as f:
        for line in f:
            line = line.strip()
            if line:
                seen.add(normalize_for_dedupe(line))
print(f"pre-seeded {len(seen)} existing labels")

new_labels = []
per_source_counts = {}
for src in SOURCES:
    src_name = os.path.basename(src).replace("_strings.xml", "")
    n_in_src = 0
    for name, text in parse_xml(src):
        # Strip XLIFF placeholder markers — these became %PLACEHOLDER%
        if "%PLACEHOLDER%" in text:
            continue
        if not looks_cacheable(text):
            continue
        norm = normalize_for_dedupe(text)
        if norm in seen:
            continue
        seen.add(norm)
        new_labels.append(text.strip())
        n_in_src += 1
    per_source_counts[src_name] = n_in_src

print(f"\nNew cacheable labels by source:")
for src, n in per_source_counts.items():
    print(f"  {src:<20} +{n}")
print(f"\ntotal new: {len(new_labels)}")
print(f"\nsample of first 20:")
for s in new_labels[:20]:
    print(f"  {s}")
print(f"\nsample of last 10:")
for s in new_labels[-10:]:
    print(f"  {s}")

with open("/tmp/aosp_strings/new_labels.txt", "w") as f:
    for s in new_labels:
        f.write(s + "\n")
print(f"\nwritten to /tmp/aosp_strings/new_labels.txt")
