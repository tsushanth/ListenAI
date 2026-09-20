import { configured, json, notConfigured, preflight } from './http.ts'

export function wellKnown(build: () => object) {
  return {
    OPTIONS: preflight,
    GET: () => (configured() ? json(build(), 200, { 'Cache-Control': 'public, max-age=300' }) : notConfigured()),
  }
}
