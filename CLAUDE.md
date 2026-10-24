# CLAUDE.md

Spectator-only zombie outbreak simulation. Thousands of people on a generated city,
top-down canvas, dots and building outlines. No player — before a run the viewer chooses
its settings on the setup screen (`src/ui/setup.ts`); once it starts, the viewer controls
camera, roster, ticker and time only.

- `docs/implementation-reference.md` is the specification: foundations, conventions,
  every entity, attack resolution, movement, systems, loops, then setup, organised
  responses, cars, the edge and the ending, presentation and build order. Its **History**
  appendix records every change since the design, in order, and the bugs the user saw.
- `docs/design-notes.md` carries the reasoning — why decisions went the way they did, and
  what was cut and why. Consult it before reversing anything. Where the two disagree,
  the reference is newer.

This file carries the constraints that must survive across sessions. When this file and
the reference disagree, ask rather than guessing.

---

## Hard invariants

Never break these. If a change would break one, stop and raise it.

1. **The population invariant holds every tick:**
   ```
   unturned.outdoors + unturned.indoors + unturned.dead + unturned.evacuated
     + turned.symptomatic + turned.outdoors + turned.occupying + turned.destroyed
     === scenario.population + World.outsiders
   ```
   `World.outsiders` counts soldiers who came in from outside (the cordon's units, the
   rescue); once in, they are counted in the leaves like anyone. Leaves are updated
   incrementally; the headless harness recounts them from entity state every tick and
   asserts the recount matches and the sum holds (harness only, not the browser). Most
   simulation bugs either lose a person or create one, so this single check catches them.
2. **Group totals are derived, never stored.** `unturned` and `turned` are sums over
   their leaves. Storing them creates a second source of truth that will drift.
3. **A run is fully reproducible from its seeds.** See Determinism below.
4. **Ticks and frames are different units.** Nothing in `sim/` reads wall-clock time,
   frame duration, or `performance.now()`.

---

## Architecture

```
src/sim/          pure simulation. No DOM, no wall-clock, no imports from render/, ui/ or audio/
  tick.ts         one tick, in the fixed order below
  setup.ts        a world from a scenario; spawn.ts creates people and the dead
  counters.ts     the invariant's leaves; context.ts per-run derived state
  state/          entity fields: every one declares @range, @unit, @readBy
  mapgen/         the city from mapSeed
  lib/            seeded RNG, spatial hash, geometry
  navigation/     map index (walkability, line of sight), A* routing, memory tables
  systems/
    shared/       perception, stimuli, movement integration, common helpers
    people/       the living: decisions, steering, awareness, the bitten, panic, encounters
    dead/         zombie decisions, infection and turning, rising
    fighting/     combat, arms
    buildings/    building processes (admission, breach, contest) and the shelter economy
    services/     police dispatch, EMTs, reservists and squads, cars and driving
    outside/      exits, the cordon, district release and evacuation, the rescue
    story/        promotion and names
src/worker/       hosts sim/ in a Web Worker: owns the World and the clock, sends snapshots,
                  writes the words the ticker and inspector show
src/render/       draws snapshots. Never writes sim state (it holds none)
src/audio/        reads sim events. Never writes to sim state
src/ui/           setup screen, ticker, roster, inspector, controls; writes only through commands
src/config.ts     every tuning parameter. Imports nothing
scripts/          headless harness, sweeps and measurements (run with tsx)
tests/            vitest
docs/             the reference and the design notes
```

- **Toolchain:** TypeScript (strict), Node 22, npm, Vitest, tsx, ESLint, Vite.
  `npm run check` runs typecheck, lint and tests — run it before every commit.
- **Boundaries are enforced, not just documented.** `src/sim/` and `src/config.ts`
  compile under `tsconfig.sim.json` with no DOM or Node types, and ESLint rejects
  `Math.random`, `Date`, `performance` and render/ui/audio imports in `src/sim/`, and any
  import in `src/config.ts`. `tests/boundaries.test.ts` proves the rules fire. Do not
  loosen either to make code compile — move the code instead.
- **Every tuning number lives in `config.ts`**, exported as one object. No magic
  numbers in simulation code. This is what makes headless parameter sweeps possible
  and is the rule most likely to be broken by accident.
- **A new state field needs `@range`, `@unit` and `@readBy`** (`tests/state-gate.test.ts`),
  and a field with no reader does not belong.
