/**
 * Migration utilities for guiding users through SDK breaking changes.
 */

export interface CompatibilityResult {
  compatible: boolean;
  breaking: boolean;
  reason: string;
}

export interface ChangelogEntry {
  version: string;
  date: string;
  sections: Record<string, string[]>;
}

/** Semver with optional leading 'v'. */
function parseSemver(v: string): [number, number, number] | null {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

/**
 * Check whether `from` can upgrade to `to` without breaking changes.
 * A major version bump (≥ 1.0.0) is treated as breaking.
 */
export function checkCompatibility(from: string, to: string): CompatibilityResult {
  const a = parseSemver(from);
  const b = parseSemver(to);

  if (!a || !b) {
    return { compatible: false, breaking: false, reason: 'unknown version format' };
  }

  const [aMajor, aMinor, aPatch] = a;
  const [bMajor, bMinor, bPatch] = b;

  if (bMajor !== aMajor) {
    return { compatible: false, breaking: true, reason: `major version bump ${aMajor} → ${bMajor}` };
  }

  if (bMinor < aMinor || (bMinor === aMinor && bPatch < aPatch)) {
    return { compatible: false, breaking: false, reason: `downgrade from ${from} to ${to}` };
  }

  return { compatible: true, breaking: false, reason: 'minor/patch upgrade' };
}

/** Parse a Keep-a-Changelog style CHANGELOG.md string into structured entries. */
export function parseChangelog(content: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const versionRe = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?/;
  const sectionRe = /^### (.+)/;

  let current: ChangelogEntry | null = null;
  let currentSection: string | null = null;

  for (const raw of content.split('\n')) {
    const line = raw.trimEnd();
    const vMatch = line.match(versionRe);
    if (vMatch) {
      if (current) entries.push(current);
      current = { version: vMatch[1], date: vMatch[2] ?? '', sections: {} };
      currentSection = null;
      continue;
    }

    if (!current) continue;

    const sMatch = line.match(sectionRe);
    if (sMatch) {
      currentSection = sMatch[1];
      current.sections[currentSection] = [];
      continue;
    }

    if (currentSection && line.startsWith('- ')) {
      current.sections[currentSection].push(line.slice(2));
    }
  }

  if (current) entries.push(current);
  return entries;
}

const _warnedKeys = new Set<string>();

export interface DeprecatedOptions {
  /** Replacement API to mention in the warning. */
  replacement?: string;
  /** If true, include a stack trace in the warning. */
  stackTrace?: boolean;
  /** Override the deduplication key (defaults to `name`). */
  key?: string;
}

/**
 * Emit a deprecation warning for `name` exactly once per process lifetime.
 * @returns true if the warning was emitted, false if it was suppressed.
 */
export function deprecated(name: string, options: DeprecatedOptions = {}): boolean {
  const key = options.key ?? name;
  if (_warnedKeys.has(key)) return false;
  _warnedKeys.add(key);

  let msg = `[DEPRECATED] "${name}" is deprecated and will be removed in a future version.`;
  if (options.replacement) msg += ` Use "${options.replacement}" instead.`;
  if (options.stackTrace) {
    const err = new Error(msg);
    console.warn(err.stack ?? msg);
  } else {
    console.warn(msg);
  }
  return true;
}

/** Clear all recorded deprecation warnings (for testing). */
export function _resetDeprecationWarnings(): void {
  _warnedKeys.clear();
}
