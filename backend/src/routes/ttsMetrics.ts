import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabaseClient.js';
import { logger } from '../lib/logger.js';

// ============================================================================
// /admin/tts-metrics — single-endpoint dashboard for the TTS pipeline.
//
// Purpose: at <100 DAU you don't need Prometheus + Grafana yet — you need
// one curl-able endpoint that tells you:
//   - Is the queue backing up right now?
//   - What's typical synth latency?
//   - Are articles longer than we expected?
//   - Are we silently failing?
//
// Mount it under the existing admin router so the `x-admin-key` header
// auth applies automatically.
//
//   curl -H "x-admin-key: $ADMIN_API_KEY" \
//     https://listenai-backend.fly.dev/admin/tts-metrics
// ============================================================================

const metricsLogger = logger.child({ module: 'tts-metrics' });

export const ttsMetricsRouter = Router();

/**
 * Compute percentiles from a sorted array. Returns null for empty arrays
 * so callers can detect "no data" cleanly.
 */
function percentile(sortedAsc: number[], p: number): number {
  // Caller guarantees non-empty (we check before calling).
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo]!;
  const w = rank - lo;
  return sortedAsc[lo]! * (1 - w) + sortedAsc[hi]! * w;
}

function stats(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    p99: Math.round(percentile(sorted, 99)),
    max: sorted[sorted.length - 1]!,
  };
}

ttsMetricsRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // 1) Current queue state (point-in-time)
    const [queuedRes, processingRes] = await Promise.all([
      supabase
        .from('tts_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'queued'),
      supabase
        .from('tts_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'processing'),
    ]);

    // 2) Last 24h job sample for latency + size percentiles. We grab the
    // raw rows once and compute everything in JS — at <100 DAU this is a
    // few hundred rows, well under any reasonable response budget.
    const { data: recentJobs, error: recentErr } = await supabase
      .from('tts_jobs')
      .select(
        'id, status, created_at, started_at, completed_at, input_char_count, retry_count'
      )
      .gte('created_at', twentyFourHoursAgo.toISOString())
      .order('created_at', { ascending: false });
    if (recentErr) throw recentErr;

    const rows = recentJobs || [];
    const completed = rows.filter(
      (r) => r.status === 'ready' && r.started_at && r.completed_at
    );
    const failed = rows.filter((r) => r.status === 'failed');

    // Latencies (ms)
    const queueWaitMs = completed
      .filter((r) => r.created_at && r.started_at)
      .map(
        (r) =>
          new Date(r.started_at as string).getTime() -
          new Date(r.created_at).getTime()
      );
    const synthMs = completed
      .filter((r) => r.started_at && r.completed_at)
      .map(
        (r) =>
          new Date(r.completed_at as string).getTime() -
          new Date(r.started_at as string).getTime()
      );
    const endToEndMs = completed
      .filter((r) => r.created_at && r.completed_at)
      .map(
        (r) =>
          new Date(r.completed_at as string).getTime() -
          new Date(r.created_at).getTime()
      );

    // Article sizes (chars) over the same window
    const articleChars = rows
      .filter((r) => r.input_char_count != null)
      .map((r) => r.input_char_count as number);

    // Synth speed in characters per second — capacity-planning gold.
    const synthCps = completed
      .filter(
        (r) =>
          r.started_at &&
          r.completed_at &&
          r.input_char_count != null &&
          r.input_char_count > 0
      )
      .map((r) => {
        const ms =
          new Date(r.completed_at as string).getTime() -
          new Date(r.started_at as string).getTime();
        return ms > 0 ? (r.input_char_count as number) / (ms / 1000) : 0;
      })
      .filter((v) => v > 0);

    // 3) Last-hour throughput (subset of the 24h sample)
    const lastHour = rows.filter(
      (r) => new Date(r.created_at).getTime() >= oneHourAgo.getTime()
    );

    const completedCount = completed.length;
    const failedCount = failed.length;
    const errorRate =
      completedCount + failedCount > 0
        ? failedCount / (completedCount + failedCount)
        : 0;

    res.json({
      now: now.toISOString(),
      queue_now: {
        queued: queuedRes.count ?? 0,
        processing: processingRes.count ?? 0,
      },
      throughput_24h: {
        submitted: rows.length,
        completed: completedCount,
        failed: failedCount,
        error_rate: Number(errorRate.toFixed(4)),
      },
      throughput_1h: {
        submitted: lastHour.length,
        completed: lastHour.filter((r) => r.status === 'ready').length,
        failed: lastHour.filter((r) => r.status === 'failed').length,
      },
      latency_ms_24h: {
        queue_wait: stats(queueWaitMs),
        synth: stats(synthMs),
        end_to_end: stats(endToEndMs),
      },
      article_chars_24h: stats(articleChars),
      synth_chars_per_sec_24h: stats(synthCps),
      retries_24h: {
        jobs_with_retries: rows.filter((r) => (r.retry_count ?? 0) > 0).length,
        total_retries: rows.reduce(
          (sum, r) => sum + (r.retry_count ?? 0),
          0
        ),
      },
    });
  } catch (err) {
    metricsLogger.error({ err }, 'tts-metrics handler failed');
    res.status(500).json({ error: 'metrics query failed' });
  }
});
