import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { getTtsFlags } from './ttsFlags.js';
import { appConfigRouter } from '../routes/appConfig.js';

test('defaults: apiEnabled true, engineApiEnabled false', () => {
  assert.deepEqual(getTtsFlags({}), { apiEnabled: true, engineApiEnabled: false });
});

test('TTS_API_ENABLED: explicit false values turn it off; garbled keeps the default (true)', () => {
  for (const v of ['false', 'FALSE', ' false ', '0', 'no', 'off']) assert.equal(getTtsFlags({ TTS_API_ENABLED: v }).apiEnabled, false, v);
  for (const v of ['true', '1', 'yes', 'on']) assert.equal(getTtsFlags({ TTS_API_ENABLED: v }).apiEnabled, true, v);
  for (const v of ['', 'maybe', 'tru', '{}', 'null', 'undefined']) assert.equal(getTtsFlags({ TTS_API_ENABLED: v }).apiEnabled, true, v);
});

test('TTS_ENGINE_API_ENABLED: only the exact string true enables it; everything else is false', () => {
  assert.equal(getTtsFlags({ TTS_ENGINE_API_ENABLED: 'true' }).engineApiEnabled, true);
  assert.equal(getTtsFlags({ TTS_ENGINE_API_ENABLED: ' TRUE ' }).engineApiEnabled, true);
  for (const v of ['1', 'yes', 'on', 'false', '', 'tru', 'truee', 'enabled', 'null']) {
    assert.equal(getTtsFlags({ TTS_ENGINE_API_ENABLED: v }).engineApiEnabled, false, v);
  }
});

test('engine flag stays false when only TTS_API_ENABLED is set (independent switches)', () => {
  assert.equal(getTtsFlags({ TTS_API_ENABLED: 'true' }).engineApiEnabled, false);
});

test('GET /api/config merges tts{} without removing paywallMode / paywall', async () => {
  const saved = { a: process.env.TTS_API_ENABLED, e: process.env.TTS_ENGINE_API_ENABLED };
  delete process.env.TTS_API_ENABLED;
  delete process.env.TTS_ENGINE_API_ENABLED;
  const app = express();
  app.use('/api/config', appConfigRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/config`;
  try {
    const body = await (await fetch(base)).json();
    assert.deepEqual(body.tts, { apiEnabled: true, engineApiEnabled: false });
    assert.ok(body.paywallMode === 'soft' || body.paywallMode === 'aggressive');
    assert.equal(typeof body.paywall.minOpensAfterFirstListen, 'number');
    assert.equal(typeof body.paywall.openLimitWithoutListen, 'number');
    assert.equal(typeof body.paywall.cooldownHours, 'number');

    process.env.TTS_API_ENABLED = 'false';
    process.env.TTS_ENGINE_API_ENABLED = 'true';
    assert.deepEqual((await (await fetch(base)).json()).tts, { apiEnabled: false, engineApiEnabled: true });
    process.env.TTS_ENGINE_API_ENABLED = 'garbage';
    assert.equal((await (await fetch(base)).json()).tts.engineApiEnabled, false);
  } finally {
    server.close();
    if (saved.a === undefined) delete process.env.TTS_API_ENABLED; else process.env.TTS_API_ENABLED = saved.a;
    if (saved.e === undefined) delete process.env.TTS_ENGINE_API_ENABLED; else process.env.TTS_ENGINE_API_ENABLED = saved.e;
  }
});
