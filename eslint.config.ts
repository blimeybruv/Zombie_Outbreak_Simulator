import type { Linter } from 'eslint';
import tseslint from 'typescript-eslint';

// Restricted reads (CLAUDE.md): each field may be touched only in the files listed.
// A read anywhere else in sim/ is a lint error — the quarantine is mechanical.
const restrictedReads = [
  {
    fields: ['released', 'releaseAt'],
    allow: ['src/sim/systems/release.ts'],
    message: 'Only the occupant release may read district release state.',
  },
  {
    fields: ['panic'],
    // panic.ts: rise, decay, and the derived mode (informed/direct/flight) that
    // routing, memory use and gait read; encounters.ts: transmission;
    // buildings.ts: expulsion.
    allow: ['src/sim/systems/panic.ts', 'src/sim/systems/encounters.ts', 'src/sim/systems/buildings.ts'],
    message: 'panic gates only routing mode, memory use and expulsion; read the derived mode instead.',
  },
];

function readSelectors(fields: string[], message: string) {
  const names = fields.join('|');
  return [
    { selector: `MemberExpression[property.name=/^(${names})$/]`, message },
    { selector: `ObjectPattern > Property[key.name=/^(${names})$/]`, message },
  ];
}

function syntaxRule(reads: typeof restrictedReads): Linter.RuleEntry {
  return ['error', ...reads.flatMap((r) => readSelectors(r.fields, r.message))];
}

const allowedFiles = [...new Set(restrictedReads.flatMap((r) => r.allow))];

const restrictedReadBlocks: Linter.Config[] = [
  {
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-syntax': syntaxRule(restrictedReads),
    },
  },
  ...allowedFiles.map((file) => ({
    files: [file],
    rules: {
      'no-restricted-syntax': syntaxRule(restrictedReads.filter((r) => !r.allow.includes(file))),
    },
  })),
];

export default tseslint.config(
  { ignores: ['node_modules', 'dist'] },
  tseslint.configs.recommended,
  {
    // Determinism: nothing in sim/ may read wall-clock time or an unseeded RNG.
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded PRNG passed in explicitly.' },
        { object: 'Date', property: 'now', message: 'sim/ must not read wall-clock time.' },
        { object: 'performance', property: 'now', message: 'sim/ must not read wall-clock time.' },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Date', message: 'sim/ must not read wall-clock time.' },
        { name: 'performance', message: 'sim/ must not read wall-clock time.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/render', '**/render/**', '**/ui', '**/ui/**', '**/audio', '**/audio/**'], message: 'sim/ must not depend on render/, ui/ or audio/.' },
          ],
        },
      ],
    },
  },
  ...restrictedReadBlocks,
  {
    // render/ and audio/ read sim state; neither may reach into ui/.
    files: ['src/render/**/*.ts', 'src/audio/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/ui', '**/ui/**'], message: 'render/ and audio/ must not depend on ui/.' }] }],
    },
  },
  {
    // config.ts imports nothing, so it can be swept and serialised on its own.
    files: ['src/config.ts'],
    rules: {
      'no-restricted-syntax': ['error', { selector: 'ImportDeclaration', message: 'config.ts must import nothing.' }],
    },
  },
);
