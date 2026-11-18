package guard.i18n;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Heuristic scanner for user-visible English that is hard-coded in Kotlin/Java source instead of
 * strings.xml. Plain java.nio + regex, no dependencies, never touches runtime code.
 *
 * Shared template: the same file is used by every Android app repo. See
 * docs/hardcoded-ui-strings-guard.md for how the baseline works and how to update it.
 *
 * Usage as a program (JDK 11+, no Gradle needed):
 *   java HardcodedUiStringScanner.java [--update | --check | --report] [moduleDir]
 */
public final class HardcodedUiStringScanner {

    public static final String BASELINE_FILE = "hardcoded-ui-strings.baseline.json";
    public static final String SUPPRESS_MARKER = "i18n-ok";
    public static final String FIX_HINT = "move to strings.xml and translate in all values-* folders";

    /** One hard-coded literal found in a source file. */
    public static final class Hit {
        public final String file;   // path relative to the module dir, '/' separated
        public final int line;      // 1-based
        public final String text;   // literal content as written between the quotes
        public final String kind;   // which pattern matched

        Hit(String file, int line, String text, String kind) {
            this.file = file;
            this.line = line;
            this.text = text;
            this.kind = kind;
        }

        public String hash() {
            return String.format("%08x", text.hashCode());
        }

        @Override
        public String toString() {
            String t = text.replace("\r", "").replace("\n", "\\n");
            if (t.length() > 90) t = t.substring(0, 90) + "...";
            return file + ":" + line + "  [" + kind + "]  \"" + t + "\"";
        }
    }

    // ---- where to look ----------------------------------------------------------------------

    private static final Set<String> SKIP_DIRS = new HashSet<String>(Arrays.asList(
            "res", "assets", "cpp", "jniLibs", "build", ".git", "debug", "test", "androidTest"));

    // ---- contexts that make a string literal user-visible ----------------------------------
    // Matched against the code (comments removed, earlier literals collapsed to "S") that
    // precedes the literal, anchored at its end.

    private static final String NAMED_ARG =
            "(?:\\w*(?:Text|Title|Label|Message|Description|Hint|Subtitle|Caption|Summary|Headline)"
            + "|text|title|label|message|description|hint|subtitle|caption|summary|headline"
            + "|placeholder|tooltip|supportingText|displayName|error|errorMessage|contentDescription)";

    private static final Object[][] CONTEXTS = new Object[][] {
        {"Text()", Pattern.compile("\\b(?:Text|BasicText|AutoSizeText|ClickableText)\\(\\s*$")},
        {"named-arg", Pattern.compile("\\b" + NAMED_ARG + "\\s*=\\s*$")},
        {"param-default", Pattern.compile("\\b" + NAMED_ARG + "\\s*:\\s*String\\??\\s*=\\s*$")},
        {"property", Pattern.compile("\\b(?:val|var)\\s+\\w*(?:Name|Label|Title|Text|Description|Message|Hint|Subtitle)\\w*"
                + "\\s*(?::\\s*String\\??)?\\s*(?:get\\(\\)\\s*)?=\\s*$")},
        {"Toast", Pattern.compile("\\bToast\\.makeText\\([^\"]*,\\s*$")},
        {"Snackbar", Pattern.compile("\\b(?:Snackbar\\.make\\([^\"]*,|showSnackbar\\(\\s*(?:message\\s*=)?|SnackbarVisuals\\(\\s*message\\s*=)\\s*$")},
        {"android-setter", Pattern.compile("\\.(?:setTitle|setMessage|setText|setSubText|setTicker|setError|setHint|setContentTitle"
                + "|setContentText|setContentInfo|setBigContentTitle|setSummaryText|setDescription|setLabel"
                + "|setPositiveButton|setNegativeButton|setNeutralButton|setContentDescription)\\(\\s*$")},
        {"android-assign", Pattern.compile("\\.(?:text|title|hint|error|contentDescription|description|subtitle|label)\\s*=\\s*$")},
        {"notif-channel", Pattern.compile("\\bNotificationChannel\\(\\s*[^,\"]+,\\s*$")},
        {"share-extra", Pattern.compile("\\bEXTRA_(?:TEXT|SUBJECT|TITLE)\\s*,\\s*$")},
        {"when-branch", Pattern.compile("->\\s*$")},
        {"enum-label", Pattern.compile("(?:^|[;{,(]\\s*)[A-Z][A-Z0-9_]+\\(\\s*$")},
        {"error-ctor", Pattern.compile("\\b\\w*(?:Error|Failure|Failed|Warning)\\(\\s*(?:\\w+\\s*=\\s*)?$")},
    };

