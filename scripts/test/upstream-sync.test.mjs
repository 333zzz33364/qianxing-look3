import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { execFileSync } from 'node:child_process'
import { inside, applyReviewedPatch } from '../upstream-sync.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'look3-upstream-'))
  const rel = relative(tmpdir(), root)
  assert.ok(rel && !rel.startsWith('..'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', root], { stdio: 'ignore', windowsHide: true })
  writeFileSync(join(root, '.gitattributes'), '* text eol=lf\n')
  writeFileSync(join(root, 'source.js'), 'export const value = 1\n')
  return root
}

test('reviewed patch applies only after an atomic preflight and does not advance acceptance', t => {
  const root = fixture(t)
  writeFileSync(join(root, 'review.diff'), 'diff --git a/source.js b/source.js\n--- a/source.js\n+++ b/source.js\n@@ -1 +1 @@\n-export const value = 1\n+export const value = 2\n')
  const result = applyReviewedPatch('review.diff', { root })
  assert.equal(readFileSync(join(root, 'source.js'), 'utf8'), 'export const value = 2\n')
  assert.equal(result.acceptedBaselineChanged, false)
  assert.throws(() => applyReviewedPatch('review.diff', { root }))
  assert.equal(readFileSync(join(root, 'source.js'), 'utf8'), 'export const value = 2\n')
})

test('patch cannot rewrite source provenance or user workspace files', t => {
  const root = fixture(t)
  for (const path of ['docs/上游/来源.json', 'look3-workspace/save.json', '上游/Look/source.js']) {
    const target = join(root, path)
    mkdirSync(resolve(target, '..'), { recursive: true })
    writeFileSync(target, 'old\n')
    writeFileSync(join(root, 'review.diff'), `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`)
    assert.throws(() => applyReviewedPatch('review.diff', { root }))
    assert.equal(readFileSync(target, 'utf8'), 'old\n')
  }
})

test('report and patch paths stay within the project', () => {
  assert.throws(() => inside(process.cwd(), '../outside.diff'))
  assert.throws(() => inside(process.cwd(), '.'))
  assert.equal(inside(process.cwd(), 'docs/change.diff'), resolve('docs/change.diff'))
})
