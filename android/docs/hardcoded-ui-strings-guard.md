# Hard-coded UI strings guard

Every user-visible string must live in `strings.xml` and be translated in every `values-*` folder.
English written directly in Kotlin/Java shows up untranslated in a non-English UI, so a unit test
stops new hard-coded English from creeping back in. It runs inside the normal local unit-test gate
(CI is not needed) and takes well under a second.

## What runs

- `app/src/test/java/guard/i18n/NoHardcodedUiStringsTest.java` is the JUnit test.
- `app/src/test/java/guard/i18n/HardcodedUiStringScanner.java` is the scanner (plain `java.nio` + regex, no dependencies).
- `app/hardcoded-ui-strings.baseline.json` records, per source file, how many hard-coded UI literals
  exist today (the pre-existing debt).

The scanner reads every `.kt`/`.java` file under `app/src/main` (not `res`, `assets`, `cpp`, test or
debug code, not `@Preview` functions) and counts string literals that sit in a user-visible position:
`Text("..")`, `text|label|title|placeholder|contentDescription|subtitle|description|hint|message|error = ".."`,
Toast/Snackbar/notification/dialog setters, `when` branches (`x -> ".."`), enum display names
(`ENTRY("..")`) and `*Error(".." )` constructors. Logs, tags, URLs, keys, identifier-like or CONSTANT-like
strings, and strings without letters are ignored. It is a heuristic: it misses strings built inside
`listOf(..)`/`mapOf(..)` and can flag a non-UI string now and then.

## When it fails

The test fails if a file's count rises above the baseline, or a file that is not in the baseline adds
any. The message lists `file:line` of the new literals. Fix: move to strings.xml and translate in all
values-* folders (use `stringResource(R.string.x)` in Compose, `context.getString` elsewhere, and a
`@StringRes` id on models that have no Context).

To see the offending `file:line` without Gradle: `scripts/update-hardcoded-baseline.sh --check`
(the Gradle console only shows the failing assertion line; the full message is in the test report
under `app/build/reports/tests/`). `--report` lists every literal the scanner sees.

If a flagged literal is not user-visible (a wire value, a log line, an analytics name), add a
`// i18n-ok` comment on that line or the line above instead of touching the baseline.

Lower counts than the baseline pass. After you remove literals, ratchet the baseline down so the
gain is locked in.

## Updating the baseline deliberately

```
scripts/update-hardcoded-baseline.sh      # needs a JDK 11+, no Gradle, about a second
git diff -- app/hardcoded-ui-strings.baseline.json
```

Commit the regenerated file in the same PR and say why in the description. Do not raise the baseline to
get a green build for new user-facing text. Renaming or moving a file that still has literals also
changes the baseline (the old path drops out, the new path appears), which is expected.

## Run only this test

```
./gradlew :app:testReaderDebugUnitTest --tests '*NoHardcodedUiStringsTest'
```
