/**
 * Test script to verify the micro-first TTS flow in production.
 *
 * This script:
 * 1. Creates a TTS job directly (bypassing API auth)
 * 2. Processes it through the worker
 * 3. Verifies the flow matches expected timing and state transitions
 *
 * Usage:
 *   cd backend && npx tsx src/scripts/testMicroFirstFlow.ts
 *
 * Environment:
 *   Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ELEVENLABS_API_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

// Load environment from .env.production if available
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.production' });
dotenv.config(); // Also try .env

// Configuration
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const TEST_VOICE_ID = process.env.TEST_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb'; // George
const TEST_USER_ID = process.env.TEST_USER_ID || 'test-user-' + randomUUID().slice(0, 8);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing required environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Test text samples
const SHORT_TEXT = 'Hello, this is a short test message for TTS synthesis.';

const MEDIUM_TEXT = `The quick brown fox jumps over the lazy dog. This is a test of the text-to-speech system that should trigger the micro-first strategy. The system should extract the first sentence as a micro-preview, generate it quickly, and then continue with the full audio generation in the background. This allows users to start hearing audio almost immediately while the full synthesis completes.`;

const LONG_TEXT = `Welcome to this demonstration of the micro-first text-to-speech strategy.

The goal of this approach is to minimize the time-to-first-audio - the delay between when a user requests audio and when they hear the first sound. Traditional TTS systems must synthesize the entire text before any audio can play, which creates long wait times for longer content.

Our micro-first strategy works differently. When you request audio, the system immediately extracts a small "micro-preview" - just the first sentence or clause, roughly 120 to 180 characters. This tiny snippet is synthesized first and made available for playback within 2 to 3 seconds.

While you're listening to this preview, the system continues working on the full audio in the background. By the time you've heard the first few seconds of content, the complete audio is typically ready. The player then seamlessly transitions from the preview to the full audio, maintaining your playback position.

This architecture provides several benefits. First, perceived latency drops dramatically - users hear audio almost immediately instead of waiting 10 to 15 seconds for long articles. Second, the system feels more responsive and modern. Third, users can decide if they want to continue listening based on the preview.

The implementation uses ElevenLabs as the TTS provider, which returns MP3 audio directly. The micro-preview is generated with a non-streaming API call for simplicity, while the full audio streams to a temporary file for memory safety. This prevents memory issues when synthesizing very long content.

Thank you for testing the micro-first TTS flow. This text should be long enough to properly exercise all parts of the system.`;

// Test types
interface TestCase {
  name: string;
  text: string;
  expectedMicroChars?: { min: number; max: number };
  expectsMicroFirst: boolean;
}

const TEST_CASES: TestCase[] = [
  {
    name: 'Short text (no micro-first)',
    text: SHORT_TEXT,
    expectsMicroFirst: false,
  },
  {
    name: 'Medium text (micro-first)',
    text: MEDIUM_TEXT,
    expectedMicroChars: { min: 40, max: 180 },
    expectsMicroFirst: true,
  },
  {
    name: 'Long text (micro-first)',
    text: LONG_TEXT,
    expectedMicroChars: { min: 40, max: 180 },
    expectsMicroFirst: true,
  },
];

interface TestResult {
  testName: string;
  passed: boolean;
  jobId: string;
  timings: {
    jobCreated?: number;
    processingStarted?: number;
    partialReady?: number;
    ready?: number;
    totalMs?: number;
    timeToPartialMs?: number;
    timeToReadyMs?: number;
  };
  states: string[];
  microTextLength?: number;
  fullDurationSec?: number;
  errors: string[];
}

async function createTestJob(text: string): Promise<string> {
  const cacheKey = 'test-' + randomUUID();

  // Create job via RPC
  const { data: jobId, error } = await supabase.rpc('create_tts_job', {
    p_user_id: TEST_USER_ID,
    p_voice_id: TEST_VOICE_ID,
    p_model_id: 'elevenlabs',
    p_speed: 1.0,
    p_format: 'mp3',
    p_input_text_hash: cacheKey,
    p_input_char_count: text.length,
    p_cache_key: cacheKey,
    p_text: text,
    p_article_id: null,
    p_article_title: 'Test Article',
  });

  if (error) {
    throw new Error(`Failed to create job: ${error.message}`);
  }

  return jobId;
}

async function pollJobStatus(
  jobId: string,
  maxWaitMs: number = 60000,
  pollIntervalMs: number = 500
): Promise<{ states: string[]; finalJob: Record<string, unknown>; timings: TestResult['timings'] }> {
  const startTime = Date.now();
  const states: string[] = [];
  const timings: TestResult['timings'] = { jobCreated: startTime };
  let lastStatus = '';

  while (Date.now() - startTime < maxWaitMs) {
    const { data: job, error } = await supabase
      .from('tts_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error) {
      throw new Error(`Failed to poll job: ${error.message}`);
    }

    const status = job.status as string;

    if (status !== lastStatus) {
      states.push(status);
      lastStatus = status;
      const now = Date.now();

      console.log(`  [${((now - startTime) / 1000).toFixed(2)}s] Status: ${status}`);

      if (status === 'processing' && !timings.processingStarted) {
        timings.processingStarted = now;
      }
      if (status === 'partial_ready' && !timings.partialReady) {
        timings.partialReady = now;
        timings.timeToPartialMs = now - startTime;
        console.log(`    📍 Micro-preview ready at ${timings.timeToPartialMs}ms`);
        console.log(`    📍 Preview path: ${job.preview_audio_path}`);
        console.log(`    📍 Preview duration: ${job.preview_duration_sec}s`);
      }
      if (status === 'ready') {
        timings.ready = now;
        timings.timeToReadyMs = now - startTime;
        timings.totalMs = now - startTime;
        console.log(`    ✅ Full audio ready at ${timings.timeToReadyMs}ms`);
        console.log(`    ✅ Full path: ${job.full_audio_path || job.audio_path}`);
        console.log(`    ✅ Duration: ${job.duration_sec}s`);
        return { states, finalJob: job as Record<string, unknown>, timings };
      }
      if (status === 'failed') {
        console.log(`    ❌ Job failed: ${job.error_message}`);
        return { states, finalJob: job as Record<string, unknown>, timings };
      }
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  throw new Error(`Job timed out after ${maxWaitMs}ms`);
}

async function runTest(testCase: TestCase): Promise<TestResult> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST: ${testCase.name}`);
  console.log(`Text length: ${testCase.text.length} characters`);
  console.log(`Expects micro-first: ${testCase.expectsMicroFirst}`);
  console.log('='.repeat(60));

  const result: TestResult = {
    testName: testCase.name,
    passed: false,
    jobId: '',
    timings: {},
    states: [],
    errors: [],
  };

  try {
    // Create job
    console.log('\n1. Creating job...');
    const jobId = await createTestJob(testCase.text);
    result.jobId = jobId;
    console.log(`   Job ID: ${jobId}`);

    // Poll for completion
    console.log('\n2. Polling for status updates...');
    const { states, finalJob, timings } = await pollJobStatus(jobId);
    result.states = states;
    result.timings = timings;
    result.fullDurationSec = finalJob.duration_sec as number | undefined;

    // Verify results
    console.log('\n3. Verifying results...');

    // Check final status
    if (finalJob.status !== 'ready') {
      result.errors.push(`Expected status 'ready', got '${finalJob.status}'`);
    }

    // Check state transitions
    if (testCase.expectsMicroFirst) {
      if (!states.includes('partial_ready')) {
        result.errors.push('Expected partial_ready state for micro-first, but not found');
      }
      if (!finalJob.preview_audio_path) {
        result.errors.push('Expected preview_audio_path to be set');
      }

      // Check timing - micro should be ready within 5 seconds
      if (timings.timeToPartialMs && timings.timeToPartialMs > 5000) {
        result.errors.push(`Micro-preview took ${timings.timeToPartialMs}ms, expected < 5000ms`);
      }
    } else {
      // Short text should go directly to ready (or through partial_ready quickly)
      if (timings.timeToReadyMs && timings.timeToReadyMs > 10000) {
        result.errors.push(`Short text took ${timings.timeToReadyMs}ms, expected < 10000ms`);
      }
    }

    // Check audio paths
    if (!finalJob.audio_path && !finalJob.full_audio_path) {
      result.errors.push('No audio path set on completed job');
    }

    result.passed = result.errors.length === 0;

    // Print summary
    console.log('\n4. Summary:');
    console.log(`   States: ${states.join(' → ')}`);
    console.log(`   Total time: ${timings.totalMs}ms`);
    if (timings.timeToPartialMs) {
      console.log(`   Time to partial_ready: ${timings.timeToPartialMs}ms`);
    }
    console.log(`   Full duration: ${result.fullDurationSec}s`);
    console.log(`   Result: ${result.passed ? '✅ PASSED' : '❌ FAILED'}`);
    if (result.errors.length > 0) {
      console.log('   Errors:');
      result.errors.forEach((e) => console.log(`     - ${e}`));
    }

    return result;
  } catch (error) {
    result.errors.push(`Test error: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`\n❌ Test failed with error: ${error}`);
    return result;
  }
}

async function cleanupTestJobs(): Promise<void> {
  console.log('\nCleaning up test jobs...');

  // Delete test jobs older than 1 hour
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('tts_jobs')
    .delete()
    .like('user_id', 'test-user-%')
    .lt('created_at', oneHourAgo);

  if (error) {
    console.log(`  Warning: Cleanup failed: ${error.message}`);
  } else {
    console.log('  Done.');
  }
}

async function main(): Promise<void> {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║          MICRO-FIRST TTS FLOW TEST SUITE                    ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log(`\nTest configuration:`);
  console.log(`  Supabase URL: ${SUPABASE_URL.slice(0, 30)}...`);
  console.log(`  Voice ID: ${TEST_VOICE_ID}`);
  console.log(`  Test User: ${TEST_USER_ID}`);

  const results: TestResult[] = [];

  for (const testCase of TEST_CASES) {
    const result = await runTest(testCase);
    results.push(result);
  }

  // Print final summary
  console.log('\n' + '═'.repeat(60));
  console.log('FINAL SUMMARY');
  console.log('═'.repeat(60));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

  results.forEach((r) => {
    const status = r.passed ? '✅' : '❌';
    const timing = r.timings.timeToPartialMs
      ? `(micro: ${r.timings.timeToPartialMs}ms, total: ${r.timings.totalMs}ms)`
      : `(total: ${r.timings.totalMs}ms)`;
    console.log(`  ${status} ${r.testName} ${timing}`);
    if (!r.passed) {
      r.errors.forEach((e) => console.log(`      ↳ ${e}`));
    }
  });

  // Cleanup
  await cleanupTestJobs();

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
