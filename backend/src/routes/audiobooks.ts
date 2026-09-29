import { Router, Response, NextFunction, RequestHandler, Request } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { z } from 'zod';
import { logger } from '../lib/logger.js';
import {
  supabase,
  getUserTier,
  canSynthesizeV2,
  createTTSJob,
  getTTSJob,
  getSignedAudioUrl,
  uploadAudioFromFile,
  AUDIO_BUCKET,
} from '../lib/supabaseClient.js';
import { computeCacheKey, computeTextHash } from '../lib/cacheKey.js';
import { normalizeVoiceId, getVoiceInfo } from '../lib/voiceMapping.js';
import { publishTTSJob } from '../lib/pubsub.js';
import { addJobToGroup, getJobGroupProgress, clearJobGroup } from '../lib/jobProgressCache.js';
import { detectChaptersFromEpub, detectChaptersFromText, type DetectedChapter } from '../lib/chapterDetection.js';
import { MAX_TEXT_LENGTH } from '../lib/config.js';
import type { AuthenticatedRequest, AudioFormat } from '../types/index.js';
import { ValidationError, NotFoundError, QuotaExceededError } from '../types/index.js';

// ============================================================================
// Async Handler Wrapper (same pattern as routes/tts.ts)
// ============================================================================

function asyncHandler(
  fn: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req as AuthenticatedRequest, res, next)).catch(next);
  };
}

export const audiobooksRouter = Router();

// ============================================================================
// DB row types (matches supabase/migrations/018_add_audiobooks.sql)
// ============================================================================

type AudiobookStatus = 'pending' | 'processing' | 'completed' | 'failed';
type ExportStatus = 'not_started' | 'processing' | 'completed' | 'failed';
type ChapterStatus = 'pending' | 'queued' | 'processing' | 'ready' | 'failed' | 'canceled';

