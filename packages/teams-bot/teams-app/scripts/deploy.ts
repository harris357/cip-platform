/**
 * deploy.ts — Build and publish the CIP Bot Teams app package to the org
 * catalog via Microsoft Graph Teams App Catalog API.
 *
 * Usage:
 *   npx tsx scripts/deploy.ts --env local                      # sideload zip only (no upload)
 *   npx tsx scripts/deploy.ts --env dev                        # app-only auth → catalog
 *   npx tsx scripts/deploy.ts --env dev --delegated            # delegated auth (recommended)
 *   npx tsx scripts/deploy.ts --env dev --delegated --submit   # submit for admin review
 *
 * Required env vars (from .envrc or environment):
 *   BOT_APP_ID         — Azure Bot app ID (GUID)
 *   BOT_DOMAIN         — bot ingress hostname (e.g. bot.cip.idlevice.ca)
 *   BOT_APP_PASSWORD   — bot client secret (for app-only catalog auth)
 *   TENANT_ID          — Azure AD tenant ID
 *
 * Required AAD app permissions for catalog upload (admin-consented):
 *   AppCatalog.ReadWrite.All  Application  (app-only — most tenants block writes)
 *   AppCatalog.ReadWrite.All  Delegated    (delegated — always works)
 */

import * as fs   from 'node:fs';
import * as os   from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { parseArgs }    from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR     = path.resolve(__dirname, '..');
const GRAPH_BASE  = 'https://graph.microsoft.com/v1.0';
const TOKEN_CACHE = path.join(os.homedir(), '.cip', 'teams-deploy-token.json');

const DELEGATED_SCOPES = 'https://graph.microsoft.com/AppCatalog.ReadWrite.All offline_access';

// ── Config ───────────────────────────────────────────────────────────────────

function loadEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!fs.existsSync(filePath)) return result;
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).split('#')[0]!.trim().replace(/^["']|["']$/g, '');
    result[key] = val;
  }
  return result;
}

// ── ZIP builder (no external deps) ───────────────────────────────────────────

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (const byte of buf) crc = (CRC_TABLE[(crc ^ byte) & 0xFF]! ^ (crc >>> 8));
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

interface ZipEntry { name: string; data: Buffer }

function buildZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const centralDir: Buffer[] = [];
  let localOffset = 0;

  const now = new Date();
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);

  for (const entry of entries) {
    const nameBuf    = Buffer.from(entry.name, 'utf8');
    const compressed = zlib.deflateRawSync(entry.data, { level: 6 });
    const checksum   = crc32(entry.data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);  local.writeUInt16LE(0, 6);   local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014B50, 0);
    central.writeUInt16LE(20, 4);  central.writeUInt16LE(20, 6);  central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12); central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    nameBuf.copy(central, 46);

    parts.push(local, compressed);
    centralDir.push(central);
    localOffset += local.length + compressed.length;
  }

  const cdBuf = Buffer.concat(centralDir);
  const eocd  = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054B50, 0);
  eocd.writeUInt16LE(0, 4);  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...parts, cdBuf, eocd]);
}

function buildAppPackage(cfg: Record<string, string>): Buffer {
  const appPkg = path.join(APP_DIR, 'appPackage');
  let manifest = fs.readFileSync(path.join(appPkg, 'manifest.json'), 'utf8');
  manifest = manifest.replaceAll('${{BOT_APP_ID}}', cfg['BOT_APP_ID'] ?? '');
  manifest = manifest.replaceAll('${{BOT_DOMAIN}}',  cfg['BOT_DOMAIN']  ?? '');
  return buildZip([
    { name: 'manifest.json',     data: Buffer.from(manifest, 'utf8') },
    { name: 'icons/color.png',   data: fs.readFileSync(path.join(appPkg, 'icons', 'color.png')) },
    { name: 'icons/outline.png', data: fs.readFileSync(path.join(appPkg, 'icons', 'outline.png')) },
  ]);
}

// ── Auth — app-only ───────────────────────────────────────────────────────────

async function getAppOnlyToken(cfg: Record<string, string>): Promise<string> {
  const resp = await fetch(
    `https://login.microsoftonline.com/${cfg['TENANT_ID']}/oauth2/v2.0/token`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'client_credentials',
        client_id:     cfg['BOT_APP_ID']!,
        client_secret: cfg['BOT_APP_PASSWORD']!,
        scope:         'https://graph.microsoft.com/.default',
      }),
    },
  );
  if (!resp.ok) {
    console.error(`[error] Token request failed ${resp.status}: ${await resp.text()}`);
    process.exit(1);
  }
  return ((await resp.json()) as { access_token: string }).access_token;
}

