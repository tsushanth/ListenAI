#!/usr/bin/env bash
# Regenerates app/hardcoded-ui-strings.baseline.json from the CURRENT hard-coded UI literals in
# app/src/main. Run this only when you have deliberately accepted the new count (for example after
# moving strings to strings.xml, to ratchet the baseline down). Review the diff before committing.
# See docs/hardcoded-ui-strings-guard.md. Needs a JDK 11+ (no Gradle, runs in about a second).
#
#   scripts/update-hardcoded-baseline.sh           regenerate the baseline (default)
#   scripts/update-hardcoded-baseline.sh --check   list literals over the baseline (file:line), no Gradle
#   scripts/update-hardcoded-baseline.sh --report  list every literal the scanner sees
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE="$ROOT/app"
SCANNER="$MODULE/src/test/java/guard/i18n/HardcodedUiStringScanner.java"

pick_java() {
  if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then echo "$JAVA_HOME/bin/java"; return; fi
  if command -v java >/dev/null 2>&1; then command -v java; return; fi
  local studio="/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/java"
  if [ -x "$studio" ]; then echo "$studio"; return; fi
  echo "No java found. Set JAVA_HOME to a JDK 11+." >&2
  exit 1
}

[ -f "$SCANNER" ] || { echo "Scanner not found: $SCANNER" >&2; exit 1; }
MODE="${1:---update}"
"$(pick_java)" "$SCANNER" "$MODE" "$MODULE"
[ "$MODE" = "--update" ] && echo "Review: git diff -- app/hardcoded-ui-strings.baseline.json"
exit 0
