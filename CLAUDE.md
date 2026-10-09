# CLAUDE.md

Spectator-only zombie outbreak simulation. ~2,000 agents, top-down canvas, dots and
building outlines. No player — the viewer controls camera, roster, ticker and time only.

Full specification lives in `docs/implementation-reference.md`, which defines the
simulation from primitives upward: foundations, scalar conventions, every entity's
field table, attack resolution, movement, systems, loops, scenario setup, presentation
and build order.

`docs/design-notes.md` carries the reasoning — why decisions went the way they did, and
what was cut and why. Consult it before reversing anything. Where the two disagree, the
implementation reference is newer.

This file carries the constraints that must survive across sessions. When this file and
the reference disagree, ask rather than guessing.

---

## Hard invariants

Never break these. If a change would break one, stop and raise it.

1. **The population invariant holds every tick:**
   ```
   unturned.outdoors + unturned.indoors + unturned.dead + unturned.rescued
     + turned.symptomatic + turned.outdoors + turned.occupying + turned.destroyed
     === scenario.population
   ```
   Leaves are updated incrementally; the headless harness recounts them from entity
   state every tick and asserts the recount matches and the sum holds (harness only,
   not the browser). Most simulation bugs either lose a person or create one, so this
   single check catches them.

2. **Group totals are derived, never stored.** `unturned` and `turned` are sums over
   their leaves. Storing them creates a second source of truth that will drift.

3. **A run is fully reproducible from its seeds.** See Determinism below.

4. **Ticks and frames are different units.** Nothing in `sim/` reads wall-clock time,
   frame duration, or `performance.now()`.

---

## Architecture

```
src/sim/        pure simulation. No DOM, no wall-clock, no imports from render/ or ui/
src/worker/     hosts sim/ in a Web Worker: owns the World and the clock, sends snapshots
src/render/     draws snapshots. Never writes sim state (it holds none)
src/audio/      reads sim events. Never writes to sim state
src/ui/         reads sim state; writes only through explicit commands
src/config.ts   every tuning parameter. Imports nothing
scripts/        headless harness and parameter sweeps (run with tsx)
tests/          vitest
docs/           design notes and implementation reference
```

- **Toolchain:** TypeScript (strict), Node 22, npm, Vitest, tsx, ESLint; Vite from
  milestone 3. `npm run check` runs typecheck, lint and tests — run it before every commit.
- **Boundaries are enforced, not just documented.** `src/sim/` and `src/config.ts`
  compile under `tsconfig.sim.json` with no DOM or Node types, and ESLint rejects
  `Math.random`, `Date`, `performance` and render/ui/audio imports in `src/sim/`, and any
  import in `src/config.ts`. `tests/boundaries.test.ts` proves the rules fire. Do not
  loosen either to make code compile — move the code instead.

- **Every tuning number lives in `config.ts`**, exported as one object. No magic
  numbers in simulation code. This is what makes headless parameter sweeps possible
  and is the rule most likely to be broken by accident.
- The same `sim/` code must run headless in Node and in the browser. If something
  only works in one, it is in the wrong module.

---

## Determinism

- Two independent seeded PRNGs (`src/sim/rng.ts`): one from `mapSeed` for generation,
  one from `runSeed` for the simulation, its state held in `world.rng`. Sweeps vary
  `runSeed` against a fixed `mapSeed`. `Math.random()` appears nowhere in `sim/`.
- Iterate agents in id order. Never iterate a `Set` or `Map` where order could vary.
- Break ties by lower id. A symmetric rule produces deadlock and non-determinism at once.
- Accumulate floats in id order, not in spatial-partition order.

---

## Tick order

Fixed. Order decides behaviour, not just performance.

The governing principle is **decide, then apply**. Perception is computed once from
start-of-tick positions into a read-only snapshot; every agent then decides against the
same world. Decisions write intent, never position. Movement integrates in one later
pass. Without this, low-id agents react to a world high-id agents have already changed.