// ── Auth — delegated (device code + token cache) ──────────────────────────────

interface CachedToken { access_token: string; refresh_token: string; expires_at: number }

function loadCachedToken(): CachedToken | null {
  try {
    if (fs.existsSync(TOKEN_CACHE))
      return JSON.parse(fs.readFileSync(TOKEN_CACHE, 'utf8')) as CachedToken;
  } catch { /* ignore */ }
  return null;
}

function saveCachedToken(t: CachedToken): void {
  fs.mkdirSync(path.dirname(TOKEN_CACHE), { recursive: true });
  fs.writeFileSync(TOKEN_CACHE, JSON.stringify(t, null, 2), { mode: 0o600 });
}

async function refreshToken(cfg: Record<string, string>, refreshToken: string): Promise<CachedToken | null> {
  const resp = await fetch(
    `https://login.microsoftonline.com/${cfg['TENANT_ID']}/oauth2/v2.0/token`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     cfg['BOT_APP_ID']!,
        refresh_token: refreshToken,
        scope:         DELEGATED_SCOPES,
      }),
    },
  );
  if (!resp.ok) return null;
  const data = await resp.json() as { access_token: string; refresh_token: string; expires_in: number };
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + (data.expires_in - 60) * 1000 };
}

async function deviceCodeFlow(cfg: Record<string, string>): Promise<CachedToken> {
  const dcResp = await fetch(
    `https://login.microsoftonline.com/${cfg['TENANT_ID']}/oauth2/v2.0/devicecode`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({ client_id: cfg['BOT_APP_ID']!, scope: DELEGATED_SCOPES }),
    },
  );
  if (!dcResp.ok) { console.error(`[error] Device code failed: ${await dcResp.text()}`); process.exit(1); }
  const dc = await dcResp.json() as { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };

  console.log('\n  ┌─────────────────────────────────────────────────────────┐');
  console.log(`  │  Open:  ${dc.verification_uri.padEnd(49)}│`);
  console.log(`  │  Code:  ${dc.user_code.padEnd(49)}│`);
  console.log('  │  Sign in with a Teams Administrator account.            │');
  console.log('  └─────────────────────────────────────────────────────────┘\n');

  const deadline = Date.now() + dc.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, (dc.interval ?? 5) * 1000));
    const pollResp = await fetch(
      `https://login.microsoftonline.com/${cfg['TENANT_ID']}/oauth2/v2.0/token`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: cfg['BOT_APP_ID']!, device_code: dc.device_code }),
      },
    );
    const data = await pollResp.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (data.access_token) {
      const cached: CachedToken = { access_token: data.access_token, refresh_token: data.refresh_token!, expires_at: Date.now() + ((data.expires_in ?? 3600) - 60) * 1000 };
      saveCachedToken(cached);
      return cached;
    }
    if (data.error === 'authorization_pending' || data.error === 'slow_down') continue;
    console.error(`[error] Device code flow failed: ${data.error}`); process.exit(1);
  }
  console.error('[error] Device code expired.'); process.exit(1);
}

async function getDelegatedToken(cfg: Record<string, string>): Promise<string> {
  const cached = loadCachedToken();
  if (cached) {
    if (Date.now() < cached.expires_at) { console.log('   using cached token'); return cached.access_token; }
    const refreshed = await refreshToken(cfg, cached.refresh_token);
    if (refreshed) { saveCachedToken(refreshed); console.log('   token refreshed silently'); return refreshed.access_token; }
  }
  return (await deviceCodeFlow(cfg)).access_token;
}

// ── Graph helpers ─────────────────────────────────────────────────────────────

