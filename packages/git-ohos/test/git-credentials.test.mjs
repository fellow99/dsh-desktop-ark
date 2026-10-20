/**
 * Unit tests for git's credential file (`lib/git-credentials.js`).
 *
 * The file is deliberately git's own format — one credential per line, each line a URL carrying the
 * userinfo — so these tests pin the parts a user or `git` itself depends on: parsing tolerates a
 * hand-edited file, matching follows `git credential-store`'s specificity rules, writing keeps every
 * other line and forces mode 0600, and the path resolves to `$DSH_HOME/.git-credentials` (with
 * `~/.dsh` as the fallback) rather than somewhere bespoke.
 *
 * All file work happens in a temp directory via the injectable `env`, so no test touches the real
 * config directory.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  dshConfigDir,
  formatCredential,
  gitCredentialsPath,
  matchCredential,
  parseCredentials,
  readCredentials,
  removeCredentials,
  writeCredentials,
} from '../lib/git-credentials.js'

/** A throwaway dsh config dir, as `{ env, path, cleanup }`. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'git-cred-'))
  const env = { DSH_HOME: join(base, '.dsh') }
  return { env, path: gitCredentialsPath(env), base, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test('the file lives in the dsh config directory', () => {
  assert.equal(gitCredentialsPath({ DSH_HOME: '/cfg' }), join('/cfg', '.git-credentials'))
  // No DSH_HOME: fall back to `~/.dsh`, the documented default.
  assert.equal(gitCredentialsPath({ HOME: '/home/u' }), join('/home/u', '.dsh', '.git-credentials'))
  assert.equal(dshConfigDir({ DSH_HOME: '/cfg', HOME: '/home/u' }), '/cfg')
})

test('parsing skips comments, blanks, non-URLs and lines without userinfo', () => {
  const entries = parseCredentials([
    '# a comment people will write',
    '',
    'https://alice:s3cret@git.example.com',
    'not-a-url',
    'https://git.example.com', // no userinfo: not a credential
    '  http://bob:pw@git.example.com:8080  ',
  ].join('\n'))
  assert.deepEqual(entries.map(entry => [entry.protocol, entry.host, entry.username, entry.password]), [
    ['https', 'git.example.com', 'alice', 's3cret'],
    ['http', 'git.example.com:8080', 'bob', 'pw'],
  ])
  assert.equal(entries[0].line, 3)
})

test('percent-encoded userinfo survives the round trip', () => {
  const credential = { protocol: 'https', host: 'git.example.com', username: 'user@corp', password: 'p@ss:with:colons/and/slashes' }
  const line = formatCredential(credential)
  assert.ok(!line.includes('p@ss:with'), line)
  const [entry] = parseCredentials(line)
  assert.equal(entry.username, credential.username)
  assert.equal(entry.password, credential.password)
})

test('matching follows protocol, host, path specificity and username', () => {
  const entries = parseCredentials([
    'https://host.example.com',
    'https://anons:@host.example.com',
    'https://team:pw@host.example.com/team',
    'https://user:pw@host.example.com',
    'http://user:pw@host.example.com',
    'https://user:pw@other.example.com',
  ].join('\n'))
  // Protocol and host must match: the http line and the other host never win.
  assert.equal(matchCredential(entries, 'https://host.example.com/team/project.git').username, 'team')
  assert.equal(matchCredential(entries, 'https://host.example.com/other').username, 'user')
  assert.equal(matchCredential(entries, 'http://host.example.com/x').username, 'user')
  assert.equal(matchCredential(entries, 'https://nope.example.com/x'), undefined)
  assert.equal(matchCredential(entries, 'not a url'), undefined)
})

test('writing creates the file with the credential, keeping other lines', () => {
  const { env, path, cleanup } = fixture()
  try {
    writeCredentials({ protocol: 'https', host: 'a.example.com', username: 'u1', password: 'p1' }, env)
    writeCredentials({ protocol: 'http', host: 'b.example.com:8080', username: 'u2', password: 'p2' }, env)
    const text = readFileSync(path, 'utf8')
    assert.equal(text.split('\n').filter(line => line !== '').length, 2)
    assert.ok(text.includes('https://u1:p1@a.example.com'), text)
    assert.ok(text.includes('http://u2:p2@b.example.com:8080'), text)
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600, 'the cleartext file must stay owner-only')
    }
  } finally {
    cleanup()
  }
})

test('writing replaces the same host and username instead of appending', () => {
  const { env, path, cleanup } = fixture()
  try {
    writeCredentials({ protocol: 'https', host: 'a.example.com', username: 'u1', password: 'old' }, env)
    writeCredentials({ protocol: 'https', host: 'a.example.com', username: 'u1', password: 'new' }, env)
    const entries = readCredentials(env).entries
    assert.equal(entries.length, 1)
    assert.equal(entries[0].password, 'new')
    // A different username on the same host is a second credential, exactly as git stores it.
    writeCredentials({ protocol: 'https', host: 'a.example.com', username: 'u2', password: 'other' }, env)
    assert.equal(readCredentials(env).entries.length, 2)
    assert.ok(readFileSync(path, 'utf8').includes('u1:new'))
  } finally {
    cleanup()
  }
})

test('comments and unknown lines are preserved by a write', () => {
  const { env, path, cleanup } = fixture()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# team credentials\nhttps://old:pw@a.example.com\n', 'utf8')
    writeCredentials({ protocol: 'https', host: 'b.example.com', username: 'u', password: 'p' }, env)
    const text = readFileSync(path, 'utf8')
    assert.ok(text.startsWith('# team credentials\n'), text)
    assert.ok(text.includes('https://old:pw@a.example.com'), text)
    assert.ok(text.includes('https://u:p@b.example.com'), text)
  } finally {
    cleanup()
  }
})

test('removing takes out one credential and deletes the file when it was the last', () => {
  const { env, path, cleanup } = fixture()
  try {
    writeCredentials({ protocol: 'https', host: 'a.example.com', username: 'u1', password: 'p1' }, env)
    writeCredentials({ protocol: 'https', host: 'b.example.com', username: 'u2', password: 'p2' }, env)
    assert.equal(removeCredentials({ protocol: 'https', host: 'a.example.com', username: 'u1' }, env), true)
    const text = readFileSync(path, 'utf8')
    assert.ok(!text.includes('a.example.com'), text)
    assert.ok(text.includes('b.example.com'), text)
    assert.equal(removeCredentials({ protocol: 'https', host: 'gone.example.com', username: 'x' }, env), false)
    assert.equal(removeCredentials({ protocol: 'https', host: 'b.example.com', username: 'u2' }, env), true)
    assert.equal(readCredentials(env).exists, false, 'an emptied file is removed, not left behind')
  } finally {
    cleanup()
  }
})

test('a missing or unreadable file reads as "no credentials" rather than throwing', () => {
  const { env, cleanup } = fixture()
  try {
    const read = readCredentials(env)
    assert.equal(read.exists, false)
    assert.deepEqual(read.entries, [])
    assert.equal(matchCredential(read.entries, 'https://a.example.com/x'), undefined)
  } finally {
    cleanup()
  }
})
