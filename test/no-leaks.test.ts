import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * This package is public. Its code and comments must not name the services behind Zapiack, its internal systems or machines, or
 * anything that is not the customer's own concern. This reads everything that ships and fails the build if any of it does.
 */
const BANNED: Array<[string, RegExp]> = [
  ['a provider behind the platform', /telnyx|bachs|paystack|\bses\b|amazon ses|aws|twilio|infobip|termii|aggregator|neon\b|cloudinary|s3 bucket/i],
  ['an internal service or queue', /bullmq|redis|prisma|postgres|nestjs|api-core|push-core|sms-core|mailing-core|whatsapp-core|automation-core|zapiack-backend|fan-?out|push-fanout|push-send/i],
  ['internal infrastructure', /\bdroplet\b|digitalocean|caddy|docker|kubernetes|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b(?!\/)/i],
  ['an internal address or a secret', /localhost:\d+|\.internal\b|sk_(live|test)_[a-z0-9]{8,}|whsec_[a-z0-9]{12,}|password\s*[:=]\s*['"][^'"]+/i],
  ['unfinished work or internal notes', /\bTODO\b|\bFIXME\b|\bHACK\b|\bXXX\b|do not (commit|publish|ship)|internal only|not public/i],
];

function files(dir: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    return statSync(path).isDirectory() ? files(path, keep) : keep(name) ? [path] : [];
  });
}

const root = join(__dirname, '..');
const sources = [...files(join(root, 'src'), (n) => n.endsWith('.ts')), join(root, 'package.json')];

describe('what ships', () => {
  it('names nothing it should not, in the source or its comments', () => {
    const found: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const [what, pattern] of BANNED) {
        const match = pattern.exec(text);
        if (match) found.push(`${file.replace(root, '')}: ${what}: "${match[0]}"`);
      }
    }
    expect(found).toEqual([]);
  });

  it('names nothing it should not in the built package either, when it has been built', () => {
    const built = files(join(root, 'dist'), (n) => /\.(js|mjs|cjs|d\.ts|d\.mts)$/.test(n));
    if (built.length === 0) return;
    const found: string[] = [];
    for (const file of built) {
      const text = readFileSync(file, 'utf8');
      for (const [what, pattern] of BANNED) {
        const match = pattern.exec(text);
        if (match) found.push(`${file.replace(root, '')}: ${what}: "${match[0]}"`);
      }
    }
    expect(found).toEqual([]);
  });

  it('puts only the build, the readme and the licence in the package', () => {
    const listing = JSON.parse(execSync('npm pack --dry-run --json --ignore-scripts', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const paths: string[] = listing[0].files.map((f: { path: string }) => f.path);
    const unexpected = paths.filter((p) => !(p === 'package.json' || p === 'README.md' || p === 'CHANGELOG.md' || p === 'LICENSE' || p.startsWith('dist/')));
    expect(unexpected).toEqual([]);
    expect(paths.some((p) => p.startsWith('src/') || p.startsWith('test/'))).toBe(false);
  });
});
