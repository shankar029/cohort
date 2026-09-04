import { describe, it, expect } from 'vitest';
import { loadConfig } from '../../src/server/config.js';

describe('loadConfig env plumbing', () => {
  it('defaults: ateam commit style, recordings off', () => {
    const c = loadConfig({} as NodeJS.ProcessEnv);
    expect(c.commitStyle).toBe('ateam');
    expect(c.recordSessions).toBe(false);
  });

  it('ATEAM_COMMIT_STYLE=conventional is honored', () => {
    expect(loadConfig({ ATEAM_COMMIT_STYLE: 'conventional' } as NodeJS.ProcessEnv).commitStyle).toBe(
      'conventional',
    );
    // anything else falls back to ateam
    expect(loadConfig({ ATEAM_COMMIT_STYLE: 'weird' } as NodeJS.ProcessEnv).commitStyle).toBe(
      'ateam',
    );
  });

  it('ATEAM_RECORD_SESSIONS=1 enables recording by default', () => {
    expect(loadConfig({ ATEAM_RECORD_SESSIONS: '1' } as NodeJS.ProcessEnv).recordSessions).toBe(true);
    expect(loadConfig({ ATEAM_RECORD_SESSIONS: '0' } as NodeJS.ProcessEnv).recordSessions).toBe(
      false,
    );
  });
});