interface AudiobookRow {
  id: string;
  user_id: string;
  title: string;
  voice_id: string;
  speed: number;
  source_type: 'text' | 'epub';
  status: AudiobookStatus;
  chapter_count: number;
  export_status: ExportStatus;
  export_audio_path: string | null;
  export_duration_sec: number | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

interface ChapterRow {
  id: string;
  audiobook_id: string;
  sequence: number;
  title: string | null;
  text_content: string;
  char_count: number;
  tts_job_id: string | null;
  status: ChapterStatus;
  audio_path: string | null;
  duration_seconds: number | null;
  error_message: string | null;
}

// ============================================================================
// POST /api/audiobooks - Create an audiobook from text or ePub content
// ============================================================================
// Runs chapter detection, creates the audiobook + chapter rows, then fans
// out one TTS job per chapter (reusing createTTSJob/publishTTSJob from
// tts.ts's job pipeline rather than duplicating synthesis logic).

const createAudiobookSchema = z
  .object({
    title: z.string().min(1).max(500),
    voice_id: z.string().min(1).max(100),
    speed: z.number().min(0.5).max(3.0).optional(),
    source_type: z.enum(['text', 'epub']).default('text'),
    // Plain text (source_type: "text") — e.g. a flat `Article` from the
    // existing PDF/ePub-to-single-blob iOS import.
    text: z.string().min(1).max(MAX_TEXT_LENGTH * 20).optional(),
    // Base64-encoded .epub file bytes (source_type: "epub").
    epub_base64: z.string().min(1).optional(),
  })
  .refine((data) => (data.source_type === 'epub' ? !!data.epub_base64 : !!data.text), {
    message: 'text is required for source_type "text"; epub_base64 is required for source_type "epub"',
  });

audiobooksRouter.post('/', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;

  const parseResult = createAudiobookSchema.safeParse(req.body);
  if (!parseResult.success) {
    throw new ValidationError('Invalid request body', {
      errors: parseResult.error.flatten().fieldErrors,
    });
  }

  const { title, voice_id, speed, source_type, text, epub_base64 } = parseResult.data;
  const effectiveSpeed = speed ?? 1.0;

  logger.info({ userId, title, voiceId: voice_id, sourceType: source_type }, 'Audiobook creation request received');

  // 1. Detect chapters up front, before creating any DB rows — if this
  // fails we haven't left a half-created audiobook behind.
  let chapters: DetectedChapter[];
  try {
    if (source_type === 'epub') {
      const epubBuffer = Buffer.from(epub_base64 as string, 'base64');
      chapters = detectChaptersFromEpub(epubBuffer);
    } else {
      chapters = await detectChaptersFromText(text as string, title);
    }
  } catch (error) {
    logger.error({ error, userId, sourceType: source_type }, 'Chapter detection failed');
    throw new ValidationError(
      error instanceof Error ? `Chapter detection failed: ${error.message}` : 'Chapter detection failed'
    );
  }

  if (chapters.length === 0) {
    throw new ValidationError('Chapter detection produced no chapters');
  }

  // 2. Tier / per-chapter length check. Each chapter becomes its own TTS
  // job and is subject to the same max_chars_per_job limit as any other
  // job (see lib/config.ts TIER_LIMITS) — fixed voice/speed per chapter,
  // no per-chapter overrides.
  const userTier = await getUserTier(userId);
  const quotaCheck = await canSynthesizeV2(userId, 0);
  const oversizedChapter = chapters.find((c) => c.text.length > quotaCheck.max_chars_per_job);
  if (oversizedChapter) {
    throw new ValidationError(
      `A detected chapter ("${oversizedChapter.title}") is ${oversizedChapter.text.length.toLocaleString()} characters, ` +
        `over the ${quotaCheck.max_chars_per_job.toLocaleString()} character-per-job limit for the ${userTier} tier.`,
      { max_chars_per_job: quotaCheck.max_chars_per_job, tier: userTier }
    );
  }

  const totalChars = chapters.reduce((sum, c) => sum + c.text.length, 0);
  const totalQuotaCheck = await canSynthesizeV2(userId, totalChars);
  if (!totalQuotaCheck.allowed) {
    throw new QuotaExceededError(totalQuotaCheck.reason ?? 'Quota exceeded', totalQuotaCheck);
  }

  // 3. Create the audiobook row.
  const voiceInfo = getVoiceInfo(voice_id);
  const providerVoiceId = normalizeVoiceId(voice_id);

  const { data: audiobook, error: audiobookError } = await supabase
    .from('audiobooks')
    .insert({
      user_id: userId,
      title,
      voice_id,
      speed: effectiveSpeed,
      source_type,
      status: 'pending',
      chapter_count: chapters.length,
    })
    .select('*')
    .single();

  if (audiobookError || !audiobook) {
    logger.error({ error: audiobookError, userId }, 'Failed to create audiobook row');
    throw new Error('Failed to create audiobook');
  }

  const audiobookRow = audiobook as AudiobookRow;

  logger.info(
    { audiobookId: audiobookRow.id, userId, chapterCount: chapters.length, voiceInfo: voiceInfo?.name },
    'Audiobook row created, creating chapters'
  );

  // 4. Create chapter rows (pending — jobs fanned out next) and fan out one
  // TTS job per chapter, same fixed voice_id/speed for every chapter.
  const chapterInserts = chapters.map((chapter, index) => ({
    audiobook_id: audiobookRow.id,
    sequence: index,
    title: chapter.title,
    text_content: chapter.text,
    char_count: chapter.text.length,
    status: 'pending' as ChapterStatus,
  }));

  const { data: insertedChapters, error: chaptersError } = await supabase
    .from('audiobook_chapters')
    .insert(chapterInserts)
    .select('*')
    .order('sequence', { ascending: true });

  if (chaptersError || !insertedChapters) {
    logger.error({ error: chaptersError, audiobookId: audiobookRow.id }, 'Failed to create chapter rows');
    await supabase.from('audiobooks').update({ status: 'failed', error_message: 'Failed to create chapter rows' }).eq('id', audiobookRow.id);
    throw new Error('Failed to create audiobook chapters');
  }

  const modelId = 'kokoro-82m';
  const format: AudioFormat = 'mp3';
  let fanOutError: string | null = null;

  for (const chapterRow of insertedChapters as ChapterRow[]) {
    try {
      const cacheKey = computeCacheKey({
        text: chapterRow.text_content,
        voiceId: providerVoiceId,
        modelId,
        speed: effectiveSpeed,
        format,
      });
      const textHash = computeTextHash(chapterRow.text_content);

      const job = await createTTSJob({
        userId,
        voiceId: providerVoiceId,
        modelId,
        speed: effectiveSpeed,
        format,
        inputTextHash: textHash,
        inputCharCount: chapterRow.text_content.length,
        cacheKey,
        text: chapterRow.text_content,
        articleTitle: chapterRow.title ?? undefined,
      });

      addJobToGroup(audiobookRow.id, job.id);

      await supabase
        .from('audiobook_chapters')
        .update({ tts_job_id: job.id, status: 'queued' })
        .eq('id', chapterRow.id);

      try {
        await publishTTSJob(job.id);
      } catch (pubsubError) {
        // Same fallback posture as tts.ts /job: worker still picks it up via DB polling.
        logger.error({ error: pubsubError, jobId: job.id }, 'Failed to publish chapter job to Pub/Sub, will rely on DB polling');
      }
    } catch (error) {
      fanOutError = error instanceof Error ? error.message : 'Unknown error creating chapter job';
      logger.error({ error, chapterId: chapterRow.id, audiobookId: audiobookRow.id }, 'Failed to create TTS job for chapter');
      await supabase
        .from('audiobook_chapters')
        .update({ status: 'failed', error_message: fanOutError })
        .eq('id', chapterRow.id);
    }
  }

  await supabase
    .from('audiobooks')
    .update({ status: fanOutError ? 'failed' : 'processing', error_message: fanOutError })
    .eq('id', audiobookRow.id);

  logger.info({ audiobookId: audiobookRow.id, chapterCount: chapters.length, fanOutError }, 'Audiobook chapter jobs fanned out');

  res.status(202).json({
    audiobook_id: audiobookRow.id,
    status: fanOutError ? 'failed' : 'processing',
    chapter_count: chapters.length,
    chapters: (insertedChapters as ChapterRow[]).map((c) => ({
      id: c.id,
      sequence: c.sequence,
      title: c.title,
      char_count: c.char_count,
    })),
  });
}));

