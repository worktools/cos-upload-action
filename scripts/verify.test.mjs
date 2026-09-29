import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  collectRegularFiles,
  normalizePublicBaseUrl,
  publicUrlForFile,
  verifyDirectory,
} from './verify.mjs';

test('normalizes secure public base URLs', () => {
  assert.equal(
    normalizePublicBaseUrl('https://cos-sh.tiye.me/worktools/example').href,
    'https://cos-sh.tiye.me/worktools/example/',
  );
  assert.throws(() => normalizePublicBaseUrl('http://cos-sh.tiye.me/example'), /HTTPS/);
  assert.throws(() => normalizePublicBaseUrl('https://user@example.com/path'), /credentials/);
  assert.throws(() => normalizePublicBaseUrl('https://example.com/path?stale=1'), /query string/);
});

test('collects nested regular files and URL-encodes their paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cos-verify-files.'));
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), 'index');
    await writeFile(join(root, 'assets', 'with space.js'), 'asset');
    const files = await collectRegularFiles(root);
    assert.equal(files.length, 2);
    const url = publicUrlForFile(
      new URL('https://cdn.example.com/repo/'),
      root,
      join(root, 'assets', 'with space.js'),
      'run-1',
    );
    assert.equal(
      url.href,
      'https://cdn.example.com/repo/assets/with%20space.js?cos-upload-verify=run-1',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retries propagation failures and verifies exact file bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cos-verify-success.'));
  try {
    await writeFile(join(root, 'index.html'), 'current build');
    let calls = 0;
    const logs = [];
    const count = await verifyDirectory({
      sourceDir: root,
      publicBaseUrl: 'https://cdn.example.com/repo/',
      attempts: 3,
      delayMs: 0,
      timeoutMs: 1000,
      routines: 1,
      cacheKey: 'test',
      sleepImpl: async () => {},
      log: (message) => logs.push(message),
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return new Response('not ready', { status: 404 });
        return new Response('current build', { status: 200 });
      },
    });
    assert.equal(count, 1);
    assert.equal(calls, 2);
    assert.match(logs[0], /Verified index\.html/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects stale public content even when the request succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cos-verify-stale.'));
  try {
    await writeFile(join(root, 'index.html'), 'new build');
    await assert.rejects(
      verifyDirectory({
        sourceDir: root,
        publicBaseUrl: 'https://cdn.example.com/repo/',
        attempts: 2,
        delayMs: 0,
        timeoutMs: 1000,
        routines: 1,
        sleepImpl: async () => {},
        log: () => {},
        fetchImpl: async () => new Response('old build', { status: 200 }),
      }),
      /matching content: index\.html/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
