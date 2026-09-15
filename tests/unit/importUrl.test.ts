import { describe, it, expect } from 'vitest';
import { isGitUrl, createProjectSchema } from '../../src/shared/api.js';
import { deriveRepoName } from '../../src/server/services.js';

describe('isGitUrl', () => {
  const accepted = [
    'https://github.com/owner/repo',
    'https://github.com/owner/repo.git',
    'http://gitlab.example.com/group/sub/repo.git',
    'git@github.com:owner/repo.git',
    'git@github.com:owner/repo',
    'ssh://git@github.com/owner/repo.git',
    'git://github.com/owner/repo.git',
    'file:///tmp/some/repo',
    '  https://github.com/owner/repo  ', // trimmed
  ];
  for (const url of accepted) {
    it(`accepts ${JSON.stringify(url)}`, () => expect(isGitUrl(url)).toBe(true));
  }

  const rejected = [
    '',
    '   ',
    'not a url',
    'github.com/owner/repo', // no scheme, not scp-style
    'https://github.com', // host but no path
    'ftp://github.com/owner/repo', // unsupported scheme
    'C:\\Users\\me\\repo', // windows path, not a url
  ];
  for (const url of rejected) {
    it(`rejects ${JSON.stringify(url)}`, () => expect(isGitUrl(url)).toBe(false));
  }
});

describe('deriveRepoName', () => {
  const cases: [string, string][] = [
    ['https://github.com/owner/my-repo.git', 'my-repo'],
    ['https://github.com/owner/my-repo', 'my-repo'],
    ['https://github.com/owner/my-repo/', 'my-repo'],
    ['git@github.com:owner/Cool_Repo.git', 'Cool_Repo'],
    ['ssh://git@host/a/b/c.git', 'c'],
    ['file:///tmp/some/fixture-repo', 'fixture-repo'],
    ['https://github.com/owner/weird name!.git', 'weird-name'], // sanitized, trailing dashes trimmed
  ];
  for (const [url, expected] of cases) {
    it(`${url} -> ${expected}`, () => expect(deriveRepoName(url)).toBe(expected));
  }

  it('returns empty string when nothing usable remains', () => {
    // Path-less URLs like https://github.com/ are already rejected by isGitUrl at the
    // schema boundary, so they never reach deriveRepoName in the real flow.
    expect(deriveRepoName('')).toBe('');
    expect(deriveRepoName('   ')).toBe('');
    expect(deriveRepoName('///')).toBe('');
  });
});

describe('createProjectSchema back-compat + discrimination', () => {
  it('treats a body without source as a local create (AC1 back-compat)', () => {
    const parsed = createProjectSchema.parse({ name: 'X', repoDir: '/tmp/x' });
    expect(parsed).toMatchObject({ source: 'local', name: 'X', repoDir: '/tmp/x' });
  });

  it('parses an explicit local body', () => {
    const parsed = createProjectSchema.parse({ source: 'local', name: 'X', repoDir: '/tmp/x' });
    expect(parsed.source).toBe('local');
  });

  it('parses a valid import body', () => {
    const parsed = createProjectSchema.parse({
      source: 'import',
      repoUrl: 'https://github.com/owner/repo.git',
      parentDir: '/tmp',
    });
    expect(parsed).toMatchObject({ source: 'import', repoUrl: 'https://github.com/owner/repo.git' });
  });

  it('rejects an import body with a malformed URL (AC2.1)', () => {
    const r = createProjectSchema.safeParse({
      source: 'import',
      repoUrl: 'not-a-git-url',
      parentDir: '/tmp',
    });
    expect(r.success).toBe(false);
  });

  it('rejects an import body missing parentDir', () => {
    const r = createProjectSchema.safeParse({
      source: 'import',
      repoUrl: 'https://github.com/owner/repo.git',
    });
    expect(r.success).toBe(false);
  });
});