- The same `sim/` code must run headless in Node and in the browser. If something
  only works in one, it is in the wrong module.
- Put new code in the folder that says what it is for; a file that has grown two jobs
  is split along them.

---

## Determinism

- Two independent seeded PRNGs (`src/sim/lib/rng.ts`): one from `mapSeed` for
  generation, one from `runSeed` for the simulation, its state held in `world.rng`.
  Generation draws names, churches and the border from streams of their own, so editing
  one never moves the city. Sweeps vary `runSeed` against a fixed `mapSeed`.
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
6  panic, then sim decisions (car decisions among them)
7  combat resolution                        <- sims by id, then zombies by id
8  infection countdowns and conversions; the dead rising
9  movement integration (sims, zombies, cars)
10 building processes (and evacuation, the cordon, the rescue, 911 and
   ambulance dispatch, car processes)
11 encounters (proximity merges)
12 reconcile counters, assert invariant     <- promotion checks its trigger here
13 emit events
```

Combat sits before movement so contact is judged on the positions perception used.
Conversion sits after combat so a sim due to turn still gets a final action.

---

## Restricted reads

Two fields are deliberately quarantined, because global state is a poor trigger for
spatial events — at 20% infection city-wide, one district may be untouched and another
already gone. Both are enforced by lint (`eslint.config.ts`, `restrictedReads`): a read
outside the allowed files fails `npm run check`.

- **`district.released` / `releaseAt` / `evacuatedAt`** — read *only* by
  `systems/outside/release.ts`. Never by behaviour, shelter criteria, or any threshold.
  `phase` is derived for display and never stored.
- **`panic`** — gates exactly three things: whether a sim routes or steers, whether it
  consults its memory table, and whether occupants are expelled from a building. Read
  only in `systems/people/panic.ts` (which also derives the informed/direct/flight mode
  that everything else reads, `modeOf`), `systems/people/encounters.ts` (transmission)
  and `systems/buildings/buildings.ts` (expulsion).

Also: **nothing may read another sim's infection state** (`condition`, `turnsAt`).
Knowledge of infection is local: each sim's `knownInfected` set, written when it sees a
bite and merged on encounter. Shelter admission checks the sets of the sims inside. The
asymmetry between who knows and who doesn't is a core mechanic, not an oversight.

---

## Conventions

- **Coordinates are continuous floats.** One world unit = one metre. Grids are
  acceleration structures only (spatial hash, render density field).
- **One tick = one simulated second.** All rates and durations are in ticks.
- **Every simulation scalar is 0–1 and clamped.** Supplies are the exception: an
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
  present at spawn, never individually simulated until something makes it matter.
- **Outsider** = a soldier who came in from off the map (the cordon, the rescue).

---

## Out of scope

Do not build these. Each was considered and rejected with reasons in the design notes.
If one seems necessary, raise it rather than adding it.

- Fire, explosions, petrol stations — wants to be the star; produces spectacle, not decisions
- Z-levels, rooftop movement — a second map, not a building attribute
- Survivor-on-survivor combat, psychopath archetype — a second hostility relation. The
  user's exceptions, all at the city's edge and all narrow: the cordon fires on people
  approaching its barrier, an armed sim fired on there may fire back, and the rescue
  company may shoot someone who does not identify itself (reference, "The cordon",
  "The rescue")
- Health pools, wounds, bandages, healer archetype — replaced by one infection flag
- Heavy weapons, grenades — changes capability rather than decisions
- Multi-slot inventory — one weapon, one ammo count, one supplies count
- Traffic modelling — cars are containers that drive, jam and are abandoned: no lanes,
  intersections or right of way beyond "the lower id yields" (reference, "Cars")
- Corpses as attractors — would make every killing a magnet
- Isometric projection, authored art, line-of-sight rendering
- Any game engine. TypeScript and a plain canvas

---

## Working practice

- **Headless before visual.** A full run is 64,800 ticks (eighteen simulated hours: the
  outbreak's fourteen, then the rescue's four). `npm run sim -- <runSeed> <mapSeed>`
  prints the eight counters every 600 ticks.
- **Sweep after any change to simulation code, map generation or tuning** — a passing
  test suite does not mean the infection curve still has its shape. `npm run sweep` runs
  20 runSeeds on one mapSeed in parallel, asserts the invariant every tick and checks the
  gates (`--seeds 8` for quicker exploration, `--set path=value` overrides any config
  value). A full sweep takes about an hour on 16 cores.
- Tuning is the actual work on this project; the code is the easy part.
- Prefer small modules and small commits. Architecture debt compounds badly here
  because everything reads the same state.
- Do not optimise speculatively. Profile first.
- Stagger expensive work on id offsets rather than running it every tick (armed sims
  pick targets when `id % 5 === tick % 5`; occupier spill every 10; roles, migration
  and door watch every 30; cascade checks every 10; dormant zombies every 4; idle
  awake zombies every 3).
- **Measuring.** The harness owns the clock; never add timing inside `src/sim/`.
  - `npx tsx scripts/bench.ts [--ticks 15000] [--runs 5]` times a fixed-seed run in
    fresh processes and reports the minimum plus a final-state fingerprint, so a speed-up
    (or a refactor) that changes behaviour shows. Absolute milliseconds, never shares; to
    compare versions, interleave their runs.
  - `npx tsx scripts/profile.ts [ticks] [population]` times each tick stage — for finding
    where to look, not for judging a change.
  - `npx tsx scripts/movement-check.ts` reports how often moving agents are stuck or
    reversing; it should stay near zero after any change to steering or movement.
- **The viewer:** `npm run dev`. A frame counter (top centre; F toggles, `?fps` in a
  build) shows fps, the worst frame, draw time and the simulation's achieved tick rate.
  `npx tsx scripts/view.ts [--advance N]` screenshots far, mid and near zoom in headless
  Chromium (`--at x,y`, `--flagged 1`, `--query k=v`); `npx tsx scripts/fps.ts` measures
  the renderer gate (run it on a real machine); `npx tsx scripts/ticker-rate.ts` checks
  the ticker's lines-per-second gate.

---

## Where the project stands

All five milestones in the build order are built: state shape, headless loop,
renderer (with audio), shelter economy, cars. On top of them, from rounds of watching:
awareness and conversation, fight/flight/freeze, police and 911, EMTs, reservists and
SWAT squads, district evacuation, a sealed city with a cordon, traffic police checkpoints on the roads out,
and the rescue. Each is
described in the reference; the order it happened in is its History appendix.

Several teams work on this repository: render and audio work from other agents arrives as
pull requests into this branch. Review each before it is merged — `npm run check`, a
screenshot (`scripts/view.ts`), and for anything in `src/sim/` a measurement — and record
what was merged in the reference.

Open, in priority order:
1. **Sweep everything since commit a3ad199** (20 runSeeds, `npm run sweep`) and compare
   with the a3ad199 sweep in the reference ("Bugs the user saw", the last "Swept" entry).
   Simulation changes since: the sealed city, car inertia/crashes/walls, freeze and pong,
   the cordon redesign, the rescue's queue and tents, barriers that stop people on foot,
   the river blocking sight, the dead besieging a peopled door, the dead no longer circling empty
   doors, the rescue's gate, reservists re-forming at armouries, traffic police checkpoints, and the mall lot fix
   (which changes some maps, so seed numbers will not match old runs).
2. **Cars kept out of walls: settle the side effects.** Clipping is gone (2.2% → 0.28% of
   driving ticks), but to tick 12,000 trips fell on seed 1 (488 → 378) and abandoned cars
   rose on seed 2 (100 → 146). Find why (cars held by walls, wedged, abandoned), fix, and
   re-measure with a car-motion probe and `scripts/movement-check.ts`.
3. **Dead air.** After the first hour, 9–12 ten-minute stretches per seed with nothing on
   the ticker (the sweep's timeline, `scripts/lib/run-one.ts TimelineEntry`). Find where and
   why the city goes quiet before changing anything.
4. **Gate 3, on a real machine:** the city legible at a glance at mid zoom; 2,000 agents at
   30 fps at 8×, by day and at night now there are street lamps (`scripts/fps.ts`). The
   ticker gate (under 6 lines a second at 1×) is measured and passes. Also confirm the
   late-game hitches when the Rangers arrive are gone.
5. **The dead pulled back and forth between sounds** from two directions, away from any
   door (reference, "The dead went back and forth at a store's door", open note).
6. **Rangers across the river:** line of sight no longer crosses it; confirm by eye that
   their back-and-forth along the bank is gone.
7. **Decisions for the user:** what a cordon wound should mean (now: no state, the person
   turns back); whether to add the story blurbs (an opening blurb, a chronicle per named
   survivor — worker-side, from events).
