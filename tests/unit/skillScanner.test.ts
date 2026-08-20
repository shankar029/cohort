import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkillFrontmatter, discoverSkills } from '../../src/server/agents/skillScanner.js';

describe('parseSkillFrontmatter', () => {
  it('parses name and description from YAML frontmatter', () => {
    const md = `---\nname: my-skill\ndescription: Does a useful thing\n---\n# Body`;
    expect(parseSkillFrontmatter(md)).toEqual({
      name: 'my-skill',
      description: 'Does a useful thing',
    });
  });

  it('strips surrounding quotes', () => {
    const md = `---\nname: "quoted"\ndescription: 'single'\n---`;
    expect(parseSkillFrontmatter(md)).toEqual({ name: 'quoted', description: 'single' });
  });

  it('returns empty object when there is no frontmatter', () => {
    expect(parseSkillFrontmatter('# Just a heading')).toEqual({});
  });
});

describe('discoverSkills', () => {
  let home: string;
  let repo: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-home-'));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ateam-proj-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function writeSkill(root: string, dir: string, name: string, description: string): void {
    const full = path.join(root, dir);
    fs.mkdirSync(full, { recursive: true });
    fs.writeFileSync(
      path.join(full, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n`,
    );
  }

  it('finds skills in home roots and project roots', () => {
    writeSkill(home, 'skills/alpha', 'alpha', 'home alpha');
    writeSkill(repo, '.agents/skills/beta', 'beta', 'project beta');

    const skills = discoverSkills([path.join(home, 'skills')], repo);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['alpha', 'beta']);
    expect(skills.find((s) => s.name === 'alpha')!.source).toBe('home');
    expect(skills.find((s) => s.name === 'beta')!.source).toBe('project');
  });

  it('lets a project skill override a home skill with the same name', () => {
    writeSkill(home, 'shared', 'dup', 'home version');
    writeSkill(repo, 'skills/shared', 'dup', 'project version');

    const skills = discoverSkills([home], repo);
    const dup = skills.filter((s) => s.name === 'dup');
    expect(dup).toHaveLength(1);
    expect(dup[0]!.source).toBe('project');
  });

  it('ignores node_modules and returns [] when roots are empty', () => {
    writeSkill(home, 'node_modules/pkg', 'hidden', 'should be ignored');
    expect(discoverSkills([home], null)).toEqual([]);
  });
});
