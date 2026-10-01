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

function htmlAttributes(tag) {
  const attributes = new Map();
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (!attributes.has(name)) {
      const raw = match[2] ?? match[3] ?? match[4];
      // Generated URLs normally use amp/numeric references. Do not guess other named entities.
      if (['src', 'href'].includes(name) && /&(?!amp;|quot;|apos;|lt;|gt;)[a-z][\da-z]+;/i.test(raw)) {
        throw new Error('Unsupported named HTML character reference in asset URL');
      }
      const value = raw.replace(
        /&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi,
        (_, entity) => {
          if (!entity.startsWith('#')) return { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[entity.toLowerCase()];
          const hexadecimal = entity[1].toLowerCase() === 'x';
          const code = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
          return String.fromCodePoint(code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code);
        },
      );
      attributes.set(name, value);
    }
  }
  return attributes;
}

function htmlResourceTags(html) {
  const tags = [];
  // Consume whole tags, including quoted attributes, before recognizing comments.
  const tokens = /<!--[\s\S]*?(?:-->|$)|<([a-z][\w:-]*)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
  for (let match; (match = tokens.exec(html));) {
    if (!match[1]) continue;
    const name = match[1].toLowerCase();
    if (['base', 'script', 'link'].includes(name)) tags.push(match);
    if (['script', 'style', 'textarea', 'title'].includes(name)) {
      const close = new RegExp(`</${name}\\s*>`, 'gi');
      close.lastIndex = tokens.lastIndex;
      tokens.lastIndex = close.exec(html) ? close.lastIndex : html.length;
    }
  }
  return tags;
}

// Check emitted script/style references without fetching external shared resources.
// HTML bytes are reused by the normal hash verifier, not downloaded a second time.
export async function validateHtmlAssets(baseUrl, sourceDir, files) {
  const available = new Set(files.map((file) => relative(resolve(sourceDir), file).split(sep).join('/')));
  const htmlBytes = new Map();
  for (const file of files.filter((path) => /\.html?$/i.test(path))) {
    const bytes = await readFile(file);
    htmlBytes.set(file, bytes);
    const documentUrl = publicUrlForFile(baseUrl, sourceDir, file, 'html');
    const displayPath = relative(resolve(sourceDir), file);
    const tags = htmlResourceTags(bytes.toString('utf8'));
    const baseTag = tags.find((tag) => tag[1].toLowerCase() === 'base' && htmlAttributes(tag[0]).has('href'));
    const effectiveBase = baseTag ? new URL(htmlAttributes(baseTag[0]).get('href'), documentUrl) : documentUrl;
    if (effectiveBase.origin !== baseUrl.origin || !effectiveBase.pathname.startsWith(baseUrl.pathname)) {
      throw new Error(`HTML base is outside public-base-url: ${displayPath}`);
    }
    for (const tag of tags) {
      const attributes = htmlAttributes(tag[0]);
      const kind = tag[1].toLowerCase();
      const rel = (attributes.get('rel') ?? '').toLowerCase().split(/\s+/);
      const isStyleOrScript = rel.includes('stylesheet') || rel.includes('modulepreload') ||
        (rel.includes('preload') && ['script', 'style'].includes((attributes.get('as') ?? '').toLowerCase()));
      const reference = kind === 'script' ? attributes.get('src') : kind === 'link' && isStyleOrScript ? attributes.get('href') : undefined;
      if (!reference) continue;
      const url = new URL(reference, effectiveBase);
      if (url.origin !== baseUrl.origin) continue; // Shared fonts/third-party scripts remain external.
      if (!url.pathname.startsWith(baseUrl.pathname)) {
        throw new Error(`HTML asset is outside public-base-url: ${displayPath} -> ${url.pathname}`);
      }
      const assetPath = decodeURIComponent(url.pathname.slice(baseUrl.pathname.length));
      if (!available.has(assetPath)) {
        throw new Error(`HTML asset is missing from source-dir: ${displayPath} -> ${assetPath}`);
      }
    }
  }
  return htmlBytes;
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
  const htmlBytes = await validateHtmlAssets(baseUrl, sourceDir, files);

  let nextIndex = 0;
  const workerCount = Math.min(routines, files.length);

  async function worker() {
    while (nextIndex < files.length) {
      const filePath = files[nextIndex];
      nextIndex += 1;
      const localBytes = htmlBytes.get(filePath) ?? await readFile(filePath);
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
