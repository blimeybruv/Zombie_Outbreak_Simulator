import tseslint from 'typescript-eslint';

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
