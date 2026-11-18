package guard.i18n;

import static org.junit.Assert.fail;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.Test;

/**
 * Baseline guard against new hard-coded user-visible English in src/main.
 *
 * Fails if any source file has more hard-coded UI literals than recorded in
 * hardcoded-ui-strings.baseline.json, or if a file that is not in the baseline adds any.
 * Fewer literals than the baseline is fine. To change the baseline deliberately run
 * scripts/update-hardcoded-baseline.sh. Details: docs/hardcoded-ui-strings-guard.md.
 */
public class NoHardcodedUiStringsTest {

    @Test
    public void noNewHardcodedUiStrings() throws Exception {
        Path module = HardcodedUiStringScanner.findModuleDir();
        Path baselineFile = module.resolve(HardcodedUiStringScanner.BASELINE_FILE);
        if (!Files.isRegularFile(baselineFile)) {
            fail("Missing " + baselineFile + ". Generate it with scripts/update-hardcoded-baseline.sh");
        }
        long t0 = System.nanoTime();
        List<HardcodedUiStringScanner.Hit> hits = HardcodedUiStringScanner.scan(module);
        HardcodedUiStringScanner.Baseline baseline = HardcodedUiStringScanner.readBaseline(baselineFile);
        long ms = (System.nanoTime() - t0) / 1000000L;

        List<HardcodedUiStringScanner.Hit> fresh = HardcodedUiStringScanner.findNewHits(hits, baseline);
        System.out.println("NoHardcodedUiStrings: " + hits.size() + " literals (baseline "
                + baseline.total() + "), scan " + ms + " ms");
        if (hits.size() < baseline.total()) {
            System.out.println("NoHardcodedUiStrings: " + (baseline.total() - hits.size())
                    + " fewer than the baseline. Ratchet it down with scripts/update-hardcoded-baseline.sh");
        }
        if (!fresh.isEmpty()) {
            StringBuilder sb = new StringBuilder();
            sb.append("New hard-coded user-visible English in src/main (").append(fresh.size()).append("):\n");
            for (HardcodedUiStringScanner.Hit h : fresh) sb.append("  ").append(h).append('\n');
            sb.append("Fix: ").append(HardcodedUiStringScanner.FIX_HINT).append(".\n");
            sb.append("Not user-visible (log, key, wire value)? Add a '// ")
              .append(HardcodedUiStringScanner.SUPPRESS_MARKER).append("' comment on that line or the line above.\n");
            sb.append("Only to accept it deliberately: scripts/update-hardcoded-baseline.sh ")
              .append("(see docs/hardcoded-ui-strings-guard.md).");
            fail(sb.toString());
        }
    }
}
