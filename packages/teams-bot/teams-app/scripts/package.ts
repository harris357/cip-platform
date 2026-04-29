/**
 * package.ts — Build the CIP Bot Teams app package without the M365 Agents Toolkit.
 * The toolkit's schema validator rejects manifest v1.17 bots arrays in newer versions.
 *
 * Usage:
 *   npx tsx scripts/package.ts --env local   # → appPackage/build/appPackage.local.zip
 *   npx tsx scripts/package.ts --env dev     # → appPackage/build/appPackage.dev.zip
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR   = path.resolve(__dirname, '..');

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

// ── ZIP builder (no external deps) ──────────────────────────────────────────

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

// ── Main ─────────────────────────────────────────────────────────────────────

const { values } = parseArgs({ options: { env: { type: 'string', default: 'local' } } });
const env = values.env ?? 'local';

const envVars = {
  ...loadEnvFile(path.join(APP_DIR, 'env', `.env.${env}`)),
  ...process.env,
} as Record<string, string>;

const required = ['BOT_APP_ID', 'BOT_DOMAIN'];
const missing  = required.filter(k => !envVars[k]);
if (missing.length) {
  console.error(`[error] Missing required vars: ${missing.join(', ')}`);
  console.error(`        Set them in env/.env.${env}`);
  process.exit(1);
}

const appPkg  = path.join(APP_DIR, 'appPackage');
let manifest  = fs.readFileSync(path.join(appPkg, 'manifest.json'), 'utf8');
manifest      = manifest.replaceAll('${{BOT_APP_ID}}', envVars['BOT_APP_ID']!);
manifest      = manifest.replaceAll('${{BOT_DOMAIN}}',  envVars['BOT_DOMAIN']!);

const zip     = buildZip([
  { name: 'manifest.json',     data: Buffer.from(manifest, 'utf8') },
  { name: 'icons/color.png',   data: fs.readFileSync(path.join(appPkg, 'icons', 'color.png')) },
  { name: 'icons/outline.png', data: fs.readFileSync(path.join(appPkg, 'icons', 'outline.png')) },
]);

const outDir  = path.join(appPkg, 'build');
const outFile = path.join(outDir, `appPackage.${env}.zip`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, zip);

console.log(`✓ Package built: ${path.relative(process.cwd(), outFile)} (${zip.length.toLocaleString()} bytes)`);
