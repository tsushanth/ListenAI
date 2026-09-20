// Local mock of the backend's /api/voice-studio routes, for screenshots/manual UI runs only.
//   node test/voice-studio-mock-server.mjs   (port 8791)  + web built with NEXT_PUBLIC_VOICE_STUDIO_MOCK=1
// Speaker name containing "reject" => training ends rejected (noisy_audio); "warn" => ready with warnings.
// POST /__seed {status, speaker_name, warnings?, error?} creates a voice directly in that state.
import http from 'node:http'

const PORT = Number(process.env.PORT || 8791)
const voices = new Map()
let n = 0
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS' })
  res.end(type === 'application/json' ? JSON.stringify(body) : body)
}
const body = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))) })
const wav = (secs = 1.5, hz = 220) => {
  const sr = 22050, len = Math.floor(secs * sr), b = Buffer.alloc(44 + len * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + len * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22)
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(len * 2, 40)
  for (let i = 0; i < len; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / sr) * 6000 * Math.min(1, i / 800, (len - i) / 800)), 44 + i * 2)
  return b
}
const pub = (v) => ({ id: v.id, status: v.status, speaker_name: v.speaker_name, created_at: v.created_at, warnings: v.warnings, stats: v.status === 'ready' || v.status === 'deployed' ? { minutes: 24.6, clips: 231 } : undefined, error: v.error, voice: v.status === 'deployed' ? `custom:${v.id}` : undefined })

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '')
  const u = new URL(req.url, 'http://x'), p = u.pathname
  if (p === '/__seed' && req.method === 'POST') {
    const j = JSON.parse((await body(req)).toString() || '{}')
    const id = `v-${(++n).toString(16).padStart(10, '0')}`
    voices.set(id, { id, status: j.status, speaker_name: j.speaker_name || 'Maria Alvarez', created_at: Math.floor(Date.now() / 1000) - 86400 * n, warnings: j.warnings || [], error: j.error, parts: new Map() })
    return send(res, 200, { id })
  }
  if (p === '/__reset') { voices.clear(); return send(res, 200, {}) }
  if (!p.startsWith('/api/voice-studio')) return send(res, 404, { error: 'not found' })
  if (!req.headers.authorization) return send(res, 401, { error: 'Sign in required.' })
  const rest = p.slice('/api/voice-studio'.length) || '/'
  if (rest === '/enabled') return send(res, 200, { enabled: true, consent_text_version: '2026-09-v1', max_zip_bytes: 300 * 1048576, part_bytes: 8 * 1048576 })
  if (rest === '/' && req.method === 'GET') return send(res, 200, { voices: [...voices.values()].map(pub) })
  if (rest === '/' && req.method === 'POST') {
    const j = JSON.parse((await body(req)).toString())
    if (!j.consent) return send(res, 400, { error: 'Consent must be confirmed.' })
    const id = `v-${(++n).toString(16).padStart(10, '0')}`
    voices.set(id, { id, status: 'created', speaker_name: j.speaker_name, created_at: Math.floor(Date.now() / 1000), warnings: [], parts: new Map() })
    return send(res, 201, { id })
  }
  const m = rest.match(/^\/(v-[0-9a-f]{10})(\/.*)?$/)
  const v = m && voices.get(m[1])
  if (!v) return send(res, 404, { error: 'Voice not found.' })
  const sub = m[2] || ''
  if (sub === '' && req.method === 'GET') return send(res, 200, pub(v))
  if (sub === '' && req.method === 'DELETE') { voices.delete(v.id); return send(res, 200, { deleted: true }) }
  let pm
  if (req.method === 'PUT' && (pm = sub.match(/^\/dataset\/parts\/(\d+)$/))) { const b = await body(req); v.parts.set(Number(pm[1]), b.length); await new Promise((r) => setTimeout(r, Number(process.env.PART_DELAY_MS || 150))); return send(res, 200, { part: Number(pm[1]), bytes: b.length }) }
  if (sub === '/dataset/parts') return send(res, 200, { parts: [...v.parts].map(([part, bytes]) => ({ part, bytes })) })
  if (sub === '/dataset/commit') {
    v.status = 'training'
    setTimeout(() => {
      if (/reject/i.test(v.speaker_name)) { v.status = 'rejected'; v.error = { code: 'noisy_audio', reason: 'The recordings have too much background noise (estimated signal-to-noise ratio 9 dB). Re-record in a quiet room, close to the microphone.' } }
      else { v.status = 'ready'; if (/warn/i.test(v.speaker_name)) v.warnings = [{ code: 'varied_delivery', message: "The speaker's pitch and delivery vary a lot from clip to clip (a theatrical style). The voice may sound shaky or unstable: listen to the samples carefully, or re-record in a calm, steady, neutral tone." }, { code: 'background_noise', message: 'There is noticeable background noise (estimated 18 dB signal-to-noise). The voice will likely reproduce it; a quieter room gives a cleaner voice.' }] }
    }, Number(process.env.TRAIN_MS || 8000))
    return send(res, 202, { id: v.id, status: 'training', clips: 200 })
  }
  if ((pm = sub.match(/^\/samples\/(\d)$/))) return send(res, 200, wav(1.2 + Number(pm[1]) * 0.3, 200 + Number(pm[1]) * 30), 'audio/wav')
  if (sub === '/preview') return send(res, 200, wav(2, 240), 'audio/wav')
  if (sub === '/deploy') { v.status = 'deployed'; return send(res, 200, { id: v.id, voice: `custom:${v.id}` }) }
  send(res, 404, { error: 'not found' })
}).listen(PORT, () => console.log('mock voice-studio backend on', PORT))
