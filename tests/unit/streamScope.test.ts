import { describe, it, expect } from 'vitest';
import { scopeStreams } from '../../src/server/streamScope.js';

const BUILDERS = ['backend', 'frontend', 'ux', 'researcher', 'data', 'docs', 'devops'];

describe('scopeStreams', () => {
  it('always drops read-only / non-implementing roles', () => {
    const r = scopeStreams('Build a full web app with a React dashboard', BUILDERS);
    expect(r.keep).not.toContain('researcher');
    expect(r.drops.some((d) => d.stream === 'researcher')).toBe(true);
  });

  it('drops ux/frontend for a headless HTTP-API request with no UI signal', () => {
    const req =
      'Build an in-memory URL shortener using only Node built-in http (no external ' +
      'dependencies). Expose POST /shorten, GET /:code, GET /api/stats/:code, plus a ' +
      'standalone client library.';
    const r = scopeStreams(req, BUILDERS);
    expect(r.keep).toContain('backend');
    expect(r.keep).not.toContain('ux');
    expect(r.keep).not.toContain('frontend');
    expect(r.keep).toContain('docs');
    expect(r.keep).toContain('devops');
  });

  it('drops ux/frontend even when the request says "no UI" (negation not a UI signal)', () => {
    const r = scopeStreams(
      'Build a headless HTTP API, no UI, using only Node built-in http',
      BUILDERS,
    );
    expect(r.keep).not.toContain('ux');
    expect(r.keep).not.toContain('frontend');
    expect(r.keep).toContain('backend');
  });

  it('keeps ux/frontend when the request clearly wants a user interface', () => {
    const req = 'Build a REST API with a responsive React dashboard and a copy button';
    const r = scopeStreams(req, BUILDERS);
    expect(r.keep).toContain('frontend');
    expect(r.keep).toContain('ux');
    expect(r.keep).toContain('backend');
  });

  it('is conservative: keeps ux/frontend when there is no headless signal', () => {
    const req = 'Build a todo tracker';
    const r = scopeStreams(req, BUILDERS);
    expect(r.keep).toContain('frontend');
    expect(r.keep).toContain('ux');
  });

  it('keeps ux/frontend for a CLI that also renders a web UI', () => {
    const req = 'A command-line tool that also serves an HTML dashboard in the browser';
    const r = scopeStreams(req, BUILDERS);
    expect(r.keep).toContain('frontend');
  });

  it('never returns an empty builder set (safety net)', () => {
    const r = scopeStreams('anything', ['researcher']);
    expect(r.keep.length).toBeGreaterThan(0);
  });

  it('records a reason for every drop', () => {
    const r = scopeStreams('a headless CLI library', BUILDERS);
    for (const d of r.drops) expect(d.reason.length).toBeGreaterThan(0);
  });
});
