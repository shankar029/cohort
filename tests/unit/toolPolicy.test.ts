import { describe, it, expect } from 'vitest';
import {
  deniedBuiltinTools,
  WRITE_TOOLS,
  SHELL_TOOLS,
} from '../../src/server/agents/toolPolicy.js';

const READONLY = ['view', 'grep', 'glob'];
const BUILDER = ['view', 'grep', 'glob', 'edit', 'write', 'bash'];

describe('deniedBuiltinTools', () => {
  it('always excludes the sandbox sql tool', () => {
    expect(deniedBuiltinTools('specialist', BUILDER)).toContain('sql');
  });

  it('the Lead loses write + shell but keeps read tools', () => {
    const denied = deniedBuiltinTools('lead', null);
    for (const t of [...WRITE_TOOLS, ...SHELL_TOOLS]) expect(denied).toContain(t);
    // read tools are never denied
    for (const t of READONLY) expect(denied).not.toContain(t);
    expect(denied).not.toContain('read');
  });

  it('the Lead is read-only even with a null (full) allowlist', () => {
    const denied = deniedBuiltinTools('lead', null);
    expect(denied).toContain('bash');
    expect(denied).toContain('powershell');
    expect(denied).toContain('write');
  });

  it('catches the real shell tool FAMILY (verb_noun variants), not just bare names', () => {
    const denied = deniedBuiltinTools('lead', null);
    // the variants actually observed from the runtime that the first fix missed
    for (const t of ['read_powershell', 'list_powershell', 'write_bash', 'stop_shell']) {
      expect(denied).toContain(t);
    }
    // but the read-file tool (noun is not a shell) must remain available
    expect(denied).not.toContain('read_file');
  });

  it('a read-only specialist (view/grep/glob) loses write + shell', () => {
    const denied = deniedBuiltinTools('specialist', READONLY);
    expect(denied).toContain('read_powershell');
    expect(denied).toContain('str_replace');
    expect(denied).not.toContain('read_file');
  });

  it('a spec/doc author (write, no bash) loses shell but keeps write', () => {
    const denied = deniedBuiltinTools('specialist', [...READONLY, 'write']);
    for (const t of SHELL_TOOLS) expect(denied).toContain(t);
    for (const t of WRITE_TOOLS) expect(denied).not.toContain(t);
  });

  it('a full builder (allowlist includes bash) loses nothing beyond sql', () => {
    expect(deniedBuiltinTools('specialist', BUILDER)).toEqual(['sql']);
  });

  it('a specialist with a null (full) allowlist loses nothing beyond sql', () => {
    expect(deniedBuiltinTools('specialist', null)).toEqual(['sql']);
  });

  it('never collides with the Lead custom board/chat tool names', () => {
    const custom = [
      'update_task_board',
      'wait',
      'poll',
      'update_progress',
      'post_message',
      'request_group_chat',
      'add_review_comment',
      'write_note',
      'update_plan',
      'list_board',
    ];
    const denied = deniedBuiltinTools('lead', null);
    for (const name of custom) expect(denied).not.toContain(name);
  });
});
