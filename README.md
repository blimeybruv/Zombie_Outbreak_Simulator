# Zombie Outbreak Simulator

A spectator-only zombie outbreak simulation: ~2,000 agents on a top-down canvas city,
no player. See `docs/implementation-reference.md` for the specification and
`docs/design-notes.md` for the reasoning behind it.

## Development

Requires Node 22+.

```sh
npm install
npm run check                 # typecheck, lint, tests
npm run sim -- 1 1            # one headless run (runSeed, mapSeed): counters every 600 ticks
npm run sweep                 # 20 runSeeds in parallel, invariant asserted, milestone 2 gate
npm run sweep -- --set zombie.wanderRate=0.002   # sweep with any config value overridden
```