async function graphRequest(token: string, method: string, graphPath: string, body?: Buffer, contentType?: string) {
  const resp = await fetch(`${GRAPH_BASE}${graphPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(contentType ? { 'Content-Type': contentType } : {}) },
    body,
  });
  const text = await resp.text();
  return { status: resp.status, body: text ? JSON.parse(text) : null };
}

async function findCatalogApp(token: string, externalId: string): Promise<string | null> {
  const qs = new URLSearchParams({ '$filter': `externalId eq '${externalId}'`, '$select': 'id,externalId' });
  const { status, body } = await graphRequest(token, 'GET', `/appCatalogs/teamsApps?${qs}`);
  if (status !== 200) return null;
  return ((body as { value?: Array<{ id: string }> }).value ?? [])[0]?.id ?? null;
}

function handleGraphError(status: number, body: unknown, tokenCachePath: string): never {
  const msg = ((body as { error?: { message?: string } } | null)?.error?.message) ?? JSON.stringify(body);
  if (status === 403) {
    console.error(`\n[error] 403 Forbidden — ${msg}`);
    console.error('  App-only tokens are blocked in this tenant. Re-run with --delegated:\n');
    console.error('    npx tsx scripts/deploy.ts --env dev --delegated\n');
    console.error(`  Token cached at: ${tokenCachePath}`);
  } else {
    console.error(`[error] Graph API ${status}: ${msg}`);
  }
  process.exit(1);
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      env:       { type: 'string',  default: 'dev' },
      delegated: { type: 'boolean', default: false },
      submit:    { type: 'boolean', default: false },
      'zip-only':{ type: 'boolean', default: false },
    },
  });

  const env           = values.env ?? 'dev';
  const useDelegated  = values.delegated ?? false;
  const requiresReview = values.submit ?? false;
  const zipOnly       = values['zip-only'] ?? false;

  console.log(`\n=== CIP Bot Teams App Deploy  [env=${env}${useDelegated ? ' / delegated' : ''}${zipOnly ? ' / zip-only' : ''}] ===\n`);

  const cfg: Record<string, string> = {
    ...loadEnvFile(path.join(APP_DIR, 'env', `.env.${env}`)),
    ...process.env as Record<string, string>,
  };

  const required = ['BOT_APP_ID', 'BOT_DOMAIN', 'TENANT_ID', ...(zipOnly || useDelegated ? [] : ['BOT_APP_PASSWORD'])];
  const missing  = required.filter(k => !cfg[k]);
  if (missing.length) {
    console.error(`[error] Missing required vars: ${missing.join(', ')}`);
    console.error(`        Set in env/.env.${env} or .envrc`);
    process.exit(1);
  }

  console.log('1. Building app package...');
  const zip     = buildAppPackage(cfg);
  const outDir  = path.join(APP_DIR, 'appPackage', 'build');
  const outFile = path.join(outDir, `appPackage.${env}.zip`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, zip);
  console.log(`   ✓ ${path.relative(process.cwd(), outFile)} (${zip.length.toLocaleString()} bytes)`);

  if (zipOnly) {
    console.log('\n   --zip-only: skipping catalog upload.');
    console.log(`   Sideload manually: Teams → Apps → Manage your apps → Upload a custom app`);
    return;
  }

  console.log('\n2. Acquiring Graph API token...');
  const token = useDelegated ? await getDelegatedToken(cfg) : await getAppOnlyToken(cfg);
  if (!useDelegated) console.log('   token acquired (app-only)');

  const externalId = cfg['BOT_APP_ID']!;
  console.log(`\n3. Checking org catalog for externalId=${externalId}...`);
  const catalogId = await findCatalogApp(token, externalId);
  console.log(catalogId ? `   found: catalog_id=${catalogId}` : '   not found — will create');

  console.log('\n4. Uploading to Teams App Catalog...');
  const reviewParam = requiresReview ? '?requiresReview=true' : '';

  const { status, body } = catalogId
    ? await graphRequest(token, 'POST', `/appCatalogs/teamsApps/${catalogId}/appDefinitions${reviewParam}`, zip, 'application/zip')
    : await graphRequest(token, 'POST', `/appCatalogs/teamsApps${reviewParam}`, zip, 'application/zip');

  if ([200, 201, 204].includes(status)) {
    const state = (body as { publishingState?: string } | null)?.publishingState ?? 'published';
    console.log(`   ✓ App ${catalogId ? 'updated' : 'created'}  state=${state}`);
  } else {
    handleGraphError(status, body, TOKEN_CACHE);
  }

  console.log('\nDone.');
  if (requiresReview) console.log('Approve at: https://admin.teams.microsoft.com → Teams apps → Manage apps');
  else console.log('App is live in the org catalog. Users may need to restart Teams.');
  console.log();
}

main().catch(err => { console.error('[fatal]', err); process.exit(1); });
