import fs from 'node:fs'
import path from 'node:path'
import { IntegrationSchema, PublishSchema, UseCaseSchema, VendorSchema, type Integration, type PublishList, type UseCase, type Vendor } from './schema.ts'

// Data loader contract
// --------------------
// loadLibrary(dir) reads, synchronously and at build time:
//   <dir>/vendors/<slug>.json        -> Vendor        (VendorSchema)
//   <dir>/use-cases/<slug>.json      -> UseCase       (UseCaseSchema)
//   <dir>/integrations/<slug>.json   -> Integration   (IntegrationSchema)
//   <dir>/publish.json               -> { "published": string[] }   (PublishSchema; a missing file means nothing is published)
// <dir> defaults to <web>/src/content, or the SEO_LIBRARY_DIR environment variable when set (tests point it at test/fixtures/seo-library;
// it is also handy for a local preview of a content branch). A missing sub-directory means "no files of that kind yet".
// A file that is not valid JSON, fails its schema, or whose "slug" differs from its file name throws with every problem listed, so
// `next build` fails instead of rendering half-shaped data. Files are returned sorted by slug so output is deterministic.
// Production builds never set SEO_LIBRARY_DIR (the Dockerfile and cloudbuild do not), so the test fixtures cannot render in production.
// This module uses fs, so import it only from server code (pages, sitemap, tests).

export type Library = {
  dir: string
  vendors: Vendor[]
  useCases: UseCase[]
  integrations: Integration[]
  publish: PublishList
}

export const DEFAULT_CONTENT_DIR = path.join(process.cwd(), 'src', 'content')

export function contentDir(): string {
  const fromEnv = process.env.SEO_LIBRARY_DIR?.trim()
  return fromEnv ? path.resolve(fromEnv) : DEFAULT_CONTENT_DIR
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`${file}: not valid JSON (${(e as Error).message})`)
  }
}

type Schema<T> = { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }

function loadDir<T extends { slug: string }>(dir: string, sub: string, schema: Schema<T>): T[] {
  const d = path.join(dir, sub)
  if (!fs.existsSync(d)) return []
  const out: T[] = []
  const problems: string[] = []
  for (const f of fs.readdirSync(d).filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(d, f)
    let raw: unknown
    try {
      raw = readJson(file)
    } catch (e) {
      problems.push((e as Error).message)
      continue
    }
    const r = schema.safeParse(raw)
    if (!r.success) {
      for (const i of r.error.issues) problems.push(`${sub}/${f}: ${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
      continue
    }
    if (`${r.data.slug}.json` !== f) problems.push(`${sub}/${f}: slug "${r.data.slug}" does not match the file name`)
    out.push(r.data)
  }
  if (problems.length) throw new Error(`Invalid content in ${d}:\n  ${problems.join('\n  ')}`)
  return out.sort((a, b) => a.slug.localeCompare(b.slug))
}

export function loadLibrary(dir: string = contentDir()): Library {
  const publishFile = path.join(dir, 'publish.json')
  let publish: PublishList = { published: [] }
  if (fs.existsSync(publishFile)) {
    const r = PublishSchema.safeParse(readJson(publishFile))
    if (!r.success) throw new Error(`${publishFile}: ${r.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`).join('; ')}`)
    publish = r.data
  }
  return {
    dir,
    vendors: loadDir(dir, 'vendors', VendorSchema),
    useCases: loadDir(dir, 'use-cases', UseCaseSchema),
    integrations: loadDir(dir, 'integrations', IntegrationSchema),
    publish,
  }
}
