import * as fs from 'fs';
import * as path from 'path';
import {
  checkCompatibility,
  parseChangelog,
  deprecated,
  _resetDeprecationWarnings,
} from '../src/utils/migration';

beforeEach(() => {
  _resetDeprecationWarnings();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── checkCompatibility ────────────────────────────────────────────────────

describe('checkCompatibility', () => {
  it('returns compatible for a patch upgrade', () => {
    const r = checkCompatibility('1.0.0', '1.0.1');
    expect(r.compatible).toBe(true);
    expect(r.breaking).toBe(false);
  });

  it('returns compatible for a minor upgrade', () => {
    const r = checkCompatibility('1.0.0', '1.1.0');
    expect(r.compatible).toBe(true);
    expect(r.breaking).toBe(false);
  });

  it('returns compatible for same version', () => {
    const r = checkCompatibility('2.3.4', '2.3.4');
    expect(r.compatible).toBe(true);
    expect(r.breaking).toBe(false);
  });

  it('detects a major version bump as breaking', () => {
    const r = checkCompatibility('1.2.3', '2.0.0');
    expect(r.compatible).toBe(false);
    expect(r.breaking).toBe(true);
    expect(r.reason).toContain('1');
    expect(r.reason).toContain('2');
  });

  it('returns incompatible (non-breaking) for a downgrade', () => {
    const r = checkCompatibility('1.2.0', '1.1.9');
    expect(r.compatible).toBe(false);
    expect(r.breaking).toBe(false);
    expect(r.reason).toContain('downgrade');
  });

  it('handles unknown / malformed version strings', () => {
    const r = checkCompatibility('foo', '1.0.0');
    expect(r.compatible).toBe(false);
    expect(r.breaking).toBe(false);
    expect(r.reason).toContain('unknown');
  });

  it('handles versions with leading "v" prefix', () => {
    const r = checkCompatibility('v1.0.0', 'v1.1.0');
    expect(r.compatible).toBe(true);
  });
});

// ─── parseChangelog ────────────────────────────────────────────────────────

const SAMPLE_CHANGELOG = `# Changelog

## [1.1.0] - 2026-02-17

### Added
- New feature A
- New feature B

### Changed
- Updated behavior X

### Backward Compatible
- Old API still works

## [1.0.0] - 2026-01-01

### Added
- Initial release
`;

describe('parseChangelog', () => {
  it('parses version numbers correctly', () => {
    const entries = parseChangelog(SAMPLE_CHANGELOG);
    expect(entries.map((e) => e.version)).toEqual(['1.1.0', '1.0.0']);
  });

  it('parses release dates', () => {
    const entries = parseChangelog(SAMPLE_CHANGELOG);
    expect(entries[0].date).toBe('2026-02-17');
    expect(entries[1].date).toBe('2026-01-01');
  });

  it('parses all section types (Added, Changed, Backward Compatible)', () => {
    const entries = parseChangelog(SAMPLE_CHANGELOG);
    const sections = Object.keys(entries[0].sections);
    expect(sections).toContain('Added');
    expect(sections).toContain('Changed');
    expect(sections).toContain('Backward Compatible');
  });

  it('captures items within each section', () => {
    const entries = parseChangelog(SAMPLE_CHANGELOG);
    expect(entries[0].sections['Added']).toEqual(['New feature A', 'New feature B']);
    expect(entries[0].sections['Changed']).toEqual(['Updated behavior X']);
  });

  it('handles empty / malformed input without throwing', () => {
    expect(() => parseChangelog('')).not.toThrow();
    expect(parseChangelog('')).toEqual([]);
  });

  it('returns empty array for content with no version headers', () => {
    expect(parseChangelog('Some random text\n- bullet')).toEqual([]);
  });

  it('parses the real CHANGELOG.md without throwing', () => {
    const changelogPath = path.resolve(__dirname, '../CHANGELOG.md');
    const content = fs.readFileSync(changelogPath, 'utf-8');
    expect(() => parseChangelog(content)).not.toThrow();
    const entries = parseChangelog(content);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].sections).toHaveProperty('Added');
  });
});

// ─── deprecated ───────────────────────────────────────────────────────────

describe('deprecated', () => {
  it('emits a console.warn on first call', () => {
    deprecated('oldApi');
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('returns true when warning is emitted', () => {
    expect(deprecated('firstCall')).toBe(true);
  });

  it('suppresses duplicate warnings (deduplication)', () => {
    deprecated('dup');
    deprecated('dup');
    deprecated('dup');
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('returns false on subsequent calls for the same name', () => {
    deprecated('repeated');
    expect(deprecated('repeated')).toBe(false);
  });

  it('includes replacement in the warning message', () => {
    deprecated('oldFn', { replacement: 'newFn' });
    const msg = (console.warn as jest.Mock).mock.calls[0][0] as string;
    expect(msg).toContain('newFn');
  });

  it('includes a stack trace when stackTrace option is true', () => {
    deprecated('tracedFn', { stackTrace: true });
    const msg = (console.warn as jest.Mock).mock.calls[0][0] as string;
    // stack traces include "at " lines
    expect(msg).toMatch(/at /);
  });

  it('treats different names as independent', () => {
    deprecated('apiA');
    deprecated('apiB');
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('respects custom deduplication key', () => {
    deprecated('nameA', { key: 'shared-key' });
    deprecated('nameB', { key: 'shared-key' });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('_resetDeprecationWarnings clears suppression state', () => {
    deprecated('resetTest');
    _resetDeprecationWarnings();
    deprecated('resetTest');
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
