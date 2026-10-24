# Zombie Outbreak Simulator

A spectator-only zombie outbreak simulation: thousands of people on a generated,
top-down canvas city, no player. Before a run you choose its settings; once it starts
you control only the camera, the roster, the ticker and time.

- `docs/implementation-reference.md` — the specification, and (its History appendix)
  every change since the design.
- `docs/design-notes.md` — the reasoning behind the design, and what was cut.
- `CLAUDE.md` — the constraints that hold across the codebase, and its layout.

## Development

Requires Node 22+.

```sh
npm install
npm run dev                   # the viewer
npm run check                 # typecheck, lint, tests
npm run sim -- 1 1            # one headless run (runSeed, mapSeed): counters every 600 ticks
npm run sweep                 # 20 runSeeds in parallel, invariant asserted, gates checked
npm run sweep -- --seeds 8 --set zombie.wanderRate=0.002   # fewer seeds, any config value overridden
```

Measurement scripts (`npx tsx scripts/<name>.ts`): `bench` (whole-run timing and a
behaviour fingerprint), `profile` (per-stage timing), `movement-check` (stuck and
reversing agents), `view` (screenshots at each zoom), `fps` (renderer frame rate),
`ticker-rate` (ticker lines per second), `sweep-report` (the sweep for a reviewer: git state, check and sweep in one file, `sweep-report.txt`; stops on the wrong branch or a dirty tree).
