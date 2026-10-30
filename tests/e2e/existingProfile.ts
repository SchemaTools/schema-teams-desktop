import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** Feature regression suites use an explicitly completed setup; setup.spec covers fresh profiles. */
export function existingProfile(profile: string): void {
  const path = join(profile, 'settings.json');
  const settings = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    : {};
  writeFileSync(path, JSON.stringify({ ...settings, onboardingComplete: true }));
}
