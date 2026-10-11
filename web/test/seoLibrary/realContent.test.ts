import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { loadLibrary } from '../../src/lib/seoLibrary/load.ts'
import { formatIssues, validateLibrary } from '../../src/lib/seoLibrary/validate.ts'

// The gate against the REAL content in src/content (not the fixtures). Any error fails the test, published or not: unpublished pages are
// future waves, and fixing them later is more expensive than fixing them now. Warnings are printed, not failed, so a reviewer sees them.
const DIR = path.join(process.cwd(), 'src', 'content')

test('real content: no validation errors (warnings are printed)', () => {
  const lib = loadLibrary(DIR)
  const r = validateLibrary(lib)
  if (r.warnings.length) console.log(`real content warnings (${r.warnings.length}):\n${formatIssues(r.warnings)}`)
  assert.deepEqual(r.errors, [], `real content has ${r.errors.length} validation errors:\n${formatIssues(r.errors)}`)
  assert.ok(lib.vendors.length >= 20 && lib.useCases.length >= 15 && lib.integrations.length >= 7, 'the real library was loaded, not a fixture')
})