```
1  advance tick, update timeOfDay
2  rebuild spatial hash
3  age and expire stimuli
4  compute perception and perceivedThreat   <- read-only snapshot
5  zombie decisions
6  sim decisions
7  combat resolution                        <- sims by id, then zombies by id
8  infection countdowns and conversions
9  movement integration
10 building processes
11 encounters (proximity merges)
12 reconcile counters, assert invariant   <- promotion checks its trigger here
13 emit events
```

Combat sits before movement so contact is judged on the positions perception used.
Conversion sits after combat so a sim due to turn still gets a final action.

---

## Restricted reads

Two fields are deliberately quarantined. Both restrictions exist because global state
is a poor trigger for spatial events — at 20% infection city-wide, one district may be
untouched and another already gone. Both are enforced by lint (`eslint.config.ts`,
`restrictedReads`): a read outside the allowed files fails `npm run check`.

- **`district.released` / `district.releaseAt`** — read *only* by the occupant release
  (`src/sim/systems/release.ts`). Never by behaviour, shelter criteria, or any threshold.
  `phase` is derived for display and never stored.
- **`panic`** — gates exactly three things: whether a sim routes or steers, whether it
  consults its memory table, and whether occupants are expelled from a building. Read
  only in `systems/panic.ts` (which also derives the informed/direct/flight mode that
  routing, memory use and gait read), `systems/encounters.ts` (transmission) and
  `systems/buildings.ts` (expulsion).

Also: **nothing may read another sim's infection state** (`condition`, `turnsAt`).
Knowledge of infection is local: each sim's `knownInfected` set, written when it sees a
bite and merged on encounter. Shelter admission checks the sets of the sims inside. The
asymmetry between who knows and who doesn't is a core mechanic, not an oversight.

---

## Conventions

- **Coordinates are continuous floats.** One world unit = one metre. Grids are
  acceleration structures only (spatial hash, render density field).
- **One tick = one simulated second.** All rates and durations are in ticks.
- **Every simulation scalar is 0–1 and clamped.** Materials are the exception: an
  integer, consumed and carried in discrete units.
- Continuous scalars approach asymptotically, never linearly:
  ```
  value += (target - value) * rate * dt
  ```
- `danger` ages rather than decays. The stored value stays as observed; confidence
  falls with age. Decaying the value would turn old bad news into good news.

---

## Terminology

- **Survivors garrison, zombies occupy.** Garrison implies intent to hold; occupiers
  are merely present. Counter leaf is `turned.occupying`; building fields are
  `zombiesInside` and `occupiedAt`.
- **Sim** = a living person. **Zombie** = a separate entity, not a Sim with a flag.
- **Tracked sim** = keeps identity inside a building. **Resident** = anonymous count
  present at spawn, never individually simulated.

---

## Out of scope

Do not build these. Each was considered and rejected with reasons in the design notes.
If one seems necessary, raise it rather than adding it.

- Fire, explosions, petrol stations — wants to be the star; produces spectacle, not decisions
- Z-levels, rooftop movement — a second map, not a building attribute
- Survivor-on-survivor combat, psychopath archetype — a second hostility relation
- Health pools, wounds, bandages, healer archetype — replaced by one infection flag
- Heavy weapons, grenades — changes capability rather than decisions
- Multi-slot inventory — one weapon, one ammo count, one materials count
- Traffic modelling — cars are deferred entirely; when built, no lanes or intersections
- Corpses as attractors — would make every killing a magnet
- Isometric projection, authored art, line-of-sight rendering
- Any game engine. TypeScript and a plain canvas

---

## Working practice

- **Headless before visual.** Milestone 2 is a script that runs a full run (36,000 ticks)
  from a fixed seed and prints the eight counters every 600. No renderer until the counters
  reconcile and the infection curve has a shape across 20 seeds.
- Write the parameter-sweep harness early. Tuning is the actual work on this project;
  the code is the easy part.
- Prefer small modules and small commits. Architecture debt compounds badly here
  because everything reads the same state.
- Do not optimise speculatively. Structure-of-arrays is a later option, not a starting
  point. Profile first.
- Stagger expensive work on id offsets rather than running it every tick (armed sims
  pick targets when `id % 5 === tick % 5`; occupier spill every 10; roles, migration
  and door watch every 30; cascade checks every 10; dormant zombies every 4; idle
  awake zombies every 3).