// ============================================================================
// GET /api/audiobooks/:id/status - Aggregate progress across all chapters
// ============================================================================

audiobooksRouter.get('/:id/status', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;
  const { id } = req.params;
  if (!id) throw new ValidationError('Audiobook id is required');

  const { audiobook, chapters } = await loadAudiobookForUser(id, userId);

  // Refresh each non-terminal chapter's status from its tts_jobs row (and
  // the in-memory job-progress-cache for percentage/ETA on active jobs),
  // then roll up into one audiobook-level status.
  let anyFailed = false;
  let allReady = true;
  let completedChapters = 0;

  const chapterStatuses = await Promise.all(
    chapters.map(async (chapter) => {
      if (!chapter.tts_job_id) {
        allReady = false;
        return { ...chapter, percentage: 0 };
      }

      if (chapter.status === 'ready' || chapter.status === 'failed' || chapter.status === 'canceled') {
        if (chapter.status === 'ready') completedChapters++;
        if (chapter.status === 'failed' || chapter.status === 'canceled') { anyFailed = true; allReady = false; }
        else if (chapter.status !== 'ready') allReady = false;
        return { ...chapter, percentage: chapter.status === 'ready' ? 100 : 0 };
      }

      const job = await getTTSJob(chapter.tts_job_id);
      if (!job) {
        allReady = false;
        return { ...chapter, percentage: 0 };
      }

      let newStatus: ChapterStatus = chapter.status;
      let audioPath: string | null = chapter.audio_path;
      let durationSeconds: number | null = chapter.duration_seconds;
      let errorMessage: string | null = chapter.error_message;

      if (job.status === 'ready') {
        newStatus = 'ready';
        audioPath = job.full_audio_path || job.audio_path;
        durationSeconds = job.duration_sec;
        completedChapters++;
      } else if (job.status === 'failed' || job.status === 'canceled') {
        newStatus = job.status;
        errorMessage = job.error_message;
        anyFailed = true;
      } else {
        newStatus = 'processing';
        allReady = false;
      }

      if (newStatus !== chapter.status || audioPath !== chapter.audio_path || durationSeconds !== chapter.duration_seconds) {
        await supabase
          .from('audiobook_chapters')
          .update({ status: newStatus, audio_path: audioPath, duration_seconds: durationSeconds, error_message: errorMessage })
          .eq('id', chapter.id);
      }

      const percentage = newStatus === 'ready' ? 100 : job.chunks_total ? Math.round((job.chunks_completed / Math.max(1, job.chunks_total)) * 100) : 0;

      return { ...chapter, status: newStatus, audio_path: audioPath, duration_seconds: durationSeconds, error_message: errorMessage, percentage };
    })
  );

  const groupProgress = getJobGroupProgress(id);

  let overallStatus: AudiobookStatus = audiobook.status;
  if (anyFailed) overallStatus = 'failed';
  else if (allReady && chapters.length > 0) overallStatus = 'completed';
  else overallStatus = 'processing';

  if (overallStatus !== audiobook.status) {
    await supabase.from('audiobooks').update({ status: overallStatus }).eq('id', id);
    if (overallStatus === 'completed' || overallStatus === 'failed') {
      clearJobGroup(id);
    }
  }

  const overallPercentage = chapters.length > 0
    ? Math.round(chapterStatuses.reduce((sum, c) => sum + c.percentage, 0) / chapters.length)
    : 0;

  res.json({
    audiobook_id: id,
    status: overallStatus,
    chapter_count: chapters.length,
    chapters_completed: completedChapters,
    overall_percentage: overallPercentage,
    export_status: audiobook.export_status,
    chapters: chapterStatuses.map((c) => ({
      id: c.id,
      sequence: c.sequence,
      title: c.title,
      status: c.status,
      percentage: c.percentage,
      duration_seconds: c.duration_seconds,
      error_message: c.error_message,
    })),
    job_group_progress: groupProgress, // in-memory rollup, informational only — DB fields above are authoritative
  });
}));

