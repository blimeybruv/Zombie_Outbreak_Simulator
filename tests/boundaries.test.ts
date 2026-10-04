import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Guards the lint rules that enforce CLAUDE.md's module boundaries, so a config
// change cannot silently stop them firing.

const eslint = new ESLint();

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.map((m) => m.ruleId ?? 'fatal');
}

describe('sim/ boundaries', () => {
  const file = 'src/sim/example.ts';

  it.each([
    ['Math.random', 'export const r = Math.random();', 'no-restricted-properties'],
    ['performance.now', 'export const t = performance.now();', 'no-restricted-properties'],
    ['Date.now', 'export const t = Date.now();', 'no-restricted-properties'],
    ['new Date', 'export const t = new Date();', 'no-restricted-globals'],
    ['render import', "export { draw } from '../render/draw';", 'no-restricted-imports'],
    ['ui import', "import { panel } from '../ui/panel';\nexport const p = panel;", 'no-restricted-imports'],
    ['audio import', "import { play } from '../audio';\nexport const p = play;", 'no-restricted-imports'],
  ])('rejects %s', async (_name, code, rule) => {
    expect(await ruleIds(code, file)).toContain(rule);
  });

  it('allows ordinary simulation code', async () => {
    expect(await ruleIds('export const add = (a: number, b: number) => a + b;', file)).toEqual([]);
  });
});

describe('config.ts boundaries', () => {
  it('rejects any import', async () => {
    expect(await ruleIds("import { x } from './sim/x';\nexport const c = x;", 'src/config.ts')).toContain(
      'no-restricted-syntax',
    );
  });
});

describe('render/ boundaries', () => {
  it('rejects ui imports', async () => {
    expect(await ruleIds("import { p } from '../ui/p';\nexport const q = p;", 'src/render/x.ts')).toContain(
      'no-restricted-imports',
    );
  });

  it('may read Math.random', async () => {
    expect(await ruleIds('export const r = Math.random();', 'src/render/x.ts')).toEqual([]);
  });
});