- Measure before optimising, and measure the whole run to decide whether a change
  worked: `npx tsx scripts/bench.ts [--ticks 15000] [--runs 5]` times a fixed-seed
  headless run in fresh processes, one after another, and reports the minimum (host
  noise only ever adds time) plus a final-state fingerprint, so a speed-up that changes
  behaviour shows. Absolute milliseconds, never shares: the budget is absolute. To
  compare versions, interleave their runs. `npx tsx scripts/profile.ts [ticks]
  [population]` times each tick stage and is for finding where to look, not for
  judging a change. The harness owns the clock; never add timing inside `src/sim/`.
- `npx tsx scripts/movement-check.ts` reports how often moving agents are stuck or
  reversing (zig-zag); it should stay near zero after any change to steering or movement.
- The viewer: `npm run dev`. A frame counter (top centre; F toggles, `?fps` in a build)
  shows fps, the worst frame, draw time and the simulation's achieved tick rate; amber
  when under 30 fps or behind. `npx tsx scripts/view.ts [--advance N]` screenshots far,
  mid and near zoom in headless Chromium (`--at x,y` centres the near shot on a point,
  `--flagged 1` on a bitten survivor, `--query k=v` passes page options such as
  `infected=fill`); `npx tsx scripts/fps.ts` measures the renderer
  gate (run it on a real machine); `npx tsx scripts/ticker-rate.ts` replays a run through
  the ticker's salience filter and checks the lines-per-second gate.

---

## Current milestone

**3 — Renderer.** Canvas, three zoom modes, trails, free camera, ticker with salience,
roster, time controls. Reads sim state, never writes it. Audio (left over from
milestone 4) comes with it.

Built so far: the worker and snapshot protocol (`src/worker/`), the renderer
(`src/render/`: static city cache, occupancy, corpse paint, trails, pulses, far-zoom
density field), and the ticker, roster and time controls (`src/ui/`). Ticker gate
measured headlessly and passing; the 30 fps at 8× gate needs measuring on a real
machine (`scripts/fps.ts`). Also built: the inspector (click a building or a person)
and audio (`src/audio/`, synthesised; M mutes). Mid zoom has a density underlay, short
trails and names; still to judge by eye whether the city is legible at a glance there.

Survivor behaviour was revised alongside (reference, "Survivor behaviour revisions"):
awareness of the outbreak and an objective in place of the errand (`systems/awareness.ts`),
homes, limited sociality (shared destinations; squads stay deferred), fight, flight or
freeze when cornered or blocked, and the bitten choosing to conceal or isolate
(`systems/bitten.ts`). The renderer shows shouts, shots, the frozen, and — at near zoom
only — the bitten (an amber ring).

Gate: the city is legible at a glance at mid zoom; 2,000 agents hold 30 fps at 8×; the
ticker surfaces fewer than 6 lines per second at 1×.

Milestone 4 (shelter economy) was built first, at the user's request, because without it
a 36,000-tick run had empty streets from tick 11,000: `src/sim/systems/shelter.ts` plus
the contest in `systems/buildings.ts`. Residents take part anonymously (builders by
count; one steps out as a tracked scavenger when materials run out). `npm run sweep`
checks its gate too: shelters form, fall and re-form; no stasis; survival differs by
caution band. Decisions are listed in the reference under "Decisions made building
milestone 4".

Milestone 2 (headless loop) is done: `npm run sim -- <runSeed> <mapSeed>` prints the eight
counters every 600 ticks; `npm run sweep` runs 20 runSeeds on one mapSeed in parallel,
asserts the invariant every tick and checks the gate (`--set path=value` overrides any
config value; `--seeds 8` for quicker exploration). A full sweep takes about 30 minutes
at the default population of 6,000 and run length of 36,000 ticks. Re-run it after any change to simulation code,
map generation or tuning — a passing test suite does not mean the infection curve
still has its shape.

Milestone 1 (state shape) is done: `src/sim/state/` and `src/config.ts`, with the gate
checked by `tests/state-gate.test.ts` — every field declares `@range`, `@unit` and
`@readBy`. Keep it that way: a new field needs all three, and a field with no reader
does not belong.
