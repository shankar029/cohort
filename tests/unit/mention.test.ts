import { describe, it, expect } from 'vitest';
import { mentionsAgent, stripMention } from '../../src/server/mention.js';

const LEAD = 'Team Lead';

describe('mentionsAgent', () => {
  const positives = [
    '@lead can you help',
    '@team-lead please step in',
    '@team lead are you looking into this?',
    '@teamlead',
    'hey @Team Lead what now',
    'cc @TEAM-LEAD',
    'so, @lead — take over',
    'ok @team-lead.', // sentence-ending period still counts
  ];
  const negatives = [
    'are you looking into this issue?', // the screenshot message — NOT a mention
    'email me at user@team-lead.io',
    'contact foo@lead',
    'the team lead should help', // no '@'
    'leadership matters',
    'a@@lead',
    '',
  ];

  it('matches valid @-mentions of the lead', () => {
    for (const s of positives) expect(mentionsAgent(s, LEAD), s).toBe(true);
  });
  it('rejects non-mentions and email/host lookalikes', () => {
    for (const s of negatives) expect(mentionsAgent(s, LEAD), s).toBe(false);
  });
  it('matches a custom display name with flexible separators', () => {
    expect(mentionsAgent('@Ada Lovelace ping', 'Ada Lovelace')).toBe(true);
    expect(mentionsAgent('@ada-lovelace ping', 'Ada Lovelace')).toBe(true);
    expect(mentionsAgent('email ada@lovelace.dev', 'Ada Lovelace')).toBe(false);
  });
  it('is ReDoS-safe on pathological input (returns fast)', () => {
    const big = '@' + 'a'.repeat(100000);
    const t = Date.now();
    mentionsAgent(big, LEAD);
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe('stripMention', () => {
  it('removes the mention token so intent is classified on the content', () => {
    expect(stripMention('@lead build the parser', LEAD)).toBe('build the parser');
    expect(stripMention('hey @Team Lead what next', LEAD)).toMatch(/^hey\s+what next$/);
  });
  it('leaves un-mentioned text unchanged', () => {
    expect(stripMention('build the parser', LEAD)).toBe('build the parser');
  });
});