// ============================================================================
// POST /api/audiobooks/:id/export - Concatenate chapters into one MP3
// ============================================================================
// Requires every chapter to be 'ready'. Downloads each chapter's audio from
// storage, concatenates via ffmpeg, and writes ID3 chapter markers (via an
// ffmpeg metadata file) before re-uploading the single MP3.
//
// NOTE: per task constraints, this endpoint's ffmpeg invocation is written
// but intentionally not exercised/executed as part of this change (no real
// ffmpeg run, no live migration, no external API calls were made building
// this route).

audiobooksRouter.post('/:id/export', asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user.id;
  const { id } = req.params;
  if (!id) throw new ValidationError('Audiobook id is required');

  const { audiobook, chapters } = await loadAudiobookForUser(id, userId);

  if (chapters.length === 0) {
    throw new ValidationError('Audiobook has no chapters');
  }

  const notReady = chapters.find((c) => c.status !== 'ready' || !c.audio_path);
  if (notReady) {
    throw new ValidationError(
      `Cannot export: chapter ${notReady.sequence + 1} ("${notReady.title ?? 'Untitled'}") is not ready (status: ${notReady.status}). ` +
        `Poll GET /api/audiobooks/${id}/status until all chapters are ready.`
    );
  }

  await supabase.from('audiobooks').update({ export_status: 'processing' }).eq('id', id);

  try {
    const exportResult = await exportAudiobookToMp3(audiobook, chapters);

    await supabase
      .from('audiobooks')
      .update({
        export_status: 'completed',
        export_audio_path: exportResult.audioPath,
        export_duration_sec: exportResult.durationSec,
      })
      .eq('id', id);

    const audioUrl = await getSignedAudioUrl(exportResult.audioPath);

    res.json({
      audiobook_id: id,
      export_status: 'completed',
      audio_path: exportResult.audioPath,
      audio_url: audioUrl,
      duration_seconds: exportResult.durationSec,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Export failed';
    logger.error({ error, audiobookId: id }, 'Audiobook export failed');
    await supabase.from('audiobooks').update({ export_status: 'failed', error_message: message }).eq('id', id);
    throw error;
  }
}));

// ============================================================================
// Helpers
// ============================================================================

async function loadAudiobookForUser(
  audiobookId: string,
  userId: string
): Promise<{ audiobook: AudiobookRow; chapters: ChapterRow[] }> {
  const { data: audiobook, error: audiobookError } = await supabase
    .from('audiobooks')
    .select('*')
    .eq('id', audiobookId)
    .eq('user_id', userId)
    .single();

  if (audiobookError || !audiobook) {
    throw new NotFoundError('Audiobook');
  }

  const { data: chapters, error: chaptersError } = await supabase
    .from('audiobook_chapters')
    .select('*')
    .eq('audiobook_id', audiobookId)
    .order('sequence', { ascending: true });

  if (chaptersError) {
    logger.error({ error: chaptersError, audiobookId }, 'Failed to load audiobook chapters');
    throw new Error('Failed to load audiobook chapters');
  }

  return { audiobook: audiobook as AudiobookRow, chapters: (chapters ?? []) as ChapterRow[] };
}

