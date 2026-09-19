import test from 'node:test';
import assert from 'node:assert/strict';
import {authorFieldError, authorValid, resolveCommitAuthor} from '../src/commit-preferences.ts';

const preferences = () => ({revision: 3, mode: 'asmagicbrain',
  asmagicbrain: {name: 'Local Writer', email: 'local@example.test'},
  github: {name: 'git-writer', email: 'git-writer@users.noreply.github.com'}});

test('commit author mode selects only the configured identity and keeps source explicit', () => {
  const local = preferences();
  assert.deepEqual(resolveCommitAuthor(local), {...local.asmagicbrain, source: 'asmagicbrain'});
  assert.deepEqual(resolveCommitAuthor({...local, mode: 'github'}), {...local.github, source: 'github'});
});

test('manual mode and unavailable settings never reuse a saved identity', () => {
  assert.deepEqual(resolveCommitAuthor({...preferences(), mode: 'manual'}), {name: '', email: '', source: 'manual'});
  assert.deepEqual(resolveCommitAuthor(null), {name: '', email: '', source: 'manual'});
});

test('empty selected profile does not fall back to another identity', () => {
  const value = {...preferences(), asmagicbrain: {name: '', email: ''}};
  assert.deepEqual(resolveCommitAuthor(value), {name: '', email: '', source: 'asmagicbrain'});
  assert.equal(authorValid('', ''), false);
});

test('per-commit author values are copies and cannot overwrite preferences', () => {
  const stored = preferences();
  const selected = resolveCommitAuthor(stored);
  selected.name = 'Only this commit';
  selected.email = 'override@example.test';
  assert.deepEqual(stored, preferences());
  assert.deepEqual(resolveCommitAuthor(stored), {...stored.asmagicbrain, source: 'asmagicbrain'});
});

test('resolved labels trim boundary whitespace without changing the saved profile', () => {
  const stored = {...preferences(), asmagicbrain: {name: '  Writer  ', email: 'writer@example.test'}};
  assert.deepEqual(resolveCommitAuthor(stored), {name: 'Writer', email: 'writer@example.test', source: 'asmagicbrain'});
  assert.equal(stored.asmagicbrain.name, '  Writer  ');
});

test('ordinary Unicode names and explicit GitHub noreply emails are valid', () => {
  for (const name of ['A', '宋朝阳', 'Renée O’Connor', '研究者 📝']) {
    assert.equal(authorValid(name, '12345+writer@users.noreply.github.com'), true);
    assert.equal(authorFieldError(name, 'name'), null);
  }
});

test('an actual commit requires both name and simple complete email', () => {
  for (const name of ['', ' ', '\u00a0']) assert.equal(authorValid(name, 'name@example.test'), false);
  for (const email of ['', 'name', 'name@host', '@example.test', 'name@@example.test', 'name@.test', 'name@example.',
    ' name@example.test', 'name@example.test ', 'name @example.test', 'name@example test']) {
    assert.equal(authorValid('Writer', email), false, JSON.stringify(email));
  }
  assert.equal(authorValid('Writer', 'name+label@example.test'), true);
});

test('control characters and Git identity delimiters are rejected in both fields', () => {
  const forbidden = [...Array.from({length: 32}, (_, index) => String.fromCharCode(index)),
    ...Array.from({length: 33}, (_, index) => String.fromCharCode(0x7f + index)), '<', '>'];
  for (const character of forbidden) {
    assert.equal(authorValid(`A${character}B`, 'a@example.test'), false);
    assert.equal(authorValid('Writer', `a${character}b@example.test`), false);
  }
});

test('invalid UTF-16 cannot silently become replacement bytes in Git metadata', () => {
  for (const fragment of ['\ud800', '\udfff', '\ud800x', 'x\udc00']) {
    assert.equal(authorValid(`Writer${fragment}`, 'a@example.test'), false);
    assert.equal(authorValid('Writer', `a${fragment}@example.test`), false);
  }
});

test('field limits match the host UTF-16 boundary for ASCII and astral text', () => {
  assert.equal(authorValid('a'.repeat(256), 'a@example.test'), true);
  assert.equal(authorValid('a'.repeat(257), 'a@example.test'), false);
  assert.equal(authorValid('📝'.repeat(128), 'a@example.test'), true);
  assert.equal(authorValid('📝'.repeat(129), 'a@example.test'), false);
  assert.equal(authorValid('Writer', `${'a'.repeat(244)}@example.com`), true);
  assert.equal(authorValid('Writer', `${'a'.repeat(245)}@example.com`), false);
});
