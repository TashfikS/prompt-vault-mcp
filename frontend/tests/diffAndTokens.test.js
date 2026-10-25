import test from 'node:test'
import assert from 'node:assert'
import { diffArrays, diffWordsWithSpace } from 'diff'

// Sentence tokenizer logic from VisualDiffViewer
function diffSentenceChunks(oldText, newText) {
  const tokenize = (text) => {
    if (!text) return []
    const tokens = text.match(/[^.!?\n]+([.!?]+(\s+|\n|$)|(\n+|$))/g)
    return tokens && tokens.length > 0 ? tokens : [text]
  }

  const partsA = tokenize(oldText)
  const partsB = tokenize(newText)
  return diffArrays(partsA, partsB).map((part) => ({
    value: part.value.join(''),
    added: Boolean(part.added),
    removed: Boolean(part.removed),
  }))
}

// Token pattern from Brand.tsx
const VAR_PATTERN = /(\{\{\s*[a-zA-Z0-9_ -]+\s*\}\})/g

function extractTokens(text) {
  const matches = text.match(VAR_PATTERN) || []
  return matches.map((m) => m.replace(/\{\{|\}\}/g, '').trim())
}

function getInitials(name) {
  return name.split(' ').map((part) => part[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}

test('diffWordsWithSpace accurately identifies modifications', () => {
  const oldText = 'Review code for Python guidelines.'
  const newText = 'Review code for Rust guidelines.'

  const diffs = diffWordsWithSpace(oldText, newText)
  assert.strictEqual(diffs[0].value, 'Review code for ')
  assert.strictEqual(Boolean(diffs[0].added), false)
  assert.strictEqual(Boolean(diffs[0].removed), false)

  assert.strictEqual(diffs[1].value, 'Python')
  assert.strictEqual(diffs[1].removed, true)

  assert.strictEqual(diffs[2].value, 'Rust')
  assert.strictEqual(diffs[2].added, true)

  assert.strictEqual(diffs[3].value, ' guidelines.')
})

test('diffSentenceChunks detects full sentence modifications and additions', () => {
  const oldText = 'First sentence. Second sentence.'
  const newText = 'First sentence. Modified sentence. Third sentence.'

  const diffs = diffSentenceChunks(oldText, newText)
  assert.ok(diffs.length >= 3)
  assert.strictEqual(diffs[0].value, 'First sentence. ')
  assert.strictEqual(diffs[0].added, false)
  assert.strictEqual(diffs[0].removed, false)

  const removed = diffs.find((d) => d.removed)
  assert.ok(removed)
  assert.strictEqual(removed.value.trim(), 'Second sentence.')

  const added = diffs.filter((d) => d.added)
  assert.ok(added.length >= 1)
})

test('VAR_PATTERN extracts variable names cleanly', () => {
  const template = 'Hello {{ user_name }}, please submit your report to {{ manager-email }} by {{ date }}.'
  const tokens = extractTokens(template)
  assert.deepStrictEqual(tokens, ['user_name', 'manager-email', 'date'])
})

test('getInitials extracts up to 2 uppercase initials', () => {
  assert.strictEqual(getInitials('Alice Morgan'), 'AM')
  assert.strictEqual(getInitials('Bob'), 'B')
  assert.strictEqual(getInitials('Charlie David Rivera'), 'CD')
  assert.strictEqual(getInitials(''), '')
})