    private static final Pattern LOG_CALL = Pattern.compile(
            "\\b(?:Log\\.[a-z]\\(|Timber\\.|println\\(|print\\(|logger\\.|Logger\\.|Napier\\.|Crashlytics|recordException"
            + "|\\.log\\(|Sentry\\.|Analytics\\.|logEvent\\(|trackEvent\\(|capture\\()");

    private HardcodedUiStringScanner() {}

    // ---- public API --------------------------------------------------------------------------

    /** Finds the app module dir (the one holding src/main) starting from the JVM working dir. */
    public static Path findModuleDir() {
        Path cwd = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        return resolveModuleDir(cwd);
    }

    public static Path resolveModuleDir(Path start) {
        if (Files.isDirectory(start.resolve("src").resolve("main"))) return start;
        Path app = start.resolve("app");
        if (Files.isDirectory(app.resolve("src").resolve("main"))) return app;
        throw new IllegalStateException("No src/main under " + start + " (expected the app module dir)");
    }

    /** Scans every src/main .kt/.java file of the module. Order: by file, then line. */
    public static List<Hit> scan(Path moduleDir) throws IOException {
        final Path main = moduleDir.resolve("src").resolve("main");
        final List<Path> files = new ArrayList<Path>();
        Files.walkFileTree(main, new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, BasicFileAttributes attrs) {
                if (!dir.equals(main) && SKIP_DIRS.contains(dir.getFileName().toString())) {
                    return FileVisitResult.SKIP_SUBTREE;
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                String n = file.getFileName().toString();
                if ((n.endsWith(".kt") || n.endsWith(".java")) && !n.contains("Preview")) files.add(file);
                return FileVisitResult.CONTINUE;
            }
        });
        Collections.sort(files);
        List<Hit> hits = new ArrayList<Hit>();
        for (Path f : files) {
            String rel = moduleDir.relativize(f).toString().replace('\\', '/');
            String src = new String(Files.readAllBytes(f), StandardCharsets.UTF_8);
            scanSource(rel, src, hits);
        }
        return hits;
    }

    // ---- lexer -------------------------------------------------------------------------------

    /**
     * Walks the source once, skipping comments and char literals, tracking brace depth to ignore
     * bodies of @Preview functions, and classifying each string literal by the code before it.
     */
    static void scanSource(String file, String s, List<Hit> out) {
        final int n = s.length();
        String[] rawLines = s.split("\n", -1);
        StringBuilder code = new StringBuilder(); // code so far, strings collapsed to S
        int line = 1;
        int i = 0;
        int brace = 0;
        int paren = 0;
        boolean previewPending = false;
        boolean sawFunAfterPreview = false;
        int funParen = 0;
        int previewBodyDepth = -1; // brace depth to return to when the preview body closes
        boolean inPreviewBody = false;

        while (i < n) {
            char c = s.charAt(i);
            if (c == '\n') { line++; code.append('\n'); i++; continue; }
            // comments
            if (c == '/' && i + 1 < n && s.charAt(i + 1) == '/') {
                while (i < n && s.charAt(i) != '\n') i++;
                continue;
            }
            if (c == '/' && i + 1 < n && s.charAt(i + 1) == '*') {
                int depth = 1;
                i += 2;
                while (i < n && depth > 0) {
                    char d = s.charAt(i);
                    if (d == '\n') line++;
                    if (d == '/' && i + 1 < n && s.charAt(i + 1) == '*') { depth++; i += 2; continue; }
                    if (d == '*' && i + 1 < n && s.charAt(i + 1) == '/') { depth--; i += 2; continue; }
                    i++;
                }
                continue;
            }
            // char literal
            if (c == '\'') {
                int j = i + 1;
                if (j < n && s.charAt(j) == '\\') j += 2;
                else j += 1;
                while (j < n && s.charAt(j) != '\'' && s.charAt(j) != '\n' && j - i < 12) j++;
                if (j < n && s.charAt(j) == '\'') { code.append("'c'"); i = j + 1; continue; }
                code.append(c); i++; continue;
            }
            // raw / text-block string
            if (c == '"' && s.startsWith("\"\"\"", i)) {
                int startLine = line;
                int j = i + 3;
                while (j < n && !s.startsWith("\"\"\"", j)) { if (s.charAt(j) == '\n') line++; j++; }
                String text = s.substring(i + 3, Math.min(j, n));
                i = Math.min(j + 3, n);
                emit(file, startLine, text, code, rawLines, inPreviewBody, out);
                code.append(" S ");
                continue;
            }
            if (c == '"') {
                int startLine = line;
                int j = i + 1;
                j = skipString(s, j);
                String text = s.substring(i + 1, Math.max(i + 1, Math.min(j - 1, n)));
                for (int k = i; k < j && k < n; k++) if (s.charAt(k) == '\n') line++;
                i = j;
                emit(file, startLine, text, code, rawLines, inPreviewBody, out);
                code.append(" S ");
                continue;
            }
            // code char
            if (c == '{') {
                if (previewPending && sawFunAfterPreview && !inPreviewBody && paren == funParen) {
                    inPreviewBody = true;
                    previewBodyDepth = brace;
                    previewPending = false;
                    sawFunAfterPreview = false;
                }
                brace++;
            } else if (c == '}') {
                brace--;
                if (inPreviewBody && brace == previewBodyDepth) inPreviewBody = false;
            } else if (c == '(') {
                paren++;
            } else if (c == ')') {
                paren--;
            } else if (c == '@' && s.startsWith("@Preview", i)) {
                previewPending = true;
                sawFunAfterPreview = false;
            } else if (previewPending && !sawFunAfterPreview && c == 'f' && s.startsWith("fun", i)
                    && (i == 0 || !Character.isLetterOrDigit(s.charAt(i - 1)))
                    && i + 3 < n && !Character.isLetterOrDigit(s.charAt(i + 3))) {
                sawFunAfterPreview = true;
                funParen = paren;
            }
            code.append(c);
            i++;
            if (code.length() > 4096) code.delete(0, code.length() - 400);
        }
    }

    /** Returns the index just past the closing quote of a regular string starting after its opening quote. */
    private static int skipString(String s, int j) {
        final int n = s.length();
        while (j < n) {
            char c = s.charAt(j);
            if (c == '\\') { j += 2; continue; }
            if (c == '"') return j + 1;
            if (c == '\n') return j; // unterminated, bail
            if (c == '$' && j + 1 < n && s.charAt(j + 1) == '{') {
                j = skipTemplate(s, j + 2);
                continue;
            }
            j++;
        }
        return j;
    }

    /** Skips a ${...} template body (may contain nested strings/braces); returns index past the closing brace. */
    private static int skipTemplate(String s, int j) {
        final int n = s.length();
        int depth = 1;
        while (j < n && depth > 0) {
            char c = s.charAt(j);
            if (c == '"') { j = skipString(s, j + 1); continue; }
            if (c == '{') depth++;
            else if (c == '}') depth--;
            j++;
        }
        return j;
    }

    private static void emit(String file, int line, String text, StringBuilder code, String[] rawLines,
                             boolean inPreviewBody, List<Hit> out) {
        if (inPreviewBody) return;
        if (!looksLikeEnglishUiText(text)) return;
        String before = tail(code, 160);
        // current source line up to the literal, for log filtering
        int nl = before.lastIndexOf('\n');
        String stmt = nl >= 0 ? before.substring(nl + 1) : before;
        if (LOG_CALL.matcher(stmt).find()) return;
        if (isSuppressed(rawLines, line)) return;
        for (Object[] ctx : CONTEXTS) {
            if (((Pattern) ctx[1]).matcher(before).find()) {
                out.add(new Hit(file, line, text, (String) ctx[0]));
                return;
            }
        }
    }

    private static String tail(StringBuilder sb, int max) {
        int len = sb.length();
        String t = len > max ? sb.substring(len - max) : sb.toString();
        return t;
    }

    private static boolean isSuppressed(String[] rawLines, int line) {
        if (line >= 1 && line <= rawLines.length && rawLines[line - 1].contains(SUPPRESS_MARKER)) return true;
        return line >= 2 && line - 2 < rawLines.length && rawLines[line - 2].contains(SUPPRESS_MARKER);
    }

    // ---- literal filter ----------------------------------------------------------------------

    private static final Pattern TEMPLATE = Pattern.compile("\\$\\{[^}]*\\}|\\$\\w+|%(?:\\d+\\$)?[-#+ 0,(]*\\d*(?:\\.\\d+)?[a-zA-Z%]");
    private static final Pattern WORDS = Pattern.compile("[A-Za-z]{2,}");
    private static final Pattern LOWER_TOKEN = Pattern.compile("^[a-z][a-z0-9_.:/#\\-]*$");
    private static final Pattern CAMEL = Pattern.compile("^[a-z]+(?:[A-Z][a-z0-9]*)+$");
    private static final Pattern DOTTED = Pattern.compile("^\\w+(?:[.:/]\\w+)+$");
    private static final Pattern CONSTANT = Pattern.compile("^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]*[0-9][A-Z0-9]*$");
    private static final Pattern URLISH = Pattern.compile("(?i)^(?:https?|content|file|market|mailto|tel|sms|geo|intent|package):|^www\\.|\\.(?:png|jpe?g|webp|json|onnx|bin|gguf|tflite|mp3|wav|m4a|ogg|txt|html?|xml|css|js)$");

    static boolean looksLikeEnglishUiText(String text) {
        String t = text.trim();
        if (t.length() < 2) return false;
        if (URLISH.matcher(t).find()) return false;
        String stripped = TEMPLATE.matcher(t).replaceAll(" ").trim();
        if (!WORDS.matcher(stripped).find()) return false;
        if (t.indexOf(' ') < 0) {
            if (LOWER_TOKEN.matcher(stripped).matches() || CAMEL.matcher(stripped).matches()
                    || DOTTED.matcher(stripped).matches() || CONSTANT.matcher(stripped).matches()) return false;
        }
        return true;
    }

    // ---- baseline ----------------------------------------------------------------------------

    /** Per-file literal fingerprints (text hashes, a multiset) of a scan, keyed by file. */
    public static Map<String, List<Hit>> byFile(List<Hit> hits) {
        Map<String, List<Hit>> m = new TreeMap<String, List<Hit>>();
        for (Hit h : hits) {
            List<Hit> l = m.get(h.file);
            if (l == null) { l = new ArrayList<Hit>(); m.put(h.file, l); }
            l.add(h);
        }
        return m;
    }

    public static final class Baseline {
        public final Map<String, Integer> counts = new TreeMap<String, Integer>();
        public final Map<String, List<String>> hashes = new HashMap<String, List<String>>();
        public int total() { int t = 0; for (int c : counts.values()) t += c; return t; }
    }

    private static final Pattern BASELINE_ENTRY = Pattern.compile(
            "\"([^\"]+)\"\\s*:\\s*\\{\\s*\"count\"\\s*:\\s*(\\d+)\\s*,\\s*\"h\"\\s*:\\s*\\[([^\\]]*)\\]");

    public static Baseline readBaseline(Path file) throws IOException {
        Baseline b = new Baseline();
        String json = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
        Matcher m = BASELINE_ENTRY.matcher(json);
        while (m.find()) {
            String path = m.group(1);
            b.counts.put(path, Integer.parseInt(m.group(2)));
            List<String> hs = new ArrayList<String>();
            for (String h : m.group(3).split(",")) {
                String x = h.trim().replace("\"", "");
                if (!x.isEmpty()) hs.add(x);
            }
            b.hashes.put(path, hs);
        }
        return b;
    }

    public static String renderBaseline(List<Hit> hits) {
        Map<String, List<Hit>> files = byFile(hits);
        StringBuilder sb = new StringBuilder();
        sb.append("{\n");
        sb.append("  \"_note\": \"Per-file count of hard-coded user-visible English literals in src/main. ")
          .append("NoHardcodedUiStringsTest fails if a count rises or a new file adds any. ")
          .append("Lower counts are fine. Regenerate deliberately with scripts/update-hardcoded-baseline.sh; ")
          .append("see docs/hardcoded-ui-strings-guard.md.\",\n");
        sb.append("  \"total\": ").append(hits.size()).append(",\n");
        sb.append("  \"files\": {");
        boolean first = true;
        for (Map.Entry<String, List<Hit>> e : files.entrySet()) {
            sb.append(first ? "\n" : ",\n");
            first = false;
            List<String> hs = new ArrayList<String>();
            for (Hit h : e.getValue()) hs.add(h.hash());
            Collections.sort(hs);
            sb.append("    \"").append(e.getKey()).append("\": {\"count\": ").append(hs.size()).append(", \"h\": [");
            for (int k = 0; k < hs.size(); k++) {
                if (k > 0) sb.append(", ");
                sb.append('"').append(hs.get(k)).append('"');
            }
            sb.append("]}");
        }
        sb.append(files.isEmpty() ? "}\n" : "\n  }\n");
        sb.append("}\n");
        return sb.toString();
    }

    /**
     * Compares a scan against the baseline. Returns the literals to blame for every file whose
     * count rose (or which is new), empty if the scan is within the baseline.
     */
    public static List<Hit> findNewHits(List<Hit> hits, Baseline base) {
        List<Hit> bad = new ArrayList<Hit>();
        for (Map.Entry<String, List<Hit>> e : byFile(hits).entrySet()) {
            Integer allowed = base.counts.get(e.getKey());
            int allow = allowed == null ? 0 : allowed;
            if (e.getValue().size() <= allow) continue;
            // multiset difference by text hash to point at the likely-new literals
            Map<String, Integer> remaining = new HashMap<String, Integer>();
            List<String> old = base.hashes.get(e.getKey());
            if (old != null) for (String h : old) remaining.put(h, remaining.containsKey(h) ? remaining.get(h) + 1 : 1);
            List<Hit> fresh = new ArrayList<Hit>();
            for (Hit h : e.getValue()) {
                Integer r = remaining.get(h.hash());
                if (r != null && r > 0) remaining.put(h.hash(), r - 1);
                else fresh.add(h);
            }
            bad.addAll(fresh.isEmpty() ? e.getValue() : fresh);
        }
        return bad;
    }

    // ---- command line ------------------------------------------------------------------------

    public static void main(String[] args) throws IOException {
        boolean update = false;
        boolean check = false;
        Path module = null;
        for (String a : args) {
            if (a.equals("--update")) update = true;
            else if (a.equals("--check")) check = true;
            else if (!a.startsWith("--")) module = Paths.get(a).toAbsolutePath();
        }
        module = resolveModuleDir(module != null ? module : Paths.get("").toAbsolutePath());
        long t0 = System.nanoTime();
        List<Hit> hits = scan(module);
        long ms = (System.nanoTime() - t0) / 1000000L;
        if (check) {
            List<Hit> fresh = findNewHits(hits, readBaseline(module.resolve(BASELINE_FILE)));
            for (Hit h : fresh) System.out.println("NEW " + h);
            System.out.println("check: " + hits.size() + " literals, " + fresh.size() + " over baseline (" + ms + " ms)");
            if (!fresh.isEmpty()) System.exit(1);
        } else if (update) {
            Path f = module.resolve(BASELINE_FILE);
            Files.write(f, renderBaseline(hits).getBytes(StandardCharsets.UTF_8));
            System.out.println("Wrote " + f + ": " + hits.size() + " literals in " + byFile(hits).size()
                    + " files (" + ms + " ms)");
        } else {
            for (Hit h : hits) System.out.println(h);
            System.out.println(hits.size() + " literals in " + byFile(hits).size() + " files (" + ms + " ms)");
        }
    }
}
