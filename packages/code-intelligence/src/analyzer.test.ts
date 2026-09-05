import { describe, expect, it } from 'vitest';

import { analyzeFile, analyzeSource, isAnalyzableLanguage, languageOf } from './analyzer.js';
import type { AnalysisResult } from './analyzer.js';
import type { SymbolRecord } from './symbols.js';

function analyze(source: string, path = 'src/sample.ts'): AnalysisResult {
  return analyzeSource(source, { path, hash: 'test' });
}

function named(result: AnalysisResult, name: string): SymbolRecord | undefined {
  return result.symbols.find((symbol) => symbol.name === name);
}

function names(result: AnalysisResult): string[] {
  return result.symbols.map((symbol) => symbol.name);
}

// ---------------------------------------------------------------------------

describe('languageOf', () => {
  it.each([
    ['a.ts', 'typescript'],
    ['a.mts', 'typescript'],
    ['a.tsx', 'tsx'],
    ['a.jsx', 'jsx'],
    ['a.js', 'javascript'],
    ['a.cjs', 'javascript'],
    ['a.md', 'unknown'],
    ['Makefile', 'unknown'],
  ])('classifies %s as %s', (path, expected) => {
    expect(languageOf(path)).toBe(expected);
  });

  it('decides what the indexer will attempt', () => {
    expect(isAnalyzableLanguage(languageOf('a.ts'))).toBe(true);
    expect(isAnalyzableLanguage(languageOf('a.png'))).toBe(false);
  });
});

describe('declarations', () => {
  it('records each kind with its exportedness', () => {
    const result = analyze(`
      export function run() {}
      function helper() {}
      export class Widget {}
      export interface Shape { size: number }
      export type Id = string;
      export enum Color { Red = 'red' }
      export const VERSION = '1.0';
      const internal = 2;
    `);

    expect(named(result, 'run')).toMatchObject({ kind: 'function', exported: true });
    expect(named(result, 'helper')).toMatchObject({ kind: 'function', exported: false });
    expect(named(result, 'Widget')).toMatchObject({ kind: 'class', exported: true });
    expect(named(result, 'Shape')).toMatchObject({ kind: 'interface', exported: true });
    expect(named(result, 'Id')).toMatchObject({ kind: 'typeAlias', exported: true });
    expect(named(result, 'Color')).toMatchObject({ kind: 'enum', exported: true });
    expect(named(result, 'VERSION')).toMatchObject({ kind: 'variable', exported: true });
    expect(named(result, 'internal')).toMatchObject({ kind: 'variable', exported: false });
  });

  it('never infers exportedness from naming or position', () => {
    const result = analyze('function PublicLookingName() {}');
    expect(named(result, 'PublicLookingName')?.exported).toBe(false);
  });

  it('treats an arrow function assigned to a const as a function', () => {
    const result = analyze('export const add = (a: number, b: number) => a + b;');
    expect(named(result, 'add')).toMatchObject({ kind: 'function', exported: true });
  });

  it('marks async declarations', () => {
    const result = analyze('export async function load() {}\nexport const save = async () => {};');
    expect(named(result, 'load')?.async).toBe(true);
    expect(named(result, 'save')?.async).toBe(true);
  });

  it('records class members against their class', () => {
    const result = analyze(`
      export class Service {
        private token = '';
        async list() { return []; }
        get size() { return 0; }
      }
    `);

    expect(named(result, 'list')).toMatchObject({
      kind: 'method',
      container: 'Service',
      async: true,
      id: 'src/sample.ts#Service.list',
    });
    expect(named(result, 'token')).toMatchObject({ kind: 'property', container: 'Service' });
    expect(named(result, 'size')).toMatchObject({ kind: 'method', container: 'Service' });
  });

  it('records interface members and enum members', () => {
    const result = analyze(`
      export interface Point { x: number; y: number }
      export enum Mode { Fast = 'fast', Slow = 'slow' }
    `);
    expect(named(result, 'x')).toMatchObject({ kind: 'property', container: 'Point' });
    expect(named(result, 'Fast')).toMatchObject({ kind: 'enumMember', container: 'Mode' });
  });

  it('does not index locals as symbols', () => {
    // A local is not addressable from anywhere else, and indexing one would
    // collide with every other function that uses the same name.
    const result = analyze(`
      export function outer() {
        const response = 1;
        let counter = 2;
        return response + counter;
      }
    `);
    expect(names(result)).toEqual(['outer']);
  });
});

