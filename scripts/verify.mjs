#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function normalizePublicBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('public-base-url must be an absolute HTTPS URL');
  }

  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'public-base-url must be an absolute HTTPS URL without credentials, query string, or fragment',
    );
  }

  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export async function collectRegularFiles(sourceDir) {
  const root = resolve(sourceDir);
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }

  await visit(root);
  return files.sort();
}

export function publicUrlForFile(baseUrl, sourceDir, filePath, cacheKey) {
  const relativePath = relative(resolve(sourceDir), resolve(filePath));
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`File is outside source-dir: ${filePath}`);
  }

  const encodedPath = relativePath.split(sep).map(encodeURIComponent).join('/');
  const url = new URL(encodedPath, baseUrl);
  url.searchParams.set('cos-upload-verify', cacheKey);
  return url;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function fetchBytes(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      headers: { 'accept-encoding': 'identity' },
      signal: controller.signal,
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    return { ok: response.ok, status: response.status, bytes };
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyDirectory({
  sourceDir,
  publicBaseUrl,
  attempts = 6,
  delayMs = 2000,
  timeoutMs = 20000,
  routines = 3,
  fetchImpl = fetch,
  sleepImpl = (duration) => new Promise((resolveSleep) => setTimeout(resolveSleep, duration)),
  cacheKey = process.env.GITHUB_RUN_ID ?? `${Date.now()}`,
  log = (message) => console.error(message),
}) {
  const baseUrl = normalizePublicBaseUrl(publicBaseUrl);
  const files = await collectRegularFiles(sourceDir);
  if (files.length === 0) throw new Error('source-dir contains no regular files to verify');

  let nextIndex = 0;
  const workerCount = Math.min(routines, files.length);

  async function worker() {
    while (nextIndex < files.length) {
      const filePath = files[nextIndex];
      nextIndex += 1;
      const localBytes = await readFile(filePath);
      const expectedHash = sha256(localBytes);
      const displayPath = relative(resolve(sourceDir), filePath).split(sep).join('/');
      let lastFailure = 'no response';

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const url = publicUrlForFile(baseUrl, sourceDir, filePath, `${cacheKey}-${attempt}`);
        try {
          const result = await fetchBytes(fetchImpl, url, timeoutMs);
          const actualHash = sha256(result.bytes);
          if (result.ok && result.bytes.length === localBytes.length && actualHash === expectedHash) {
            log(`Verified ${displayPath} (${localBytes.length} bytes)`);
            lastFailure = '';
            break;
          }
          lastFailure = `HTTP ${result.status}, ${result.bytes.length} bytes, SHA-256 ${actualHash}`;
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : String(error);
        }

        if (attempt < attempts) await sleepImpl(delayMs);
      }

      if (lastFailure) {
        throw new Error(
          `Uploaded file was not available with matching content: ${displayPath} (${lastFailure})`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return files.length;
}

async function main() {
  const validateOnly = process.argv[2] === '--validate-only';
  const offset = validateOnly ? 3 : 2;
  const sourceDir = process.argv[offset];
  const publicBaseUrl = process.argv[offset + 1];
  if (!sourceDir || !publicBaseUrl) {
    throw new Error('Usage: verify.mjs [--validate-only] <source-dir> <public-base-url> [attempts] [delay-seconds] [timeout-seconds] [routines]');
  }

  normalizePublicBaseUrl(publicBaseUrl);
  if (validateOnly) return;

  const attempts = Number.parseInt(process.argv[offset + 2] ?? '6', 10);
  const delayMs = Number.parseInt(process.argv[offset + 3] ?? '2', 10) * 1000;
  const timeoutMs = Number.parseInt(process.argv[offset + 4] ?? '20', 10) * 1000;
  const routines = Number.parseInt(process.argv[offset + 5] ?? '3', 10);
  const count = await verifyDirectory({
    sourceDir,
    publicBaseUrl,
    attempts,
    delayMs,
    timeoutMs,
    routines,
  });
  process.stdout.write(String(count));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