/**
 * Download each chapter's audio, concatenate with ffmpeg, and write ID3
 * chapter markers via an ffmpeg metadata file (FFMETADATA1 format), then
 * upload the resulting MP3 back to storage.
 *
 * Written to match ttsJobWorker.ts's existing ffmpeg-via-child_process
 * pattern (spawn('ffmpeg', [...]), no fluent-ffmpeg/ffmpeg-static — this
 * repo has neither as an npm dependency, it shells out directly and assumes
 * ffmpeg is on PATH; see workers/ttsJobWorker.ts convertWavToMp3/concatWavFiles).
 *
 * Per task constraints this function is not invoked by any test or startup
 * path in this change — it is code-complete but unexecuted.
 */
async function exportAudiobookToMp3(
  audiobook: AudiobookRow,
  chapters: ChapterRow[]
): Promise<{ audioPath: string; durationSec: number }> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `audiobook-${audiobook.id}-`));

  try {
    // 1. Download each chapter's audio to a local temp file, in sequence order.
    const localChapterPaths: string[] = [];
    const chapterDurationsSec: number[] = [];

    for (const chapter of chapters) {
      if (!chapter.audio_path) {
        throw new Error(`Chapter ${chapter.sequence + 1} has no audio_path`);
      }
      const { data, error } = await supabase.storage.from(AUDIO_BUCKET).download(chapter.audio_path);
      if (error || !data) {
        throw new Error(`Failed to download chapter ${chapter.sequence + 1} audio: ${error?.message ?? 'no data'}`);
      }
      const localPath = path.join(workDir, `chapter-${String(chapter.sequence).padStart(4, '0')}.mp3`);
      const arrayBuffer = await data.arrayBuffer();
      await fs.writeFile(localPath, Buffer.from(arrayBuffer));
      localChapterPaths.push(localPath);
      chapterDurationsSec.push(chapter.duration_seconds ?? 0);
    }

    // 2. Write the ffmpeg concat list.
    const concatListPath = path.join(workDir, 'concat_list.txt');
    const concatListContent = localChapterPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    await fs.writeFile(concatListPath, concatListContent, 'utf8');

    // 3. Write an FFMETADATA1 file with one CHAPTER block per chapter, so
    // the exported MP3 carries ID3 chapter markers.
    const metadataPath = path.join(workDir, 'chapters.txt');
    await fs.writeFile(metadataPath, buildFfmetadata(audiobook.title, chapters, chapterDurationsSec), 'utf8');

    // 4. Concatenate + attach chapter metadata in one ffmpeg pass.
    const outputPath = path.join(workDir, 'export.mp3');
    await runFfmpegConcatWithChapters(concatListPath, metadataPath, outputPath);

    // 5. Upload the result and clean up.
    const storagePath = `audiobooks/${audiobook.id}/export.mp3`;
    await uploadAudioFromFile(storagePath, outputPath, 'mp3');

    const totalDurationSec = chapterDurationsSec.reduce((sum, s) => sum + s, 0);

    return { audioPath: storagePath, durationSec: totalDurationSec };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function buildFfmetadata(title: string, chapters: ChapterRow[], durationsSec: number[]): string {
  const lines = [';FFMETADATA1', `title=${escapeFfmetadata(title)}`, ''];
  let cursorMs = 0;
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    if (!chapter) continue;
    const durationMs = Math.max(0, Math.round((durationsSec[i] ?? 0) * 1000));
    const startMs = cursorMs;
    const endMs = cursorMs + durationMs;
    lines.push(
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${startMs}`,
      `END=${endMs}`,
      `title=${escapeFfmetadata(chapter.title ?? `Chapter ${i + 1}`)}`,
      ''
    );
    cursorMs = endMs;
  }
  return lines.join('\n');
}

function escapeFfmetadata(value: string): string {
  return value.replace(/([=;#\\\n])/g, '\\$1');
}

/**
 * Runs: ffmpeg -f concat -safe 0 -i <concatList> -i <metadata> -map_metadata 1 -codec copy <output>
 * NOT executed as part of this task (see task constraints) — provided for
 * completeness of the export endpoint's implementation.
 */
function runFfmpegConcatWithChapters(concatListPath: string, metadataPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-i', metadataPath,
      '-map_metadata', '1',
      '-codec', 'copy',
      outputPath,
    ]);

    let stderrOutput = '';
    ffmpeg.stderr.on('data', (data: Buffer) => {
      stderrOutput += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderrOutput.slice(-500)}`));
    });

    ffmpeg.on('error', (err) => {
      reject(new Error(`ffmpeg spawn error: ${err.message}`));
    });
  });
}