describe('signatures and docs', () => {
  it('quotes the declaration verbatim, stopping before the body', () => {
    const result = analyze(
      'export async function fetchOrder(id: string): Promise<Order> { return x; }',
    );
    expect(named(result, 'fetchOrder')?.signature).toBe(
      'export async function fetchOrder(id: string): Promise<Order>',
    );
  });

  it('collapses a multi-line signature onto one line', () => {
    const result = analyze(`
      export function build(
        first: string,
        second: number,
      ): void {}
    `);
    expect(named(result, 'build')?.signature).toBe(
      'export function build( first: string, second: number, ): void',
    );
  });

  it('keeps a JSDoc comment, stripped of its markers', () => {
    const result = analyze(`
      /**
       * Loads an order.
       * Throws when it is missing.
       */
      export function load() {}
    `);
    expect(named(result, 'load')?.doc).toBe('Loads an order.\nThrows when it is missing.');
  });

  it('keeps the doc attached to the statement, not the declarator', () => {
    const result = analyze('/** The base URL. */\nexport const BASE = "x";');
    expect(named(result, 'BASE')?.doc).toBe('The base URL.');
  });
});

describe('imports', () => {
  it('distinguishes every import form', () => {
    const result = analyze(`
      import defaultExport from './a.js';
      import { named1, named2 as renamed } from './b.js';
      import * as everything from './c.js';
      import './side-effect.js';
      import type { OnlyType } from './d.js';
      import { type InlineType, value } from './e.js';
      import external from 'react';
    `);

    expect(result.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'default',
          importedName: 'default',
          localName: 'defaultExport',
        }),
        expect.objectContaining({ kind: 'named', importedName: 'named1' }),
        expect.objectContaining({ kind: 'named', importedName: 'named2', localName: 'renamed' }),
        expect.objectContaining({ kind: 'namespace', importedName: '*', localName: 'everything' }),
        expect.objectContaining({ kind: 'sideEffect', moduleSpecifier: './side-effect.js' }),
        expect.objectContaining({ importedName: 'OnlyType', typeOnly: true }),
        expect.objectContaining({ importedName: 'InlineType', typeOnly: true }),
        expect.objectContaining({ importedName: 'value', typeOnly: false }),
      ]),
    );
  });

  it('marks a package specifier external and a relative one not', () => {
    const result = analyze(`
      import a from 'react';
      import b from './local.js';
      import c from '../parent.js';
    `);
    const byModule = new Map(result.imports.map((record) => [record.moduleSpecifier, record]));
    expect(byModule.get('react')?.external).toBe(true);
    expect(byModule.get('./local.js')?.external).toBe(false);
    expect(byModule.get('../parent.js')?.external).toBe(false);
  });
});

describe('exports', () => {
  it('records a declaration carrying the export keyword', () => {
    const result = analyze('export function run() {}\nexport const X = 1;\nfunction hidden() {}');
    expect(result.exports.map((record) => record.name)).toEqual(['run', 'X']);
  });

  it('records an export statement and its renames', () => {
    const result = analyze('const a = 1;\nexport { a as publicName };');
    expect(result.exports).toEqual([
      expect.objectContaining({ name: 'publicName', localName: 'a' }),
    ]);
  });

  it('records a re-export as both an import and an export', () => {
    const result = analyze("export { thing } from './other.js';");
    expect(result.exports[0]).toMatchObject({ name: 'thing', fromModule: './other.js' });
    expect(result.imports[0]).toMatchObject({ kind: 'reExport', importedName: 'thing' });
  });

  it('records a star re-export', () => {
    const result = analyze("export * from './all.js';");
    expect(result.exports[0]).toMatchObject({ name: '*', fromModule: './all.js' });
  });

  it('records a default export assignment', () => {
    const result = analyze('const thing = 1;\nexport default thing;');
    expect(result.exports).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'default', localName: 'thing' })]),
    );
  });

  it('records a default-exported declaration under `default`', () => {
    const result = analyze('export default function handler() {}');
    expect(named(result, 'handler')?.defaultExport).toBe(true);
    expect(result.exports.map((record) => record.name)).toContain('default');
  });
});

