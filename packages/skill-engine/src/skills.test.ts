import path from 'node:path';

import { WorkspaceReader } from '@aica/fs-engine';
import { PathPolicy } from '@aica/security-engine';
import { beforeAll, describe, expect, it } from 'vitest';

import { SkillRegistry, renderSkills } from './registry.js';
import type { Skill } from './skill.js';
import { parseSkillFile, skillManifestSchema } from './skill.js';

/**
 * Phase 8's gate is selection correctness, so most of this file is about which
 * skills come back for which request — including, importantly, which ones do
 * not. A selector that returns everything is not a selector.
 */

const REPO_ROOT = path.resolve('.');

function skill(overrides: Partial<Skill['manifest']> & { name: string }, body = 'guidance'): Skill {
  return {
    manifest: skillManifestSchema.parse({
      description: 'A skill for testing selection.',
      ...overrides,
    }),
    source: 'shipped',
    path: `skills/${overrides.name}/SKILL.md`,
    body,
  };
}

function registryWith(...skills: Skill[]): SkillRegistry {
  const registry = new SkillRegistry();
  for (const entry of skills) registry.add(entry);
  return registry;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('reading a skill file', () => {
  it('parses frontmatter and keeps the body', () => {
    const parsed = parseSkillFile(
      [
        '---',
        'name: react',
        'description: React components and their rendering states',
        'requires: [react, react-dom]',
        'always: false',
        '---',
        '',
        '## Guidance',
        'Do the thing.',
      ].join('\n'),
      'skills/react/SKILL.md',
    );

    expect(parsed).toBeDefined();
    const manifest = skillManifestSchema.parse(parsed?.manifest);
    expect(manifest.name).toBe('react');
    expect(manifest.requires).toEqual(['react', 'react-dom']);
    expect(manifest.always).toBe(false);
    expect(parsed?.body).toContain('Do the thing.');
  });

  it('parses a block list', () => {
    const parsed = parseSkillFile(
      [
        '---',
        'name: x',
        'description: A skill with a block list',
        'keywords:',
        '  - one',
        '  - two',
        '---',
        'body',
      ].join('\n'),
      'x',
    );

    expect(skillManifestSchema.parse(parsed?.manifest).keywords).toEqual(['one', 'two']);
  });

  it('rejects a file with no frontmatter', () => {
    expect(parseSkillFile('# Just a heading', 'x')).toBeUndefined();
  });

  it('rejects a name that is not kebab-case', () => {
    const parsed = parseSkillFile(
      ['---', 'name: My Skill', 'description: A skill with a bad name', '---', 'body'].join('\n'),
      'x',
    );
    expect(skillManifestSchema.safeParse(parsed?.manifest).success).toBe(false);
  });

  it('rejects a description too short to select on', () => {
    // The description does the selection work; a two-word one cannot.
    const parsed = parseSkillFile(
      ['---', 'name: x', 'description: React', '---', 'b'].join('\n'),
      'x',
    );
    expect(skillManifestSchema.safeParse(parsed?.manifest).success).toBe(false);
  });

  it('records the body size, which the budget depends on', () => {
    const parsed = parseSkillFile(
      [
        '---',
        'name: x',
        'description: A skill with a measurable body',
        '---',
        'a'.repeat(500),
      ].join('\n'),
      'x',
    );
    expect(skillManifestSchema.parse(parsed?.manifest).bytes).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// The shipped skills
// ---------------------------------------------------------------------------

describe('the shipped skills', () => {
  let registry: SkillRegistry;

  beforeAll(async () => {
    const pathPolicy = new PathPolicy({ root: REPO_ROOT });
    const reader = new WorkspaceReader({ pathPolicy });
    registry = new SkillRegistry();
    await registry.loadFrom(reader, 'skills', 'shipped');
  });

  it('loads every one of them', () => {
    expect(registry.all.map((entry) => entry.manifest.name).sort()).toEqual([
      'api-integration',
      'nextjs',
      'react',
      'testing',
      'typescript',
    ]);
  });

  it('picks the API skill for an integration request', () => {
    const selection = registry.select({
      task: 'API_INTEGRATION',
      text: 'integrate the refunds endpoint into the order service',
    });

    expect(selection.selected[0]?.skill.manifest.name).toBe('api-integration');
  });

  it('does not pick React for a project that does not use React', () => {
    const selection = registry.select({
      // The word is in the request, but the repository says otherwise.
      text: 'render a react component for the order list',
      dependencies: ['express', 'zod'],
    });

    expect(selection.selected.map((entry) => entry.skill.manifest.name)).not.toContain('react');
  });

  it('picks React for a project that does use it', () => {
    const selection = registry.select({
      text: 'render the order list',
      dependencies: ['react', 'react-dom'],
      extensions: ['.tsx'],
    });

    expect(selection.selected.map((entry) => entry.skill.manifest.name)).toContain('react');
  });

  it('picks the testing skill for a test-writing task', () => {
    const selection = registry.select({
      task: 'TEST_GENERATION',
      text: 'add tests for the client',
    });
    expect(selection.selected.map((entry) => entry.skill.manifest.name)).toContain('testing');
  });

  it('selects nothing for a request nothing matches', () => {
    // Loading a skill "just in case" spends the budget that the relevant one
    // needed.
    const selection = registry.select({ text: 'what is the weather' });
    expect(selection.selected).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Selection correctness
// ---------------------------------------------------------------------------

describe('what makes a skill relevant', () => {
  it('ranks a project dependency above a word in the request', () => {
    const registry = registryWith(
      skill({ name: 'vue', description: 'Vue components and reactivity', requires: ['vue'] }),
      skill({
        name: 'svelte',
        description: 'Svelte components and stores',
        keywords: ['component'],
        requires: ['svelte'],
      }),
    );

    const selection = registry.select({
      text: 'build a svelte component',
      dependencies: ['vue'],
    });

    // A fact about the repository beats a word in a sentence.
    expect(selection.selected).toHaveLength(1);
    expect(selection.selected[0]?.skill.manifest.name).toBe('vue');
  });

  it('excludes a skill whose required dependency is absent, however well it matches', () => {
    const registry = registryWith(
      skill({
        name: 'angular',
        description: 'Angular modules, services and dependency injection',
        requires: ['@angular/core'],
        keywords: ['angular', 'service', 'module'],
      }),
    );

    const selection = registry.select({
      text: 'create an angular service module with dependency injection',
      dependencies: ['react'],
    });

    // Otherwise word matching alone pulls a framework skill into a project
    // built on a different framework.
    expect(selection.selected).toHaveLength(0);
  });

  it('loads a skill named in configuration even when nothing else matches', () => {
    const registry = registryWith(
      skill({ name: 'house-style', description: 'How this team writes code' }),
    );

    const selection = registry.select({ text: 'unrelated', requested: ['house-style'] });
    expect(selection.selected).toHaveLength(1);
    expect(selection.selected[0]?.evidence[0]?.kind).toBe('explicit');
  });

  it('loads an always-on skill for any request', () => {
    const registry = registryWith(
      skill({ name: 'conventions', description: 'Project-wide conventions', always: true }),
      skill({ name: 'react', description: 'React components', requires: ['react'] }),
    );

    const selection = registry.select({ text: 'anything at all' });
    expect(selection.selected.map((entry) => entry.skill.manifest.name)).toEqual(['conventions']);
  });

  it('explains why each skill was chosen', () => {
    const registry = registryWith(
      skill({
        name: 'react',
        description: 'React components and their states',
        requires: ['react'],
        extensions: ['.tsx'],
        tasks: ['FRONTEND_REVIEW'],
      }),
    );

    const selection = registry.select({
      task: 'FRONTEND_REVIEW',
      dependencies: ['react'],
      extensions: ['.tsx'],
    });

    // "Why is this loaded" is the first question a user asks when the agent
    // does something they did not expect.
    const kinds = selection.selected[0]?.evidence.map((entry) => entry.kind);
    expect(kinds).toContain('dependency');
    expect(kinds).toContain('task');
    expect(kinds).toContain('extension');
  });

  it('ignores words that appear in every request', () => {
    const registry = registryWith(
      skill({ name: 'noise', description: 'The a an and to of in on for with code' }),
    );

    expect(registry.select({ text: 'add the new code to the app' }).selected).toHaveLength(0);
  });
});

describe('the loading budget', () => {
  it('caps the number of skills and reports what it left out', () => {
    const registry = registryWith(
      ...['a', 'b', 'c', 'd', 'e', 'f'].map((name) =>
        skill({ name, description: 'Handles order processing work', keywords: ['orders'] }),
      ),
    );

    const selection = registry.select({ text: 'orders' }, { maxSkills: 2 });

    // Twelve loaded skills produce a prompt in which none of the guidance is
    // followed, so the cap is real.
    expect(selection.selected).toHaveLength(2);
    expect(selection.omitted).toHaveLength(4);
    expect(selection.omitted[0]?.reason).toContain('2 skills');
  });

  it('caps total size and says which skill did not fit', () => {
    const registry = registryWith(
      skill(
        { name: 'small', description: 'Small guidance about orders', keywords: ['orders'] },
        'x',
      ),
      skill(
        { name: 'large', description: 'Large guidance about orders', keywords: ['orders'] },
        'y'.repeat(5000),
      ),
    );

    // Sizes come from the file, so they are set here the way the loader would.
    const withSizes = new SkillRegistry();
    for (const entry of registry.all) {
      withSizes.add({
        ...entry,
        manifest: { ...entry.manifest, bytes: Buffer.byteLength(entry.body, 'utf8') },
      });
    }

    const selection = withSizes.select({ text: 'orders' }, { maxBytes: 1000 });

    expect(selection.selected.map((entry) => entry.skill.manifest.name)).toEqual(['small']);
    expect(selection.omitted[0]?.name).toBe('large');
    expect(selection.omitted[0]?.reason).toContain('budget');
  });

  it('loads the single best skill even when it exceeds the budget alone', () => {
    // Refusing to load anything because the only relevant skill is large would
    // silently give the user no guidance at all.
    const registry = new SkillRegistry();
    registry.add({
      ...skill({ name: 'big', description: 'Guidance about orders', keywords: ['orders'] }),
      manifest: skillManifestSchema.parse({
        name: 'big',
        description: 'Guidance about orders',
        keywords: ['orders'],
        bytes: 50_000,
      }),
    });

    const selection = registry.select({ text: 'orders' }, { maxBytes: 100 });
    expect(selection.selected).toHaveLength(1);
  });
});

describe('project skills override shipped ones', () => {
  it('keeps the project version when both exist', () => {
    const registry = new SkillRegistry();
    registry.add({ ...skill({ name: 'react', description: 'The shipped React skill' }) });
    registry.add({
      ...skill({ name: 'react', description: 'This team’s React rules' }),
      source: 'project',
    });

    expect(registry.get('react')?.manifest.description).toBe('This team’s React rules');
  });

  it('does not let a shipped skill overwrite a project one, whatever the load order', () => {
    const registry = new SkillRegistry();
    registry.add({
      ...skill({ name: 'react', description: 'This team’s React rules' }),
      source: 'project',
    });
    registry.add({ ...skill({ name: 'react', description: 'The shipped React skill' }) });

    // The house rule wins over the general one. That is what a project skill is
    // for, and a name collision is how a project says so.
    expect(registry.get('react')?.source).toBe('project');
  });
});

describe('rendering guidance for a prompt', () => {
  it('frames a skill as guidance, not as permission', () => {
    const registry = registryWith(
      skill({ name: 'react', description: 'React components', always: true }, 'Use hooks.'),
    );

    const rendered = renderSkills(registry.select({ text: 'anything' }));

    // A skill is a file, and a project can ship one. "The skill told me to"
    // must not be an available excuse.
    expect(rendered).toContain('guidance, not permission');
    expect(rendered).toContain('overrides a safety rule');
    expect(rendered).toContain('Use hooks.');
  });

  it('renders nothing when nothing was selected', () => {
    expect(renderSkills({ selected: [], omitted: [], bytes: 0 })).toBe('');
  });
});