describe('references', () => {
  it('classifies how a name is used', () => {
    const result = analyze(`
      import { helper, Widget, Shape } from './dep.js';
      export function run(): void {
        helper();
        const w = new Widget();
        const s: Shape = w;
      }
    `);

    const kinds = new Map(result.references.map((reference) => [reference.name, reference.kind]));
    expect(kinds.get('helper')).toBe('call');
    expect(kinds.get('Widget')).toBe('construct');
    expect(kinds.get('Shape')).toBe('type');
  });

  it('records a method call reached through a value', () => {
    const result = analyze(`
      export function run(service: unknown) {
        service.list();
      }
    `);
    // The receiver is a parameter, but the member name is still worth knowing:
    // "who calls list()" has to be answerable.
    expect(result.references.some((r) => r.name === 'list' && r.kind === 'call')).toBe(true);
  });

  it('does not record parameters and locals as references', () => {
    const result = analyze(`
      export function run(token: string) {
        const local = token;
        return local;
      }
    `);
    const referenced = result.references.map((reference) => reference.name);
    expect(referenced).not.toContain('token');
    expect(referenced).not.toContain('local');
  });

  it('does not count a declaration as a reference to itself', () => {
    const result = analyze('export function run() {}');
    expect(result.references.filter((reference) => reference.name === 'run')).toEqual([]);
  });

  it('attributes a reference to the symbol whose body contains it', () => {
    const result = analyze(`
      import { helper } from './dep.js';
      export function outer() { helper(); }
    `);
    const call = result.references.find((r) => r.name === 'helper' && r.kind === 'call');
    expect(call?.fromSymbolId).toBe('src/sample.ts#outer');
  });

  it('records a heritage clause as a type reference', () => {
    const result = analyze(`
      import { Base } from './base.js';
      export class Derived extends Base {}
    `);
    expect(result.references.some((r) => r.name === 'Base' && r.kind === 'type')).toBe(true);
  });
});

describe('JSX', () => {
  const component = `
    import { useState } from 'react';
    export function OrderList() {
      const [items] = useState([]);
      return <ul>{items.length}</ul>;
    }
    export function helper() { return 1; }
    export function NotAComponent() { return 'text'; }
  `;

  it('recognizes a capitalised function returning JSX as a component', () => {
    const result = analyze(component, 'src/OrderList.tsx');
    expect(named(result, 'OrderList')?.kind).toBe('component');
  });

  it('does not call a lower-case function or a non-JSX function a component', () => {
    const result = analyze(component, 'src/OrderList.tsx');
    expect(named(result, 'helper')?.kind).toBe('function');
    expect(named(result, 'NotAComponent')?.kind).toBe('function');
  });

  it('does not treat JSX-looking code in a .ts file as a component', () => {
    // Without the .tsx extension the syntax means something else entirely.
    const result = analyze('export function Thing() { return 1; }', 'src/Thing.ts');
    expect(named(result, 'Thing')?.kind).toBe('function');
  });
});

describe('positions', () => {
  it('reports 1-based lines and columns, as editors do', () => {
    const result = analyze('const a = 1;\nexport function target() {}');
    expect(named(result, 'target')?.location).toMatchObject({
      file: 'src/sample.ts',
      start: { line: 2, column: 1 },
    });
  });
});

describe('robustness', () => {
  it('indexes what it can from a file with a syntax error, and reports it', () => {
    const result = analyze('export function ok() {}\nexport function broken( {');
    expect(names(result)).toContain('ok');
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('handles an empty file', () => {
    const index = analyzeFile('', { path: 'src/empty.ts', hash: 'h' });
    expect(index.symbols).toEqual([]);
    expect(index.lineCount).toBe(0);
  });

  it('counts lines and bytes for the file record', () => {
    const index = analyzeFile('a\nb\nc', { path: 'src/x.ts', hash: 'h' });
    expect(index.lineCount).toBe(3);
    expect(index.bytes).toBe(5);
  });

  it('parses plain JavaScript without type syntax', () => {
    const result = analyze('export function run(a) { return a; }', 'src/plain.js');
    expect(named(result, 'run')?.kind).toBe('function');
    expect(result.diagnostics).toEqual([]);
  });

  it('is deterministic', () => {
    const source = 'export class A { run() {} }\nexport const b = 1;';
    expect(analyze(source)).toEqual(analyze(source));
  });
});
