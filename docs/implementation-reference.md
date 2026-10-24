# Zombie outbreak simulator — implementation reference

@Trib

The specification, built from the ground up: each layer uses only terms the layers above it have defined. Companion to the design notes, which carry the reasoning.

## How to read this

The body defines the simulation from primitives upward — foundations, conventions, the entities, attack resolution, movement, systems and loops — then the parts built on that base, each in one place: scenario setup, organised responses (police, reservists, SWAT, EMTs), cars, the edge of the city and the ending, and presentation. **History**, at the end, records what changed after the design was written, in order: decisions made while building each milestone, the rounds of revisions after watching, and the bugs the user saw. Entries there that define behaviour are part of the specification; where one changes a rule in the body it says so, and the later word stands.

The design notes carry the reasoning — why decisions went the way they did, what was cut and why — and should be consulted before reversing anything here. Where the two disagree, this document is newer.

Numbers given as **defaults** are starting values, not findings. Every one of them belongs in the single config object (`src/config.ts`) and is expected to move under parameter sweeps. Numbers given as **fixed** are structural and changing them breaks other things.

Open decisions are marked inline, so they are visible at the point they matter; the few still open are listed next.

### What is still open

Everything else marked open further down has since been decided, resolved or made moot, and says so where it stands ("Was open … Since …").

- **Gate 3, by eye and on a real machine.** Whether the city is legible at a glance at mid zoom, including whether the occupancy fill is too faint for a block emptying to be seen. Whether 2,000 agents hold 30 fps at 8× (`scripts/fps.ts`).
- **Recorded sounds** in place of the synthesised ones. Optional.
- **A sweep of everything since commit a3ad199** (the last 20-seed sweep, "Final state", under the rescue): the sealed city, the car work, the freeze and pong fixes and the cordon redesign have each been measured on a seed or two, not swept.
- **Cars kept out of walls:** trips and abandoned cars moved both ways on two seeds; being measured ("Cars").
- **What a cordon wound means:** for now it has no state (struck, the person turns back). Anything lasting would be the health system the design notes cut ("The cordon").
- **Settled, not open:** the narrow spread at the end of a run is a stable system, not a determined one ("Sweep targets", restated). This city punishes grouping ("Grouping is punished in this city", under the rescue); the roster is a record (re-score, under promotion); civilian squads stay out, which that finding makes moot.

### Field lists live in code

The entity field tables below are the original design. The authoritative field list is `src/sim/state/`, where every field declares its range, unit and readers, and `tests/state-gate.test.ts` fails if any field lacks one. Where a table here differs from the code, the code is newer. The rules and formulas in this document remain the specification.

### Where the code is

`src/sim/` is the simulation; `tick.ts` runs one tick in the fixed order (Loops, "Tick order"), `setup.ts` builds a world from a scenario, `spawn.ts` creates people and the dead, `counters.ts` keeps the invariant's leaves, `context.ts` holds the per-run derived state. Below it:

| Folder | What it is for |
| --- | --- |
| `state/` | the entities' fields (Sim, Zombie, Building, Street, District, Car, World, events) |
| `mapgen/` | generating the city from `mapSeed` |
| `lib/` | seeded RNG, spatial hash, geometry |
| `navigation/` | the map index (adjacency, walkability, line of sight), A* routing, memory tables |
| `systems/shared/` | perception, stimuli, movement integration, helpers every system uses |
| `systems/people/` | the living: decisions, steering, awareness, the bitten, panic, encounters |
| `systems/dead/` | zombie decisions, infection and turning, rising |
| `systems/fighting/` | combat and arms |
| `systems/buildings/` | building processes (admission, breach, contest, spill) and the shelter economy |
| `systems/services/` | police dispatch, EMTs, reservists and squads, cars and driving |
| `systems/outside/` | exits, the cordon, district release and evacuation, the rescue |
| `systems/story/` | promotion and names |

Outside the simulation: `src/worker/` hosts it in a Web Worker and writes the snapshot and the words the ticker and inspector use; `src/render/` draws snapshots; `src/ui/` is the setup screen, ticker, roster, inspector and controls; `src/audio/` synthesises the sound. `scripts/` is the headless harness, sweeps and measurements; `tests/` is Vitest.

## The concept in brief

A spectator-only outbreak simulation. A top-down city of dots and building outlines, roughly 2,000 people, rendered to a plain canvas. There is no player: before a run the viewer chooses its settings on a setup screen; once it starts, the viewer controls the camera, a survivor roster, a news ticker and the speed of time, nothing else.

The simulation runs on local perception. No agent knows anything it has not seen or been told. Sims carry beliefs about the city that decay with age and spread by contact, so a survivor can act confidently on information that is no longer true.

The core loop is a shelter economy. Groups fortify a building, fortification consumes materials, materials run out, someone has to go and fetch more — and the retrieval trip is what draws the horde back. The safe position generates its own threat, which is what keeps the map from settling.

**What the demo tests:** whether a population of dots, driven by archetype behaviour and a spreading infection, produces a story worth watching without any player agency at all.

**The test every addition must pass:** does it change which decision a sim makes, or only the noun describing it? Capabilities are expensive because each one requires the whole balance to be rechecked. Decisions are cheap and are what the viewer reads off the screen.

**Stack.** TypeScript, no engine. The simulation is a pure module with no DOM dependency, so identical code runs headless in Node and in the browser. Rendering is a separate layer that reads simulation state and never writes to it.

**Out of scope,** with reasons in the design notes: traffic modelling, fire and explosions, z-levels, health pools, wound and treatment mechanics, survivor-on-survivor combat, multi-slot inventory, line-of-sight rendering, isometric projection, authored art.

## Foundations

Nothing below this section may contradict anything in it.

### Space

**Coordinates are continuous floats, not grid cells.** Fixed. Flocking, steering and motion trails all need sub-cell positions, and a grid would quantise them visibly at close zoom. Grids are used only as acceleration structures: the spatial hash for neighbour queries, and the coarse density field for zoomed-out rendering.

**One world unit is one metre.** Fixed. Every distance in this document is in metres and can be reasoned about physically.

| Quantity | Default | Note |
| --- | --- | --- |
| Map size | 3200 × 3200 m | 40 × 40 blocks |
| Block pitch | 80 m | Map default; a district's `blockPitch` overrides it |
| Street width | 12 m | Main streets 20 m, alleys 6 m |
| Spatial hash cell | 16 m | Should exceed the largest query radius |

The street graph is an overlay on continuous space, not a replacement for it. Sims have real positions; streets are edges used for routing and as the key space for memory. A sim is *on* a street when within half its width of the centreline.

**Layout.** Fixed. Districts are a 3×3 grid of ~1,067 m cells: downtown in the centre, industrial in one corner, suburbs on the rest of the ring. District boundaries and the ring road round the city, inside an empty margin ("The city's edge"), are straight continuous streets; inside each district the street grid is rotated a few degrees against its neighbours, so the seams show where grids meet. Everything is edge-based: a park is a block with no building whose bounding streets carry terrain `open`; there is no area primitive. A sim off any street (rare; only while steering) reads perception from the nearest street within 40 m, falling back to `standard`.

**The river** runs edge to edge on a diagonal with gentle bends. Streets stop short of its banks except at three bridges — streets with terrain `bridge` — so `blocked` has something meaningful to sever.

**Diagonals** break the grid without creating a highway. A single map-spanning avenue would be the cheapest long edge in the graph; every sim shares the graph, so most cross-map routes would converge on it. Instead there are short ones, each about a third of the map, starting and ending on existing grid nodes so they terminate inside the city rather than becoming through-routes: two arms meeting at one hub on a main street (a landmark junction), and one diagonal that crosses the river, putting a bridge at a junction. No diagonal runs within 35° of the river's heading, which would strand thin slivers between them. Where diagonals meet the grid they cut triangular blocks and small plazas.

**Blocks** are the faces of the planar street graph. Faces below 1,500 m² become plazas (no buildings, `open` streets) and a few become parks. The rest are subdivided along their street frontages: suburbs into terraced plots of 9–14 m frontage, often backing onto a mid-block alley; industrial into long shallow sheds; downtown into a few large footprints. A share of blocks (most downtown) is built as one whole-block footprint — offices, schools, hospitals. Alleys are lanes through the middle of blocks, not whole grid lines, so the choice between the lit main street and the dark alley is visible on the map.

**Occupancy scales with footprint area.** Each tag has an occupancy density per 100 m² and a multiplier per time band; starting residents are the indoor population divided in proportion to density × area × band. Big offices and schools fill by day, homes by night.

### Time

**One tick is one second of simulated time.** Fixed. All rates and durations in this document are in ticks and convert directly to seconds.

| Quantity | Default | Note |
| --- | --- | --- |
| Tick | 1 s simulated | Fixed |
| Display rate at 1× | 10 ticks/s | A 1× minute of watching is 10 simulated minutes |
| Speed multipliers | 0.25×, 1×, 2×, 4×, 8× | Plus pause and step-one-tick |
| Speed ceiling | 8× | Above this, audio and ticker become unreadable |
| Run length | 50,400 ticks | 14 simulated hours: seven whole day/night cycles, ending at the hour it began; 84 min at 1×, 10½ min at 8× (was 36,000; before that 21,600) |
| Day length | 7,200 ticks | Compressed: three day/night cycles per run. `timeOfDay` is derived from tick, start hour and day length, never stored |

**Correction to the design notes:** the "one in-game month" ending is not reachable at one tick per second and should be read as flavour. The timer ending is a tick count.

**Ticks and frames are different units.** Fixed. Nothing in the simulation may read wall-clock time, frame duration or `performance.now()`. Fast-forward runs more ticks per frame; slow motion runs fewer. The simulation cannot tell the difference, which is what makes runs reproducible.

### Determinism

**A run is fully reproducible from its seed.** Fixed, and the property the entire testing approach depends on.

- One seeded PRNG instance, passed explicitly. `Math.random()` appears nowhere in the simulation module.
- Iteration order over agents is stable — arrays indexed by id, never `Set` or `Map` iteration where order could vary.
- Ties are broken deterministically. Where two agents contend, lower id wins; a symmetric rule produces deadlock and non-determinism at once.
- Floating-point accumulation order is fixed by iterating in id order, not by spatial partition order.

### Module boundaries

| Module | May depend on | Must not |
| --- | --- | --- |
| `sim/` | Nothing outside itself | Touch the DOM, read wall-clock, import the renderer |
| `render/` | `sim/` state, read-only | Write to simulation state |
| `audio/` | `sim/` events, read-only | Write to simulation state |
| `ui/` | `sim/` state, `render/` | Write to simulation state except through explicit commands |
| `config.ts` | Nothing | Import anything |

**Every tuning parameter lives in `config.ts`,** exported as one object. Fixed. No magic numbers in simulation code. This is what makes headless parameter sweeps possible, and it is the rule most likely to be broken by accident.

## Scalar conventions

**Every simulation scalar is normalised to 0–1 and clamped.** Fixed. A threshold against an unbounded quantity is not implementable, and unbounded accumulators drift in ways that are invisible until they are not.

| Scalar | Lives on | 0 means | 1 means |
| --- | --- | --- | --- |
| `panic` | Sim | Calm, routes normally | Blind flight, no routing |
| `perceivedThreat` | Computed, not stored | Nothing visible | Overwhelmed, immediate danger |
| `danger` | Memory entry, per street | Believed clear | Believed impassable |
| `fortification` | Building | Bare, as-built | Fully barricaded |
| `integrity` | Building, from tag | Trivially breached | Structurally sound |

**Materials are the exception:** an integer count, not a normalised scalar, because it is consumed in discrete units and carried in discrete amounts.

### Accumulation and decay

All continuous scalars follow one pattern, so there is one function to write and one behaviour to reason about:

```
value += (target - value) * rate * dt
```

Approach is asymptotic, never linear. `rate` is per tick, expressed as the fraction of remaining distance closed each tick. A rate of 0.01 closes roughly 63% of the gap in 100 ticks, which is the intuition to hold.

| Scalar | Rises from | Default rise | Default decay |
| --- | --- | --- | --- |
| `panic` | Witnessed conversion, nearby noise, panicked neighbours | 0.25 per event | 0.004 per tick |
| `danger` | Observation writes `perceivedThreat` at that moment | Direct set | Confidence ages, value does not decay |
| `fortification` | A builder working, consuming materials | 0.002 per tick per worker | 0.0005 per tick, unattended |

**`danger` ages rather than decays.** The stored value stays as observed; what changes is confidence, derived from `tick - observedAt`. This matters: a street remembered as lethal an hour ago should still read as dangerous, just less certainly. Decaying the value toward zero would make old bad news look like good news, which is the wrong failure.

Confidence is `exp(-ln2 * age / halfLife)` with a default half-life of 1,800 ticks (30 simulated minutes), so a belief that old is held at 0.5. Routing cost uses `danger * confidence`, so an unconfirmed belief fades toward neutral rather than toward safe.

### Thresholds

Thresholds are per-archetype where behaviour differs, and live in config as named constants rather than literals at the comparison site.

| Threshold | Reads | Default | Effect above |
| --- | --- | --- | --- |
| `panicRoutingCutoff` | `panic` | 0.55 | Sim abandons pathfinding for local steering |
| `panicMemoryCutoff` | `panic` | 0.40 | Sim stops consulting its memory table |
| `panicExpelThreshold` | `panic` of occupants | 0.70 | Occupants are expelled from a building |
| `engageThreshold` | `perceivedThreat` | 0.30 (police) | Below it, police approach; above, they fall back |
| `shelterSeekThreshold` | `perceivedThreat` | Per archetype | Sim begins seeking shelter |
| `splinterDensity` | Local zombie count | 12 within 8 m | Repulsion activates, horde fragments |

**Was open:** all six default values were guesses, and the first thing the sweep should move. **Since:** the panic cutoffs and engage threshold have held through every sweep. `splinterDensity` became `splinterRadius`/`splinterCount` in config. The ranges and the pattern are fixed; the numbers are not.

## Sim

A living person. Zombies are a separate entity, not a Sim with a flag — the field sets barely overlap and keeping them apart makes the per-tick cost of the majority population visible.

### Identity and state

| Field | Type | Range / unit | Meaning |
| --- | --- | --- | --- |
| `id` | `int` | Stable index | Array position; also the deterministic tiebreak |
| `archetype` | `enum` | 5 values | Civilian, police, prepper, loner, reckless |
| `profession` | `enum` | Label set | Display only; derived at spawn from starting building tag |
| `age` | `int` | 16–85 years | Small speed modifier and shelter-preference bias |
| `sociality` | `float` | 0–1 | How readily it goes along with others; uniform, nudged by profession, independent of archetype |
| `trust` | `float` | 0–1 | How readily it believes what it is told; uniform, independent of archetype |
| `status` | `enum` | 4 values | `indoors`, `outdoors`, `infected`, `dead` |
| `promoted` | `bool` | — | On the roster, named, ticker-eligible |
| `name` | `string?` | — | Assigned at promotion, not at spawn |

### Physical

| Field | Type | Range / unit | Meaning |
| --- | --- | --- | --- |
| `x`, `y` | `float` | 0–3200 m | Continuous position |
| `heading` | `float` | 0–2π rad | Facing; also trail direction |
| `speed` | `float` | 0–2.9 m/tick | Derived from gait and stamina; see Movement. Not stored |
| `insideBuilding` | `int?` | Building id | Null when outdoors |

### Perception and belief

| Field | Type | Range / unit | Meaning |
| --- | --- | --- | --- |
| `perceptionRadius` | `float` | 0–60 m | 45 day, 15 night, 60 on open ground, 25 on lit streets |
| `panic` | `float` | 0–1 | See scalar conventions |
| `memory` | `Map<streetId, {danger, observedAt}>` | Bounded by street count | Belief about the city |
| `lastMergeTick` | `int` | Ticks | Rate-limits proximity merges |

### Movement intent

| Field | Type | Range / unit | Meaning |
| --- | --- | --- | --- |
| `destination` | `{x, y}?` | Metres | Null when fleeing or idle |
| `destinationKind` | `enum?` | 4 values | `routine`, `scavenge`, `shelter`, `regroup` (`broadcast` returns with the v2 rescue) |
| `route` | `int[]` | Street ids | Empty when steering rather than routing |
| `routeIndex` | `int` | — | Position along `route` |
| `repathCooldown` | `int` | Ticks | Blocks repathing until zero |

### Carried

| Field | Type | Range / unit | Meaning |
| --- | --- | --- | --- |
| `weapon` | `enum?` | 6 values | Pistol, SMG, shotgun, knife, club, sledgehammer |
| `ammo` | `int` | 0–30 | Zero makes a firearm dead weight |
| `materials` | `int` | 0–8 | Carried; capped so one trip cannot resupply a shelter |

### Infection

| Field | Type | Range / unit | Meaning |
| --- | --- | --- | --- |
| `infected` | `bool` | — | Set on a successful bite |
| `turnsAt` | `int?` | Tick | Conversion tick; default delay 300–1,200 ticks (was 20–40) |
| `infectionWitnessed` | `bool` | — | Whether anyone saw the bite. Drives whether shelters admit them |

### Shelter

**Supplies** (the user's redesign, from here on; formerly *materials*: the one stock, renamed throughout the code — `Building.supplies`, `Sim.supplies` carried, `buildings.suppliesCap`, `suppliesDelivered`; History keeps the old word). One stock that the people sheltering eat and builders spend on barricades; fortification stays a separate, durable value (`shelter.ts eat`, `suppliesLast`; `config.supplies`; `Building.outOfSuppliesAt`):

- **Eaten.** An alerted building's people — residents and those sheltering — get through a unit each `personTicksPerUnit` (10,800) ticks between them: a full load (`carryCap` 8) feeds eight for three hours (the user's choice). Eight eat eight times as fast as one: the cost of a big group. Police stations, hospitals and the armoury keep their own stores and are not eaten into (`exempt`). Unalerted buildings live as normal.
- **Scavenging** goes out once what is left would last under `scavengeBelow` (3,600) ticks (was: only with none left). **Builders** spend supplies on barricades only while they would last over `buildAbove` (7,200): eating comes first.
- **Running out moves people on** (the user's choice; no starvation): out of supplies `leaveAfter` (14,400: four hours) ticks with nobody bringing more, each `roles.interval` `leaveShare` (0.1) of the residents step out to find shelter elsewhere, and of those sheltering the same share go for the best other shelter they know of (`suppliesRanOut`, said once). A shelter can fail with nothing breaking in.
- **Shown:** the building panel gives the stock and about how long it will last.


| Field | Type | Range / unit | Meaning |
| --- | --- | --- | --- |
| `role` | `enum?` | 3 values | `builder`, `scavenger`, `dispatcher`; reassigned dynamically |
| `roleSince` | `int` | Tick | Prevents role thrashing |

### History counters

Accrue from tick zero on every sim, anonymous or not. Promotion scoring reads them; the end-of-run statistics read them; they cost roughly 30 bytes per sim.

| Field | Type | Meaning |
| --- | --- | --- |
| `ticksSurvived` | `int` | Since spawn |
| `conversionsWitnessed` | `int` | Within perception radius |
| `buildingsEntered` | `int` | Distinct |
| `streetsVisited` | `int` | Distinct |
| `ticksAlone` | `int` | Since last proximity to another sim |
| `nearMisses` | `int` | Within contact range of a zombie and survived |
| `kills` | `int` | Zombies destroyed |
| `materialsDelivered` | `int` | Total returned to a shelter |

**Decided:** counters live inline on the Sim (`Sim.history`); profiling never asked for the parallel structure. (Was open: whether counters live inline on the Sim or in a parallel structure indexed by id.) Inline is simpler; parallel is better for cache locality if the tick loop is ever restructured as structure-of-arrays. Not worth deciding until profiling says so.

## Zombie, Building, Street, District

### Zombie

Deliberately minimal. By the end of a run these are most of the population, so every field costs 2,000 times over.

| Field | Type | Range / unit | Meaning |
| --- | --- | --- | --- |
| `id` | `int` | Stable index | Also the deterministic tiebreak |
| `x`, `y` | `float` | 0–3200 m | Continuous position |
| `heading` | `float` | 0–2π rad | Facing |
| `dormant` | `bool` | — | Idle; ticks cheaply, wakes on stimulus |
| `wandering` | `bool` | — | Spontaneously woken, drifting, will re-dormant |
| `wanderUntil` | `int?` | Tick | When drifting ends |
| `target` | `int?` | Sim id | Tracked survivor; null when drifting or flocking |
| `wasSim` | `int?` | Sim id | For the ticker: naming who this used to be |

No archetype, no memory, no history counters, no shelter logic, no names. Default speed 1.1 m/tick, detection radius 18 m — both below the sim equivalents, which is the asymmetry the whole design rests on.

### Building

| Field | Type | Range / unit | Meaning |
| --- | --- | --- | --- |
| `id` | `int` | Stable index | — |
| `outline` | `{x, y}[]` | Metres | Polygon, usually rectangular |
| `tag` | `enum` | \~30 values | Functional or flavour; see tag table |
| `district` | `int` | District id | — |
| `street` | `int` | Street id | The street it fronts; occupier spill reads this street's zombie count |
| `occupants` | `int` | 0–200 | Anonymous residents present at spawn only |
| `sheltered` | `int[]` | Sim ids | Everyone who entered during the run; identity retained |
| `zombiesInside` | `int` | 0–200 | Occupying zombies, de-instantiated |
| `occupiedAt` | `int?` | Tick | When the occupation began |
| `contested` | `bool` | — | A tracked sim is fighting the occupiers; drives render state |
| `materials` | `int` | 0–60 | Stock available to builders |
| `fortification` | `float` | 0–1 | Raised by builders, decays unattended |
| `integrity` | `float` | 0–1 | Derived from tag; structural soundness |
| `breached` | `bool` | — | A zombie has entered |
| `lit` | `bool` | — | Interior light; visible from outside at night |
| `entrances` | `{x, y}[]` | Metres | Where sims cross the outline |

**Three populations, deliberately.** The anonymous living count dissolves into a number; sheltered sims keep their identity and history; occupying zombies are a count with no identity at all. Breach probability scales with `(1 - integrity) / (1 + 2 * fortification)`: integrity sets how breachable the bare building is and fortification divides it, so a fortified weak building can outlast a bare strong one and no building ever becomes unbreachable.

**Breach rolls.** Every 10 ticks on a cycle staggered by building id, each building with zombies within 5 m of an entrance takes one roll per adjacent zombie, up to four, at `p = breachBase * (1 - integrity) / (1 + 2 * fortification)`.

An earlier form, `breachBase * (1 - integrity * (1 + 2 * fortification))`, was rejected: it reaches zero once `integrity * (1 + 2 * fortification) ≥ 1` — at fortification 0.06 for a police station and 0.21 for a house — so most sound buildings became unbreachable almost immediately.

**Occupation.** Zombies that breach a building are de-instantiated and become `zombiesInside`. They leave the map, cost nothing per tick, and are not rendered — which matters, because in a saturated city a breached building would otherwise hold hundreds of agents. An occupied building reads visually as full; nothing on screen says by what.

The occupiers re-instantiate onto the street when any of these fire:

1. A stimulus occurs within `buildings.spill.alertRadius` (default 40 m) of the building.
2. Local zombie density in the surrounding cells falls below `buildings.spill.densityThreshold`. **Local, never a city-wide ratio** — at any global figure one street can be empty and another packed, which is the same reason nothing but the release reads `phase`.
3. A sim attempts entry.

Spill is capped per tick like any other expulsion, so an occupation empties over several seconds rather than in one frame.

**Contesting an occupation.** A sim cannot see inside. Occupancy fill looks identical whether a building holds forty residents or forty zombies, so shelter-seeking is a gamble informed only by memory, which may be stale. This is deliberate: it is the design's clearest source of confident wrong decisions.

Entry commits. A sim that enters an occupied building discovers `zombiesInside` and is already in contact range — there is no peek-and-withdraw, or every building becomes free reconnaissance and shelter stops being a gamble at all.

On discovery:

1. **Armed and the odds are acceptable** — the sim contests. Combat resolves per tick against one zombie at a time under the ordinary weapon rules. Winning decrements `zombiesInside`; clearing it to zero takes the building, and `breached` resets once fortification begins.
2. **Unarmed, or the occupation is too large** — the sim attempts to withdraw, taking one contact-range infection roll on the way out.
3. **Panicked above `panicRoutingCutoff`** — no evaluation happens. The sim entered blind and fights or dies on reflex.

The threshold for acceptable odds is per archetype, reusing the `engageThreshold` police already apply to `perceivedThreat`.

**Every sim that enters during the run is individually tracked.** The anonymous `occupants` count covers only the original residents present at spawn. Anyone who walks in keeps their identity, weapon, history counters and memory table, because all four are needed the moment they meet an occupation. A sim never dissolves into a number.

**Interior fighting is invisible,** which is a presentation problem rather than a simulation one. The viewer sees an outline, not a fight. Hence `contested` on the building: it needs a distinct render state and a ticker line, or the most dramatic event in the design happens silently.

### Street

The graph's edges, and the key space for sim memory. Everything about routing and belief hangs off these.

| Field | Type | Range / unit | Meaning |
| --- | --- | --- | --- |
| `id` | `int` | Stable index | Memory table key |
| `name` | `string` | — | Generated; used by ticker, waypoints, roster |
| `a`, `b` | `int` | Node ids | Endpoints in the street graph |
| `width` | `float` | 6–20 m | Alley, standard, main |
| `terrain` | `enum` | 4 values | `standard`, `alley`, `open`, `bridge` |
| `lit` | `bool` | — | Street lighting present |
| `blocked` | `float` | 0–1 | Permanent obstruction; 1 is impassable |
| `district` | `int` | District id | — |

`terrain` and `lit` together set the perception radius of any sim on that street, which is how open ground can favour survivors by day and punish them at night from a single flag.

`blocked` is the mechanism for permanent structural change — a bridge reaching 1 severs a district for the rest of the run.

### District

A parameter set, not an authored place type. Suburb, downtown and industrial fall out of one generator with different weights.

| Field | Type | Range / unit | Meaning |
| --- | --- | --- | --- |
| `id` | `int` | Stable index | — |
| `name` | `string` | — | Ticker legibility |
| `bounds` | `{x, y, w, h}` | Metres | Axis-aligned |
| `blockPitch` | `float` | 60–120 m | Generator input |
| `buildingDensity` | `float` | 0–1 | Generator input |
| `lightingCoverage` | `float` | 0–1 | Fraction of streets lit |
| `tagWeights` | `Map<tag, float>` | — | Generator input |
| `released` | `bool` | — | Whether the phase release has fired here |
| `phase` | `enum` | 4 values | Display only; nothing but the release may read it |

**`released` and `releaseAt` are the only global-ish state any behaviour touches,** and they govern only whether occupants become agents — never what those agents decide. Only the occupant release may read them; a lint rule enforces it. `phase` is derived for display and never stored.

## World

Everything needed to resume a run exactly. If this serialises and reloads identically, the simulation is correct in the sense that matters for testing.

| Field | Type | Range / unit | Meaning |
| --- | --- | --- | --- |
| `tick` | `int` | 0–50,400 | Simulated seconds elapsed |
| `seed` | `int` | — | Reproduces the whole run |
| `rng` | `PRNG` | — | Seeded instance; its internal state is part of the snapshot |
| `timeOfDay` | `float` | 0–1 | 0 midnight, 0.5 noon; drives perception radii |
| `sims` | `Sim[]` | — | Indexed by id |
| `zombies` | `Zombie[]` | — | Indexed by id |
| `buildings` | `Building[]` | — | Indexed by id |
| `streets` | `Street[]` | — | Indexed by id |
| `districts` | `District[]` | — | Indexed by id |
| `spatialHash` | `SpatialHash` | — | Rebuilt per tick; derived, not persisted |
| `repathQueue` | `int[]` | Sim ids | Drained under a per-tick cap |
| `stimuli` | `Stimulus[]` | — | Active noise events with position, radius, decay |
| `events` | `Event[]` | — | Scored; feeds ticker and audio |
| `roster` | `int[]` | Sim ids | Promoted survivors |
| `counters` | `Counters` | — | Below |
| `config` | `Config` | — | Every tuning parameter |

### Populations and counters

### Terminology

**Survivors garrison, zombies occupy.** A garrison implies intent to hold; occupiers are merely present. The counter leaf is `turned.occupying`, the building fields are `zombiesInside` and `occupiedAt`, and taking a building back is contesting an occupation.

### Entering and leaving

A building holds members of two kinds, and the difference matters for everything downstream.

**Anonymous residents** never had positions. They are a count that was there at spawn, and they leave only by being expelled, converted or killed. Nothing about them is simulated individually.

**Tracked sims** arrive during the run and keep everything — identity, weapon, stamina, memory table, history counters.

| Step | Rule |
| --- | --- |
| Approach | The sim routes to the nearest `entrance` point on the outline, not to the building's centre |
| Transition | On reaching the entrance, `insideBuilding` is set, the sim id is pushed to `sheltered`, and `unturned.outdoors` decrements as `unturned.indoors` increments |
| Position | `x, y` freeze at the entrance used. Not cleared — it is where the sim reappears on exit |
| Spatial hash | Removed. This is the point of the transition: an indoor sim costs nothing in neighbour queries, which is what makes a hundred people in a building affordable |
| Ticking | Cheap tick only — history accrues, stamina recovers at the `still` rate, panic decays, shelter role is evaluated. No movement, no pathfinding, no perception |
| Exit | Costs `fortification * 40` ticks, then the reverse transition at the same entrance |

**Removal from the spatial hash is why interior combat is building-scoped.** An indoor sim has no spatial neighbours, so contesting an occupation cannot use the ordinary contact rules — it resolves against `zombiesInside` as a count, one roll per cooldown, rather than against positioned zombies. Same weapon numbers, different lookup.

**Decided:** residents resolve statistically; one steps out as a tracked sim only to scavenge, be released or evacuate, or on a call-up. (Was open: whether residents should be instantiated as tracked sims when a building is breached, rather than resolving statistically. It would make interior events legible person by person on the panel, at the cost of spawning forty agents at the worst possible moment for the frame budget. The count classes shown when inspecting depend on this: five if residents, symptomatic sims and bodies are tracked separately, two if everything indoors collapses to living and occupying.

Two groups, each with its own terminal leaf, plus rescue. Leaves are updated incrementally at each transition; the headless harness recounts them from entity state every tick and asserts the recount matches (not in the browser). Group totals are sums, never stored — deriving them removes a whole class of desynchronisation bug.

| Group | Leaf | Holds |
| --- | --- | --- |
| `unturned` | `outdoors` | Survivors on the street |
| `unturned` | `indoors` | Anonymous residents plus tracked sims inside buildings |
| `unturned` | `dead` | Died without converting |
| `unturned` | `evacuated` | Left the map by an exit (`systems/outside/exits.ts`), bitten or not |
| `turned` | `symptomatic` | Bitten and not yet converted, wherever they are |
| `turned` | `outdoors` | Active, dormant, wandering and feeding, on the map |
| `turned` | `occupying` | Occupying breached buildings, de-instantiated |
| `turned` | `destroyed` | Killed |

**The top-level split is whether a person ever turned.** That is what makes the statistics readable: total human loss is `unturned.dead` plus the whole of `turned`, since every zombie but patient zero was someone.

**Why `unturned` rather than `uninfected`.** A bitten sim is infected and still walking, so `uninfected` becomes false the moment infection mechanics land.

**`symptomatic` belongs under `turned`,** as a transient leaf, and is in the invariant from milestone 1 so it does not change mid-milestone. Under `unturned` it would produce a false ending: a run where every zombie has been destroyed but one bitten survivor is still walking would read as outbreak over, when it is thirty seconds from starting again. It resolves to `turned.outdoors` on turning, or transfers to `unturned.dead` if the sim is killed first — cross-group transfers are fine, the invariant only cares about the total.

**Counters are ground truth; the ticker and roster are perception.** A symptomatic sim sits under `turned` in the accounting while still appearing on the roster as a living survivor, because nobody who did not witness the bite knows otherwise. The two are allowed to disagree, and the moment they do is the point.

**Why the indoor splits exist.** Without them a falling street count is ambiguous between deaths and people going inside. The same argument applies to zombies once occupation exists: fewer visible zombies could mean police are winning or that a horde has moved indoors, and those are opposite situations.

### The invariant

```
unturned.outdoors + unturned.indoors + unturned.dead + unturned.evacuated
  + turned.symptomatic + turned.outdoors + turned.occupying + turned.destroyed
  === startingPopulation
```

Asserted every tick in the headless harness. Fixed. This single check catches most simulation bugs, because almost every mistake in a state transition either loses a person or creates one.

### Derived, not stored

Recomputed per tick and never persisted: `perceivedThreat` per sim, local zombie density, memory confidence, the spatial hash, the render density field. Storing any of these creates a second source of truth that will drift.

## Attack resolution

No health pools on either side. Every attack is a single roll that kills, misses, or infects. Health bars would be invisible at dot scale, and a hit-point model would need tuning for no visible gain.

### Ranged

Only sims have ranged attacks. Requires line of sight — a segment test against building outlines, the one genuinely costly operation in combat, which is why armed sims evaluate on a staggered five-tick cycle rather than every tick.

| Weapon | Range | Cooldown | Base kill | Ammo | Noise radius | Note |
| --- | --- | --- | --- | --- | --- | --- |
| Pistol | 25 m | 12 ticks | 0.55 | 1/shot | 120 m | Police default |
| SMG | 25 m | 4 ticks | 0.30 | 3/burst | 160 m | Empties a magazine fast |
| Shotgun | 10 m | 18 ticks | 0.85 | 1/shot | 200 m | Rolls against up to 3 targets in a 45° arc |

Kill chance falls with distance: `base * (1 - 0.4 * d / range)`. A miss does nothing but make noise — there are no stray-shot casualties.

### Melee

Contact range is 1.5 m for everything. A miss is what makes melee dangerous: the zombie is already inside contact range and gets a free infection roll.

| Weapon | Cooldown | Base kill | Infection on miss | Noise radius |
| --- | --- | --- | --- | --- |
| Sledgehammer | 20 ticks | 0.80 | 0.50 | 15 m |
| Club | 10 ticks | 0.50 | 0.30 | 15 m |
| Knife | 6 ticks | 0.35 | 0.40 | 0 m |
| Unarmed | 8 ticks | 0.10 | 0.60 | 0 m |

The sledgehammer's long cooldown is the commitment: high kill chance, and a bad roll leaves the sim exposed for twenty ticks. The knife is a desperate option rather than a stealth one — silent, but a miss is nearly a coin flip against infection.

### Zombie attack

| Property | Default | Note |
| --- | --- | --- |
| Contact range | 1.5 m | Same as melee |
| Cooldown | 10 ticks | Per zombie, staggered by id |
| Base infection | 0.35 | Against a stationary target |
| Moving-target modifier | ×0.6 | Sim moving away at speed |
| Cornered modifier | ×1.4 | No escape vector available |

**Every zombie in contact rolls independently.** Being surrounded is fatal quickly, which is correct and needs no special rule. Three zombies in contact is roughly a 72% chance of infection per cooldown cycle.

### Resolution order

Fixed, and required for determinism: sims act in id order, then zombies in id order. A zombie killed earlier in a tick does not act later in that tick. No simultaneous resolution, no initiative rolls.

### Indoors

Same rules, with two changes. Noise radius is halved, since walls muffle — which makes taking a building by force quieter than holding a street, and is the main reason clearing an occupation is viable at all. And ranged distance falloff does not apply: interior engagements are assumed to be at contact-to-short range.

### Firing from inside

An armed sim sheltering in a building that knows about the outbreak fires on the dead within 20 m of one of its doors (`combat.doorDefenceRadius`), on the armed sims' staggered cycle: the ordinary ranged roll, measured from the door, the noise muffled by the walls, not while the dead are inside. It defends the door rather than sniping at the street, because every shot draws more. A shot fired from a building alerts it but does not drive its own residents out (`Stimulus.from`). No other new state: the building already knows who is inside. A defended building is now different from an empty barricaded one, and police have a reason to hold a station. Seed 1, 9,000 ticks: breaches 810 → 686, shelters fallen 154 → 125, dead 1,183 → 929, turned 1,372 → 1,078, police alive at the end 27 → 34.

### Engagement capacity

The number a sim believes it can handle, used by police `engageThreshold` and by the occupation contest rule. Not a perception value — a rough self-assessment:

```
capacity = floor(ammo * baseKill) + meleeCapacity
```

where `meleeCapacity` is 3 for sledgehammer, 2 for club, 1 for knife, 0 unarmed. A police officer with 12 rounds reads as capacity 6 and will contest an occupation of five; the same officer at 2 rounds reads as 1 and will not.

**Was open:** every number in this section was a starting guess. **Since:** these numbers were swept and adjusted round by round (the swarm table, `corneredFactor`, darkness and the cone), and the current values are in config. The ones most likely to be wrong are base infection chance, which sets how survivable contact is at all, and the melee miss penalties, which decide whether unarmed survivors have any agency.

### Feeding and swarming

Zombies eat. Not every victim converts, and a zombie with a body in front of it stops pursuing anyone else.

Feeding is a value of the zombie `state` enum, with `stateUntil` holding when it ends.

**Outcome depends on how many are in contact.** A successful attack resolves differently by crowd size, which is the whole point of the mechanic:

| Zombies in contact | Infected and released | Taken down and fed on |
| --- | --- | --- |
| 1 | 0.80 | 0.20 |
| 2 | 0.55 | 0.45 |
| 3 | 0.25 | 0.75 |
| 4+ | 0.10 | 0.90 |

This produces the design's epidemiology rather than merely its body count. **Wanderers are the vector; hordes are attrition.** The infection spreads through isolated encounters in quiet streets, while the mass of the horde mostly kills outright. A survivor's worst outcome and the city's worst outcome are different events, and the lone zombie nobody noticed is the one that matters.

It also flattens the curve. Every consumed victim is a zombie that never existed, so total conversion stops being the default trajectory — which is the failure mode the second build gate exists to catch.

**Feeding occupies.** A zombie that takes someone down enters state `feeding` until tick + 90–150 and stops pursuing, tracking, flocking and detecting for that span. Someone who falls buys time for everyone else. The body goes to `unturned.dead`; no counter change is needed.

**Corpses do not attract.** A dead sim is inert. Making bodies into stimuli would turn every killing into a magnet and produce runaway pileups on the streets where things first went wrong. Deliberately rejected.

### Drag

Contact slows rather than grabs, so it needs no separate roll and reuses stamina:

```
speedMultiplier = 1 / (1 + 0.6 * zombiesInContact)
staminaDrain *= (1 + 0.8 * zombiesInContact)
```

One zombie in contact costs a survivor 38% of their speed; three costs 64%, dropping them below zombie pace — at which point they are caught and the swarm table above decides what happens. Pulling free is not a check, it is whether stamina lasts. A fresh survivor breaks away from one; an exhausted one breaks away from nothing.

This is what makes being surrounded legible on screen. The dot does not just start losing rolls, it visibly slows and stops, which is the difference between the viewer seeing a death and seeing a number change.

**Moot:** indoors is counts, not positions, so there is no contact for drag to act on; the contest decides. (Was open: whether drag applies to a sim inside an occupied building.) It probably should, and it would make withdrawing from a bad contest much harder than entering it — which is either good drama or an unfair trap, and only playing it will say which.

## Movement

Zombies move at 1.1 m/tick, below a walking pace. Without exhaustion a survivor in open ground is never caught, and the horde would only be dangerous indoors or when cornered. **Stamina is what makes slow zombies lethal:** they do not outrun anyone, they outlast them.

### Gait

Two fields extend Sim: `gait` (enum) and `stamina` (float, 0–1, the same clamped scalar convention as everything else).

| Gait | Speed | Stamina / tick | Detectability | Noise radius |
| --- | --- | --- | --- | --- |
| `still` | 0 | +0.004 | 0.35 | 0 m |
| `sneak` | 0.7 m | +0.001 | 0.50 | 0 m |
| `walk` | 1.4 m | +0.002 | 1.00 | 0 m |
| `run` | 2.2 m | −0.006 | 1.30 | 8 m |
| `sprint` | 2.9 m | −0.015 | 1.60 | 15 m |

Drain and recovery are deliberately asymmetric: a full sprint lasts about 67 ticks, and recovering from empty while standing still takes 250. Spending stamina is a decision with a long tail.

**Speed scales softly with stamina** rather than cutting off:

```
effectiveSpeed = gaitSpeed * (0.5 + 0.5 * stamina) * ageFactor
```

No cliff — a tiring survivor visibly slows, which reads on screen as a chase being lost. `ageFactor` runs from 1.05 at 20 to 0.75 at 80, which is what makes the displayed age honest rather than cosmetic.

### Detectability

Zombie detection radius is fixed at 18 m, but what it tests against is now per-sim:

```
detected = distance < 18 * sim.detectability
```

where `detectability` is the gait value above, halved again if the sim is inside a building or on an unlit street at night. A sneaking sim is noticed at 9 m; a sprinting one at 29 m. That single multiplier gives sneaking and hiding without a new system, and it is why dormancy matters — quiet movement past a sleeping cluster is genuinely viable.

**Hiding is `still` plus enclosure.** A stationary sim indoors reads at 0.175 detectability, roughly 3 m. Not invisible, but occupiers spilling into a building may miss someone who stopped moving.

### Gait selection

Chosen per tick from panic and `perceivedThreat`, so the mode gradient already defined extends naturally into the body:

| Condition | Gait |
| --- | --- |
| Panic above 0.55 | `sprint`, regardless of stamina |
| Panic 0.40–0.55 | `run` |
| `perceivedThreat` above archetype threshold, panic low | `run` if approaching, `sneak` if avoiding |
| Scavenging through remembered-dangerous streets | `sneak` |
| Default with a destination | `walk` |
| Sheltered, or hiding | `still` |

**Panic forcing sprint is the mechanic's point.** Panicked sims exhaust themselves and are then slow when it matters; calm sims pace. This is where police immunity pays a second dividend — they never burn stamina involuntarily, so a fighting retreat is possible.

### Running zombies

A scenario toggle, set before the run and never changed during it.

| Setting | Zombie speed | Effect |
| --- | --- | --- |
| `shambler` | 1.1 m | Default. Stamina management is the survival skill |
| `runner` | 2.4 m | Faster than a walk, slower than a sprint |

This inverts which strategies work rather than just raising difficulty. Against runners, stamina cannot save anyone — sprinting only buys distance briefly, sneaking is worthless once detected, and shelter is the only viable answer. It should be swept as a separate scenario, not as a parameter within one, because every other default is tuned against shamblers.

**Decided:** no. Runners detect at the same radius. (Was open: whether runners should also detect at a longer radius.) Probably not — fast and blind is more interesting than fast and aware, and keeps sneaking meaningful.

## Systems

Everything here reads entity state and writes back to it. Nothing here touches rendering.

### Perception

What a sim can see right now. Recomputed per tick, never stored.

Perception radius is a property of where the sim is standing, not of the sim:

| Condition | Radius | Note |
| --- | --- | --- |
| Open ground, day | 60 m | Parks, car parks, plazas |
| Standard street, day | 45 m | Baseline |
| Alley, day | 30 m | Short sightlines |
| Lit street, night | 25 m | Street lighting |
| Standard street, night | 15 m | Unlit |
| Open ground, night | 15 m | No cover and no light: the worst place to be |

`timeOfDay` interpolates between the day and night values rather than switching, so dusk is a gradual loss.

Open ground reversing between day and night is the design's cheapest piece of terrain interest: one flag, two opposite meanings, and it makes routing decisions time-dependent without any system knowing about time.

**Zombie detection does not vary.** Fixed at 18 m regardless of light or terrain — they are not using sight in any meaningful sense. The asymmetry is the point: at night the survivors' disadvantage is not that zombies get stronger, it is that people stop seeing them coming.

### Zombie perception

Three channels in strict precedence, evaluated in order, first hit wins. Not a weighted sum — precedence is cheaper and produces clearer behaviour.

| Channel | Range | Grants | Requires |
| --- | --- | --- | --- |
| Sight | 18 m × sim `detectability` | Target lock and tracking | Line of sight |
| Sound | The stimulus radius | A destination point, no lock | Nothing |
| Scent | 20–80 m | Bias only, no movement of its own | Nothing |

Three fields extend Zombie: `targetSeenAt` (tick), `heardPoint` (`{x, y}?`) and `heardAt` (tick).

**Sight requires line of sight.** A wall blocks it, and so does the river but at a bridge (`runtime.ts crossesWater`; the user's call): seeing across the water what could not be reached there, Rangers fired across it now and then and otherwise went back and forth along the bank looking for a way to their target, and the dead did the same for the living. Combined with the indoor `detectability` halving, a sim inside a building is effectively invisible to sight — which is intended, and is why discovery of shelters runs through the other two channels.

The boundary is softened rather than hard: detection probability ramps from 0 to 1 across the outer 20% of effective range. A hard edge makes sims flicker in and out of pursuit at close zoom.

**Sound grants a place, not a person.** A zombie responding to noise moves toward the point and arrives to find nothing there. This is what makes shoot-and-relocate viable, and it is the reason gunfire is survivable at all — if sound granted target lock, firing once would be fatal and the weapon table would be decoration.

Three rules keep sound sane. Intensity below `wakeThreshold` (default 0.2 at the zombie's position) does not wake a dormant zombie at all, which is what makes sneaking past a sleeping cluster work. Overlapping stimuli arbitrate by loudest, never by sum — summing lets three distant noises equal one close gunshot. And a zombie already tracking a target ignores sound entirely, or every shot yanks the horde off whoever it was chasing.

**Scent is emitted by concentrations of the living,** not by individuals:

| Source | Threshold | Radius |
| --- | --- | --- |
| Building | 4+ living inside | `20 + 4 × occupants`, capped at 80 m |
| Outdoor cluster | 6+ sims within 15 m | 20 m |

Scent never wakes anything and never sets a heading. It multiplies the spontaneous wake chance of dormant zombies within range, by up to 3×. Wanderers therefore emerge preferentially near populated buildings, and an awake idle zombie drifts weakly up the gradient.

This is the pressure against group snowballing. A larger shelter is better at everything — more builders, more defenders, more pooled memory — and until now had no cost. Scent makes size the thing that gets it found. It is also a slow leak against perfect noise discipline: a silent, fortified, well-run shelter is still discovered eventually, which is the outcome the wander rate was previously carrying alone, and means that rate can probably come down.

**Tracking ends.** Fixed, and the rule the entire gait system depends on. A target is lost when out of sight for 40 ticks, when beyond twice effective detection range, or when it enters a building the zombie does not. On loss the last known position becomes a sound-style destination, so the zombie converges on where the sim was rather than forgetting instantly. Without a loss condition the first mistake a survivor makes is permanent, and sneaking, hiding and stamina all stop meaning anything.

### Perceived threat

A derived 0–1 scalar, the input to almost every behavioural decision. Distinct from `danger`, which is remembered belief about a street; this is what is visible now.

```
perceivedThreat = clamp( Σ zombieWeight(z) , 0, 1 )

zombieWeight(z) = (1 - d / perceptionRadius) * (z.dormant ? 0.25 : 1.0)
```

Summed over zombies within perception radius, with line of sight required. Three things follow deliberately:

- **Distance matters.** A crowd forty metres off does not read the same as one at arm's length, so a count would be wrong.
- **Dormant zombies weigh a quarter.** Walking past a sleeping cluster is not the same as walking into an alert one, and this is what makes quiet movement viable.
- **It saturates.** Beyond a certain density everything is equally hopeless, and behaviour should not keep escalating.

This is the single most reused quantity in the simulation. Every archetype threshold, shelter-seeking decision and panic rise reads it.

### Memory and belief

**There is one map, shared and objective:** the street graph, its geometry, its connections and its names. Every sim can use all of it, because people know their own city.

What is private is a thin overlay — the memory table, keyed by street id, holding `danger` and `observedAt`. A sim does not have a private copy of the city. It has opinions about parts of it. The map has a few thousand segments; a given sim will have opinions about twenty.

**Writing.** On entering a street, the sim writes its current `perceivedThreat` as that street's `danger`, with the current tick. Observation is the only way the table is written from the world.

**Ageing.** The stored value never decays. Confidence does:

```
confidence = exp( -ln2 * (tick - observedAt) / 1800 )
```

A street remembered as lethal half an hour ago still reads as dangerous, just less certainly. Decaying the value toward zero would turn old bad news into good news, which is the wrong failure.

**Merging.** When two sims come within 4 m, for each street take whichever record is newer. Symmetric, no ownership, no conflict resolution. Rate-limited by `lastMergeTick` so a crowd does not merge every pair every tick.

This is what makes grouping an advantage rather than a preference, and it is why police being panic-immune matters — they keep observing and merging while everyone around them runs blind, so they function as the population's information carriers.

### Hearsay and street danger

**Street danger is written asymmetrically** (`memory.ts settleDanger`, `noteStreet`). Raising a belief is immediate; lowering it is not: a quieter reading — a quiet look on entering the street, or newer hearsay of a quiet street in a merge — moves it `memory.quietLook` (0.5) of the way, never to zero in one pass. Repeated quiet passes clear it; otherwise age does (danger ages rather than decays). Before this, the next sim through a street overwrote "dangerous" with "clear", and that newer clear won every merge: decay by the back door. Things that happened are written where they happened, at a fixed danger rather than the seer's distance from them: a zombie sighted and shouted (`sightedDanger` 0.8, the zombie's street — before, the shouter's distance-weighted threat, so 37% of shouts said "about safe"), a bite seen outdoors or a turning seen (`witnessedDanger` 1, to the bitten and the witnesses), a shelter fallen (`fellDanger` 1, carried away by those expelled). Measured on seed 1 at the defaults, danger entries rose from about 2% of street tables to 5–10%, and live warnings (confidence above 0.25) from 0.5–3 per sim to 2–7. The cautious-sim prior and the table caps were tuned against the sparser tables; re-measure before touching either.

Sweep after the change (8 seeds, defaults): both gates pass; caution z 5.8 → 7.3 (high-caution survival 26.5% → 27.1%, low 23.0% → 22.7%), and among the asocial z 3.7 → 6.2; overall survival unchanged at about 24%; sociality and trust still flat (z 0.3, 1.7).

A figure quoted while investigating this — 99.87% of street entries at danger 0 — was measured under the old default (one zombie, enclosed), on a seed where the outbreak barely spread. It does not hold at the defaults; the before/after figures above supersede it.

**Hearsay arrives about the wrong places** (seeds 1–3 at the defaults, to tick 18,000; a new warning is a street a sim did not believe dangerous until told). Conversation delivered about 170,000 new warnings a run, 70–75% of them to sims indoors (merging on entering a shelter). Of those heard outdoors, the street was a median 450 m from the listener and 570 m from where it was going; 1–2% lay on its planned route, and 1–2% were entered within a half-life. Shouts are the opposite: about 900 a run, a median 45 m away, 26–30% on the route, 29–34% entered within a half-life — but with a median lead of 2–15 ticks, barely time to turn. So sociality's null is not that shared information is worthless (caution among the asocial shows information helps) but that what is shared concerns places the listener is not going: a problem of relevance, not of value. Hence trimming by relevance (distance to position and destination) rather than age, which would keep the few entries that matter.

**Relevance trimming and dropping quiet hearsay** (`memory.ts trimStreets`; `encounters.ts quietFloorOf`). Past its slack a street table keeps a reserve of the 10 gravest warnings it holds wherever they are (danger × confidence: where a shelter fell is worth keeping when not headed there), then the streets nearest the sim, distance from its destination counting double (position is stable; destination changes). And news that a street the listener knew nothing of was quiet is no longer kept, except by the especially cautious, for whom it answers their unknown-street prior. Switches: `features.relevanceTrim`, `features.dropQuietHearsay`. Each swept alone (8 seeds, defaults; z-scores of survival by trait band):

| | caution | caution, asocial | sociality | trust | survival | ms/tick (6,000 ticks, interleaved) |
|---|---|---|---|---|---|---|
| before (danger writes) | 7.3 | 6.2 | 0.3 | 1.7 | ~24% | 7.01 |
| + relevance trimming | 7.5 | 3.0 | 0.3 | 2.7 | ~24% | 6.74 |
| + dropping quiet hearsay | 5.6 | 3.5 | 0.0 | 2.1 | ~25% | 6.41 |

Cheaper by 8.5% together; behaviour within what 8 seeds can tell apart (the asocial-caution figure moves most, and is the noisiest: fewest people). Sociality stays null: hearsay is about the wrong places, as measured above, and trimming discards it rather than making it matter.

**A wider warning** (`encounters.warnRadius` 60 m, the dead still hearing the shout at `shoutNoiseRadius` 30 m — the two were one radius until a sweep of the wider warning also drew the dead from twice as far): survival ~24% → ~26%, caution z 7.3 → 6.5, among the asocial 6.2 → 2.1, sociality 0.3 → 1.6. Warning more people evens survival out, so caution counts for less. Not adopted; the radius stays 30 m. (Widening both together: survival ~23%, caution z 5.4.)

### Pathfinding

A\* over the shared street graph with a per-sim cost function:

```
cost(street) = length + dangerWeight * danger * confidence
```

**Unknown streets cost pure distance,** because an absent memory entry means `danger` is 0. The consequence is deliberate and worth stating: ignorance reads as safety. A sim routes happily through territory it knows nothing about and detours around the one street it personally watched go bad. The best-informed survivors take the longest paths; naive ones walk confidently into the unknown.

**Decided:** both, in a way. For the especially cautious, an unknown street reads as `memory.unknownStreetDanger` and reports drift back toward it (`features.cautiousRouting`). (Was open: the alternative is a small baseline pessimism for unvisited streets, which makes sims hug familiar routes instead. Both are defensible and they look different on screen. Worth running both in a sweep.

Movement runs in two layers. Strategically, A\* returns a sequence of street ids cached in `route`. Tactically, the sim steers along that route in continuous space, avoiding what it can actually see — which is where float coordinates earn themselves.

**Repathing is gated four ways,** because this is the expensive part:

1. Fleeing does not path at all. Only sims with a destination route: scavengers, police falling back, survivors converging on a broadcast. Dozens of agents, not thousands.
2. A merge triggers a repath only if a changed street is on the current route. A list intersection, not a search.
3. `repathCooldown` blocks repathing more than once every 30 ticks.
4. A global `repathQueue` with a cap of 20 sims per tick, drained in id order. A few ticks of stale route is invisible.

Danger seen directly ahead bypasses the queue. A sim walking into a horde it can now see does not wait its turn.

### The especially cautious and unknown streets

Caution had stopped separating survival (z 0.5 and 1.5 in the last two sweeps, and z −0.9 among the asocial, so not sociality standing in for it). Quiet streets were already remembered (every street walked is written with the danger seen there) and passed on in conversation; but an unknown street also read as danger 0 (`memory.unknownStreetDanger` was 0: ignorance reads as safety), and caution only scales believed danger, so with danger news slow there was almost nothing for it to act on. Now, for the especially cautious only (the user's call), an unknown street reads as 0.15 — ramping in from caution 0.66, the top band's edge, to the full value at caution 1 — and a report drifts back toward that prior as it ages instead of toward safe: believed danger = confidence × seen + (1 − confidence) × prior (`pathfinding.ts believedDanger`; routing only). Everyone below 0.66 routes exactly as before. So the cautious keep to streets they or those they talk to know are quiet, paying detours for it, and news of a quiet street is worth something to them; a sceptic, hearing it as older than it is, takes less reassurance from it. Bad news still never turns good.

- **Sweep with the cautious change, the first at 50,400 ticks** (mapSeed 1, runSeeds 1–8, commit 9554f8d; 1,744 s). **Gate 2 passes** (loss 40–95% in 7 of 8: 64–73% in seven; seed 3 smoulders at 15%). **Gate 4 still fails on caution:** 26.4% / 26.9% / 26.7% (z 0.5); among the asocial z 1.1; by trust z 3.6. Named survivors: 38% alive at the end, median 12,031 ticks after naming. Curves keep rising slowly to the end (seeds 2, 5, 8 add 4–8 points of turned after tick 36,000); awake zombies peak at ticks 33,000–37,800 in four seeds. Dead air: none where the outbreak took off.
- **Why caution still does not show — where people are lost** (seed 1, first 20,000 ticks, tracked sims): more than half of bites (219–269 per caution band) and killings (252–268) happen indoors, in shelters; outdoors, the bands fare alike — about 20% of each band bitten outside, about 19% killed outside, the most cautious no better than the boldest. Caution's levers are route cost and migration's margin; neither reaches the shelter, where most die, and outdoors the danger that bites people is the danger nobody yet knew of, so routing on belief, cautious or not, avoids little of it. The routing change is kept (it is principled, and costs nothing for most); making caution matter needs it to act on what a sim sees and on the shelter — the user's decision.

### Panic gating

Panic does not modify routing. It switches between three modes, which makes behaviour legible on screen — a viewer can read a sim's state from how it moves.

| Panic | Mode | Behaviour |
| --- | --- | --- |
| 0 – 0.40 | Informed | Full cost function; routes around remembered danger |
| 0.40 – 0.55 | Direct | Still routes, ignores memory; takes the shortest path regardless of what it knows |
| 0.55 – 1.0 | Flight | No pathfinding. Pure steering away from the threat vector, no destination |

Mild fear making people take the direct route is both plausible and useful: it puts panicking sims onto main streets, where they are visible and where they meet each other.

**Police are immune.** Panic never gates their mode, which is what makes the rest of their profile work — retreating *toward* a defensible position requires still being able to route.

### Stimulus and noise

One event type, used by combat, vehicles, the helicopter and anything else that makes noise.

| Field | Type | Meaning |
| --- | --- | --- |
| `x`, `y` | `float` | Origin |
| `radius` | `float` | Metres; halved when the source is indoors |
| `intensity` | `float` | 0–1 at origin, falls linearly to the radius |
| `createdAt` | `int` | Tick |
| `decay` | `int` | Ticks until removed; default 30 |

Stimuli wake dormant zombies, set their heading, raise sim panic, and feed the audio layer. **Cohesion means a stimulus recruits secondhand** — zombies pulled toward it pull their neighbours — so effective reach is much larger than `radius`. Expect to tune noise radii down once flocking is in.

### Encounters

One handler, run when two sims come within 4 m, doing both transfers in one pass:

1. **Street memory** merges by recency, per street.
2. **Building memory** merges by recency, per building.
3. **Known infected** merges by union.
4. **Panic** averages toward the higher value with a damping factor of 0.3, so calm spreads too, but more slowly than fear.

Kept as separate fields deliberately. Panic is internal state, memory is belief about the world, and conflating them would mean a calm survivor cannot deliver bad news.

## Loops

### Tick order

Fixed. Order decides behaviour, not just performance, and determinism depends on it.

The governing principle is **decide, then apply**. Perception is computed once from start-of-tick positions into a read-only snapshot; every agent then decides against the same world. Decisions write intent, never position. Movement is integrated in a single later pass. Without this, an agent with a low id would react to a world that agents with high ids had already changed, and behaviour would depend on array order.

| # | Stage | Notes |
| --- | --- | --- |
| 1 | Advance `tick`, update `timeOfDay` | — |
| 2 | Rebuild spatial hash | From final positions of the previous tick |
| 3 | Age and expire stimuli | Before anything reads them |
| 4 | Compute perception and `perceivedThreat` | Read-only snapshot; the shared basis for all decisions |
| 5 | Zombie decisions | Dormancy, waking, targeting, flocking and alignment vectors |
| 6 | Sim decisions | Panic update, mode gating, role and destination, drain `repathQueue` |
| 7 | Combat resolution | Sims in id order, then zombies in id order |
| 8 | Infection countdowns and conversions | After combat, so a sim due to turn still gets a final action |
| 9 | Movement integration | Apply velocities; sims then zombies |
| 10 | Building processes | Arrivals and exits, breach rolls, contests inside occupations, occupier spill, expulsion, then the shelter economy's building side: alerting, fortification and material consumption, resident scavengers, garrisons and the cascade |
| 11 | Encounters | Proximity merges, from final positions |
| 12 | Reconcile counters and assert the invariant | Every tick, in the headless harness. Promotion checks its trigger straight after, against the reconciled counters |
| 13 | Emit events | Feeds ticker and audio; no simulation state written |

Combat sits before movement so contact is judged on the same positions perception used — a sim cannot be bitten by a zombie that has not yet moved into range this tick.

**Staggering.** Expensive evaluations run on an id offset rather than every tick: armed sims pick targets when `id % 5 === tick % 5`, occupier spill checks every 10 ticks, role reassignment every 30. This is what keeps 8× affordable.

### The shelter economy

The only cycle in the design. Everything else pushes one way; this closes a circle, and the safe position generates its own threat.

**Shelter selection reads from memory, not from the map.** A sim considers only buildings it has entered, passed close to, been told about, or can currently see. Scanning every building would make shelter choice omniscient in a design that is local everywhere else, and it is why sims new to a district make worse choices than residents.

```
desirability =
    2.0 * integrity
  + 1.5 * fortification
  + 1.2 * (1 - danger * confidence)      // street it fronts, from memory
  + 0.8 * groupTerm(believedOccupants)
  + 0.6 * materialsBelief
  - 1.0 * (distance / 1000)
```

`groupTerm` peaks around 8 occupants and declines after. Safety in numbers up to a point, then crowding — and this is the anti-convergence term. Without it every survivor routes to the same best-known building, and since scent scales with occupancy, desirability and detectability would rise together into a single megashelter that gets found and erased.

Archetype sets the weights, never the logic: preppers lean on integrity and street quiet, police on integrity and defensible tags, civilians almost entirely on distance, loners invert `groupTerm` entirely.

**Panic collapses the evaluation.** Above `panicRoutingCutoff` a sim is not choosing a shelter, it is entering the nearest door it can see. Consistent with panic switching modes elsewhere, and it produces the classic bad decision: running into the building the horde came out of.

**Believed occupancy is a belief.** The fill looks identical whether a building holds forty residents or forty zombies, so shelter choice inherits the occupation gamble rather than routing around it. A remembered-safe building may have fallen an hour ago.

**Commit on choice.** Re-evaluating every tick makes sims oscillate between two similar buildings. Re-evaluation fires only on breach, the shelter falling, fortification decaying past a floor, or a migration trigger.

### Fortification stages

Fortification was one number dividing the breach odds, and integrity multiplied them: one zombie at the door of a bare house got in within about 170 ticks, and a besieging zombie (600 ticks at the door) got into an unfortified house 97.5% of the time and a fully fortified one 70%. Nothing made a building safe from one zombie. Now there are stages (`buildings.stages`), derived, never stored (`common.ts stageOf`):

- **Open:** the people inside do not know of the outbreak, nobody is inside, or the door has been opened in the last `barricadeTicks` (60). One zombie may try.
- **Barricaded:** they know, someone is inside, and nobody has come in or gone out for 60 ticks: furniture against the door. Time only, no materials. Undone whenever the door opens — anyone entering or leaving, a resident released or driven out (`Building.doorOpenedAt`) — so a scavenger coming home, or one leading the dead home, leaves the door open behind it. It takes two zombies at the door to try.
- **Reinforced:** fortification at least 0.3. Takes five. This is where materials and decay belong, as before.
- **Fortified:** fortification at least 0.8. Takes fifteen — the crowd a cascade means.

Integrity no longer scales the odds; it caps the stage (the user's suggestion): reinforcible from 0.4, fortifiable from 0.7. Houses, warehouses, workshops, hardware stores, gun shops and police stations can be fortified; offices and hospitals stop at reinforced; supermarkets and schools, glass-fronted, at barricaded. Within a stage the odds per roll are `breach.base` / (1 + 2 × fortification), with `base` 0.06 so a bare house keeps its old odds. Leaving through a barricade takes 10 ticks more. A garrison now forms on a barricaded door (it was fortification 0.05).

Drawn at near zoom: a bar across each door step when barricaded; a heavier outline as well when reinforced; an inner outline too when fortified.

Seed 1, 9,000 ticks: breaches 686 → 363, dead 929 → 633, turned 1,078 → 702. At tick 3,000, of 2,068 peopled buildings 1,838 were open (most never learned of the outbreak), 38 barricaded, 171 reinforced, 21 fortified; by 9,000, 201 barricaded, 135 reinforced, 2 fortified, as materials ran out.

- **Sweep** (mapSeed 1, runSeeds 1–8): **gate 2 fails**, as expected. Six runs end at 31–36% turned and 22–27% dead, below the 40–90% band; two smoulder out (seed 3 resolved at tick 2,962, seed 8 at 12,435, both at 1–2%). Gate 4 passes: shelters form, fall and re-form in all eight, no stasis, survival by caution band 37.9% / 40.2% / 41.4% (z 4.5); named survivors live a median 18,000 ticks after naming, 54% alive at the end. **Was open:** retune — the levers are the turn delay, the breach base, and the stage thresholds. **Since:** retuned; gate 2 passes 8 of 8 in every sweep since nerve and rising.
- **Retune 1: turn delay 300–1,200 ticks (was 20–40), reinforced takes 4 (was 5)** (runSeeds 1–8): gate 2 still fails, and further: six runs at 21–31% turned, 20–26% dead; two smoulder out at 2–3%. The longer delay slows the epidemic more than admission speeds it — a conversion now comes minutes after the bite, not seconds, so each generation of the outbreak takes ten times as long. Gate 4 passes (survival by caution 43.1% / 44.2% / 45.2%, z 2.6).
- **The gate measures loss, not infection** (decided after the exploration below): gate 2 is now total human loss — dead plus turned — 40–95% of the population (`scripts/sweep.ts`). With feeding, most of the swarmed are eaten rather than turned, and a city where everyone dies and few turn is still falling; the turned share alone capped below the band once feeding and stages were in, and tuning the turn delay to it would have tuned a side effect. The long delay stays: it is what makes the unwitnessed bite dangerous. On the retune-1 sweep, loss was 41–57% in six of eight runs (two smouldered), so it would pass as tuned; not yet re-swept.
- **Bites add up** (`Sim.bites`, `infection.rebiteFactor` 0.5): each bite after the first halves the time left to turning — someone who got away from a crowd is further gone — and the inspector shows the count. It also plugs part of a leak: an infected sim lingering near the dead was more likely to be eaten (counted dead) before it turned.
- **Exploring the breach base on top of retune 1** (runSeeds 1–4, not adopted): 0.15 gives 30–32% turned, 0.25 gives 31–38%; gate 2 fails at both, gate 4 passes. The crowd minimums now decide most break-ins, so the per-roll odds have little left to move: raising them two- to fourfold buys only a few points.

### Strangers at the door

Since most survivors are lost indoors, caution now acts at the door (`buildings.ts refusedAsStranger`, `shelter.strangerVeto` 0.5, `strangerVetoFrom` 0.66). In a building that knows of the outbreak, each especially cautious person sheltering inside refuses a stranger at 0.5, ramping in from caution 0.66 to the full chance at caution 1; with several of them inside, a stranger seldom gets in. Not a stranger: someone coming home, one of the congregation at its church, an officer at its station. No groups were needed: admission was already a veto by whoever is inside (anyone who knows the newcomer is bitten keeps them out), and a cautious shelter is simply one with cautious people in it, changing as they come and go. Nobody reads the stranger's infection — a stranger is refused for being one, which is the point: a cautious house keeps out the hidden bite along with everyone else, and the people it turns away take their chances outside. Ticker line "A survivor was turned away from …" (salience 12). On one 20,000-tick probe (seed 1, which smouldered under this change's random sequence) strangers were refused 2,961 times; whether that saves or costs lives is for the sweep.

- **Sweep with the stranger veto** (mapSeed 1, runSeeds 1–8, 50,400 ticks, commit 3b5f3bd). **Both gates pass**, the first time since fortification stages. Gate 2: loss 40–95% in 6 of 8 (59–64% in six; seeds 1 and 5 smoulder at 2% and 12%, seed 1 resolving at tick 4,168). Gate 4: shelters form, fall and re-form in all eight, no stasis, and survival by caution band 38.5% / 38.7% / 40.8% (z 3.0) — the most cautious band now does better, as the veto's design intended. Among the asocial z 1.8 (39.0% / 38.1% / 41.3%); by trust z 1.4 (was 3.6–4.2: caution at the door has taken part of trust's place); by sociality z 0.1. Survival overall rose (about 39% of tracked sims alive at the end, was about 27%); named survivors: 42% alive at the end, a median 22,309 ticks lived after naming (was 12,031). Strangers were refused 3,000–9,000 times a run; the ticker's salience absorbs it (median 8–10 lines per 10 minutes, as before). Two smouldering runs of eight is the opening's problem, still to be reworked then. **Since:** with nerve and rising, every run of the last sweeps takes off.

### Migration

A sim that learns of a better shelter through an encounter may move to it. This is information trading's third payoff, after routing and panic, and it is what lets survivors consolidate rather than scattering into singletons.

Three brakes, all necessary:

| Brake | Rule | Why |
| --- | --- | --- |
| Hysteresis | Requires a desirability delta above 0.25 | Otherwise sims churn between near-equivalents |
| Cooldown | No migration within 600 ticks of the last | Bounds thrash and repath load |
| Exit cost | Leaving costs `fortification * 40` ticks | Already in the design; work done is work lost |

The trip is the real cost. Migration means crossing streets the sim believes are clear on possibly stale information, and arriving at a building whose occupancy is a guess. A group that consolidates is stronger, more findable by scent, and spent a dangerous journey getting there.

**Fortification damps migration rather than forbidding it.** The hysteresis threshold is not a constant:

```
requiredDelta = 0.25 + 0.5 * fortification + 0.3 * caution
```

A bare shelter leaks easily. A well-fortified one holds almost everyone, but never quite everyone — which is the realistic outcome and the more interesting one. Security should make leaving unattractive, not impossible.

**Splitters then emerge rather than being scripted.** Because `caution` is per-sim and orthogonal to archetype, the part of a group that leaves is always its least cautious tail. Groups shed their riskiest members first, and those are the ones who die on the road — or who arrive somewhere better and, through the next encounter, pull others after them.

This also gives the caution experiment a second axis. Survival by caution band now measures not just route choice but whether staying put beats chasing rumours, which are different questions with possibly opposite answers.

**Roles** are assigned individually, never negotiated. Every 30 ticks a sheltered sim re-evaluates and takes the role its own situation argues for. Multiple sims contributing to one fortification value is addition and is fine; sims deciding together who goes out is a large system and is not built. The aggregate reads as a division of labour with nothing dividing it.

| Role | Taken when | Effect |
| --- | --- | --- |
| `builder` | Materials available, fortification below 1 | Raises `fortification` by 0.002/tick, consumes 1 material per 50 ticks |
| `scavenger` | Materials at 0 and this sim is least useful here | Leaves for the nearest known materials tag |
| `dispatcher` | Armed, and `perceivedThreat` outside is under `engageThreshold` | Steps out to clear isolated zombies |

**The loop.** Builders raise fortification and consume materials. Materials hit zero and fortification stalls, then decays. A scavenger leaves for a hardware store, workshop or warehouse. The trip is the danger: zombies track, so a returning survivor may bring the horde to the door.

**The cascade** is the payoff and needs its own threshold. Noise at the shelter draws zombies; cohesion pulls their neighbours secondhand. Above `cascadeDensity` — default 15 zombies within 30 m — the crowd becomes self-sustaining, attracted by each other rather than by the original sound. Below it, a returning survivor is a near miss. Crossing it deserves a distinct ticker line and an automatic drop to 1×.

**Barricades cut both ways.** A heavily fortified building is slow to leave: exit takes `fortification * 40` ticks. If a horde settles outside, the occupants are trapped by their own work. Without this, hunkering down dominates.

**The occupation contest** is specified under Building, since it is building state. It is the other way a shelter changes hands.

### Infection lifecycle

| Stage | Rule |
| --- | --- |
| Bite | A zombie attack succeeds, or a melee miss rolls infection |
| Flagging | `infected` set, `turnsAt` = tick + 300–1,200 (seeded; was 20–40) |
| Witness | Every other sim with the bite within perception radius and line of sight adds the bitten sim's id to its own `knownInfected` |
| Symptomatic | Sim behaves normally, counted under `turned.symptomatic`, still shown as living |
| Conversion | At `turnsAt`, the sim is removed and a Zombie spawned with `wasSim` set |

**The asymmetry is the whole mechanic.** The infected sim knows. Others know only if they saw it. An unwitnessed bite means a sim can be admitted to a shelter and turn inside a fortified building the occupants cannot quickly leave — the best scene the design can produce, and it costs one boolean.

Knowledge is local, like memory: `knownInfected` spreads only by encounter merge, so suspicion travels by word of mouth and can arrive too late. Shelter admission refuses a sim if anyone currently inside has it in their `knownInfected`. Nothing anywhere may read another sim's infection state directly. A sim bitten in an empty street is a danger to everyone.

**Decided for milestone 2:** an infected sim has no special behaviour and continues its current intent. The drama lives in admission and in who knows. Archetype-specific responses can come later, once it has been watched. **Revised:** a bitten sim now chooses, once, to conceal or to isolate (see "Survivor behaviour revisions").

### Promotion

Two stages, so the roster is not judged on thin histories:

1. **Provisional** — when `unturned.outdoors + unturned.indoors` falls below 0.5 of starting population (fallback tick 10,000), the 12 most unusual living sims are named and added to the roster. The viewer has someone to follow through the middle of the run.
2. **Re-score** — when the living fall below 0.3 (fallback tick 18,000), scoring runs again over the survivors, and the most unusual of the unnamed are named until 12 of the named are alive again. The same top-up then repeats every 1,800 ticks as the pool thins, so the roster always carries a current cast of living people as well as the record of the lost. (Measured on two runs: from the re-score to the end, 8–12 of the named are alive at any time, and 40–44 names accumulate in all; the roster stops adding at 96.) Between the provisional names dying off and the 30% threshold, the living cast can run out: seed 2 had none alive from about tick 13,000 to 15,800. **Decided (the user's): accepted.** A roster mostly struck through is a memorial, not a failure. Named survivors live about as long as anyone, so an empty stretch means the city held no notable survivors, which is true. If such gaps prove common rather than a seed-2 oddity, the fix is to let the re-score add names more readily, not to delay the first stage.

**Merge rule: the roster is append-only.** A name is never taken away — un-naming someone the viewer has been following would break the one promise the roster makes. Provisional names whose histories have since been overtaken stay on the roster; they simply stop being the most remarkable, and the new entries sit beside them. Promoted survivors who die or turn stay on it as a record: the roster lists the living at full weight and collapses the lost into a count whose names show on hover. Each sim records when it was named (`namedAt`).

At 6,000 population the stages fire around tick 7,000 and 12,000–13,000.

Scoring rewards unusual histories rather than high ones, so the interesting survivors self-select:

```
score = Σ |counter - populationMean| / populationStdDev
```

Over `ticksSurvived`, `conversionsWitnessed`, `ticksAlone`, `nearMisses`, `kills`, `materialsDelivered` and caution. Ties go to the lower id.

**Revised after measuring it.** Every sweep now logs each promoted survivor with what made them stand out, their backstory and their fate, and records every stage's whole candidate pool, so scoring rules can be replayed offline against the same runs (`scripts/roster-eval.ts`; names never change behaviour). Over 20 runs:

- Scoring did not converge on survival time — `ticksSurvived` led no one's score. `streetsVisited` did duplicate it (r = 0.92 with time on record), so it is no longer scored.
- The counters that led were kills, near misses and conversions witnessed: heavy-tailed, so one outlier swamped the sum, and markers of being in danger right now. The provisionally named then died sooner than the pool they came from (median 1,432 ticks left against 1,886; 60% gone within 1,800 ticks against 49%).
- No rule makes the provisional roster durable: at around tick 7,600 the scored pool is the tracked sims — those released, expelled or out scavenging — and half of any of them are gone within half an hour. The final stage fares better (median 5,180 ticks left in the pool, 28% alive at the end). **Decided:** accept a roster that is mostly a record (see the re-score above). (Was open: whether to change when the provisional stage fires.)
- Now: the counters that grow with exposure are scored per hour on record (floored at half an hour), each counter's contribution is capped at 3 standard deviations, and someone already bitten is not newly named (promotion may see a bite; the people in the run may not). Named survivors who are bitten later stay on the roster as living until they turn, as designed. Replayed, the provisionally named live as long as the pool (median 2,022 ticks), 8% see the end (pool 5%), and they stand out for a wider spread of reasons (near misses 30%, conversions witnessed 22%, kills 17%, time alone 16%, time on record 13%). The newly promoted are given a name from a wordlist (first name and surname, unique, drawn from the run's PRNG), added to the roster, and made ticker-eligible.

The backstory is composed at promotion from fields already held — profession, age, caution band, and whichever counters scored highest. "Nurse, 54, cautious; sheltered in the same building since tick 900, witnessed 14 conversions" falls straight out of state and is true rather than decorative. The history is recorded from tick zero; only the name arrives late.

### The stalemate controller

If no conversion occurs for 600 ticks, raise the wander rate, promoting dormant zombies to wandering a fraction at a time until movement resumes. A scavenger stepping out then risks meeting one, which is a slow leak rather than a stalemate.

**Off during sweeps.** A settled map is a true finding about the parameters, and a simulation that silently corrects for bad tuning hides exactly the result the sweep was run to get. On for viewing, off for measuring.

## Scenario setup

### Starting street population

**Not everyone starts indoors.** A fraction of the population spawns as agents on the street at tick zero, generated from time of day and street type. This supersedes the phase diagram in the design notes, whose opening stage holds the entire population as counts — that version produces a dead grid at tick zero and a city that only comes alive by panicking.

| Start time | Outdoors | Character |
| --- | --- | --- |
| 03:00 | 2% | Near-empty; night-shift and loners |
| 09:00 | 12% | Commuters, delivery drivers, main streets busy |
| 13:00 | 15% | Peak; spread across all street types |
| 19:00 | 10% | Thinning, residential-weighted |

Distribution is weighted by street type — main streets dense, alleys sparse — and by district. This makes the start-time setting visible in the first frame rather than only in building occupancy.

**Street population does not bootstrap the outbreak, it feeds it.** A lone zombie is no threat to anyone outdoors who can see it at 45 m and outrun it at twice its pace. What a street population provides is somewhere for a horde to spill *into* once one exists: panic transmits, sims sprint and exhaust, and the cascade has fuel. Without it, a horde emerging from its first building has to find the next one with nothing in between.

### Outbreak origin

**Default: enclosed, high-occupancy, before release.** Patient zero spawns inside a building tagged hospital, office or school with 30+ occupants, or the fullest such building if none reaches 30. Starting occupancy is weighted steeply by tag (a hospital holds roughly 75 times a house) so that at ~2,000 people across ~1,000 buildings the high-occupancy buildings exist at every start time. Sight cannot pass walls, occupants cannot see 45 m or outrun anything, and the breach pipeline does the bootstrapping that a single zombie in the open cannot.

| Setting | Effect |
| --- | --- |
| `enclosed` (default) | One zombie inside a high-occupancy building. Slow visible bloom with a clear front |
| `street` | One zombie outdoors. Expected to fizzle; kept as a control for the sweep |
| `multiple` | 3–6 simultaneous enclosed sources. A city already lost; a story about survival rather than spread |

**Breach resolution ratios are the highest-leverage unknown in the model.** How a building's occupant count splits into zombies, dead and expelled survivors sets the gain on the whole outbreak. At 5 zombies from a 40-occupant building it fizzles; at 35 it explodes. Starting point: 45% turn, 20% die, 35% expelled, resolved at 2 per tick.

### Scenario settings

In front of the viewer, not in the config file: population, start time, outbreak origin, archetype mix, zombie gait (`shambler` or `runner`), power on or off, seed.

**Built as the setup screen** (`src/ui/setup.ts`), at the user's request, replacing the single patient zero: survivors (2,000–10,000 in steps of 500), initial zombies (1–200; `Scenario.initialZombies`), where they start (all in one high-occupancy building; scattered, one each in as many buildings weighted by residents; or out on the streets — `Scenario.origin` enclosed / scattered / street, `multiple` renamed), start hour, shamblers or runners, power, and the city and run seeds (each with a random roll the page makes; the simulation only ever sees the number). Archetype mix and the tuning stay off it. Every setting lives in the page address, so a run is reproducible from its address and can be shared; without `start` in the address the page shows the panel prefilled from it, and Start reloads with every setting and `start=1`. A "new run…" button returns to the panel with the current settings. The initial zombies are taken from the population (residents turned, or people outdoors turned), so the invariant holds. The ranges are `config.setup`. The sweep takes the same settings (`--scenario initialZombies=20 --scenario origin=scattered`); the gates are judged at the defaults.

**Default: 10 initial zombies, scattered** (8-seed sweeps, map seed 1). Scattered 10: both gates pass, loss in range 8/8, caution z 5.8, survival about 24%. Scattered 25: both pass, caution z 6.1, survival about 22%, the awake peak earlier and higher. Enclosed 10: gate 2 fails (loss in range 5/8, one run resolved before tick 3,000) and caution z 0.1 — one building still fizzles as often as not. Scattered 10 is the gentlest that reliably takes hold.

### Run length 50,400

At the user's request, the run is now 50,400 ticks (was 36,000): 14 simulated hours, seven whole day/night cycles, ending at the hour it began. The sweep after the fourth round showed runs unfinished at 36,000 — awake zombies peaking at ticks 17,400–34,800 and 250–350 dormant at the end where the outbreak took off — and the late rise of dormant hordes needed room. (48,000, ending at night, was tried first; whole days were kept, and a night ending left for later.) Nothing but the stopping point reads the run length (viewer, harness); the roster's stages, the release and the day all run on their own ticks. Sweeps run about 40% longer. The loss gate is measured at the end, so it reads higher than at 36,000 for the same run; earlier sweeps in this document are at 36,000.

## Organised responses

The city answering for itself: police from the start, then ambulances, reservists and SWAT. Each is a few named mechanisms, not a command structure.

### Police: first responders and 911

- **911 and first responders** (`systems/services/dispatch.ts`, `config.dispatch`). Each police station with at least four residents starts with three of them as first responders: tracked police, garrisoned there (`Sim.station`), as opposed to patrol officers out on the streets (30 on map 1). Someone who gets indoors within 60 ticks of seeing a zombie calls it in (`Building.callAt`). Every 10 ticks each waiting call goes to the nearest station within 1 km with responders inside, armed and free, which sends two to the caller's door. Within 50 m of it they are on the scene: the call is answered and they go back. On a call they engage up to threat 0.6, not their usual 0.3; above it they fall back and the call is given up. A call lapses after 600 ticks. Seed 1, 9,000 ticks: 98 officers dispatched, 28 reached the scene, 69 turned back from a horde, none died on the way. The telephone is the one piece of knowledge that travels further than a shout, and it carries only where the trouble is.
- **Officers act as a unit.** Deciding alone, the officer in front fell back while those behind, not yet seeing what it saw, walked on past it. Now police within 25 m of each other with something to shoot (`config.police`) engage and fall back on the danger the most exposed of them sees (the perception snapshot, so all decide on the same numbers in the same tick), share the higher threshold if any of them is on a call, and stand longer for numbers: each officer beyond the first raises the threshold by a quarter, up to 0.8. Officers sent to the same call keep together: the one ahead waits while it is more than 10 m nearer the call than its partner, or its partner is still leaving the station. Officer fall-backs with another officer within 25 m not falling back, seed 1, 9,000 ticks: 15 of 174 → 8 of 169 (most of the rest have no ammunition and are in no unit).
- **Police are cops.** The archetype is drawn from the scenario mix whatever the profession (a bias, as decided in milestone 2), so police included receptionists, cleaners and tourists, and age was uniform 16–85. Police now always have a cop's profession (`spawn.policeProfessions`: patrol officer, detective) and a cop's age, and every cop is police; paramedics, firefighters and security guards no longer lean police (they would carry pistols). Ages come from the profession (`spawn.professionAge`: retirees 65–85, students 16–25, patrol officers 22–58...), working age 18–67 otherwise. There are 44 police on map 1, 30 of them first responders.
- **Police run toward gunfire.** Officers outdoors with something to shoot, hearing a shot more than 15 m off (not their own nor their neighbour's), drop their path and run for the sound, re-planning at once, unless already on their way to trouble — re-aiming at every louder shot re-planned every tick and halved the simulation's speed. It overrides a fall-back while their unit sees less than it would stand on a call. Police responding to anything — a call, shots, trouble — stand like officers on a call (0.6), and so does any unit with one of them in it. Officers who fell back one by one used to scatter to their own shelters and re-emerge piecemeal; now they converge where the shooting is. Seed 1, 9,000 ticks: mean officers within 25 m of one firing 1.17 → 1.32, firing alone 84% → 78%, police kills 163 → 177, police alive at the end 30 → 27.

### Reservists and squads

The only mechanism that makes an armed group mid-run (`systems/services/squads.ts`). Police are placed at tick zero and spent; reservists are the city organising itself after collapse. This builds the squads the design notes deferred to v2, keeping what made them cheap: no negotiation. The one joining rule is forming at a depot; members leave only by dying; succession is fixed (the lowest surviving id); squads never meet squads.

- **Reservists** (archetype `reservist`, `config.reservists`): anonymous residents until the order — nobody is a reservist before it. They were first placed from the residents at setup and tracked from the start, which made them 12% of everyone tracked at tick zero against 2% of the city: 56 pistols on the street, as many as the police, an armed population nobody designed, with outsized weight in the first hour. Then drawn like any archetype at instantiation (2%): seeds 1 and 3 to tick 24,000 instantiated 32–44, 2–3 ever waited armed at a depot, and no squad formed — too few and too scattered (as when drawn at 1.5% before the order existed).
- **Armouries.** Two of the map's `depot` buildings (about 60 per map, a flavour tag), the one nearest the middle and then the farthest from it, each holding 12 rifles (`Building.weaponStock`). Two, not more: with three or four the same ten or so arrivals split across depots that rarely gather four (three seeds each: two armouries formed 2 squads every time; three, 0–2; four, 0–2).
- **The order and the muster** (`squads.ts callUp`, `muster`; the user's design): the reserve is activated once `reservists.callUpCalls` (300) 911 calls have come in (`World.callsTaken`, `World.calledUpAt`, `reservistsCalledUp` — a ticker line that drops playback to 1×): what the authorities know, not the outbreak itself. Reservists at their strength could not deal with a city already lost, and a call-up from the first bite put the outbreak down before it had a shape. At the order, `reservists.share` (2%) of the residents **still in buildings the living hold** step out as tracked reservists — a district already gone produces none, so the order depends on how bad things already are — weighted toward buildings near an armoury (`exp(−d / depotScale)`, 1,500 m, normalised so the share overall is unchanged): the lever for how many arrive, without changing what the journey costs. A tenth (`pistolShare` 0.1) carry a pistol of their own (12 rounds). Each makes for its depot (the armoury nearest home) at once. The journey stays lethal: not a guaranteed delivery of squads. Measured (seeds 1 and 3, to tick 18,000): ordered at ticks 5,016 and 2,155; 65 and 75 mustered; 6 squads formed each (the rifles run out at 24); by tick 3,600 on seed 3, 19 of 75 had died; by tick 18,000, 15 and 55 dead, 24 and 16 turned.
- **No local call-up any more.** A bite or a turning seen, or a shelter falling within sight, used to call a reservist up; with the muster they are not needed, and they are gone (`witnessFall` removed). Called up (`muster` mobilised), a reservist makes for its depot, never stopping to shelter — panicked, it gets clear of the danger first, then goes on.
- **At the depot** it draws a rifle while any are left (`waiting`), or stands down and shelters there. Not a stranger at its own depot.
- **The service rifle** (`combat.ranged.rifle`): 40 m, 0.6 per round, 8-tick cooldown, noise 220 m — the loudest weapon. Found only in armouries; 20 rounds each.
- **A squad** is no object: each member carries `squadLeader` (its leader's id, its own for the leader) and `squadSlot`. Four waiting at one depot form one, the lowest id leading, and wait inside for a target. Later arrivals wait for the next four (reinforcing a squad in the field is not built).
- **Formation** (`squadPass`, before decisions): file while travelling — slots back along the leader's trail, a point each 3 m; diamond while any member has a zombie within 0.8 of its weapon's range, held 30 ticks after — slots 3 m out ahead, to either side and behind, turned toward the danger the leader sees. File to diamond is a ticker line (`squadEngaged`).
- **Only the leader routes**; followers steer for their slots. A follower more than 8 m from its slot for 20 ticks makes straight for the leader for 30 ticks or until within 4 m: the same hold-and-release that stopped fleeing sims swinging back and forth. The leader waits while a follower lags more than 12 m.
- **Targets** (`squadTarget`, `claimCheckpoint`; the user's redesign, replacing 911 calls and gunfire): once the checkpoints are ordered ("Checkpoints"), the leader claims the nearest checkpoint no other reservist squad has — held by traffic police, unset, or fallen — for the whole squad (`Sim.checkpoint`). It takes one of its armoury's HMMWVs (`reservists.hmmwvs`, 2 per armoury, parked at setup, kind `hmmwv`: no siren, and nobody else takes one while a reservist of that armoury lives), drives there as SWAT does in its van, and holds the checkpoint as the traffic police do, turning back anyone on foot making for that exit. It counts toward the checkpoint's unit: a checkpoint falls only with none of the police or the reservists at it, and a fallen one is set again when reservists reach it (`checkpointSet`, by reservists). With every checkpoint claimed, a squad waits at its armoury until one is free (a squad below two dissolves and gives its checkpoint up; a member run dry leaves it). Drawn as a HMMWV in the reservists' green.
- **Engagement** is the first group decision in the design, and has one decision point: at an occupied door, the members' capacity summed against the occupiers (`squads.contestRatio` 1), the leader's call, which each member then shares (`buildings.ts acceptable`). They go in together and contest it; cleared, the call is answered and they come out.
- **Dissolution.** Below two, the last stands down (`squadDissolved`), keeping its weapon. Combat, stamina, infection and panic are everyone's, unchanged.
- **Drawn** pale green (anyone with a rifle), a triangle like any firearm; at near zoom a thin line joins each follower to its leader. The inspector says where a reservist stands in the call-up.
- **Measured** (seeds 1–3, to tick 24,000): 42–45 called up, 10 armed at a depot, 2 squads formed, 5–10 engagements, both squads dissolved. Off with `features.reservists`.

### SWAT

The same squad machinery as reservists, with the opposite origin: reservists are the city improvising — scattered, called up by local collapse, arriving on foot, mobilising unevenly; SWAT is the institution responding — equipped, together, sent deliberately (`squads.ts placeSwat, swatTarget, swatVan`; `config.swat`). Not civilians making for a depot: that would duplicate the reservist under another name.

- **Roster.** A squad of four police at each of three stations, spread across the city like the armouries (nearest the middle, then farthest from those chosen), taken from the station's residents, armed with the SMG and 60 rounds, a van at the kerb (`Car.kind` van, `Car.home` its station). Finite: three squads a run, not one per station (about 27) — once spent, that station answers nothing further, as its first responders drain on calls.
- **Trigger: the officer's radio** (rarer than a 911 call, which SWAT never answers; dispatch passes squad members over). A police officer on a call — sent to one, or responding to shots or trouble — who sees more zombies than its unit's summed capacity, and at least 4, radios for SWAT with what it counted, where and when (`World.radios`, `policeRadio`; at most once each 600 ticks; a radio still open within 30 m is brought up to date instead). A SWAT squad takes the nearest open radio within 1,500 m whose count its own summed capacity can take on — sized by the report, not by what is there now; if it has grown by the time they arrive, that is acting on stale information. It is caused rather than ambient (a specific officer decided), and self-limiting: it needs living officers on calls, who thin as the run goes on. (The first trigger, a shelter falling or a horde massing within 1,500 m, measured the world rather than an event, and fired within 80 ticks; reservists keep the shelter-falling trigger.) Radios nobody takes lapse after 1,800 ticks.
- **The van**, the first thing with a reason to use the car system beyond flavour. From the station, with its van there and the target beyond `swat.vanBeyond` (250 m: radios mostly come from near the station whose officers took the call): the leader walks to it, waits until every member is within 8 m, and all four board at once (`cars.ts boardSquad`; a radio's point is moved onto the nearest street, where a van can pull up). It drives like any car — the same route-finding, jams, engine noise drawing the dead, break-ins — and at the door the squad gets out formed, on foot. One way: the van is transport, not a base; where it stops it stays, parked, for anyone to take (on seed 1 a survivor drove off in one). A van jammed or broken into puts the squad out wherever it is: stay in the box, or out among them. Drawn longer than a car and police blue at mid zoom too; moving, a light bar flashes red and blue.
- **Measured with the radio** (seeds 1–3, to tick 18,000): 11–22 radios a run; first deployment at ticks 111–363 (officers reach calls fast with ten zombies scattered); 38–62 zombies destroyed by SWAT; 0, 1 and 6 of 12 alive at the end. Off with `features.swat`.

### Police cars

First responders drive (`dispatch.ts rideToCall`, `config.police.carNear/carBeyond/carGather`). Each station with first responders has a police car at the kerb (`Car.kind` cruiser). Officers sent to a call beyond 250 m, with their car within 40 m of the station door, go to it, wait until all those sent are within 10 m, and drive together, the lowest id at the wheel (`cars.ts boardSquad`). They get out by the caller's door still on the call (alighting leaves an officer's call alone), and answer it as before. One way, like the SWAT van: they walk back, and the car stays where it stopped, for anyone to take; a station whose car is out sends its next officers on foot. Drawn a car's size in police blue, at mid zoom too, with a red and blue light bar while moving. Measured on seed 1: 9 police cars, 9 trips in the first 6,000 ticks.

### Service yards

Police stations and hospitals get a yard where it fits (`map.yard`, `Lot.home`): open ground 30 × 18 m with a driveway and two double rows of bays, drawn like the mall's grounds. A station or hospital laid along a frontage gets one beside it on the same frontage; a whole-block one gives up the far end of its own footprint, if at least 25 m of building is left. About half of stations get one (11 of 21 on map 1, 20 of 38 on map 3), and a few hospitals (1–3 a map: most are too big to share their block). Civilian cars never park in a yard; its bays are for its own vehicles, which park there first and at the kerb only without one (`cars.ts parkVan`).

With a yard, a station has `yards.policeCrews` (2) police cars, each with `dispatch.perCall` (2) first responders, and a hospital `yards.hospitalCrews` (3) ambulances with their crews; without, one at the kerb as before. Crews are taken from the building's residents, or with none left from the fullest building in its district (`spawn.ts takeStaff`; indoors either way, so the counters do not move) — at nine in the morning a small station holds one or two people. Finite either way: a yard empties over a run. Map 1: 26 police cars and 59 officers (about 24 before yards), 7 ambulances and 14 EMTs (4 and 8). With three crews a yard station had 81 officers; two keeps the force nearer what it was.

### EMTs

A vector dressed as a rescue (`systems/services/emt.ts`, `config.emt`). A bitten sim calls for help; an ambulance comes, its crew fetches the patient and drives it to a hospital — one of the fullest buildings on the map — where it turns, inside, among everyone. Nobody involved does anything wrong, and hospitals gain a part mid-run beyond being an origin.

- **The call comes from belief, not condition.** A bitten sim indoors that has seen nobody bitten and nobody turn (no `conversionsWitnessed`, nothing in `knownInfected`), and has not chosen to go off alone, thinks it is an injury and phones, once (`Building.ambulanceAt`, `ambulancePatient`). One that has seen what bites do does not. Its own infection is the only one read.
- **It gets through at 0.9 × ½^(tick / 9,000)**, decided as it is made: early calls are answered and seed the hospitals, late ones do not connect — a window, not a constant.
- **Crews** of two EMTs with an ambulance at each hospital, from its residents; finite, like SWAT. On the 911 cadence the nearest idle crew within 2,500 m takes a call (`ambulanceDispatched`). They go out to the ambulance and board together (`cars.ts boardSquad`), drive there, walk in, and take the patient if it is still there — **nobody screens**: they came for an injury — then out, in again, and home; the patient is admitted (`patientAdmitted`) and the crew is free. Turned away at an occupied door, they give the job up. A call nobody takes lapses after 600 ticks. Not strangers where they are called, nor the patient at the hospital.
- **In transit** a patient who turns bites the crew (`turnedInCar`): an ambulance can arrive with three zombies in the back.
- **Drawn** white and as long as a SWAT van; moving, a red light flashing on and off (US practice: the city dials 911).
- **Measured** (seeds 1–3, to tick 15,000): 4 hospitals with a crew each; 26–45 calls a run, 5 sent, 0–1 patients admitted (each that was, turned there); nearly every crew dead by the end, most on its first job. A trickle, as the belief rule intends; one crew a hospital is spent quickly. Off with `features.emt`.

**Full sweep with reservists, SWAT, police cars, yards and EMTs** (mapSeed 1, runSeeds 1–20, 50,400 ticks, commit 897b3bb, before exits and the cordon; 6,961 s). **Both gates pass**: loss 40–95% in 19 of 20 (seed 16 smoulders at 7% turned, 5% dead), nothing resolved, shelters form, fall and re-form in 20 of 20, no stasis. Survival by caution 33.0% / 33.0% / 35.0% (z 4.7); among the asocial z 3.2; by sociality z −3.2 (joiners do slightly worse); by trust z 3.0. Turned share at the end 22–36% (seed 16 aside); 911 calls 164–304 a run; cars peak 19–37 driving, 24–107 abandoned; 9 ticker lines per ten minutes (median). Squads only fired in contact: reservists keep a civilian `engageThreshold` of 0, so nobody in a squad picked a target at range. **Fixed after this sweep**: every squad member (reservists, SWAT, the cordon) engages at range (`combat.ts`, `Sim.squadLeader`) — every piece of reasoning about squads (noise recruiting more than they can handle, holding a position, relieving a shelter, SWAT arriving with capacity that matters) assumed it.

**Sweep with squads firing at range** (mapSeed 1, runSeeds 1–8, 50,400 ticks, commit 279dafd, two sweeps sharing four cores). Evacuation off: **both gates fail** — loss 40–95% in 4 of 8 (seeds 2 and 7 smoulder at 5% turned, 6 and 8 at 15–20%), stasis in 2, survival 47% (from 33%), caution z 0.9, trust z 3.1. Evacuation on at 10%: worse — loss in range 3 of 8, one seed resolved at tick 7,318, stasis in 1, survival 52%, caution z 0.9. With evacuation off the cordon never comes (nobody leaves), so the change at defaults is the squads: armed units that engage at range put the outbreak down in half the seeds. To tune next — the squads' reach (reservist share, armouries, ammunition, the rifle's kill chance), not the decision to let them fire.

**Sweeps after the muster, highways on and off** (mapSeed 1, runSeeds 1–8, 50,400 ticks, commit 4eccf43; exits now chosen from a copy of the map stream, so the city is the same either way but for the highways). The earlier A/B (exits off passing, on failing) compared two different cities: choosing exits advanced the map stream. **Both pass both gates.** Highways on: loss in range 8 of 8, no stasis, survival ~30%, caution z 3.5, trust z 3.6, turned at the end 28–37%. Off: 8 of 8, no stasis, survival ~27%, caution z 4.4, trust z 2.5, turned 31–37%. So the highways do not decide the outbreak; the stalls came from the city the old exit draw produced together with what has since gone — 56 reservist pistols on the street from tick zero and the local call-up. First hour: turned 274–648 (on) and 370–769 (off), killed per turned 0.41–0.77 — the armed response no longer keeps pace, so every seed grows. Kills over the run (on / off): melee 7,211 / 7,584 — over half of all kills — police 3,123 / 3,575, bare hands 1,019 / 1,086, civilians with guns 462 / 450, reservist squads 405 / 421, reservists off duty 354 / 372, SWAT 316 / 179, cordon 0 (evacuation off: nobody leaves, so the cordon never comes). Shots in the first hour against the dead walking at two hours: r = −0.03 (on), 0.68 (off) — no evidence either way.

**The cornered fix** (after the swarm probe, seeds 1 and 3 to tick 14,400). Melee fight stands outdoors mostly began with **no zombie within 15 m** (45% and 34% of them; 0.1 kills a stand): cornered was judged on perceived threat over the whole sight radius, so danger seen 20–60 m off on two sides, or with a wall behind, had a sim with a kitchen knife plant its feet with an open street to run down. Kills were overwhelmingly one-on-one (about 85% with one zombie in contact); swarms resolved as they should (two or three in contact: 55–79% of stands ended in death, against 4–10% with one) but were rare. And the ×1.4 cornered modifier on the zombie's roll (`combat.zombieAttack.corneredFactor`) was defined and read by nothing. Fixed: cornered now also needs a zombie within `cornered.near` (6 m — about four times contact range, close enough that running is worse than swinging), keeping the several-sides and wall-behind tests, so a zombie at 5 m with an open street behind still sends the sim off; and a zombie's roll against a cornered victim (not one fleeing) is ×1.4. **Every melee finding before this was downstream of the bug** — the outdoor share, the supply conclusion, the arming figures — and is to be measured again. **Prediction, recorded before the sweep:** melee kills fall substantially, more of those who flee survive, and the infection curve rises, because fewer zombies die to opportunistic knife fights; if the curve does not move, something else is suppressing it.

**With the facing cone, and with evacuation on** (mapSeed 1, runSeeds 1–8, 50,400 ticks, commit 24e987c). *Defaults*: both gates pass — loss in range 8 of 8, no stall (seed 7's 3,174-tick quiet end comes after 79% loss and no longer counts), turned 39–43%, dead 27–36%, survival ~19%, caution z 8.2; police kills 3,940 → 3,642, melee 3,963 → 3,688, civilians with guns 1,147 → 1,366; per hour by day and night, turned 181 / 178, destroyed 85 / 92. Sociality still separates nothing (z −1.2): the back-to-back case has not shown up in survival. *Evacuation on at 10%*: both gates pass too — loss in range 8 of 8, no stall, turned 37–44%, caution z 7.6, the cordon firing 168 times over eight runs: evacuation no longer starves the outbreak now that evacuees leave the map. The cordon's pattern (seeds 1–4, to tick 30,000): the first district goes at ticks 90–300, the barriers close at 710–920, and 64–94 get out before them, 1–16 after; a second district at 450–780 on seeds 1 and 2 is caught part-way, on seeds 3 and 4 (1,560 and 4,140) entirely; every later evacuation (ticks ~9,000–25,000) meets a sealed road; peak queue 20–29; 13–16 try the flank; units that fire shoot 9–14 of them, the one that held its fire (seed 2) let 15 by.

**Rising, then darkness** (mapSeed 1, runSeeds 1–8, 50,400 ticks). *Nerve and rising* (commit 41bf951): turned 39–46% (from 28–31% with nerve alone), dead 26–35%, loss ~75–80%, survival ~19%; loss in range 8 of 8, no stasis; caution z 8.3 — the strongest separation yet; melee 3,937, police 3,996. Seven curves flatten by about tick 36,000 and hold — no late surge; seed 5 smoulders at 10% from tick ~14,000 to ~23,000, then climbs to 32% by the end: risings restarting a stalled outbreak. *Plus a shot in the dark* (commit 7d0c07c): almost no change — turned 37–45%, police kills 3,940, one seed with a 3,748-tick quiet stretch at the end (gate 4's stasis fails on it). No step at nightfall: per hour, turned 186 by day and 177 by night, zombies destroyed 89 and 99. Two reasons it barely bites: 61% of the street length is lit (seed 1), so most shots are unaffected; and a miss at close range costs a round and a cooldown, not the kill — the zombie keeps coming and is shot again — so the armed response is limited by encounters and ammunition, not by the chance per shot. (The day is 7,200 ticks: seven nights a run, not three.) **The stasis check is now conditional** (the user's): a quiet stretch at the end of the run counts as a stall only while loss is still under gate 2's 40% — a city already consumed has nothing left to happen, a run that finished early, not one that froze; a quiet stretch that something later breaks still counts wherever it falls. The sweep reports both (`stall/quiet end`).

**Three measurements against the burnout** (mapSeed 1, runSeeds 1–8, 50,400 ticks). Baseline (commit 421b5e9): turned 28–37%, dead 26–33%, melee kills 6,287, bare hands 1,141, caution z 4.0.
- *The bitten who never turn* (seeds 1–2, commit cab5b4b): all of them were eaten — 583 of 1,548 and 623 of 1,664 fed on after the bite, a median of 26 ticks after it (quartiles 10 / ~110), against a drawn turn delay of median ~740. The leak is a second zombie in the same encounter, not the turn delay: the swarm table again.
- *The swarm table toward release* (0.85 / 0.7 / 0.5 / 0.3, alone, as an override): turned 39–44%, dead 24–28%; loss and survival (~29%) barely move; loss in range 7 of 8 (seed 4 smoulders at 11% turned), no stasis, caution z 3.2; melee kills 7,546. It changes what the lost become, not how far the outbreak goes.
- *Nerve* (commit ed1a146, alone): melee kills 6,287 → 2,927 and bare hands 1,141 → 639 — the knife-fighting population collapses as intended — but turned 28–31% and **dead 37–41%**: the frozen are eaten rather than bitten, so loss rises about six points while the turned share does not. Loss in range 7 of 8; seed 5 burns out at 3% (resolved at tick 13,357, one stasis — gate 4 fails on it); caution z 4.5; survival by nerve band flat (z 0.3) — freezing and fighting end alike.
So the two levers are complements: nerve removes the civilians' kills, the swarm table turns the dead into the dead walking. Neither alone moves the reach.

**What caps the outbreak at about a third turned** (seeds 1 and 2, full runs, commit 3cb8514). Not combat, and not fortification as such: **the dead burn out before they reach most of the city.** Of about 1,800 zombies a run, 1,544–1,692 (~87%) are destroyed; awake zombies fall from 100–135 at two hours to 20–60 by mid-run, and conversions from 720–750 per two hours to about 100 (23 in the last window of seed 2). Every resident still alive at the end is in a building the dead never entered (1,464 and 1,125; none survive in a building they reached), and the far districts are barely touched — 8–31 of about 1,200 buildings ever entered in d7 and d8, which keep 81–86% of their residents, against 1% in d4 where it starts. About 500 buildings are fortified by the end; the dead never test them. Total loss is 56–63% (dead 1,589 / 1,714, turned 1,785 / 2,074), so the city is emptied where the outbreak goes; it simply stops going. **What each victim yields**: tracked sims attacked successfully were bitten 1,548 / 1,664 times and fed on 1,479 / 1,579 — about half — and two-thirds of the feeding happened with two or more zombies in contact (swarm table: released 0.8 / 0.55 / 0.25 / 0.1); of the bitten, only 957 / 1,037 turned — about 60%; the rest were killed before turning. Residents at a breach turn at 0.6 (810 / 1,023 turned, 110 / 135 died). So a tracked victim yields about 0.3 zombies, a resident 0.6, while 87% of zombies are destroyed: the outbreak's reproduction falls below one by mid-run, and it dies out short of the far districts. The levers are the swarm table's split, how many of the bitten turn before they are killed, and how fast the dead are destroyed — not the knife.

**After the cornered fix and finite arms** (sweep: mapSeed 1, runSeeds 1–8, commit 421b5e9; melee and swarm probes on seeds 1–4 and 3). Both gates pass: loss in range 8 of 8, no stasis, survival ~28%, caution z 4.0, trust z 1.7, turned at the end 28–37%. Against the sweep before both changes (highways on): melee kills over the run 7,211 → 6,287 (−13%), bare hands 1,019 → 1,141, police 3,123 → 3,800, civilians with guns 462 → 1,028 (dropped police pistols picked up), squads 405 → 315, SWAT 316 → 259. **The prediction held only in part**: no fight stand now begins without a zombie within 15 m (none of 661 on seed 3 to tick 14,400, against 327 of 955 before), and kills are still mostly one-on-one, but melee fell 13%, not substantially, and the infection curve did not move — turned at the end has sat at about a third (28–37%) through every variant this round (highways on and off, squads firing at range or not, the cornered fix): a cap set somewhere other than combat. Melee kills by place (seeds 1–4, full runs): 75–77% outdoors in a fight stand, 15–16% indoors, the rest in contact; 53–65% with a found weapon. Arming is unchanged: 60–62% of the tracked living hold a melee weapon at two hours, 71–72% at the end; 275–374 weapons lie on the ground by the end. The 8,000 homes, one knife block each, still arm the 2,000 tracked.

**Where melee kills come from** (seeds 1–4, full runs, commit e5ac49b; non-police, non-squad kills by weapon, place and source). Not shelter defence: indoors — the occupation contest — is under a tenth of them. About nine in ten are **outdoors, by a sim standing to fight because it is cornered or blocked** (`stand` fight: the cornered rule fights if armed). Most with a **found** weapon: found clubs and knives alone are about 60% of melee kills (club 289–388, knife 216–274 a seed, after the first hour). The supply is the home: 1,499–1,603 weapon finds a seed in residential buildings, against 69–96 in hardware stores, 86–101 in workshops — `lootChance` 0.3 a visit, and a residential roll is always a knife or a club (materials come from the stock, not the roll), with no limit per building. By two hours 63–70% of the tracked living hold a melee weapon, and 70–78% for the rest of the run. Per fight the numbers bite: melee killers have a median of 1 kill (max 4–12) and most end turned (290–351 a seed) or dead (120–153), against 69–81 alive. So the per-fight lethality is about right; what is wrong is that nearly everyone is armed, from their own and their neighbours' kitchens, and so nearly everyone cornered fights.

## Cars

Built at the user's request ahead of the sequencing in the design notes (cars were the second expansion, after the base dynamics proved out): gridlock as a vector for infection, and engines as a dinner bell for an opening that smoulders. Jams and abandonment, not traffic modelling (`state/car.ts`, `systems/services/cars.ts`, `config.cars`).

- **A car is a building with a velocity.** `Car`: parked, driving or abandoned; occupants (the driver first), a claim by whoever is walking to it, a destination building and kerb point, a route of streets, and since when it has been blocked. `Sim.car` marks someone inside: counted outdoors (or symptomatic) as before, so the population invariant is unchanged, and out of reach of everything that acts on people on foot (`isOutdoorLiving` excludes them: hashing, perception, combat, encounters, decisions). `Sim.boarding` marks the car someone is walking to.
- **Parked at setup** (run RNG): at the kerb in front of a share of each tag's buildings (houses 0.45, workplaces 0.3–0.5, flavour 0.25), on standard streets only (an alley is too narrow to pass one; never on a bridge or open ground), at least 14 m from a junction and 6.5 m from another car; and in 60% of the mall's stalls. About 2,600 on map 1, 138 in the mall lot. Every car is a 4.5 × 1.9 m rectangle (`CarIndex`: standing cars on a grid rebuilt only when one starts, stops or is abandoned; moving ones checked directly — rebuilding the grid every tick cost 4–5 ms a tick). A moving car stops anyone on foot. A standing one is gone round if a turn of up to 0.8 rad will do; otherwise it is climbed straight over, the living at 0.35 of their pace and the dead at 0.2 (`movement.climb`, `climbDead`; `movement.ts climbOver`). At first it stopped everyone, and the user saw police and others wedged between two cars nose to tail, sliding back and forth. Once only the living climbed, the dead piled up behind any car they had crossed: on seed 1, zombies were stuck on 2.8% of their moving ticks (1.0% before), 15% of them beside a car (4% before). With the dead climbing too, 1.8%, 3% beside a car; the rest is the run's own divergence. Sims stuck 0.3% → 0.1%.
- **Cars on top of one another** (the user saw it, abandoned cars especially; `driving.ts decideCars`, `pullUpBy`, `cars.parkWithin`, `cars.clearance`, `cars.pullUpTries`). Three causes. A car stopped for what was within 9.25 m ahead, but moves up to 9 m a tick, so one just beyond that ended the next tick on top of it. A car pulled up in the driving lane, not at the kerb, and the next car to that door stopped on top of it. And a car within 6 m of its spot parked where it was, across the car beside it. Now a moving car never moves closer than 0.5 m to an abandoned or moving car ahead, pulls up at the kerb in the first free spot along the street from the door, and parks on its spot (or within 6 m of it when blocked there). Parked cars are left out of the first rule: they stand at the kerb, and counting them stopped every car pulling out behind the next one along until it was abandoned (abandoned cars by tick 6,000 rose from 61 to 311 until that was seen). Seed 1, overlapping pairs at ticks 6,000 and 12,000: 108 and 236 before, 8 and 9 after; abandoned cars 72 and 88, against 61 and 68. What is left is mostly abandoned pairs from two cars meeting across a junction, each looking only straight ahead.
- **Cars turn back from a wreck** (the user's call, after seed 11 of the a3ad199 sweep abandoned 809 cars; `cars.ts reroute`, `pathfinding.ts route` with `back`, `Car.reroutes`, `cars.rerouteAfter` 60, `cars.maxReroutes` 2). A car stopped 60 ticks with an abandoned car directly ahead of it turns back to the junction behind it and takes a route that never uses that street again; twice at most, then it waits out the 180 ticks to abandonment as before. Seed 11's 809 were a mass exodus by car, not a bug: in the hour after the broadcast 657 cars set out at once, and 461 of those abandoned in that hour stood behind another abandoned car. Measured three ways (seed 1 ordinary traffic, abandoned by ticks 6,000 and 12,000; seed 11's hour after the broadcast, rerouting switched on only then, so the runs are the same until it acts): without rerouting 72 and 88, and 226 got out in the hour; turning back whenever stopped, 29 and 29, but only 81 got out — in a city-wide jam a car turning round only blocks the cars beside it, and keeps its people in it; turning back only from a wreck, 54 and 66, and 207 got out. The last is kept.
- **Cars drive like vehicles** (the user saw ambulances swing round 180° at full speed; `driving.ts decideCars`, `cars.accel`, `brake`, `turnRadius`, `turnMin`, `turnSlow`, `approach`, `personGap`). A car's heading snapped to its next waypoint every tick and its speed jumped to the target. Now speed closes a quarter of the gap to its target a tick, half when braking; it turns no faster than an 8 m turning circle allows at its speed, its target scaled by the cosine of the turn still to make, so it slows into a sharp turn and makes a U-turn as an arc; and it eases off as it closes on what is ahead (its target at most 0.35 × the room left), stopping 2 m short of anyone on foot, the living or the dead — the hard limit, never passed. A driver in flight does not brake for the dead: it rams them (`cars.ts ram`), each struck destroyed at 0.6 and the car slowed to 0.6 of its speed; it still stops for the living (running people down would be survivor-on-survivor harm, out of scope). Seed 1 to tick 12,000, against the commit before: turns of more than 90° in one tick at over 3 m/tick 1,269 → 0 (the sharpest 158° → 52°); trips completed 439 → 451; cars abandoned 78 → 41; overlapping pairs 11 → 7; mean driving speed 6.5 → 5.0 m/tick. Nobody drove in flight into the dead in that span; a test covers it.
- **Struck, swerved round, crashed** (the user's next asks; `cars.ts ram`, `decideCars`, `wouldHit`, `crash`; `Car.impact`; events `carHit`, `carCrashed`; death cause `crash`; `cars.knockBack`, `lookahead`, `swerveFrom`, `swerveClear`, `crashMin`, `crashKill`).
  - **A struck zombie goes flying.** Each one a fleeing driver hits is thrown 4–7 m along the car's path (further the faster it was going), if it lands on open ground, destroyed or not; the renderer draws the flight from `carHit` (`drawThrown`: a body rising and falling along a faint streak, its shadow under it, 650 ms of wall time).
  - **Swerving.** A car doing at least 1.5 m/tick swerves round the nearest person in its path instead of braking for them, aiming to pass them 1 m clear, if the aim and the way to it stay on the carriageway and no car stands there; it keeps its speed for it (the hard stop short of them still holds). Aimed only beside the person at first, swerves left the road for the buildings.
  - **Collisions.** Movement stops a car that would move into another car (not one it is already touching, not a parked one: pulling in and out at the kerb, a car passes close to them) or, at crash speed, drive its front into a building; car processes resolve the impact. At 6 m/tick or more it is a crash: the car is abandoned for good where it hit, each person in it dies at 0.5 × (speed / 9)², the rest get out, and the ticker says so. Slower, a bump that only stops it. Buildings count only at crash speed: at walking pace a car's corner brushes plots pulling out of the kerb, a yard bay or a stall, 14,403 such bumps in 4,000 ticks on seed 1, each one stopping a car until it was abandoned.
  - **What made crashes rare: lane-keeping and slowing for corners.** First measured, 260 crashes by tick 12,000 on seed 1. The crash sites showed why: cars 5–8 m off the middle of 6 m alleys, and cars 10–17 m off their first street. A car aimed straight at the next junction, so one thrown wide by a turn, or joining from a yard or lot, closed on its lane over a whole street at a shallow angle. Now it steers for a point 12 m ahead along its lane (`cars.lookahead`), slows before a junction to a speed set by the turn it makes there (braking in time for it), and can turn tightly at a crawl (`turnMin` 0.35 rad/tick, a three-point turn rather than a 16 m circle on a 12 m street).
  - **Measured** (to tick 12,000, against the commit before, 397a36d): seed 1 — trips 451 → 478, abandoned 41 → 66, overlapping pairs 7 → 1, crashes 10 (3 dead); seed 2 — trips 554 → 565, abandoned 73 → 131 (21 of them wrecks), crashes 21 (9 dead). About one trip in 25–50 ends in a crash. Nobody drove in flight into the dead in either span, so nothing was thrown; tests cover ramming and a crash.
- **Inertia** (`Sim.pace`, `movement.inertia`; the user's suggestion, B's design). The living no longer jump from standing to the gait's speed. Each tick `pace` closes 0.35 of the gap to the gait's speed when speeding up (0.6 in flight: fear is a spring), 0.7 when slowing, so stopping is quicker than starting; a walk from standing reaches 90% in about six ticks, a panicked run in about three. Indoors or in a car, pace is reset to 0. B also proposed a turn-rate cap, slower turns at speed. It was left out: a turn limit was already rejected for the dead (bugs-seen, "the dead bounced off"), because it would make pursuers orbit their prey, and it would fight the wall-sliding in `movement.ts step`, which turns up to 2 rad in a tick to get round an obstacle. The dead keep their instant speed: they have no rest to start from that reads, and their pace was capped near prey for the pong fix. `movement-check` after: sims stuck 0.1%, reversing 0.4%.
- **Who drives:** an aware sim on foot heading for home or shelter more than 500 m away, not in flight, checking on the 30-tick cadence, takes the nearest free parked car it can see within 50 m and walks to it (giving it up, back on foot, if it is taken or it panics). At the car it gets in with any aware companions on foot beside it bound for the same building, up to four, and plans the drive with its own memory.
- **Driving:** toward the next junction along the street, kept right of the centreline (2.5 m, at most a quarter of the street's width) so opposing cars never meet; a junction counts as passed once the car has drawn level with it (the first version aimed at a point offset across the line to the junction, which turned as the car closed in, and cars orbited junctions for ever). Up to 9 m a tick, slowed by congestion (1 / (1 + 0.3 × cars driving within 15 m)). It stops for anything in its own path within 9.25 m — people, the dead, abandoned cars, moving cars — and when two moving cars stop for each other the lower id yields. It pulls up at the kerb by the destination's door and everyone gets out; the car is parked there, free for anyone.
- **Jams and abandonment:** a car stopped behind something for 180 ticks is abandoned where it stands, for good, and its people walk on; another car stopped behind it is abandoned in turn. Ticker line "A car was abandoned on …" (salience 25). Drawn dark and crossed.
- **Under siege:** a car being driven, moving or stuck, makes engine noise every 10 ticks (45 m, intensity 0.6) that the dead hear and people ignore (no panic, unease or alert). Each awake zombie at an occupied car breaks in at 0.02 a tick: the car is abandoned and everyone inside is out among them. Someone who turns inside bites each of the others at 0.6, and the car is abandoned.
- **Drawn:** a rectangle along its heading — parked, a dim outline at near zoom; abandoned, dark and crossed at mid and near; driving, filled, every frame. Standing cars are drawn into the cached static layer (drawing all 2,600 every frame took 37 ms).
- **Measured** (mapSeed 1, 9,000 ticks, invariant checked every tick): 355–544 trips per run, 332–512 completed, 14–31 cars abandoned, at most 28–33 driving at once; loss by 9,000 for runSeeds 1, 3, 5: 1,634, 629, 483 (seed 1 smouldered at 109 before cars). On seed 1 by tick 6,000 a line of five abandoned cars stands across a bridge: the river crossing is closed, as the design notes foresaw. About 7.9 ms a tick against 6.8 without cars (3,000-tick bench). No gridlock yet: with awareness slow, too few drive at once for the roads to choke. Not yet swept then; swept in every sweep since (below).
- **Sweep with cars** (mapSeed 1, runSeeds 1–8, still at 36,000 ticks; commit dcbf643). **Gate 2 passes** (loss 40–95% in 7 of 8: 57–69% in seven; seed 5 smoulders at 10%). The car placement shifts every run's random sequence, so seed numbers do not match the sweep before; across the eight, one smoulders where two did and a third limped to 21%. **Gate 4 fails on caution again:** shelters form, fall and re-form in all eight, no stasis, but survival by caution band is 29.1% / 29.9% / 30.1% (z 1.5). Among the asocial (sociality < 0.33) caution makes no difference either (30.0% / 29.4% / 29.0%, z −0.9): it is not sociality standing in for caution. Trust still separates survival (28.3% / 29.5% / 31.2%, z 4.2); sociality does not (z 0.5). Survival overall fell (about 30% of tracked sims alive at the end, was about 41%); named survivors live a median 6,060 ticks after naming (was 14,822), 37% alive at the end. Cars: at most 15–27 driving at once, 15–68 abandoned per run — no gridlock. Awareness is still slow: at an hour 60–95% of people outdoors are unaware. Ticker: a median 8–9 lines per 10 minutes, dead air only in the smouldering run (4 of 54 windows). Awake zombies still peak late (ticks 16,800–34,800 where the outbreak took off), 264–393 dormant at the end. Wall time 1,390 s, 16–22 ms a tick: this host is about twice as slow as the last (the code before cars runs 6,000 ticks at 12.2 ms a tick here, after at 12.8 — cars cost about 4%).

- **Kept out of walls** (the user saw cars turning through buildings; `driving.ts decideCars`, `inWalls`; `cars.wallTurn`, `wallSpeed`, `bodySamples`, `reverseSpeed`). The building check ran only at crash speed and only on the front edge, so a car turning at a crawl swung its corners through walls (2.2% of driving car-ticks on seed 1, nearly all under 3 m/tick), and one pulling out of a yard or bay aimed a lookahead along its street, at a point past the corner of the building beside it. Now, below crash speed, a car takes only a pose that puts no more of its body (a grid of points over it) in a building: the turn it wants or less, then steering away from the wall, at its speed or less; boxed in, it backs out, turning as it goes. Standing, it stays put. Off its street, it aims at the nearest point of the street first. Being held back by walls counts as blocked, so a wedged car parks near its spot, reroutes or is in the end abandoned. To tick 6,000 on seed 1, 2.2% → 0.28% of driving car-ticks (six cars, all under 1 m/tick). **Open:** trips to tick 12,000 fell on seed 1 (488 → 378) and rose on seed 2 (462 → 518); abandoned cars rose (77 → 95, 100 → 146). Being measured.

### Car alarms and sirens

Two noises the dead hear that are not gunfire. Both are stimuli like any other, so the alarm or siren the viewer hears is one the dead heard. Neither frightens people or drives residents out of their houses, as engines don't.

- **Car alarms** (`Car.alarm`, `Car.alarmUntil`, `cars.alarm`, `features.carAlarms`).
  - **Which cars:** 30% of ordinary parked cars carry an armed alarm, drawn at setup from a copy of the run's stream so nothing else moves. Police cars, vans and ambulances do not.
  - **When it sounds:** the first time the car is taken, by anyone for any reason, or the first time the dead tear at it with people inside. Then it is spent: a car screams once in its life, so a stationary car can never become a fly-trap.
  - **Loud and brief:** a blast heard to 150 m every 5 ticks for 30 ticks.
  - **The ticker** names the street ("A car alarm went off on Selby Cut."), so the viewer knows why a horde just turned.
  - **No ownership and no hotwiring trait** (the user's call, on B's argument). Gating who can take a car would cut the driving that makes the jams and the closed bridges. If a hotwirer comes later, it should change how long taking a car takes and how likely the alarm is, not whether you can.
- **Sirens** (`cars.siren`, `features.sirens`). A police car, SWAT van or ambulance on the move (a vehicle with a home; rescue trucks have none) makes a 100 m noise every 15 ticks. That is a thin wake behind it, not a corridor, and a zombie that reaches the spot and finds nothing loses interest as it does for any sound.
  - **Measured first:** emergency vehicles drive almost only in the first hour (police cars 62–66 driving-minutes in hour 1, 0–7 in hours 2–3, none after; ambulances 105–147, then 0–18; SWAT vans 3–7 in hours 2–3). So sirens act on the opening, where a run's take-off is decided.
  - **On by default** (the user's call). Without them the audio layer would be lying, the one place the viewer would hear something the city does not.
- **Swept** (mapSeed 1, runSeeds 1–8; commit b2962e1). Compared with the household rounding sweep on the same map, with neither feature:

  | | neither | + alarms | + alarms + sirens |
  |---|---|---|---|
  | civilians survived | 20.7% | 20.2% | 19.8% |
  | loners survived | 27.8% | 30.5% | 25.9% |
  | freezes per 100 civilians | 91 | 88 | 99 |
  | caution z (to broadcast) | 7.9 | 5.9 | 7.2 |
  | trust z | −9.5 | −11.9 | −12.5 |
  | alarms per seed | — | 156–191 | 152–216 |

  Both gates pass in all three, and turned is 42–47% throughout. Alarms cost little. Sirens make the opening harder: more freezes, and loners lose about four points, which is about three standard errors.

## The edge and the ending

How the city is sealed and how the run ends: the ways out, the margin round the city, districts leaving together, the cordon closing the roads, the rescue, and the end.

### Exits

The map had none: its edge is a ring road, and nothing left. Evacuation therefore sent people to buildings far across the city, scattering in every direction (measured: with evacuation at 10%, never more than three cars stopped on any one street at once, the same as without it; abandoned cars piled up one at a time, up to ten on a street, not in a queue). What a jam, and a cordon, need is scarcity: a few ways out, each fed by an arterial that converges on it.

So the generator marks `map.exits.count` (3) of the district-boundary arterials — which already run straight from edge to edge — as highways (28 m, always lit), each leaving the map at one end (`World.exits`: the edge node, the last segment, the outward direction). The first end is drawn at random, each next at random among ends at least half the map from those chosen (one a line); ends where the river meets the edge are passed over. A highway that crosses the river is bridged there — the natural chokepoint, where a cordon would stand and abandoned cars could close the way out (two of three highways cross it on maps 1–5). Exits differ by map seed, not by run. Drawn as an amber arrow at the edge, pointing out, with the word, at every zoom.

**Leaving** (`systems/outside/exits.ts`). Evacuees now make for the nearest exit (the highways out are signposted: common knowledge), destination kind `leave`: on foot, or in a car if one is at hand (any free parked car within reach, with companions making for the same exit; `Car.exit`). Someone on foot within 8 m of an exit's node is through it; a car reaching it takes everyone inside out, and is gone (`Car.state` gone: out of play, off the obstacle grid, not drawn). Either way the sim is out of play (condition `evacuated`) and counted in `unturned.evacuated` — the bitten too: nobody at the exit looks for a bite yet, and those are also counted in `World.escapedInfected`, the number a cordon would exist to keep down. A named survivor getting out makes a ticker line. Without an exit on the map, evacuees go to a far building as before. Measured, evacuation on at 10% (seed 1, to tick 12,000): 130 evacuated, 103 cars driven off the map, none bitten; at worst 11 cars stopped behind another at once (3 before), 3 of them within 400 m of an exit. Off with `features.exits`.

### The city's edge

The cordon did not seal the city (the user's diagnosis). The exits were ordinary roads that happened to reach the map edge, and the ring road ran along the edge itself with houses facing it, so there was city beyond where the barrier stood and people walked past it to reach it: blocking one segment of a connected network blocks nothing. And the edge was not a wall to steering — walkability was "on the map, not in a building, not in water" — so anyone in flight, who steers and never consults the street graph, could leave the streets and stand off the map, where people and the dead were seen to stop acting.

- **An empty margin** (`map.border.margin` 160 m; `World.border`). The map is now 3,520 m square, the city the same 3,200 m inside it: the districts tile the inner square, the ring road runs round its edge, and nothing is generated in the margin — no blocks, buildings or parked cars. Every street of the city ends at or inside the ring road.
- **The exits are the only crossings.** Each exit is still a district-boundary arterial made a highway across the city, so the main streets feed it and traffic converges before the barrier; from its end on the ring road a stub carries it on across the margin to the map edge (`generate.ts`, the stub named as the arterial). The exit's node is the stub's outer end, its street the stub, so the cordon's barrier stands on the stub, in the margin.
- **Impassable to steering** (`runtime.ts MapIndex.walkable`, `inCity`). Nothing beyond the ring road's outer kerb is walkable except on a stub. Leaving was already a property of the graph, not of a coordinate: only someone making for an exit leaves, on reaching its node (`exits.ts exitArrivals`). Now nobody can steer into the margin either, so flight cannot carry anyone round a barrier or off the map.
- **A boundary, not an absence.** Across the middle of the margin (`BORDER_KINDS`, drawn by `renderer.ts buildBorder`): a fenced double-track railway along two adjacent sides and a motorway with a median barrier along the other two — a chain-link fence on its outer side, a sound barrier (a solid wall with posts every 4 m) on its city side (the user's call) — each curving round its own corner and, where it would meet the other, turning off the map instead — so the two never meet, and both run on beyond the edge, the way a city's railway and orbital road would (the user's design, in steps: first water, railway and motorway one to a side; then the motorway round a corner; then the water band made railway, and the ends turned off the map). Drawn from a stream of its own (`BORDER_STREAM`), as before, so each map's motorway keeps its place and the city is the same whatever the border. Scenery: the whole margin is impassable already. What differs is the crossing: a stub crosses the motorway on an overpass (terrain `bridge`) and the railway at a level crossing (the user's call; an underpass at first), at grade, the fences and sleepers broken for the road and the rails running on across it. Every stub is a 28 m highway. The river that crosses the city still runs out through the margin, the one water crossing.
- **Traffic on the motorway, as scenery** (`render/traffic.ts`; the user's request). Cars come on at either end of the motorway, from beyond the map edge, keep to the right-hand carriageway, and go off at the other end, hidden where they pass under an exit's overpass. They are not simulation entities: nothing in `sim/` knows of them, they are not counted, block nothing, and nobody sees or hears them. Each car's place is worked out from simulation time alone (`Interpolator.time`, fractional between ticks): a fixed spacing per carriageway (30–260 m, from a fixed hash), all at 22 m a tick (about 80 km/h), so the same moment always looks the same, pausing stops them, and playback speed speeds them. Mid and near zoom only. About a quarter are articulated trucks (the user's request): a 2.6 m cab and a 13 m trailer, 2.5 m wide; six in ten trailers carry a container (filled, a muted rust), the rest are empty flatbeds (outlined); a long trailer goes under an overpass a piece at a time. The motorway's figures (`BORDER`) and each side's run (`borderRun`) live in `render/border.ts`, shared with `traffic.ts`, so the vehicles stay on the road drawn.
- **Verified by graph test, not by eye** (`tests/border.test.ts`, maps 1–3): no building, parked car or non-exit street in the margin; every exit reaches the map edge; with every exit street blocked, no node outside the city is reachable from any node inside it; and on a 9 m grid over the margin, no point is walkable but on a stub.
- **What moved with it.** The city is the same size, but the river (drawn across the whole map) lies differently against it, so map 1 is a different city: at 19:00 its fullest hospital, office or school held 27, under `spawn.originMinResidents` (30), now 25.

### Evacuation

The release at tick 600 was a cold-start fix — people onto the streets so the map is not dead — and it stays exactly as it was. But at tick 600 only 77 of 8,592 buildings know of the outbreak (seed 1), so release and awareness are two unrelated things at the same moment by accident: 674 of 883 released walked out unaware. Traffic was sparse (at most about 30 cars driving) because people learned in a trickle and left one at a time; a jam needs simultaneity.

So a second, separate event (`release.ts updateEvacuation`, the only other reader of district release state, `District.evacuatedAt`): every 30 ticks, a district with `evacuation.threshold` (7%) of its buildings alerted evacuates — half the residents still in each of its buildings leave together (one a tick per building), aware, each for a building 800–2,000 m away (the most robust of 8 drawn at random; failing any in range, the farthest drawn), far enough to drive. It happens where and when the outbreak arrives, per district, so a neighbourhood empties onto the roads while the next is still calm (`districtEvacuating`, a ticker line). Nothing is learnt by proximity: a building knowing does not tell the house next door; shouts and conversation still carry news.

Measured (seeds 1–2, to tick 15,000, against evacuation off): peak cars driving 28–29 → 44–48, peak stopped behind another 8–11 → 13–16, abandoned 9–21 → 34–83. Four to six districts evacuate per run; the first can go within 120 ticks where the outbreak starts. The threshold is a sweep parameter (5–10% the plausible range). Off with `features.evacuation`.

**Swept, and switched off by default** (8 seeds, with reservists and squads in): evacuation off, survival ~31%, both gates pass, caution z 5.0. On, at thresholds 5% / 7% / 10%: survival ~59% / ~62% / ~55%, loss in range only 3–4 of 8 seeds (gate 2 fails), stasis in 1–2, caution z 1.5 / 1.4 / −0.1 (gate 4 fails); cars abandoned per run 20–140. Half of each district's remaining residents leaving for far buildings takes away the people whose buildings would be breached and turned: the outbreak runs out of fuel, and survival no longer depends on caution. The jams are there; the share is far too large. To revisit: a share nearer 10–20%, or where evacuees go (both since done: below). **Switched on by default at a tenth** (`evacuation.share` 0.1; the user's, commit after d5fb65b): with evacuees leaving the map rather than crossing it, and the cordon closing behind the first district, both gates pass with it on (8 seeds: loss in range 8 of 8, no stall, turned 37–44%, caution z 7.6).

**Shares of a household are rounded by chance** (`rng.ts roundByChance`). A share of a building's residents was rounded down: at `evacuation.share` 0.1, a building sent anyone out only if it held ten or more. A suburb (mapSeed 1's district 0: 1,166 houses, 314 residents, none with ten) never evacuated at all. Now a tenth of a household of three is one person three times in ten, so a share means the same in a house as in a tower block. The same fix applies to the two other shares with the same flaw: the rescue broadcast (`broadcastShare` 0.5, which sent no one from a house of one) and expulsion by nearby gunfire (`residentExpelShare` 0.3, which drove no one out of a house of three). The release at tick 600 keeps its round-down: the cold-start fix stays exactly as it was. **Swept** (mapSeed 1, runSeeds 1–8, commit 337fc17, against 7dd4dcb on the same map). Both gates pass; turned 44–48% as before.
- **More people step out of houses**, so more are tracked: 28,030 civilians against 25,413.
- **Survival rises:** 20.7% of civilians against 18.4%; loners at 27.8% against 28.8%, so the gap narrows from ten points to seven.
- **Freezes rise:** 91 per 100 civilians against 73, as more are out on the streets when the shooting starts.
- **The broadcast reaches one-person houses:** 469–769 answer it against 363–537, and about three in four are still lost.
- **Separations:** caution z 7.9 up to the broadcast (was 6.5); trust −9.5; nerve 4.4; sociality −0.1.

**Feature switches** (`config.features`), so each later addition can be benchmarked and swept with it off: `conversations` (off: every meeting trades everything, as before the fourth round), `unease` (off: the first telling convinces), `trust` (off: everything heard is taken at face value), `reconsider` (off: objectives are held once chosen), `intactZombies` (off: the one-bite dead are recognised like any other), `cars` (off: none are placed), `strangerVeto` (off: strangers are let in), `cautiousRouting` (off: unknown streets read as safe). All default on. Timing: `npx tsx scripts/bench.ts --ticks 15000 --runs 3 --set features.cars=false`, interleaved with a run at the defaults; behaviour: `npm run sweep -- --seeds 8 --set features.conversations=false`.

Everything in the tuning tables stays in `config.ts`. Those interact chaotically and thirty sliders produce frustration rather than agency.

### The cordon

The world outside sealing the city (`systems/outside/cordon.ts`, `config.cordon`): an outside authority, arriving late, from off the map — not the city containing itself, which would make its own reservists the antagonists of the people they came from, and would compete with the depots' supply.

- **Notice.** The first district to evacuate is what the world outside reacts to (`release.ts updateEvacuation` sets `World.noticedAt`; the user's): one district gets out, the authorities react, the barriers close, and every district after that meets a sealed road — the same legible pattern every run. That first evacuation has its own ticker line, which drops playback to 1× (`districtEvacuating` with `first`). Before this, the outside noticed once 20 had come out by the exits; before that, at the first officer to radio for SWAT, a fixed lag after the outbreak, so the evacuees were mostly out before the barriers closed. With evacuation off, nobody leaves and the cordon never comes.
- **Arrival.** `cordon.delay` (600) ticks later — enough for that district to get through, not the next — a squad of four soldiers comes in at every exit: reservists by archetype, pale green, rifles and 40 rounds, `outsider`. **The invariant is amended**: soldiers are counted in the leaves like anyone (they can be bitten, die, turn), so the sum of the eight leaves is `scenario.population + World.outsiders` (the user's choice; the alternatives were a barrier with nobody holding it, or an abstract guard that cannot die). Their losses are derivable from entity state.
- **The barrier.** Each squad walks to its post, 8 m outside a barrier 40 m in from the edge; when the leader is there, the barrier closes (`Exit.closedAt`, `cordonClosed`, a ticker line that drops playback to 1×): the highway's last segment is `blocked` 1 for good, so route-finding treats it as impassable whether or not anyone is left to hold it. Drawn as a hard bright bar across the road in the institutional blue — the one thing in the city an outside authority put there — drawing itself across from the middle when it first appears. The squad holds its post (its leader's `post`, carried to a successor) in line abreast across the highway, `squads.lineSpacing` 3 m apart with the leader in the middle, and fights from the line rather than the diamond — it marches in that line too, from the edge to the post.
- **The barrier's geometry.** The exit's outward direction runs along the highway's last segment, not square to the map edge (the two differ where the road meets the edge at an angle, and the barrier then stopped short of one kerb). The bar is drawn kerb to kerb and 0.5 m past, square-ended, so the blockage is plain before anyone queues; the exit arrow and its label are signage, small and faint (alpha 0.4 and 0.6), so the barrier is the dominant mark.
- **Fire at everyone who comes near** (the user's redesign; `combat.ts cordonFire`, `cordon.warnRadius` 75, `fireRadius` 25, `warnEvery` 20, `killShare` 0.5; events `cordonWarned`, `cordonWounded`, `simDied` cause `shot`). The soldiers do not screen, and nobody queues. A soldier with no dead in reach fires at the person nearest its barrier, on foot, in sight, on the armed sims' staggered cycle: within 75 m of the barrier a warning shot — no roll, the noise of any shot, at someone not warned in the last 20 ticks — and within 25 m aimed fire, the rifle's ordinary roll (darkness and distance included), of whose hits half kill and half wound. A wound has no state (health is out of scope): struck, the person turns back and gives that way out up. Every unit fires; the earlier per-unit draw, half the units holding their fire, is gone. Distance from the barrier is all that counts, so someone past it, hugging the edge of the map, is fired on as much as someone coming up the road. The soldiers carry 120 rounds each (`cordon.ammo`, was 40): warnings use rounds.
- **Warned off.** Someone making for a closed exit does not know it is closed until the soldiers fire. Warned, it gives the exit up (`Sim.knownClosed`) for the nearest it has not found closed — a long way, through whatever the outbreak now holds — or, with none left, for shelter; or, at `cordon.defy` (0.5) × (1 − trust), presses on round the barrier (`Sim.crossing`, the side of the road it is on): along the kerb, `cordon.kerb` 1.5 m outside the road's edge, past the barrier's end and out at the edge — through 25 m of aimed fire. Out, it is evacuated, bitten or not (`cordonEvaded`, then `simLeft`). Gunfire frightens like any; one in flight runs for a door, and comes back to be warned again once calm.
- **Panic at the barrier.** Fired on, someone in flight runs from the guns, back up the road, not from the dead as elsewhere: out on the exit road there is no door to run for, and running from the dead the frightened sprinted straight into the aimed fire (40 of 51 hits on seed 1 before this). Someone already going round keeps going, at a sprint: panic does not undo the choice. Police do not run toward the cordon's gunfire (`sims.ts shotHeard`, `cordon.ts cordonShot`): its warning shots drew officers into its aimed fire.
- **Firing back.** An armed sim pressing on round the barrier fires back at the soldiers for `cordon.returnFor` (60) ticks after they fire at it, or first if its trust is below `cordon.fireFirstBelow` (0.15) (`crosserFire`, `cordonFiredOn`, death cause `returned`). With every unit firing, nearly every one who presses on is fired at first.
- **Cars** making for a closed exit are left `warnRadius` short of the barrier (`cars.ts`), and their people walk on to be warned off like anyone; the cars behind stop behind them and are abandoned in their turn: the road in becomes a jam that stays.
- **DO NOT CROSS**, underlined, is painted across the road where the warnings begin, `warnRadius` in from each closed barrier, upright for whoever comes up the road (the user's request; `renderer.ts drawDoNotCross`, `MapSnapshot.cordonWarn`). Mid and near zoom, in the barrier's colour.
- **The rescue's exit.** Once the rescue has come, its exit's soldiers hold their fire (`cordon.ts holdsFire`), and those answering the broadcast queue behind the line ("The rescue", the queue and the tents).
- **Why it changed** (the user's report): the queue at a closed exit had people standing on top of one another, and people got past the barrier and walked along the edge of the map with no reaction from the guards — half the units held their fire by design, and the others fired only at someone within 2 m of the barrier line while crossing. **Superseded:** the queue of the hopeful at every closed exit, believing they would be screened (`cordon.patience`), and the per-unit choice to fire (`cordon.fireShare`, `Sim.firesOnCrossers`).
- **Measured** (seeds 1 and 2, to tick 15,000): barriers closed at ticks 860 and 891, after 75 and 68 got out; nobody out past a closed barrier since. 83 and 99 people warned (120 and 173 warning shots); 11 and 25 wounded, 10 and 19 shot dead, nearly all of them pressing on round the barrier; nobody fired back; every soldier alive, about 1,200 of 1,440 rounds left. At most one person within 30 m of a barrier at a time, and no two closer than 0.5 m.
- **Not built:** whether seeing someone shot changes what others do beyond the gunfire's fear.

### Checkpoints

Traffic police: the city trying to contain itself, between the cordon closing and the rescue (`services/traffic.ts`, `config.traffic`, `World.checkpoints`, `Sim.checkpoint`; the user's design: attempted containment is a story of its own, and the checkpoints the Rangers find fallen hours later add to theirs).

- **Placed at setup.** One checkpoint on each exit's road, `traffic.inset` (350) m in from the cordon's barrier by the streets, following the widest street inward (the arterial that feeds the exit; on a tie the straightest, then the lower id). A unit of `traffic.officers` (2) police, taken from the station's residents like SWAT, waits inside the police station nearest it, a squad the lower id leads, with a cruiser at the kerb. Shown as *traffic police* in the inspector; police in every other respect, and never sent on a 911 call.
- **Ordered when the first barrier closes.** Each unit drives out in its cruiser (as SWAT does, `squads.ts swatVan`), parks it `traffic.parkShort` (7) m short of the sawhorses on the city side, in the lane (a reservists' HMMWV `parkAside` 3.5 m beside it; each `parkStep` 6 m further back while a vehicle already stands there: `traffic.ts parkingSpot`), clear of the sawhorses, and stands across the road in line (the checkpoint becomes the leader's post). Set once the leader stands there (`checkpointSet`).
- **Turning back.** Every `traffic.every` (5) ticks, anyone on foot within `stopRadius` (12) m making for that checkpoint's exit is turned back: that way out is known shut (`Sim.knownClosed`), as if warned at the barrier, and it makes for another it does not know is shut, or stops leaving. Before they reach the soldiers' guns. The officers fire on nobody living; the dead they fight as police do. Not at the rescue's exit once the rescue has come. Cars are not stopped.
- **At the first evacuation** (the user's design; `traffic.ts evacuationCheckpoints`; `Checkpoint.district`, `orderedAt`; `Sim.evacuatedFrom`): when the first district evacuates, `traffic.evacCheckpoints` (2) more, where its roads at least `evacRoadWidth` (20) m wide — or its widest — leave it: at the junctions on them farthest from where its evacuees set out, in directions at least 90° apart (`evacApart`), `evacOffset` (15) m out along the road leaving the district, facing it. Manned at once by `officers` of the first responders of the nearest police station with that many in and free, who drive out in one of its cars (fewer to answer 911 calls); with none free, it waits for reservists. They let that district's evacuees through, and turn back anyone else making for any way out. Shown with the others (the frame now carries the checkpoints, as these appear mid-run). Seeds 1 / 2 to tick 12,000: police set one at 649 (the other set by reservists at 6,037) / both at 257 and 276, the one fallen at 1,050, set again by reservists at 3,641, and both fallen by 7,903.
- **Falling.** None of the unit within `holdRadius` (30) m — dead, turned, run dry or gone — and the checkpoint has fallen, for good (`checkpointFallen`); what is left of the unit is police like any other.
- **Drawn.** Once set, two short sawhorses (3.5 m) across the road, police blue, a 3 m lane between them where the cruiser parks; fallen, grey and faded, knocked askew toward the kerbs, for the rest of the run, with the cruiser where it was left.

### The rescue

Player-facing English is American (the user's): street suffixes are Street, Road, Way, Drive, Place, Court, Circle, Terrace (alleys Lane, Alley, Passage, Walk, Path; main roads Road, Avenue, Boulevard, Parkway — no Close, Gardens, Mews, Yard, High Street or Parade), Harbor not Harbour, armory not armoury, get around not get round. Code identifiers and these documents keep their British spelling.

The ending (`systems/outside/rescue.ts`, `config.rescue`; the user's design, after B's ordering). The run is 64,800 ticks: the outbreak keeps its fourteen hours, so its tuning stays valid, and the rescue has four. Sweep first, broadcast second: a broadcast first would empty the city of everyone who could move, and the sweep would clear an empty map; a sweep first makes the convergence, a flow across ground nobody has crossed in hours, against the way the soldiers came.

- **The Rangers** (the user's: Army Rangers — elite, light infantry, rapidly deployable, which is why they never panic) come in at `rescue.at` (50,400) by the exit whose corridor holds the most people still sheltering (`World.rescueExit`, `rescueSweep` — a ticker line that drops playback to 1×): `rescue.squads` (4) squads of soldiers from outside (`Sim.sweep`, outsiders like the cordon's, through the same `spawnSquad`), rifles and 120 rounds.
- **The corridor and its front.** The corridor runs from the exit toward the middle of the map, `halfWidth` (150 m) either side. The front advances `speed` (0.15 m a tick, about 540 m an hour) to at most `depth` (2,200 m), and never more than `lead` (60 m) ahead of the farthest living soldier: it is where the company has got to, and with none left the sweep stops. Soldiers from outside — the company and the cordon — never panic (panic.ts: their mode is always informed, and their nerve never breaks); panicking, the first company stopped firing and was eaten in an hour and a half: slow and incomplete — it takes a corridor, not the city, and districts away from it are never reached, which is the ending most of the roster gets. Each squad leader's post is its lane of the front line, snapped to the street; the squads fight as squads do.
- **Sending back.** Every 30 ticks, anyone outdoors within `sendRadius` (40 m) of a soldier who identifies itself makes for the exit; buildings the living hold behind the front give up their residents (`takeShare` 1, as evacuees) and their tracked people (`Building.sweptAt`).
- **The unidentified** (combat.ts `sweepFire`; the user's: only those). A soldier with no dead in reach looks at the nearest person in sight and range who does not identify itself — frozen, sprinting in a panic, or in the dark — and at `misidentify` (0.15) a look takes it for one of the dead and shoots (`simDied` cause `mistaken`). Nobody tells the living from the bitten: a sweep that did would know what nobody knows. The bitten are sent back like anyone. This widens the cordon's exception to the no-survivor-on-survivor rule, at the scale of the ending.
- **The broadcast**, `broadcast` (7,200) ticks after the sweep began (`rescueBroadcast`, a ticker line): everyone tracked and free to — not police, crews, their patients, squads, those from outside — who believes it and dares makes for the exit. **Answering is a choice** (the user's, after the first sweep showed everyone answering and 85% of them lost): a sceptic (trust under `trustFloor` 0.25) stays put; so does anyone whose caution × risk passes `riskTolerance` (0.3), risk growing with the uncleared ground between it and the corridor the company has cleared (`World.rescueFront`), full at `farFrom` (1,500 m); asked again as the front comes on. The soldiers' own sending back is not a choice. Those who answer keep doing so, setting out again once calm if it ran for a door on the way; buildings still held let out `broadcastShare` (half) of their residents. Those far from the corridor cross uncleared ground.
- **The queue and the tents** (the user's design, after the waiting crowded the barrier's end and stood on one another; `rescue.ts queueSlot`, `reachesQueue`, `tentsAt`, `sims.ts rankQueue`; `Sim.tent`, `World.tented`; `rescue.passEvery`, `queueRow`, `tents`, `cordon.queueGap`, `queueSpacing`, `queueRadius`). Those making for the rescue's exit join the queue within `queueRadius` (20 m) of its last row and stand in rows across the road behind the cordon line — the front row `queueGap` (10) m in from the barrier, places `queueSpacing` (1.2) m apart across the road and `queueRow` (1.5) m apart along it — each in a place of its own, in the order it came (the lower id first on a tie; ranked at the start of sim decisions), moving up as the front goes. Every `passEvery` (24) ticks — a truck's worth each truck's interval — the soldiers let the front one through, if it is at its place. It walks past the line to one of six tents beside the road beyond it (`tents`: three each side, 7 × 4 m, 3 m apart, the nearest 8 m out from the barrier; they appear when the rescue comes) and, at its door, is out of the city (evacuated). The wait has no patience and no flank: it is for a truck, among soldiers. Nobody is screened; the bitten get out with everyone else (`World.escapedInfected`). When the run ends, those still in the queue are left behind. Drawn: the tents in plan, an outline and a ridge, faintly filled while anyone waits in them. **A closed barrier stops people on foot** going outward (`movement.ts crossesFence`), not just routes: seen at tick 59,000 on seed 1, about 80 people panicked near the rescue's line had run from the dead straight past it to the end of the road and piled against the map's edge, and none were queuing. Only soldiers, those let through to a tent and those pressing on round are not held. And someone in the rescue's queue who panics keeps its place, cowering, among the soldiers. After: 97 in the queue at that moment, nobody past the barrier.
- **Trucks**, at the exit, every `truckEvery` (600) ticks: one pulls up beyond the barrier, loads for `truckLoad` (180), and takes up to `truckCapacity` (25) of those in the tents (`truckLeft`). It backs in from off the map and drives out again over `truckDrive` (20) ticks (`rescue.ts truckStop`; the worker draws the drive as one more van, `sim-worker.ts truckOnRoad`; the simulation's truck exists only while it stands). Drawn in army canvas, without a van's lights (`CAR_TRUCK`).
- **The gate** (the user's design; `rescue.gate` 1.5, `screenTicks` 6, `Sim.screenedUntil`). Everyone let through crosses the line at the same point, the middle of the barrier: walking there, it stops in the gate for `screenTicks` as if screened, then goes on to its tent. The queue's rows fill from the middle out, so the front one stands at the gate. When the rescue comes, the cordon squad at that exit moves its post to beside the gate, just beyond the line. **At the broadcast** (the user's design) that squad advances to the DO NOT CROSS line, `cordon.warnRadius` (75) m in from the barrier, and stands in line across the road between the queue and the city, against the dead the broadcast draws down it; it holds its fire on the living, as everyone at this exit does. A fresh squad of `squads.size` comes in from outside (outsiders, counted on top of the population) to take the gate, and with it the barrier, which a squad 75 m off, beyond `cordon.breachRadius`, would no longer hold. Drawn: two thin black lines across the barrier, `gate` either side of the middle, reaching just past it (`renderer.ts drawGate`, frame `rescueExit`, `rescueGate`).
- **Measured** (seeds 1 and 3, the default timing, commit 24dcaf5): the company comes in at the exit with the most people behind it; 5 and 3 of its 16 are still standing at the end, its front 2.1 km and 1.5 km up the corridor, 258 and 362 buildings swept. The broadcast sends 825 and 1,106 for the exit; 132 and 302 are still on the way half an hour later, the rest dead, turned or gone back to ground; the queue at the barrier peaks at 136 and 48; the trucks take 226 and 126, and 17 and 7 are left waiting when the run ends. 4 a run are shot by soldiers who took them for the dead. (With the company panicking, as it did at first, it was down to 2–3 of 16 within an hour and a half, the front stalled at 300–500 m, and no one was mistaken — the soldiers were dead before the broadcast.)
- **What the broadcast does to those who answer it** (`Sim.answeredAt`, set by anyone setting out for the rescue's exit after the broadcast; `rescueTally`): got out, died on the way, turned, still waiting at the barrier when the run ended, still out there. It is the darkest thing in the design — as a rule it kills more of those who answer it than it saves — and it is said on the end screen rather than buried, and printed per seed by the sweep. Read from the same function in both.
- **Swept** (mapSeed 1, runSeeds 1–8, 64,800 ticks, commit cdf4837). Gate 2 passes (loss in range 8 of 8 — now 85–90%: turned 48–51%, dead 37–39%); no stall. 809–1,149 answer the broadcast a run; 67–224 get out, 275–441 die on the way and 350–598 turn, 0–24 are left at the barrier, 2–50 are still out there: **about 85% of those who answer it are lost** — it kills five or six for every one it saves. The trucks take 104–241 in all. Tracked survival at the end, counted as alive and healthy in the city, fell to 0.7–0.9%, and the caution gate failed (z 1.9): everyone who could answer did, and those taken out were not counted as surviving. The gate now counts getting out as surviving (`survived` in the harness: healthy or evacuated).
- **Swept again with answering a choice** (mapSeed 1, runSeeds 1–8, commit 9f7bc86; survival now counts getting out). Both gates pass: loss in range 8 of 8 (turned 41–47%, dead 32–37%), no stall, and **caution separates survival as never before** — 10.9% / 18.4% / 23.7% (z 25.9): the cautious far from the corridor stay hidden and live. Trust now cuts the other way (21.2% / 15.7% / 16.1%, z −9.8): the sceptics stay put. Nerve z 3.2, sociality still nothing. 348–509 answer the broadcast a run (about half as many); 30–122 get out, 98–175 die on the way, 132–229 turn, 0–4 are left at the barrier, 23–110 are still out there — still about three in four lost. The trucks take 62–138 in all.
- **Sociality does not predict survival.** This is a result, not an open question. Across every sweep since the trait became per sim, survival by sociality band has separated nothing (z 0.5, 0.1, 0.3, 1.6, −1.3, −1.2, −1.0, −0.8; −3.2 once, over 20 seeds, joiners doing slightly worse). That holds through the stranger veto, cars, reservists, the cone, evacuation and the rescue. Going along with others and stopping to talk changes where people walk and what they know, but not whether they live. The reason was measured ("Hearsay arrives about the wrong places"): what is shared concerns places the listener is not going. Caution among the asocial still separating survival shows that information is worth having. The sweep keeps reporting the trait, ungated, so a change that makes it matter would show. **Cause found later**: grouping's costs act continuously and its benefits only at the instant of a test, when people are almost always alone ("Grouping is punished in this city", under the rescue).
- **Company steadies; solitude frays** (`config.company`, `ctx.company`, `features.company`; panic.ts). This is the first survival benefit to being with others: the side of the grouping trade that was never built. Scent makes groups easy to find and crowds die together; company is what they get back. Shared perception was considered and rejected as a hive mind. Shouts and contagion are the honest version of covering each other's blind spots, and how fast people react to a shout is the lever if the blind arc needs softening. Mutual defence comes next, separately.
  - **Who counts.** For the aware outdoors, company is the people within 8 m and in sight who are neither running nor frozen, read from the perception snapshot.
  - **With company,** panic decays at up to 1 + 2 × sociality times the usual rate, in full with four people near.
  - **Alone,** it settles not to 0 but to 0.25 × sociality. The gregarious alone stay on edge and the solitary do not. The floor sits below `memoryCutoff`, so it changes no one's routing mode, only whether their nerve holds when cornered, blocked or exhausted (`breaks`).
  - **Only the baseline moves.** No rise is damped, so witnessed turnings, noise and people running this way frighten a calm crowd as before. A crowd settles; it does not become fearless, and it can still tip into a stampede.
  - **Things to watch.** Whether loners (who never join, so are alone more) collapse: the sweep now prints survival and the mean panic of the aware outdoors by archetype. Prediction before the sweep (the user's): sociality's z rises above zero for the first time, and nerve's effect may rise with it, since the two now interact.
  - **Swept** (mapSeed 1, runSeeds 1–8, commit 7c21f48, on the new map that the name stream made; company on against `features.company=false`). Both gates pass either way. Company leaves survival where it was, and **the prediction fails**:

    | | company on | company off |
    |---|---|---|
    | sociality z | −0.3 | 1.0 |
    | nerve z | 0.7 | 1.1 |
    | trust z | −9.3 | −10.0 |
    | caution z | 22.8 | 23.4 |
    | loners | 30.0% | 28.4% |
    | civilians | 18.2% | 17.9% |

    Mean panic of the aware outdoors rises (civilians 0.115 → 0.177): most of the time people are alone, and the lonely floor holds them up. Loners do not collapse; they survive best of any archetype either way. Why damping does not separate anyone: it acts on the calm between shocks, over minutes. But a break is decided seconds after a shock, when each witnessed turning or nearby noise has added 0.25 and the cornered moment has come before any settling can matter.
- **Company moved into the test of nerve** (`panic.ts breaks`, `config.company.nerve` 0.3). The lonely floor and the faster settling are gone. The floor raised mean panic everywhere without separating anyone: a global shift rather than a differentiator, worth removing on principle. Now calm company acts at the moment of the test, which is decided in the seconds after a shock. When a sim is cornered, blocked or run to exhaustion, the panic it takes to break rises by up to 0.3 × sociality, in full with four calm people beside it (within 8 m and in sight). Only the calm count: those running or frozen are excluded, so a crowd mid-stampede steadies none of its members. Panic itself is untouched. The sweep also counts freezes per hundred people by archetype.
  - **What this sweep is for.** In both company sweeps loners survived best of any archetype (about 30% against about 18% for civilians): avoiding people protects, presumably because crowds carry scent, die together when a shelter falls and pass on panic. Mutual defence is the remaining candidate for a benefit to grouping large enough to outweigh that. If neither it nor this moves loners and civilians toward each other, the conclusion is that this city punishes grouping, and that is to be stated, not engineered away.
  - **Swept** (mapSeed 1, runSeeds 1–8, commit 7dd4dcb, company on against off). Both gates pass. Company off reproduced the earlier off sweep exactly.

    | | company on | company off |
    |---|---|---|
    | sociality z | −1.6 | 1.0 |
    | nerve z | 3.4 | 1.1 |
    | trust z | −9.5 | −10.0 |
    | caution z | 20.6 | 23.4 |
    | civilians survived | 18.4% | 17.9% |
    | loners survived | 28.8% | 28.4% |
    | freezes per 100 civilians | 72.8 | 71.8 |

    Company still separates nothing, and loners still lead by ten points. **Why: it is seldom there when it would count.** Freezing sims, seeds 1–2 to tick 30,000, about 2,000 freezes each: 80–84% had no calm company at the moment, and 4–5% had the full four. Half had someone outdoors within 8 m, but running or frozen themselves; 17–20% had people running toward them. By the time anyone is cornered, the people around them have already run. A crowd steadies its members only while it is calm, and while it is calm nobody in it is being tested. Kept on: it is cheap, harmless, and right in the few cases it reaches.
- **Mutual defence, probed before building** (seeds 1–2 to tick 30,000, sampled every 5 ticks; ordinary sims only, not squads or crews). This counts unarmed people in contact with a zombie, 6,000–10,000 samples a seed. An armed person who is not frozen stood within 5 m in 2–3% of them, within 10 m in 3–5%, within 20 m in 6–8%. A loaded firearm was within 20 m in 1–2%. So mutual defence could reach at most a few percent of attacks, even if every intervention saved the victim: too few to close a ten-point gap. It has the same cause as the company result. At the moment of contact people are seldom together, and those who were have already scattered.
- **Cohesion, tried and reverted** (the user's experiment). The idea was a weak pull toward the living within 12 m and in sight, × sociality, while running alongside the crowd's current: the dead's own flocking, with no leader and no membership. The question was whether crowds would then hold together through a shock and the 80–84% figure would move. On seeds 1–2 to tick 30,000 it did not. Freezes with no calm company were 84% and 81% with cohesion, 84% and 80% without. Freezes rose 6–15% (2,072 against 1,960; 2,312 against 2,019), and on seed 2 those with people running toward them rose from 20% to 35%. Cohesion keeps people together, but what it keeps together is people running. That spreads panic and steadies nobody. Not adopted.
- **Grouping is punished in this city, by a structural asymmetry.** This is the finding of the company sweeps, the mutual defence probe and the cohesion experiment.
  - **Costs act continuously.** Scent scales with how many are inside, a shelter that falls takes everyone in it, and panic passes from person to person.
  - **Benefits act only at the instant of a test.** Company steadies nerve and armed neighbours fight, but only if they are present and calm when someone is cornered, blocked or attacked.
  - **They almost never are.** 80–84% of those who freeze have no calm company at that moment, and armed help is within 10 m of 3–5% of unarmed people attacked.
  - **This is the load-bearing number, and it is not a tuning failure.** By the time someone is being tested, anyone near them is running or frozen too. Calm company and dangerous situations are nearly disjoint, and no weight on company's effect changes that.
  - **So this is not a balance problem** that a stronger benefit could fix. Things that act over time are set against things that act in a moment.
  - **Loners show it.** They avoid people and pay none of the continuous costs, and survive best of any archetype: about 29% against about 18% for civilians.
  - **It explains the sociality null.** Every sweep since sociality became per sim has found it predicts nothing: going along with others buys none of the moment-of-test benefits and avoids none of the costs. The null was an open question; this is its cause.
  - **What stays.** Company is left on, cheap and correct in the few cases it reaches. Mutual defence is not built: its reach was computed beforehand, and at 3–5% coverage it could not close a ten-point gap even at perfect efficacy.
- **Final state, 20 seeds** (mapSeed 1, runSeeds 1–20, 64,800 ticks, commit 09a6cc4; 2,848 s wall). **Both gates pass 20 of 20:**
  - **Gate 2:** the invariant holds every tick; loss is in range in 20 of 20, ending at 44–48% turned; no run resolves early.
  - **Gate 4:** shelters form, fall and re-form in 20 of 20, with no stasis.
  - **Survival by caution:** 13.7% / 20.0% / 25.7% (z 37.5). Split at the broadcast: up to it z 11.6, after it z 48.7.
  - **Other traits:** trust z −16.1, the sceptics living; nerve z 5.2; sociality −1.2.
  - **By archetype:** loners survive 28.9% against 20.3% for civilians.
  - **The broadcast:** 469–769 answer it a run, 30–225 get out, and the trucks take 73–263.
  - **The roster:** no seed had a stretch with no named person alive in the city. The gap seen once on seed 2 was an oddity of an earlier state; the re-score needs no change.
  - **Cost** (`scripts/bench.ts --ticks 64800`, two fresh runs): 458 s for the full run, 7.06 ms a tick. The busiest stretch is at ticks 58,000–59,000, the rescue's last hours, at 13.1 ms a tick; elsewhere 6–9 ms. At 8× that is under a tenth of each second.
- **Caution split at the broadcast, measured** (old map, commit 7796794): up to the broadcast 23.1% / 23.9% / 27.0% (z 6.8); after it, of those still in the city, 38.4% / 72.7% / 85.3% (z 34.9). Caution's large separation is the broadcast's choice — the careless answer it and die on the way — and its effect over the outbreak itself is the modest one earlier sweeps found. On the new map, z 7.7 before and 29.7 after with company, 7.5 and 29.9 without.
- **The end screen says what trust did** (`EndSummary.trust`, `sim-worker.ts trustSplit`): of those still in the city when the broadcast went out (outsiders aside), how many doubted the radio (trust below `rescue.trustFloor`) and how many believed it, and the share of each who lived or got out. The sceptics' better survival is the broadcast's doing, and the viewer should not have to read it off a sweep.
- **Caution split at the broadcast** (the sweep's `cautionSplit`, ungated): survival by caution band up to the broadcast (of those spawned by then, still in the city or already out at it), and after it (of those in the city at it, healthy or out at the end) — to say which phase caution's separation comes from.
- Off with `features.rescue`.

### Ending

One terminal condition for the demo: the timer, at 50,400 ticks (36,000 until the fourth round). Stalemate is handled by the controller rather than by ending the run. The rescue is a v2 ending and is not built.

## Presentation

Reads simulation state, never writes it. Top-down on a plain canvas, not isometric — with dots and outlines, isometric buys nothing visually and costs coordinate transforms and occlusion logic.

### Visual language

Near-black background. Buildings as thin single-pixel outlines in dim grey, unfilled, so the city reads as a wireframe plan rather than an illustration. Streets are negative space. Nothing textured, nothing shaded.

**Colour carries state and nothing else.**

| Element | Colour | Note |
| --- | --- | --- |
| Living sim | Cool desaturated white | — |
| Zombie | Dim red | — |
| Dead | Dark grey | Painted into the corpse buffer, never an entity |
| Building outline | Dim grey | — |
| Building occupancy | Faint white fill | Opacity tracks total inside; a block emptying is visible as it dims |
| Contested building | Pulsing outline | The only way interior fighting is visible |
| Street lighting | Faint warm | The one terrain colour; it is not a population state |

The arc of a run is then legible at a glance as a field of white draining to red, with grey accumulating where it went badly.

**Occupancy fill does not distinguish residents from occupiers.** Deliberate: a sim cannot tell either, and neither should the viewer.

**Corpses are paint, not entities.** Nothing in the simulation reads them — they do not attract, block, or tick. Each death is drawn once into an offscreen buffer composited *under* the live layer and never touched again, so the cost is constant regardless of how many accumulate, and they cannot visually compete with the living because they are literally beneath them.

Opacity fades toward a floor of about 0.25 over 1,200 ticks rather than persisting at full strength. Recent deaths read clearly; older ones sink into background texture. Without the fade, two thousand deaths carpet the late map in grey at exactly the point the remaining red and white most need to be legible.

Destroyed zombies and dead humans use the same grey. Two dark shades will not separate at dot scale, and the ticker already says who died. The corpse layer is the only thing on screen that remembers, and what it remembers is where the run went wrong — the first breach, the street a shelter died on, where someone made a stand.

### Zoom

Representation changes with zoom, not just scale.

| Mode | Threshold | Draws |
| --- | --- | --- |
| Far | < 0.3 px/m | Density field on a coarse grid. No individuals — 2,000 one-pixel dots is mush |
| Mid | 0.3–1.5 px/m | Individual dots |
| Near | > 1.5 px/m | Dots, motion trails, labels on promoted survivors only |

**Motion trails are the cheapest way to make it feel alive.** A dot is static information; a dot with two seconds of fading history behind it shows panic as a shape, and crowds fleeing a breach become visible as flow. A slow pulse on newly converted zombies makes conversions register as events rather than silent colour swaps.

### Camera and roster

The camera is free — the viewer pans and zooms at will, and nothing automatically frames the interesting thing. The ticker and roster carry the directorial load instead.

The roster lists promoted survivors; clicking one centres and tracks them. Click-to-inspect works on anonymous sims too, since the fields already exist. Promotion means tracking and ticker presence, not whether a sim has an identity.

### Inspecting

**The viewer sees ground truth.** This is the whole dramatic engine: you know more than the people do. Watching a survivor choose a building while the panel shows twelve zombies occupying it is the design's best moment, and hiding it would make that moment invisible. The sim's beliefs are shown on the sim's own panel; the world's state is shown on the world's.

Clicking a building centres the camera, outlines the footprint so the selection stays visible while panning, and pins a compact corner panel.

**Interior population is drawn as squares in the panel, never as dots on the map.** A building can hold a hundred people in a footprint smaller than a street is wide; placing them would be unreadable and would imply interior geometry the simulation does not have. Three classes, matching the three populations a building actually stores:

| Square | Class | Clickable |
| --- | --- | --- |
| Dim white | Anonymous residents present at spawn | No — they have no identity |
| Bright white | Tracked sims who entered during the run | Yes, through to tracking |
| Red | Occupying zombies | No |

One square per person up to 60, then one square per five with a numeral, so a large building stays a readable grid rather than a wall of pixels.

The rest of the panel: tag and street name, integrity and fortification as bars, materials, breach and contested state, and a filtered event history for that building — when it was breached, who arrived, what fell. The history is what makes it a place with a past rather than a status readout.

**Clicking a street** shows its name, remembered danger averaged across sims who know it, lit state and `blocked` value. Mostly a debugging affordance, but it is also the only way to see the graph the memory system runs on.

Inspection is available at mid and near zoom only; far zoom draws a density field with no individual buildings in it.

**Keep it compact.** The risk is the panel becoming the way the run is watched. If it is rich enough to read instead of the map, the visual design stops mattering. Corner-anchored, never modal, and nothing in it that is not legible at a glance.

### Salience

The filtering problem, not the logging problem. Two thousand sims generate thousands of events per tick and almost none deserve a line.

```
salience = baseWeight * rarity * involvement * proximity
```

| Term | Value |
| --- | --- |
| `baseWeight` | Per event type, below |
| `rarity` | `1 / (1 + occurrencesOfThisTypeInLast600Ticks)` |
| `involvement` | 3.0 promoted survivor, 1.5 armed sim, 1.0 otherwise |
| `proximity` | 1.5 inside the viewport, 1.0 outside |

| Event | Base weight |
| --- | --- |
| Promoted survivor dies or turns | 100 |
| Cascade threshold crossed at a shelter | 80 |
| Occupation contested | 60 |
| Building breached | 40 |
| Shelter falls | 40 |
| Scavenger returns with materials | 25 |
| Promoted survivor changes district | 20 |
| Weapon found | 15 |
| Anonymous sim converted | 2 |

The display threshold scales with speed, so 8× surfaces only the large events. Significant events auto-drop speed to 1× — a promoted survivor dying at 8× should pull the viewer back.

**Copy.** Entity ids read as debug output. Promoted survivors use their names; anonymous ones are "a survivor", never a number. Streets and districts are named, which is what makes a ticker line about somewhere off-screen mean anything. Every entry is a button: clicking centres and tracks the subject.

### Audio

Reads off the stimulus system rather than sitting beside it — the gunshot that recruits the horde is the same event that plays, so the soundscape is a readout of the simulation.

Author as `.wav`, ship as `.ogg` or `.m4a`; uncompressed masters are fine on disk and wrong over the wire. Web Audio, not `<audio>` elements: decode each file once into an AudioBuffer, and per event create a throwaway source node routed through a panner set from position relative to camera, then a category gain, then master. Source nodes are meant to be created and discarded constantly.

**The funnel is the work.** Same problem as the ticker and the same solution: score, then play only the top handful per frame. Cull outside the viewport, cap concurrent voices per category, and play no per-agent zombie sounds at all — drive one looping moan bed whose gain tracks local zombie density. That single decision removes most of the problem.

Above 4×, thin; above 8×, mute all but the largest events. Add slight random pitch variation per one-shot or identical gunshots become obviously synthetic within seconds. Browsers block audio until user interaction, so resume the context on first click; the scenario starts paused regardless.

### End-of-run statistics

**Built so far** (`ui/end.ts`, the worker's `ended` message at the last tick): the city's totals — got out, dead, turned, alive inside — and what became of those who answered the rescue's broadcast, with the line that it killed more than it saved when it did; the trucks' total. Read from the same place as the sweep metrics, so the end screen and the headless output cannot disagree: evacuated versus dead, peak horde size, largest survivor group, longest-surviving named sim, highest kills by one survivor, shelters established and lost, survival rate by caution band, and the infection curve over time.

## Build order

Each gate is a question with a yes or no answer. A milestone is not done because its code exists; it is done when its gate passes.

1. **State shape** — types for Sim, Zombie, Building, Street, District, World, plus `config.ts`. No behaviour, no rendering.
2. **Headless loop** — tick order, movement, infection, perception, threat. Prints the eight counters. Text output only.
3. **Renderer** — canvas, three zoom modes, trails, free camera, ticker with salience, roster, time controls.
4. **Shelter economy** — roles, fortification, materials, scavenging, occupations, memory merging, promotion, audio. Built before 3 (except audio, which needs the browser): without it a full run empties the streets.
5. **Cars** — mobile occupancy containers on the street graph. Jams and abandonment, not traffic modelling.

&#91;embedded content: build order · 5 milestones, 4 gates\]

**Milestone 2 is the one that matters.** The deliverable is a script that runs a full run (now 50,400 ticks) from a fixed seed and prints the eight counters every 600. A text dump takes seconds to read; a renderer takes hours to build, and the question it answers — whether the infection curve has any shape — is answerable without one.

That output doubles as the first test. The invariant assertion runs every tick, which is what keeps a growing simulation from silently rotting.

### What the gates mean

| Gate | Passes when |
| --- | --- |
| After 1 | Every field has a type, a range and a unit. Coordinates and tick length are settled. No field exists that nothing reads |
| After 2 | The invariant holds for a full run (now 50,400 ticks) across 20 runSeeds on one mapSeed; infection reaches 40–90% of population in at least 15 of them; no seed resolves in under 3,000 ticks |
| After 3 | The city is legible at a glance at mid zoom; 2,000 agents hold 30 fps at 8×; the ticker surfaces fewer than 6 lines per second at 1× |
| After 4 | Shelters form, fall and re-form; no seed settles into stasis with the controller off; survival differs measurably by caution band |

**The second gate is the real one.** If the infection curve is a straight line to total conversion, or fizzles below 40%, nothing downstream saves it and the parameters need work before any renderer is written.

### Sweep targets

A sweep needs something to optimise. "Interesting" is not measurable; these are:

- Survivors alive at the end, and variance across seeds — low variance means the outcome is determined, which is the failure mode to avoid. **Restated (the user's, after the 20-seed sweep of the final state):** the variance that matters is in the trajectory, not the endpoint. Read it in the first hour (turned 159–651 over 20 seeds) and the middle of the run: when and where the outbreak takes the city. This target was written when runs ended mid-curve and the worry was that nothing differed between seeds. Now every run converges to 44–48% turned, because the outbreak reliably takes the same share before the rescue and the clock end it. That is a stable system, not a determined one.
- Duration of the middle phase, from first cascade to promotion
- Count of events above salience 40 per 1,000 ticks
- Peak horde size, and whether splintering bounds it
- Shelters established, and the ratio that fall to occupation contest rather than breach

### Scope note

Milestone 2 with three archetypes and no shelter economy is already a complete test of whether the core idea works. Everything after is an addition to make or not make. If the project starts feeling large, cut scope rather than changing approach.

Before any of it, a `CLAUDE.md` carrying the fixed constraints from this document — the invariant, the module boundaries, the config rule, what may read `phase` and `panic` — so they survive across sessions.

## History

What changed after the design above was written, in order: the decisions made while building each milestone, the rounds of revisions after watching the viewer, and the bugs the user saw. Entries that define behaviour are part of the specification; where one changes a rule stated above, the entry is newer and says so (or a later entry supersedes it). Sweep results are recorded where they were run.

### Revisions from the milestone 1 consultation

- **Knowing who is infected is local.** `infectionWitnessed` is gone. Each sim carries `knownInfected`, a set of sim ids it has seen bitten, merged by union on encounter. Admission checks the sets of the sims currently inside.
- **Building beliefs.** Each sim carries `buildingMemory`: building id → believed occupants, materials, fortification and `observedAt`, written on entry or a close pass and merged by recency like street memory. Shelter selection and migration read it.
- **Eight counter leaves.** `turned.symptomatic` joins the invariant now; the zombie leaf inside buildings is `turned.occupying`.
- **Sim `condition`** (`healthy`, `infected`, `dead`, `turned`) replaces `status`; location is `insideBuilding` alone. Turned sims keep their record so ids and history survive.
- **Zombie `state`** (`active`, `dormant`, `wandering`, `feeding`, `occupying`, `destroyed`) replaces separate flags, with `stateUntil` for the timed states. Destroyed zombies stay in `zombies[]`, so ids are stable. A converted sim gets a new zombie id, with `wasSim` set.
- **Two seeds.** `mapSeed` and `runSeed` seed two independent PRNG instances. A sweep varies `runSeed` against one fixed `mapSeed`, and editing generator code never shifts the simulation's draws. Within map generation, names (districts and streets) draw from a third stream seeded from the map's (`generate.ts`, `NAME_STREAM`), so that editing a name list, or a collision redrawn, never moves the city. Until that split the names shared the layout's stream and a changed word could move every building after it; isolating them changed every city once (sweeps before that commit are on a different map 1). People's names, drawn at promotion from the run's stream, take a fixed two draws whatever the lists hold.
- **Release trigger is a tick:** 600, with ±150 per-district jitter drawn at setup and stored as `releaseAt`. Never infection-based, which would tie the opening to the quantity the gate measures. Display phase is derived from release state and promotion, not stored.
- **Routine.** `destinationKind` gains `routine`: pick a tagged building weighted by profession, walk there, idle 200–600 ticks, pick another. This is what unaware sims do.
- **Derived, not stored:** sim speed (range 0–2.9 m/tick before the age factor) and perception radius, building integrity (from tag) and `contested`, `timeOfDay`, `ticksSurvived` and `ticksAlone` (from tick stamps), and `promoted` (a name is assigned).
- **Occupancy follows time of day.** Starting residents are the indoor share of population divided across buildings by tag weight × time-band multiplier, so the two cannot disagree.

### Decisions made building milestone 2

Choices the specification left open, made while implementing the headless loop. Each is small and reversible; all tuning values are in `config.ts`.

- **Patient zero is one of the residents.** The origin building loses a resident and gains an occupier, so the population total never changes.
- **The origin is weighted by its neighbourhood.** Among eligible buildings (hospital, office or school with 30+ inside), the choice is weighted by the people living within 300 m. Uniform choice sometimes put patient zero in a suburban school in an empty corner at 09:00, where the bloom had nowhere to go — in effect the `street` control case. Corner origins remain possible, just rare.
- **Population is 6,000** (was 2,000). Residents are counts and nearly free; the cost is agents on the map, which peak around 1,700 at this population — inside the renderer's 2,000-agent budget. 12,000 put about 3,000 agents on the map.
- **Dormant zombies do not use sight.** They wake on sound at or above `wakeThreshold`, or on a sim in contact range. Sneaking past a sleeping cluster works because of this.
- **Footsteps are not stored stimuli.** Running and sprinting are heard only by zombies inside the gait's noise radius at that moment. Stored stimuli are weapon noise only.
- **Residents have no panic of their own,** so expelling them reads gunfire instead: a stimulus within the occupier alert radius queues a share of the building's residents to leave (`buildings.residentExpelShare`). Tracked sims inside are expelled by their own panic, as specified.
- **No contest inside occupied buildings yet** (milestone 4). A sim who reaches an occupied building meets the occupiers at the door, takes one contact roll, is turned away, and triggers the spill. A zombie appearing inside a building (breach or conversion) gives each tracked sim inside one contact roll, then drives them out.
- **Idle zombies drift up the scent gradient,** toward the entrance of the strongest nearby source, as well as waking faster near it. Outdoor-cluster scent is not built yet.
- **Archetype from profession is a bias, not an override:** the scenario mix with the profession's archetype multiplied by `professionBias`. As an override it made police about 10% of the population.
- **Not built yet:** the cornered modifier (needs an escape-vector test). The shelter economy and roles followed in milestone 4, below. (The escape-vector test now exists, for the fight, flight or freeze rule under "Survivor behaviour revisions"; the ×1.4 on the zombie's roll is applied against a cornered victim since the cornered fix, below.)
- **Reaching a door ends the flight.** Entering a building caps panic just below `panicExpelThreshold`. Otherwise a sim who ran in panicked is expelled by that same panic the next tick and bounces in and out of the door; expulsion is meant to come from panic that rises inside.
- **Memory is capped.** With terraced streets a close pass touches dozens of buildings, so building memory holds the 30 newest beliefs and street memory the 150 newest; older observations are forgotten, which reads exactly like an unknown entry.
- **Movement follows walls with hysteresis.** A blocked agent slides along the obstacle at 70% speed, keeping to the side it chose until its direct way opens (`Sim.slide`, `Zombie.slide`). Scaling progress by the cosine of the deflection left agents heading into a wall nearly stationary (9% of moving sims, 27% of zombies), and choosing a side afresh each tick made them zig-zag.
- **Avoidance holds.** A sim that steps away from a threat keeps going for 15 ticks after the threat drops out of sight (`Sim.avoidUntil`). Without it, a zombie flickering at the edge of view flipped the sim between avoiding it and walking its route every tick — the visible zig-zag. Re-planning the route on sight was tried and made reversals more frequent.
- **A refusal is remembered.** The building that last turned a sim away is excluded from its door and shelter choices (`Sim.refusedBy`). A panicked sim otherwise ran back to the same occupied door every tick, taking a contact roll each time.
- **Idle agents tick cheaply.** Dormant zombies check for waking every 4 ticks; awake zombies with nothing tracked, heard or seen re-decide every 3 ticks (sight still interrupts immediately); scent is a grid rebuilt every 30 ticks. Memory merges are limited to one per sim per 30 ticks.
- **Spatial hash cell is 32 m,** not 16: the per-rebuild cell scan dominated the profile, and the reference also asks for a cell above the largest query radius.
- **State added:** `Sim.street` (the street the sim is on, kept while within half its width), `Building.pendingSpill`, and `World.residentDeaths` (anonymous residents killed in a breach — the only record the full recount can count them from).

### Revisions after milestone 2

- **Run length is 36,000 ticks** (was 21,600): five whole day/night cycles at `dayLength` 7,200, so the run ends at the same time of day it began. (Since the fourth round, 50,400: see "Run length 50,400".)
- **Promotion is two-stage** (provisional at 50% living, re-score at 30%) with an append-only roster; see Promotion. It was 8% living, which at 6,000 population would have named survivors only once the city was nearly gone.

**Tuning that passed the milestone 2 gate** (swept from the guessed defaults): zombie `dormantAfter` 300 → 1,200 ticks, `wanderRate` 0.0002 → 0.001, scent `idleDrift` 0.02 → 0.2, breach split 45/20/35 → 60/10/30 (turn/die/expel), and breach `base` 0.05 → 0.35 (0.15 passed on the old one-building-per-block map; subdivided blocks put most people in small houses, where a breach yields one or two conversions, so breaches had to come more often). On the current map at a population of 6,000, after the movement fixes (agents no longer stall against walls), mapSeed 1 has 20 of 20 runSeeds between 40% and 90% infection (65–68%, with about 24% dead without turning); the invariant held on every tick of every run, and no run resolved early. At the 36,000-tick run length the gate still passes 20 of 20 (72–74% turned, 23–26% dead; wall time about 20 minutes). The curve flattens after about 25,000 ticks, and from about tick 11,000 almost nobody is outdoors: with no shelter economy, nothing brings the sheltered back out — milestone 4's job. **Was open:** the spread across seeds is now only about 2 points; the sweep targets treat low variance as the outcome being determined, so this is the first thing milestone 4 tuning should look at. **Since:** the spread is no longer narrow. Openings differ widely (turned in the first hour 274–630 over eight seeds, latest sweeps), runs have smouldered or taken off, and the ending is shaped by the rescue.

### Decisions made building milestone 4

Built ahead of the renderer: without it, a 36,000-tick run had almost nobody outdoors from tick 11,000. Audio belongs to milestone 4 in the build order but needs the browser, so it comes with or after the renderer. Everything below is in `systems/buildings/shelter.ts` and `systems/buildings/buildings.ts`, and every number is in `config.ts`.

- **Residents take part, anonymously.** Mid-run about nine in ten of the indoor living are anonymous residents, spread one or two to a house. An economy run only by tracked sims would leave them sitting until a breach. So a building is **alerted** once its people learn of the outbreak: a zombie seen from the door (within 30 m of an entrance, no line of sight needed — they look out of the windows), gunfire within 40 m, or a frightened arrival. Only an alerted building fortifies or sends anyone out. Up to two residents work as builders, since fortification is addition and needs no identity. When the building needs materials and has no tracked sim to send, one resident steps out and becomes a tracked sim, keeping its identity from then on. It knows the 30 buildings nearest home within 250 m as they stand — residents choose better than newcomers, as the shelter section expects.
- **Fortification approaches 1 asymptotically** while there are materials: `f += (1 − f) × 0.002 × crew` per tick, with `crew` materials consumed every 50 ticks. Unattended, `f −= f × 0.0005` per tick, and below 0.001 it is gone.
- **Roles.** Builder while there are materials and fortification is below 1. Scavenger when materials are at 0, the door is quiet (door threat under 0.2), nobody is already out for this building (`scavengerOut`, one at a time), and this sim is the least useful inside: usefulness is engagement capacity plus caution, so the unarmed and incautious go first, ties to the lower id. Dispatcher: an armed engager while door threat is above 0 and under its engage threshold; it holds by the door for 300 ticks engaging what it can see, and goes back in early if outmatched or out of ammunition.
- **The trip.** The target is the remembered building with the best believed stock (up to one load of 8) over distance. On the way the scavenger pushes on past 0.3 more threat than its archetype's shelter-seek threshold before turning for home, which is how it brings the horde to the door. Materials are delivered to whichever shelter it ends up in. Buildings' stock is finite, so over a run the city is stripped.
- **Nobody has to stay behind.** One person staying was the first rule; it left lone residents — a large share of the indoor living — sitting out the run in houses whose fortification decayed. Swept to 0: a lone resident goes out and the house stands empty meanwhile.
- **Loot:** one roll at 0.3 per entry on a scavenging trip; a weapon is taken when it raises engagement capacity, ammunition comes in finds of 4–12 rounds. The `materials` loot entries are ignored, since stock models materials.
- **Arms are finite and move about** (`systems/fighting/arms.ts`, after the melee breakdown, "Where melee kills come from"). Each building holds a few things from the start (`Building.stock`, `buildings.lootStock` items drawn by the tag's loot weights: a house 1 — one knife block, not an endless one — a firearms store 8, a police station 5, a hardware store 6, a workshop 3, a supermarket 2, the mall 6); the roll on entry takes one of them, and what is taken is gone. Nothing is destroyed either: a weapon given up for a better one is left in the building's stock; one carried by someone who dies or turns stays where they fell — in the stock indoors, on the ground outdoors (`World.drops`), where the nearest living sim within `buildings.pickupRadius` (2 m) that it would make more capable picks it up, leaving its own. So the city's arms move about rather than only running down. A reservist drawing a rifle leaves its own pistol at the depot. Stocks are drawn from a copy of the run's stream, so setup is otherwise unchanged.
- **The occupation contest** is as specified, fought against the occupiers as a count with the ordinary weapon numbers: melee kills on a hit (a miss rolls infection), ranged at contact-range falloff, a shotgun up to three. The occupiers strike each sim inside every 10 ticks at the base infection chance, with the usual bite-or-feed table. Gunfire inside is heard outside at half radius. A sim inside reassesses the odds every tick and withdraws if they turn. Withdrawing, at the door or from inside, costs one occupier strike. Occupiers do not spill while a contest is on.
- **Barricades cut both ways for every exit,** panicked ones included: a sim expelled by panic or fleeing an occupation waits out the exit time, under attack if occupiers are inside.
- **Commit on choice.** A sim with a shelter goes home when it seeks shelter. The shelter is dropped when it falls (expelled by an occupation, or turned away at its own door); migration is checked on the role cycle.
- **News travels indoors.** A sim entering a building merges with everyone already inside — how a scavenger's discovery reaches the household, and how migration pulls a group after its least cautious member.
- **Migration** as specified, with its three brakes, and only while the door is quiet.
- **Garrisons.** A building counts as an established shelter when it is alerted, holds at least 3 living, and fortification has reached 0.05 (`shelterEstablished`). It falls when occupied (`shelterFell`); emptying ends it silently. Garrisons are counted for the gate and the end screen.
- **Cascade.** Each garrison checks every 10 ticks. At 15 or more awake zombies within 30 m of an entrance it emits `cascadeCrossed`, and while it stays above, the crowd stays awake and is drawn to its own centroid rather than to whatever brought it: a siege. Below, the next check clears it.
- **Caution now reaches behaviour** in three places: the danger term of route cost is scaled by `0.5 + caution` (averaging 1), migration's hysteresis, and who is sent out.
- **State added:** `Building.alertedAt`, `scavengerOut`, `garrisonedAt`, `cascadeAt`; `Sim.sortieUntil`; events `shelterEstablished` and `buildingRetaken`.
- **The milestone 4 gate, made mechanical** in the sweep: shelters form, fall and re-form (a garrison established after the first fell) in at least 15 of 20 seeds; no seed has 3,600 ticks (half a day) with no conversion, death, kill, delivery or breach while anyone is alive; and survival differs by caution band — tracked sims alive and healthy at the end, lowest band against highest, pooled over seeds, `|z| ≥ 2`. Anonymous residents never instantiated have no caution and are left out.

**Tuning with the economy in place:** breach `base` 0.35 → 0.2 and `minStayBehind` 1 → 0. With the economy at the old breach rate, survivors were about 3% at the end and the streets emptied by tick 25,000. On 20 runSeeds of mapSeed 1 the tuned values pass both gates. All 20 are at 58–61% turned and 32–34% dead without turning, with the invariant holding throughout. Each run establishes 740–820 garrisons, of which 500–560 fall. There is no stasis (the longest quiet stretch was 1,164 ticks). Survival by caution band is 8.5% / 9.6% / 9.6% from least to most cautious (z 4.7). Wall time is about 28 minutes. **Was open:** the caution effect is real but modest, about a point, and comes from the low band doing worse rather than the high band doing better. Seed spread is still only about 3 points; and the economy raised the peak cost to about 10 ms per tick, which the renderer's 8× budget has to absorb. **Since:** caution separates survival clearly (z 6.5–7.7 up to the broadcast, larger after; "Caution split at the broadcast"); for the cost per tick, see the current timing under the rescue.

### Movement revisions after milestone 4

Found by watching the viewer, then measured before changing anything.

- **Survivors no longer walk back into what they fled.** The zig-zag seen by the river was the common case of a loop: a sim sees a zombie, avoids it, holds that course for 15 ticks after losing sight of it, then resumes a route that still runs through the zombie. Over seeds 1–3, 0.71–0.77 loops per 1,000 moving sim-ticks; only about 5% were near the river, and the zombie was visible only about 9% of the time. Fleeing sims were almost never cornered (under 1% of fleeing ticks made no progress, none by the river), and water was already excluded from steering. Now, on a fresh sighting, a sim records the zombie's street as dangerous (an observation), anyone heading somewhere other than a routine stop re-plans at once with that knowledge (danger seen ahead skips the repath queue), and a walker on a routine who has just stopped avoiding picks a new stop, weighting stops behind it at 0.1 (`behaviour.scaredBehindWeight`). (Superseded: a sim that has seen a zombie is now aware of the outbreak and drops its routine altogether; see "Survivor behaviour revisions".)
- **Sightings are shouted.** Everyone outdoors within 30 m (`encounters.warnRadius`) learns the street is dangerous, heard in the encounters step so decisions stay decide-then-apply; anyone whose route uses that street queues a re-plan. The shout is a stimulus (kind `shout`, intensity 0.6, `behaviour.shoutIntensity`): the dead hear it too, nearby survivors are frightened by it as by gunfire, occupiers nearby may spill. It alerts buildings but, unlike gunfire, drives no residents out.
- **Survivors go round danger they can see.** Of first contacts between a survivor and an awake zombie (seed 1), 77% were the survivor walking in, nearly all having seen it — 42% while heading for shelter (that branch had no avoidance at all) and 30% in panicked flight to the nearest door. Anyone following a route or running for a door now bends its heading away from visible danger ahead (`behaviour.avoidWeight` × threat × how directly ahead it is; head-on, to the side away from it; danger behind or beside changes nothing), and a panicked sim's nearest door counts three times as far if it lies toward the threat. Walk-ins halved (1,022 → 513) and loops fell to 0.11 per 1,000 moving sim-ticks. **Was open:** most remaining walk-ins are panicked sims already inside a crowd (threat ≥ 0.6) — the cornered case. The reference's cornered modifier, and a rule for having nowhere to go (fight if armed, take any door, or freeze), would be the fix. **Since:** the cornered rule (fight, flight or freeze) and the cornered distance gate handle it.
- **Sweep after these changes** (mapSeed 1, 20 runSeeds): both gates pass 20 of 20. 59–62% turned, 32–35% dead; about 940 shelters established per run (shouts alert more buildings early); survival by caution band 7.1% / 7.7% / 8.5% (z 6.6).

### Decisions made building milestone 3

The viewer, built after the shelter economy. Everything here is presentation: none of it changes what the simulation does.

- **The simulation runs in a Web Worker** (`src/worker/sim-worker.ts`), which owns the World and the wall clock, as the headless harness does. It steps at the requested rate in slices of at most 10 ms so messages are handled between them, and if it falls more than a quarter of a second behind it drops the debt rather than bursting: the run slows, it never skips ticks. The main thread asks for a snapshot each animation frame; positions, kinds, building fill and flags travel as transferred typed arrays, so the page never holds simulation state.
- **Events are annotated in the worker, when they happen:** who (a name only if promoted), armed or not, and where in words — "the hardware store on Elm Street", with the district. The ticker composes copy from those notes. A few tags get nouns: residential is "a house", firearmsStore "a gun shop", office "an office block".
- **Salience** is as specified, with three event kinds the table does not list: `buildingRetaken` 50, `shelterEstablished` 10, an anonymous death 1. The bar is 10 at 1× and scales with speed. A repeat of the same kind at the same building within the 600-tick rarity window is suppressed — a breach and a conversion inside the same house otherwise read as two breaches. A cascade drops playback to 1×, and so does a named survivor's death or conversion — but only if they had been named for at least 3,600 ticks (`playback.dropTo1xNamedFor`), someone the viewer has had time to follow. Dropping for every named death interrupted an 8× run about every 15 seconds once the roster tops up; now 11 times in a run, about every 41 seconds. Measured headlessly over a full run of seed 1 with every event counted as on screen (`scripts/ticker-rate.ts`): 0.12 lines a second on average at 1×, 3 in the busiest second (gate: under 6).
- **Roads, drawn** (the render team's pull requests #1 and #2, reviewed and adjusted): over the street surface a lighter carriageway fill (`ROAD_FILL`), a faint kerb line where the road meets the ground (`ROAD_EDGE`; drawn along each side and then covered where it falls inside another road, so only the kerb shows), and on roads wider than 14 m a dashed centre line at near zoom (`CENTER_LINE`), stopped short of each junction by half the widest road crossing there. All in the cached static layer.
- **Merged from the render and audio teams** (reviewed: check, screenshot): **street lamps** — kerbside lamps on lit streets, staggered from kerb to kerb about 22 m apart, each a warm glow stamped from one pre-rendered sprite, drawn only within the cached static layer, glows left out at far zoom (a faint stroke on lit streets instead), lamp heads at near zoom only and dimmer than any agent (`render/lamps.ts`). The glow is the soft one: radius 16×4/5.5 m, so a 20 m road's pools still meet over the carriageway, core alpha 0.22 at near zoom, and no hotter centre at mid. Placed from `map.streetLit`, so the lit streets drawn are the ones perception treats as lit. **Road hierarchy** — main roads lighter with stronger kerbs, alleys darker and fainter. **Street names** along the roads at mid and near zoom (`render/street-labels.ts`). **Was open:** at mid zoom they are dense. **Since:** mid zoom labels only main roads, the same width bucket as the carriageway (`ROAD_MAIN_MIN_W`, 16 m, the `ROAD_FILL_MAIN` roads); near zoom still labels every named street. **Ambient sound** in layers (`src/audio/audio.ts`): the city by day and night, the outbreak's progress (shouts, screams, panicked breath by how many are dead and turned), the cordon's radio, army chatter while the Rangers are in (the worker sends their positions for it); **open:** `audio.ts` is now 2,300 lines and should be split by layer. Not merged: cordon vehicles drawn as trucks and Humvees (the user's call: not the right graphic), and open-ground fills (made redundant by the mall lot fix below, and too faint to see).
- **Static city:** building outlines one device pixel wide at 0.2 alpha, cached and redrawn only when the view or the light changes; every street's surface drawn at its own width, day and night, in one opaque shade a little lighter than the ground (so crossings do not add up), under the border and the bridge decks — the roads used to show only at night, as the lit streets' glow, and vanish at dawn (the user's call); lit streets glow faintly warm over that at night; the river a faint band. At far zoom the outlines drop to under half strength so the density field leads.
- **Occupancy fill** is bucketed into six alpha levels (one fill call each), saturating at 24 inside and peaking at about 0.06 alpha — near the noise floor, so the agents are the brightest things on screen. **Open:** at this strength a block emptying may be too subtle to see.
- **Far zoom** bins the living and the dead on an 80 m grid and draws it blurred: a pale haze where people are, red where the dead outnumber them.
- **Mid zoom** sits between reading the city as density and following people, and borrows from both: the far-zoom density field at half strength under the dots, short trails (the last five samples, about 0.8 s), names on promoted survivors, and dots at least 2.5 px. On its own the dot layer was too sparse to read as density and too far out to follow anyone.
- **Corpses** are painted into world-space buffers at half a pixel per metre: a floor layer at 0.25 and a recent layer that is faded as a whole every 120 ticks, reaching about 5% after 1,200.
- **Trails** sample snapshot positions every 160 ms of wall time into a ring of 12 per agent (about two seconds of history, whatever the speed) and are drawn at near zoom only, batched by age. Steps over 12 m (appearing, going inside) are not motion.
- **Tracking:** clicking a roster name or a ticker line centres on its subject and follows it while it is on the map; dragging lets go.
- **The inspector** is as specified. Detail is built by the worker and sent with every frame while the panel is open; a building's history is the ticker copy of its own events, kept on the page. The backstory moved to `src/worker/`, where the state is.
- **Audio** has no assets: everything is synthesised into buffers at start (about half a second, on the first click or key), each one-shot normalised to one peak so the gains alone set levels. M mutes.
  - **One-shots.** Each noise in the snapshot (the stimuli that draw the dead) is heard out to its own radius — how far the dead hear it — or the view, whichever is larger, so a fight just off screen is heard. The loudest at the listener go first, at most four a frame (two above 4×, one at 8×), with voice caps per category and ±6% pitch jitter.
  - **Distance.** The listener stands at the middle of the view, raised by 0.18 of the view's width, so a city-wide view hears everything from far off and street level hears it close. Farther is quieter, duller (a low-pass falling by e every 450 m) and later (by its distance along the ground at 343 m/s, at most 1.2 s).
  - **Gunshots** come in three layers: a crack of a couple of milliseconds, a body with a low thump, and a dull tail. They differ per weapon: pistol pop, rifle crack, shotgun boom, a burst of three from the SMG. Gunfire sends to one shared street echo (a synthesised impulse response: reflections off the buildings at 15–70 ms, then a diffuse tail of about 1.5 s), more of it the farther off the shot. Until this change rifle shots were silent, the rifle missing from the categories played.
  - **Beds** follow what is in view: the dead as a crowd (low voices through vowel resonances, by how many are awake and how near); engines (cars being driven, nearer louder, panned); a siren (the nearest police car, SWAT van or ambulance on the move, as the light bar is drawn); wind always; the hum of a living city, scaled by the share still alive in it and by daylight, so it thins as the city empties and falls away at night, the wind rising a little in its place. (Crickets after dark were tried and removed: high pulsed chirps that read as birdsong, and jarred.)
  - **Sirens and car alarms are stimuli**, so what the viewer hears is what the city hears ("Car alarms and sirens", below). The siren bed plays from the nearest emergency vehicle on the move; the alarm is a one-shot like gunfire, two tones taking turns over 1.6 s, its own category with two voices.
  - **Open:** recorded sounds in place of the synthesised ones. Optional; CC0 libraries would do, behind the same code, with synthesis as the fallback.
- **The view opens where it began:** centred on patient zero's building at mid zoom, with a red ☣ in a ring pinging over it — the two shrinking together onto the building, over and over — until tick 120 (twelve seconds at 1×; the run opens paused, so it waits). The worker notes the buildings occupied at tick 0 for the map snapshot (`MapSnapshot.origins`); no simulation state.
- **Frame counter** (development): top centre, on under the dev server, F toggles, `?fps` shows it in a build. Over the last second: frames per second, the worst frame, the main thread's draw time, and the simulation's achieved tick rate against its target; amber below 30 fps or 90% of the target rate. Draw time counts only issuing the drawing — rasterising happens after it — so frames per second is the number that decides.
- **The density blur is done small.** Blurring the density field at screen resolution every frame took mid zoom from 30 to 11 fps in the build container once the underlay was added; it is now blurred on a canvas of four pixels per 80 m cell and scaled up with smoothing, which looks the same (24 fps there).
- **Measuring:** `scripts/view.ts` screenshots far, mid and near zoom from a fast-forwarded run (`?advance=N`); `scripts/fps.ts` measures frame rate, draw time and the tick rate achieved at 8×. In the build container (software rendering, shared CPU) draws cost about 5.5 ms a frame and the simulation reaches only 19 of 80 ticks a second at the busiest stretch, so the 30 fps gate has to be measured on a real machine.

### Survivor behaviour revisions

After milestone 3, watching the viewer: survivor behaviour felt lacklustre. Outdoors a survivor was either running an errand, unaware, or reacting to a zombie in sight; nothing between. Measured on seed 1 before changing anything: up to 131 survivors at a time walked their errands within 60 m of a zombie, oblivious; and survivors heading for shelter with a zombie in view reversed direction on 17% of their moves.

- **Awareness of the outbreak** (`Sim.awareAt`). A sim becomes aware by seeing a zombie, seeing a bite or a conversion, hearing gunfire or a shout, meeting someone who knows (an encounter merge passes it on), entering a building that has been alerted, or being inside one when it is. Unaware, it keeps its routine. Aware, it drops the routine for an objective, chosen once and kept (`systems/people/awareness.ts`): those who engage, armed, go toward the trouble they believe in nearby (`respond`, a street within 600 m whose believed danger × confidence is at least 0.15; on arrival what they see is written as that street's danger, so they do not return to an empty street); everyone else goes home if it is within the archetype's `homeReach` (civilians 1,200 m, preppers anywhere, police, loners and the reckless never) and home is not believed dangerous; otherwise the best shelter it knows. Someone heading home who meets danger enough to seek shelter gives up a home more than 250 m off for the nearest good shelter. Released residents leave unaware, as before; expelled residents and resident scavengers start aware. Awareness spreads fast by word of mouth in crowds: on seed 1, 157 of 722 survivors outdoors were still unaware at tick 2,400, and almost none from 3,600. Oblivious walkers near zombies fell to almost none.
- **Homes** (`Sim.home`). Everyone has one at spawn: the residential building they came out of, or else one of eight sampled residential buildings, nearer ones likelier (`awareness.homeDistanceScale`, 400 m). The homeless have none. A home is not a shelter until the sim gets there.
- **Limited sociality** (`archetypes.*.sociality`). When two aware sims meet outdoors, one bound for a shelter it has not yet made its own goes along with the other if the other's shelter is nearer to it than its own goal, at 2 × its own sociality × the archetype's figure, up to 1 (civilians 0.8, preppers and the reckless 0.3, police and loners never — the figure is the chance at middling sociality), and never with danger in sight. (Per-sim sociality since the fourth round; before, the archetype's figure was the chance for all.) That is all the grouping there is: shared destinations, so knots of survivors walk the same way. No leader, formation or keeping together: those are the squads deferred to v2.
- **Fight, flight or freeze** (`Sim.stand`, `config.cornered`). Cornered — a zombie within `cornered.near` (6 m), perceived threat at least 0.4, and either danger on several sides (`threatFocus`, the threat vector's length over its summed weights, under 0.5) or no walkable ground 6 m along the way out — a sim stands and fights if it carries anything, else dashes for a door (the one it already chose, else any in reach, whichever way it lies), else freezes. Freezing is still gait: detectability 0.35, so a zombie that has not locked on may pass, and a tracker loses it beyond twice that range. A stand is reconsidered after 10 ticks (fight) or 20 (freeze). Anyone standing to fight uses its weapon at range whatever its archetype, and in a panic; a frozen sim does not strike.
- **Nerve** (`Sim.nerve`, `config.nerve`; panic.ts `breaks`). Competence under terror is not universal: every sim had acted as a sensible agent, so everyone with a knife could stand and kill. Nerve is a per-sim uniform draw, like caution and trust (police held up to 0.8, reservists to 0.6); it breaks when panic passes it — the one question about panic the cornered, blocked and exhausted ask, answered in panic.ts so the restricted read stays there. Cornered with its nerve gone, a sim freezes in shock, armed or not (before, it stood and fought if it carried anything). With the way blocked, it will not stand to fight. Run to exhaustion (stamina at most 0.05) with the dead in sight and its nerve gone, it gives up: frozen for 120 ticks. The melee kills then come from the part of the population that would plausibly manage them. The sweep reports survival by nerve band.
- **Rising** (`systems/dead/rising.ts`, `config.rising`; the user's design, after the burnout measurements). Of those the dead kill — a tracked sim fed on in the street or indoors (`Sim.risesAt`), a resident killed in a breach (`Building.risings`) — a quarter (`rising.chance` 0.25) get up again 1,200–2,400 ticks (20–40 minutes) later, where they fell: in the street an awake zombie where the body lay, indoors an occupier of the building, which is then treated as newly occupied. Low and late on purpose, so as not to set off a late-run surge. A zombie destroyed stays destroyed, and anyone shot stays dead: only the dead's own kills rise, so combat keeps its meaning. Feeding keeps its character — bites stay the vector, the swarm mostly kills — but the eaten are no longer lost to the outbreak for good, and nowhere people died is safe for good. Step 8, after conversions. A named survivor getting up again makes a ticker line (`bodyRose`).
- **A shot in the dark** (`combat.darkHit` 0.5). Ranged combat had distance falloff and nothing else: a pistol at 20 m worked the same at noon and at 3 a.m. in an unlit alley. Now every ranged roll — in the street, from a door, the cordon's — is scaled by how well the target can be made out: fully in daylight or wherever its street is lit, down to `darkHit` in the dark, ramping through each twilight. On the shot only: perception already has its day and night radii, and melee is at arm's length. The armed response — police the largest sink — weakens after dark, and unevenly: a lit arterial is the one place it works properly at night. Three nights a run, three windows for the outbreak.
- **Survivors see ahead of them** (`perception.coneCos` 0.34 ≈ ±70°, `perception.rear` 0.3; perception.ts `viewFactor`). Sim perception was a radius with a line-of-sight test and no facing: an armed sim engaging what was in front saw everything behind it as well, so nothing ever closed on it unobserved — competence that should not exist, like the cornered bug. Now the full radius holds within the cone of its heading and 0.3 of it outside: not blind behind, but what comes from behind gets much nearer before it registers — and no one aims at what it has not seen (the same rule picks targets at range). Contact is felt, whatever the facing. Facing now means something on screen (the triangle), and two people back to back cover each other: the first mechanical case for company the design has had. Hearing is unchanged — the dead still make no sound of their own; to add if the cone makes the sneak-up unsurvivable.
- **A blocked way is a decision, not a hover.** Survivors going round danger (`goRound`) used to bend further the closer it was, so with a zombie between them and their door they backed off until the bend weakened, then came on again: the beelining back and forth. Now danger squarely ahead (blend weight at least 0.8) is a decision (`wayBlocked`): fight if what it carries is up to the zombies within 15 m; else take a door that does not lie toward them; else back off for the avoid hold, giving up a shelter not yet its own to choose afresh. During the hold the way out is kept and turned only for danger ahead, and the hold comes before every other rule (a panicked sim otherwise ran for the same door again, and an engager turned back in). Panicked flight keeps the door it chose while it is in reach. An engager that has fallen back toward shelter does not turn to engage again on the way. Heading reversals by a sim that had reversed within the previous ten ticks, seed 1, 6,000 ticks: heading for shelter with a zombie in sight 4,525 → 172, panicked flight 1,164 → 249, scavenging with a zombie in sight 333 → 2.
- **The bitten choose** (`Sim.infectedChoice`, `systems/people/bitten.ts`). At its first decision after the bite, a sim chooses by archetype (`isolates`: loners 0.7, police 0.6, the reckless 0.4, civilians 0.25, preppers 0.1) to go off alone to the nearest building within 200 m that looks empty from outside — leaving its shelter and its role — and turn there; otherwise, or if there is none, it conceals, carrying on as if nothing happened. Isolating emits `simIsolating` (salience 30): "A survivor, bitten, is going off alone to the house on Mill Avenue."
- **Responders' and walkers' dead ends.** Wall-following tried deflections up to 115°, so in a slit between buildings where the only way out lay behind, an agent stood for the rest of the run (one walker for 5,400 ticks on seed 1). When every deflection on both sides fails, a fine sweep all the way round at half a step now finds the way out. Movement check, seed 1: sims stuck 0.0%, reversals 0.1%; zombies 0.0% and 1.2%.
- **Shown to the viewer:** a shouted warning is a faint ring growing to earshot (30 m), a shot a brief flash, at mid and near zoom; a frozen survivor is drawn dim; at near zoom a bitten survivor carries an amber ring (`?infected=fill` tries a pale amber dot instead, which read as barely different from white at dot size; `?infected=off` hides it), which pulses faster the nearer they are to turning (A's idea, B's shaping; `FrameSnapshot.simTurnIn`). Its period runs from 3.2 s a full turn delay away (1,200 ticks or more) to 0.26 s at the turn, on an exponential so the change shows. The depth runs from about 5% to 90% on the same curve, so someone long from turning is nearly a steady ring and motion means imminence. Each ring keeps its own phase as its rate changes. Nothing else on screen pulses at a variable rate. Someone swarmed, with their delay cut by each bite, visibly pulses faster than someone bitten once, and a bitten survivor walking into a shelter with the ring racing is the design's central asymmetry shown as suspense. The inspector says what someone is doing in words — heading home, responding to trouble, frozen, hiding, going off alone to turn, errands, unaware — and where they live and shelter. The bridges are drawn: a deck that cuts the river and a rail either side; before, a crossing showed only where lights or buildings framed it.
- **Sweep after these changes** (mapSeed 1, 20 runSeeds): both gates pass 20 of 20, invariant holding throughout. 53–57% turned (was 59–62%), 25–32% dead (was 32–35%); survival by caution band 17.3% / 18.3% / 19.4% (z 6.4; was 7.1 / 7.7 / 8.5). 509–700 shelters established per run (was about 940: survivors now head home rather than into the nearest door), no stasis (longest quiet stretch 404 ticks). Named survivors live a median 7,954 ticks after naming (was about 2,000), and 34% are alive at the end. The curve still rises steadily to the end of the run. **Was open:** the seed spread is still about 4 points; and survival roughly doubling may want the pressure turned back up (breach rate, wander rate) once it has been watched. **Since:** seed spread as above; pressure was raised by the later rounds (nerve, rising), and loss now sits at 75–85%.

### Second round of revisions after watching

Floated by the user after the survivor revisions; each was measured on seed 1 before and after.

- **Zombies wake their neighbours.** A zombie that newly sights a survivor wakes the dormant and idle dead within 25 m (`zombie.alertRadius`) and sends them toward that survivor. Applied after every zombie has decided, in sighting order, so the order zombies decide in does not matter. Dormant clusters are seldom near a fresh sighting, so the effect is modest: dormant zombies woken by tick 9,000 rose from 60 to 77.
- **Zombies besiege.** A tracked survivor who goes indoors leaves the zombie holding that building's door (`Zombie.besieging`) for 600 ticks (`zombie.besiegeTicks`), ignoring sound, until the building empties or falls or it sights someone else. It is the zombies at a door that make a building's breach rolls, so a siege is a breach attempt: breaches by tick 9,000 rose from 754 to 971, with up to 89 zombies at doors at once.
- **Age tells when running.** Running and sprinting use their own age curve (`movement.fleeAgeFactor`: full speed to 30, 0.45 at 80) in place of the gentle walking one (1.05 at 20 to 0.75 at 80). At 80 a sprint is 1.3 m/tick and a run 1.0, against a shambler's 1.1.
- **Panic is contagious, and crowds flow** (`config.crowd`). People running toward a sim, within 20 m and in sight, are second-hand danger lying the way they came from (0.2 × nearness each, in perceived threat), and panic rises toward twice that sum. Runners going the same way do not count for each other, so there is no runaway: panicked flight stayed under 1% of outdoor sim-ticks, and flight with no zombie within 100 m under 2% of it. Survivors who ever came into contact with a zombie fell from 989 to 840. Panicked sims, and those backing off, lean their heading toward the mean heading of people running within 12 m (alignment 0.35), from start-of-tick headings in perception, so a fleeing crowd moves as a current: repeated reversals while panicked fell from 14.2 to 11.1 per 1,000 moves. Checked for mass pile-ups: water is not walkable (nobody drowns; they slide along the bank), runners pressed against a wall or bank stayed about a fifth of panicked moves, and those pressed against the river bank fell from 473 to 48.
- **The faithful** (`Sim.church`, `faithful.share` 0.08). They belong to the church nearest home, know it from the start, and shelter only in churches while they know one that has not turned them away; then anywhere. They do not go home, and sociality never takes them anywhere but a church. Churches (41 on map 1, small, about 16 × 12 m) are drawn as an oval in their footprint with a spire off the eastern end.
- **Shown:** police are light blue; anyone who can shoot back (a firearm with ammunition) is a triangle pointing the way they face, whatever their colour, about the area of the square everyone else is (it was two and a half times that, and out of place among the dots: the user's note), with the fighting outline traced just outside it rather than as a larger triangle round it; 911 calls are drawn in light blue, kept below the brightness of what they are about. All three states show at every zoom:
  - **Officers sent:** the moment they are sent is the one bright thing, a single ring flashing outward over 0.8 s.
  - **On their way:** a dim, small ring closes in on the caller's building again and again (the building plus 6 m, at least 10 px).
  - **Going unanswered:** a call that has waited half its 600 ticks with nobody sent is a faint, slow pulse. When it lapses it just stops, which is the telling case (B's point: answered and unanswered calls must not look the same).
  - **History:** at first every waiting call was drawn, and they swamped the outbreak's neighbourhood. Then only officers on their way were drawn, as a bright ring the building plus 30 m across, and an unanswered call never showed at all.
 "Officers are on the way to the house on Mill Avenue." Positions are interpolated between ticks at every speed (`src/render/interpolate.ts`): drawing runs one snapshot behind and blends over the time the ticks take, so dots no longer step at 1× (ten ticks a second) or 0.25×.
- **Sweep:** not run separately; the third round below changed the map and police before it finished, and one sweep covers both.

### Third round of revisions after watching

- **Churches** are placed after the city is built, never drawn by weight (`map.churches`, `mapgen/generate.ts placeChurches`, on a stream of their own). Drawn by weight they all fell downtown, where the big plots are: 13 on map 1, none in the suburbs, many of them small (the user: "a few total, scattered between the suburbs and downtown, but no more than 3 per district"). Now 2 downtown and 4 across the suburbs, one to a district before any gets a second, at most 3 in one, at least 250 m apart, each 600–2,500 m². Downtown a church takes a house or flavour plot that size. The suburbs have none (houses are 12–18 m a side), so there a church takes two to four neighbouring house plots on one frontage, joined into one: about 50 × 14 m. Drawn in plan, as one continuous outline (A's and B's revision, then the user's): a long nave narrower than the plot; a square tower wider than the nave (1.35 times its width), standing at its western end; on a long shallow plot the church is cut to four nave-widths long and centred; and a semicircular apse at the east whose radius is half the nave's width, so the curve meets the corners. Parts share edges and never overlap. An overlapping outline leaves an interior line that reads as a mistake, as the old tower square did, which was wider than the nave and laid over it. The tower was narrower than the nave until the user asked for it to read as a tower; standing proud of the nave either side, it still shares edges with it. The tower carries the silhouette, which still reads as a church a few pixels across at mid zoom. The same rule holds for any composite footprint drawn later: shared edges, never intersections. **Hospitals and schools** have shapes of their own too, so the city reads by shape as well as size (B's suggestion, the user's go-ahead), all cut from the back of the plot as one outline. A hospital is an L: a back corner cut away, 45% of the width by 45% of the depth, whichever corner has no door near it. A school is a U, open at the back: the middle third of the back, 42% of the depth in. The front, the wall the first door is on, stays whole. Where a door would fall in the cut, the building stays a plain box; on map 1 every door of both is on the front. It is drawing only (`MapSnapshot.buildingShape`, `renderer.ts shapedOutline`): the simulation's footprint, picking by click and capacity are the plot. Warehouses keep their plots: drawn smaller, they would misstate how much room is inside. Schools are not drawn as B's H, because an H's front notch falls where the door usually is.
- **Doors.** Every entrance has a small step, 1.8 × 0.9 m, standing proud of the wall, drawn at near zoom only (less than a pixel further out): it shows where people go in and out. A church's plot doors would float beside the narrower drawn church, so it gets one wider door on the west face of its tower instead.
- **Fight, flight and freeze are shown.** Fighting — standing its ground, or having struck or fired within its weapon's cooldown — is a bright warm outline round the dot or triangle. Flight — panicked, or backing off — leaves a long bright streak, at mid zoom too. Freeze is dim and pulses slowly. The streak is drawn only for those fleeing: about 0.2–0.4 ms a frame at near zoom.
- **Sweep with police running toward gunfire** (mapSeed 1, runSeeds 1–8; before firing from inside): both gates pass on all eight. 55–59% turned, 30–34% dead; survival by caution band 11.9% / 12.9% / 13.4% (z 3.2); no stasis; named survivors live a median 5,118 ticks after naming, 34% alive at the end. The curve keeps its shape: the gunfire response changes the small picture, not the big one.
- **Sweep after the second and third rounds** (mapSeed 1, 20 runSeeds; before police ran toward gunfire): both gates pass, invariant holding throughout. Nineteen runs at 55–58% turned and 29–34% dead; survival by caution band 13.6% / 14.7% / 15.2% (z 5.2); 460–560 shelters established per run, no stasis (longest quiet 521 ticks); named survivors live a median 3,486 ticks after naming, 31% alive at the end. **Seed 19 smouldered:** 4% turned, 2% dead. Not police clearing it at birth: about 30 zombies stayed out for hours, killed about as fast as they spread (by tick 7,200, 107 destroyed — 53 by civilians, 22 by police and first responders), no building held by the dead for long, deaths levelling at 65. The first run in any sweep to end differently from the rest — the seed spread was the open complaint — and kept as a real outcome, not a bug.

### Fourth round

- **Hunker-down is now the prepper** (`prepper` in `ARCHETYPES`; the user's choice of name): same weights, same mix share (0.26). Its professions other than retiree — parent, librarian, accountant, nurse, night-shift worker, caretaker — now lean civilian, and six new ones lean prepper: firearm instructor (gun shops), reseller (warehouses), trail guide, ham radio operator and homesteader (houses), and locksmith (hardware stores). Firearm instructor, trail guide, homesteader and ham radio operator have their own age ranges. The design notes keep the old name where they record the reasoning.
- **A mall** (`mall`, a functional tag the generator places rather than draws by weight; `map.mall`). Pairs of suburban blocks qualify across a standard street when each block is at least 8,000 m² and the pair at most 50,000 m²; those whose street meets a main street come first, then the largest. The best is cut back to a 45 m driveway from its main-street end: the two blocks become one, reached by the driveway, a dead end with `open` terrain. The grounds fill the merged block inside its streets; the building — at most 170 × 80 m, centred on the driveway where the grounds allow — stands 8 m beyond the driveway's end with its three doors facing the parking. A site the compound does not fit (an irregular block) is put back and the next tried, up to 12. Integrity 0.5 (glass-fronted, so reinforcible, never fortifiable), 80–150 materials, a few shotguns and some ammunition among the loot, and staff drawn from retail, security, cleaning, catering and shoppers. The grounds are state only to be drawn (`World.lots`): their edge, broken where the driveway enters, and at near zoom double rows of stalls either side of it. There is no commercial district kind: the map is a downtown, one industrial district and seven suburbs, and a retail park belongs on a suburban arterial. Maps 1–8 each get one in a suburb, its driveway on a main street, the building 152–170 × 80 m on grounds of 168–192 × 150–167 m. (Industrial districts were allowed at first; their blocks are larger and won every time.)
- **Sociality is per sim** (`Sim.sociality`), as caution is: a uniform draw at spawn, independent of archetype, so a gregarious prepper and a solitary civilian are both possible and the high and low tails are present in every archetype that joins anyone. The archetype scales it into the joining chance — 2 × trait × the archetype's figure, up to 1 — so the average civilian joins as before (a little less: the cap trims the top), the most sociable always do, the least never; loners and police, whose figure is 0, never join whatever their trait. Profession nudges the draw a little (`spawn.professionSociality`, clamped to 0–1): bartenders +0.2; teachers and parents +0.15; baristas, nurses, students, receptionists +0.1; retail assistants +0.05; night cleaners and long-haul drivers −0.2; groundskeepers and homesteaders −0.15; ham radio operators, trail guides and the homeless −0.1. Since profession also leans archetype, the trait is very nearly but not exactly independent of it. The inspector shows it beside caution. The sweep reports survival by sociality band, ungated, over sims whose archetype joins anyone (for the rest the trait does nothing): whether going along with others helps or hurts — crowds share memory and defend better, but are found sooner and die together when a shelter falls. The extra draw at spawn shifts every run's random sequence. Not yet swept then; swept in every sweep since (below).
- **Conversations** (`config.talk`, `Sim.gathering`, `Sim.talkUntil`; encounters.ts). Meeting no longer trades everything. Two who pass within 4 m still pass on panic and that there is an outbreak; only if they stop to talk do they trade street and building memory and who is known to be bitten. They stop at 1.5 × their mean sociality, up to 1 (the average pair three times in four, two of the most sociable always), unless either has danger in sight, is in flight, fighting, backing off, on a sortie or on a call. A conversation is named by the sim that started it. Each member stays 4–20 ticks, longer the more sociable, so the least sociable drift off first. A passer within 12 m of one may join it at its own sociality, up to 10 people; members walk in until on the circle they would stand on a set distance apart, then stand still facing the middle. That distance is the conversation's own, 1–4 m (`talk.spacing`, from a hash of its id, so it draws nothing from the run's stream): anyone nearer than 0.7 of it to another member steps back at a sneak's pace, and walks in only while the nearest is more than 0.75 m beyond it, at a sneak's pace for the last 2 m. Of two adjusting to each other the higher id moves and the lower holds. Before, the user saw people "congealed": they met within the 4 m encounter radius, often passing shoulder to shoulder, and stood where they met (seed 1, ticks 600–3,000: 19% of members within 1 m of another, now 3.5%; 89% are 1–4 m from the nearest). Both moving made pairs swing back and forth, 42% of members moving at any tick; with the lower id holding, 21%, against 15% before the change. What a conversation knows is pooled every 5 ticks. Decisions break it up the moment anyone in it sees danger (`ctx.talkAlarm`, from the perception snapshot, so all decide alike). The invitation to come along ("come with us") still happens on any meeting. Drawn at mid and near zoom: a faint line from each member to the middle, and for three or more a ring at least 5 px across. Seed 1, 3,000 ticks: 6.6% of outdoor sim-ticks spent talking; about 4,760 conversations, a quarter reaching three people, 6% four, 65 five, 17 six, 4 eight and 2 the cap of ten. Joining only within the 4 m encounter radius gave almost no gatherings (a passer seldom comes that close to a pair standing still), hence the 12 m reach. On three runSeeds of mapSeed 1 at 9,000 ticks, against the commit before: seed 1 lost more (1,854 dead or turned, was 1,019), seed 3 fewer (779, was 1,672), seed 2 smouldered either way; awareness spread about as fast. Seed spread swamps it: not yet swept. (These comparisons were before members closed in; sims stuck 0.0%, reversals 0.2% after.)
- **The outbreak is news only in conversation.** Passing someone now passes on only fear (panic, damped); that there is an outbreak travels by word of mouth only when two stop to talk, or inside a building (the merge on entering). Everything else that makes a sim aware is unchanged and direct: seeing a zombie, a bite or a conversion, gunfire or a shout, an alerted building, a dispatch. A crowd running toward someone frightens it (panic contagion) but, as before, does not tell it why. Against conversations alone, mapSeed 1, runSeeds 1–4: awareness spreads markedly slower — unaware outdoors at tick 1,800 were 224–707 of 721–1,026, now 444–1,148 of 851–1,194; at 3,000, 40–123 were 57–200 now 167–555 — and more people are still out on the streets on their routines. Loss by tick 9,000 fell in three of four (seed 1 1,446 → 282, seed 3 1,532 → 1,267, seed 4 1,326 → 828; seed 2, which smoulders, 83 → 174). The likely reading, not yet checked: the unaware keep their routines rather than converging on homes and shelters, so fewer crowded buildings fall in the first hours; seed 1 now nearly smoulders (267 lost by 3,000, 282 by 9,000). That pulls against gate 2 (loss 40–95%): not yet swept.
- **Trust** (`Sim.trust`, `config.trust`): a third per-sim trait, a uniform draw independent of archetype, judged by the listener alone — sociality is whether you talk, trust whether you believe what you hear, caution how much risk you take on it. Hearsay is taken as (1 − trust) × 1,800 ticks older than it is (`ageShift`, one memory half-life): a sceptic believes what it is told about streets and buildings half as much, the trusting at face value, and a rumour grows staler at every telling. It costs nothing new: `observedAt` already ages beliefs, and merging compares beliefs as heard. Believing in the outbreak took 1 + round((1 − trust) × 2) tellings from different people (`Sim.toldBy`, emptied once aware): one for the trusting, three for a sceptic (now unease, below). Who is said to be bitten is taken on at chance `trust` at each telling, so a sceptic may let someone in whom the others knew was bitten. Shouted warnings and everything seen or heard directly are unchanged. The inspector shows trust; the sweep reports survival by trust band, ungated. Against step 2, mapSeed 1, runSeeds 1–4: awareness slower again — unaware outdoors at tick 3,000 were 167–555, now 580–952 — and outcomes split further: loss by 9,000 seed 1 282 → 150, seed 2 174 → 1,718, seed 3 1,267 → 1,454, seed 4 828 → 63. Two of four now smoulder through 9,000 and two take off: whether a run takes off is decided in the first hour or two, and the levers for that are the opening zombie mechanics (to be reworked) and here `unease.tellingGain` and `talk.chance`. Not yet swept then; swept in every sweep since (below).
- **Release from an alerted building.** Residents released from a building that knows of the outbreak no longer walk out unaware: an alerted household keeps its people home (its pending release is dropped), and people at work leave aware, so their first decision outdoors sends them home — the same bodies on the street at release, knowing, on a different errand.
- **Unease** (`Sim.unease`, `config.unease`) in place of the telling count: belief short of knowing, 0–1, in someone not yet aware. Each telling from someone new closes 0.4 (least trusting) to 1 (most) of the gap to 1, and at 0.75 it becomes awareness — one telling for the trusting, two at middling trust, three for a sceptic, as before. Being swept along by a running crowd moves it toward 0.6 × the crowd's pull (never far enough to know); gunfire too faint to know for what it is closes 0.3 of the gap. It fades by 0.0005 of itself a tick. Meanwhile it does something: stops on errands are shortened (idle × 1 − 0.8 × unease), home joins the sampled next stops weighted by 3 × unease, and panic is held up to 0.3 × unease. The inspector shows "errands, uneasy" from 0.2. Disbelief degrades into unease rather than flipping.
- **A shout carries danger, not the outbreak.** Hearing a warning still marks the street dangerous and frightens (panic); it tells the hearer there is an outbreak only if the hearer can see the shouter (within its sight radius, line of sight) — otherwise it is a telling, raising unease. Shouts no longer alert buildings (gunfire still does): through a wall a shout says something is wrong, not what. People flee a street they now believe dangerous without knowing why — and may run toward somewhere nothing has happened yet.
- **Objectives are weighed again with migration's rules** (`awareness.ts reconsider`). An aware sim outdoors heading for shelter weighs its objective every 30 ticks (staggered by id, as roles and migration) and at once when news of its target's street or the building comes in (`Sim.reconsider`, set when a conversation or a shout changes those beliefs). Home is given up once believed dangerous. A shelter is given up only for one better by more than migration's margin (0.25 + 0.5 × the target's believed fortification + 0.3 × caution), and never within migration's cooldown (600 ticks) of the last change (`Sim.lastMigratedAt`, shared). First responders returning to their station are left alone.
- **Measured together** (release, unease and shouts, objectives) against trust alone, mapSeed 1, runSeeds 1–4, loss by 9,000: 150 → 141, 1,718 → 950, 1,454 → 2,097, 63 → 210; unaware outdoors at 3,000 a little fewer in seeds 2 and 3 (447 and 403, were 730 and 580). Movement: sims stuck 0.0%, reversals 0.1%. Seed spread still dominates; not yet swept.
- **The intact dead** (`Zombie.intact`, `zombie.intactSight` 0.35, `intactGiveaway` 8 m; `perception.ts recognisedWithin`). A sim who turns from a single bite has no wounds or torn clothes to give it away: survivors register it at 0.35 of their sight radius, but never nearer than 8 m (or their sight, if less), because the way it moves gives it away — recognisability shortens the range, it does not allow a clean approach. The same range applies wherever survivors notice the dead: perception and threat, an armed survivor picking a target, watching from a door, firing from inside. It is lost on the zombie's first attack, bite or miss: the first grab is when people notice. Perception is rebuilt every tick, so the next tick everyone near sees it at full range, and a fresh sighting shouts as usual. More than one bite, or turned in a breach, and it is marked like any other. The asymmetry about who knows now outlasts the moment of turning: the zombies hardest to spot are the ones made by the quietest encounters — the same ones that carry infection into shelters. Drawn paler (#d49a9e) at near zoom only, where the viewer is told; the city is not. Against the commit before, mapSeed 1, runSeeds 1–4, loss by 9,000: 141 → 109, 950 → 347, 2,097 → 1,434, 210 → 147 — lower in all four, not the expected direction; unexamined (one guess: armed survivors no longer shoot an intact zombie at range, so less gunfire draws the dead). Only 1–8 are still intact at 9,000: the camouflage is spent quickly. Not yet swept then; swept in every sweep since (below). (Zombie types — a slow shambler among others — remain a scenario-wide gait, not per zombie.)
- **Sweep after the fourth round** (mapSeed 1, runSeeds 1–8, commit 8fdc86a; 526 s wall, about 7 ms a tick). **Gate 2 fails** (loss 40–95% in 5 of 8: seeds 3, 5, 6, 7, 8 at 48–70%; seed 2 at 21%; seeds 1 and 4 smoulder at 2–3%, seed 4 resolving at tick 9,805). **Gate 4 fails on caution:** shelters form, fall and re-form in all eight and there is no stasis, but survival by caution band is 40.7% / 41.0% / 41.1% (z 0.5; it was z 2.6–6.6 in every earlier sweep). Survival now differs by trust instead (39.4% / 41.2% / 42.2%, z 3.6), not by sociality (z −1.3). Named survivors: 45% alive at the end, a median 14,822 ticks lived after naming.
  - **Why runs smoulder:** the early dead are killed as fast as they are made. In seeds 1 and 4, zombies destroyed over the run match conversions almost one for one (88 of 90, 84 of 83); where the outbreak takes off it is about seven in ten (571 of 677 to 1,546 of 2,145). Both smouldering origins were small (51–55 conversions in the first hour, against 102–229), and awake zombies peaked at 28–29 within 20 minutes and fell to none.
  - **Awareness is slow:** at 30 minutes 70–99% of people outdoors are unaware, at an hour 60–80% (447–934 of 613–1,235). Conversations are many early (69–133 people talking at 30 minutes) and thin out as the streets empty (12–63 at an hour).
  - **Caution lost its grip, probably because danger knowledge now travels slowly:** caution acts through how much believed danger costs a route, migration's margin and who is sent out, and all three need believed danger; since only talk trades it, and sceptics discount it, there is less to be cautious about. Trust, which decides what reaches a sim, now separates survival. The gate (caution, |z| ≥ 2) was written to show that a per-sim trait matters; whether it should now read "some per-sim trait" is the user's call — not changed.
  - **What there is to watch:** at 1×, with every event treated as on screen (an upper bound), a median 8–9 ticker lines per 10 minutes once an outbreak has taken off — one a minute or so — and 1–2 in a smouldering run, where 12–18 of 54 ten-minute windows after the first hour have no line at all ("dead air"); taking-off runs have none. The first hour reads alike in every seed (52–83 lines), before the runs part ways. Awake zombies peak late in several runs (seeds 2, 5, 6 at ticks 17,400–34,800) as dormant hordes build (250–350 dormant at the end where it took off).
  - The sweep now records this timeline per run (`scripts/lib/run-one.ts TimelineEntry`) and prints it per seed.

### Bugs the user saw while watching

- **A squad that did not fire until bitten.** A zombie charged a squad of reservists; nobody shot until it had bitten the leader. Measured on seeds 1–2 to tick 20,000: of squad-member ticks with a zombie in rifle range and no shot for 10 ticks, 64–68% were members panicked into flight. Anyone in flight fires only when standing to fight, and their own gunfire and the dead closing in raise their panic. Next came zombies behind them, outside the facing cone (5–12% before the first fix; the leading cause after it). Two changes:
  - **A squad does not scatter** (`panic.ts modeOf`): panic past the routing cutoff takes a squad member to direct, never flight. Its members follow the leader's route and fall back as a unit, as the squad code already assumed. Their nerve can still go when cornered, at the reservists' floor.
  - **A squad keeps all-round watch** (`perception.ts viewFactor`): its members see all round rather than through the cone. Each looks for themselves, so this is not the shared perception rejected under company.
  - **What is left** is darkness and camouflage (an intact zombie passes for living until close; at night sight is 15–25 m, short of a rifle's 40), which is intended.
  - **Swept** with the pong fix (mapSeed 1, runSeeds 1–8, 64,800 ticks, commit 950dcd3; 4,675 s). **Both gates pass.** Gate 2: loss 40–95% in 8 of 8 (turned at the end 43–46%), none resolved early. Gate 4: shelters form, fall and re-form in all eight, no stasis, survival by caution band 14.5% / 22.3% / 27.7% (z 25.7). Squads killed 1,288 over the eight runs, against 99 when they would not fire; police 4,713, melee 5,249, cordon 2,047. Survival by archetype: civilians 21.8%, loners 34.8%, preppers 19.5%, police 18.6%, reservists 5.3%. Trust now goes against survival (25.9% / 19.7% / 19.2%, z −12.9), as the end screen says; sociality makes no difference (z 0.5). No stretch without a named person alive in the city in any run.
- **The dead bounced off the people they attacked** (`zombies.ts`, `zombie.closeIn`). A zombie tracking someone headed for their position at full speed every tick. From closer than a step it went past them and turned back the next tick: on seed 1, 68% of its moves within 3 m of its target were reversals, against 6.5% farther out. Now, closing on its target, it steps no further than 0.6 of contact range short of them: 2.8% and 0.6%. Inertia for every agent was considered (the user's suggestion). The cause was the overshoot, and a turn-rate limit would have hidden it or made the dead orbit their prey. `movement-check` after: sims stuck 0.1%, reversing 0.3%; zombies 1.0% and 0.5%.
- **Service vehicles driven off the map** (`cars.ts takeable`, event `vehicleTaken`). Anyone heading far took the nearest free parked vehicle, whatever its kind, so a leaver could take a staffed hospital's ambulance, or a station's police car or SWAT van, to an exit, quietly ending that service for the run. Now a service vehicle can be taken only once nobody living is left to drive it: an ambulance's crew, or the officers of a police car's or SWAT van's station, all dead or turned. A rescue truck is the Army's, never. When one is taken, the ticker says so ("Someone drove off in an ambulance on Ripley Place, making for the way out. There was nobody left to drive it."). On seed 1 to tick 30,000: two ambulances taken, each after its crew was gone; no service vehicle left the map.
- **Police kited a lone zombie** (`sims.ts`, `police.standRatio` 0.25). Perceived threat rises with nearness, so one zombie a few metres off read as near the top of the scale, and a pair of armed officers fell back from it, firing as it followed. Now a police unit stands its ground, whatever the threat reads, while the dead in sight are no more than a quarter of what its ammunition can expect to kill (its summed capacity: about 12 for a pair with pistols). Its decision to fall back to shelter yields the same way. Police with one or two of the dead within 15 m, seeds 1–2, first hour: moving away 53% → 11–13%, standing 44% → 84–86%.
- **Cordon soldiers looked frozen** (`sims.ts atEase`, `cordon.atEase`). A squad holding its post stood stock still. They were first made to amble about their places, which looked jittery (the user's note). Now, with nothing in sight, each stays where it stands. Every 90 ticks, out of step with the others, it either holds still (a time in three) or turns slowly, 0.02 rad a tick at most, to look up to about 70° either side of facing back into the city. The variety comes from a hash of id and period, not a draw from the run's stream. Anything in sight ends it.
- **Crossers fire back** (`combat.ts crosserFire`, `Sim.firedOnAt`, `Sim.firedOnCordon`, `cordon.returnFor` 60, `cordon.fireFirstBelow` 0.15; death cause `returned`; event `cordonFiredOn`). This is the user's third exception to no survivor-on-survivor combat, as narrow as the other two: only at a cordon's barrier, only while getting round it. An armed sim crossing fires back at the nearest cordon soldier in range and sight for 60 ticks after the soldiers fired on it. If its trust is below 0.15, it fires first, whether or not that unit fires. It uses the ordinary ranged roll and noise. Being fired on while crossing does not stop it shooting, as flight would otherwise. The first time each one opens fire, the ticker says so; a soldier it kills is counted like any death and told as "shot at the cordon by someone getting round the barrier". It happens rarely: few reach the barrier armed.
- **A barrier nobody holds is breached** (`cordon.ts shut`, `Exit.breachedAt`, `cordon.breachRadius` 40; event `cordonBreached`; the user's call). A cordon squad could be wiped out and its barrier stayed shut for good, with people still queueing at it. Now a closed barrier with no living soldier within 40 m is breached, for good: nobody comes to relieve it. People on foot then pass it like an open road, with no queue and no getting round, and its street opens to their routes again. Vehicles still stop at the barrier itself, and their people go on on foot. The ticker says so ("Nobody is left at the barrier on Quarry Highway. People are walking out past it."), and the barrier is drawn faded.
- **Run dry, rearm** (`squads.ts`, `arms.ts outOfAmmo`, `restock`, `sims.ts policeStationFor`; event `outOfAmmo`; the user's call). A squad member or officer out of rounds kept walking with the squad, or standing at a call, with nothing to shoot.
  - **Out of the squad:** a member run dry leaves its squad (the rest go on, the lowest id leading) and goes back to where it set out from.
  - **A reservist** goes to its depot, called up again, and draws a fresh rifle and its rounds if the depot has any kit left (one unit of `weaponStock`); otherwise it stands down there.
  - **An officer**, SWAT included, goes to its station, or the nearest, and takes the rounds the station still holds: boxes of ammunition and the rounds in any weapon like its own, up to `combat.ammoCap`. Finite, like all arms: a station emptied stays empty. An officer goes only to a station that is not overrun and still holds rounds for its weapon. One walking to an empty station would come back out and go again.
  - **Outsiders** (the cordon, the Rangers) hold where they are.
- **People blinking at a door, in and out every tick or two** (the user saw one; found with a probe for six entries of one building within 300 ticks). Three causes:
  - **A bitten EMT going off alone** was still crew on its ambulance's job, so the crew's rule sent it out of every building but the job, and its isolating walked it straight back in. Going off alone to turn now leaves the crew and any call.
  - **A crew whose ambulance was abandoned** kept its job the same way. The crew now disbands when its ambulance is abandoned or gone.
  - **Panic expulsion.** Reaching a door caps panic just under the expulsion threshold. Gunfire nearby took someone back over it, out they went, and in at the nearest door, the same one. Now the panic-immune (police) and outsiders are never expelled by panic, and nobody is within `panic.settleTicks` (120) of coming in (`Sim.enteredAt`).
  - **Result:** on seed 1 to tick 20,000, six such loops before, one slow one after.
- **A crowd froze by turns while one zombie bit each in sequence, and people darted between two doors like pong balls** (the user saw both outside a shelter; `sims.ts resolveCornered`, `wayBlocked`, the flight branch; `buildings.ts turnAway`; `Sim.thawedAt`, `turnedFrom`, `turnedFromUntil`; `cornered.refreeze` 120, `behaviour.turnedFromHold` 120). Found with a probe that counts sims freezing three times within 300 ticks and sims whose shelter goes A, B, A, B within 600, then by tracing who set each destination.
  - **Freezing by turns.** About half of all freezes were exhaustion collapses in crowds: a sim sprinting from the dead ran out of breath, froze for 120 ticks, got just enough back to sprint, and collapsed again; cornered sims froze, thawed and froze at once. Now for `cornered.refreeze` ticks after a freeze it runs (or fights) instead of freezing again.
  - **Pong.** Three causes. Panic flickering about the flight threshold: in flight a sim ran for the nearest door, calm again it went back to the one it had chosen. A door picked as lying away from the danger was often just past the search radius, so it was dropped the next tick for the nearer door it had turned from. And a sim between two doors that both turned it away remembered only the last (`refusedBy`), so it ran back to the first. Now a door chosen in flight is kept for `turnedFromHold` ticks wherever it is, and counts as a change of shelter for reconsidering; the door it turned from, or that refused it before the last, is not run for again for as long.
  - **Two strandings found on the way** (the movement check showed sims stuck at 0.6%). People who drove for an exit kept the walking route to the car, so when they got out they made straight for the map edge across the margin; and making for a shut exit's queue went straight there, which off the exit's own road meant into the margin. Now they route afresh on getting out, and go to the queue by the streets. And people getting out of a car crashed into a building were put down where it stood, inside the building: they now get out wherever there is ground within two car lengths.
  - **Result** (to tick 20,000, against fb202dd): seed 1 — sims freezing three times in 300 ticks 27 → 0, pong 440 → 160, freezes 2,174 → 1,539, bites on the frozen 20% → 18%; seed 2 — 124 → 2, pong 638 → 162, freezes 2,796 → 1,757. Movement check: sims stuck 0.0%, reversals 0.5%.
- **The cordon failed** (the user's report, then a redesign to the user's spec): people queueing at a closed exit stood on top of one another, and people got past the barrier and walked along the edge of the map with no reaction from the guards. Now the soldiers fire at everyone who comes near — warning shots within 75 m, aimed fire within 25 m to wound or kill — and nobody queues. See "The cordon".
- **The dead went back and forth at a store's door** (the user saw twenty awake dead looping at a hardware store; `zombies.ts doorAt`). Found on seed 1 at tick 2,700: the store held 26 people, and the armed among them fired from the door. Each shot gave every zombie around a point to go to — the door; arriving, the point was spent, they drifted off a few metres, and the next shot called them back, for as long as the store held. Now a zombie that arrives at a sound by the door of a building the living are in, with none of the dead inside, stays there besieging it (`zombie.besiegeTicks`), as one does that saw someone go in. Seed 2 to tick 15,000: zombie-minutes going back and forth by a peopled door without besieging it 62 → 18. **Open:** the dead also go back and forth between sounds from two directions away from any door (248 and 518 zombie-minutes on seed 2 before and after; runs diverge), not addressed.
- **The mall's car park overlapped the streets round its block** (the render team's fix, `mapgen/generate.ts insetCarriageways`): its rectangle follows the driveway, not the rotated streets, so a corner could lie in a carriageway. Each street's carriageway now pulls the grounds back by its own half-width and the curb; a test checks five maps. It changes those maps' malls, so runs on them differ from before.
- **The status bar shows the infected**, the bitten not yet turned, beside the dead walking, so the viewer can tell whether the infection is truly burned out.
- **An intact zombie in a horde is not intact** (`zombies.ts`, `zombie.intactCompany` 5 m; the user's note). A group of the dead was shot down and the intact one among them walked away, still passing for living. Now an awake intact zombie within 5 m of an ordinary awake one loses its camouflage for good, as it does on its first attack.
- **The street origin's zombies start intact** (the user's call): people outdoors turned where they stand pass for living until close, like anyone turned by a single bite.
- **Swept** after the fixes above, inertia, climbing over cars, churches placed, the rescue line in bounds and cars kept out of each other (mapSeed 1, runSeeds 1–20, 64,800 ticks, commit a3ad199; 1,610 s on 16 cores; seeds 1–8 alone in 376 s, identical per seed). **Both gates pass.**
  - **Over 20 seeds:** loss in range in 17 of 20, none resolved early; shelters form, fall and re-form in 20 of 20, no stasis; caution 25.7% / 31.6% / 36.8% (z 29.8). Three seeds smoulder (9, 14 and 17 end at 12–14% turned). The other seventeen end at 37–48%.
  - **Seeds 1–8 against 950dcd3:** turned at the end 37–48% (was 43–46%). Seed 6 ends at 37%, having stalled near 20% for most of the run before the rescue hours. Survival is up about three points throughout: by caution 17.7% / 24.4% / 30.5% (z 23.6; was 14.5% / 22.3% / 27.7%, z 25.7). Split at the broadcast: up to it z 6.5, after it z 30.3.
  - **By archetype:** civilians 24.6% (was 21.8%), loners 38.0% (34.8%), preppers 21.8% (19.5%), police 16.9% (18.6%), reservists 7.6% (5.3%; rearming keeps them armed), reckless 12.7%. Trust z −9.8 (was −12.9), still the sceptics living; sociality z 0.6 (0.5); nerve z 1.8.
  - **Kills over the eight runs:** squads 1,210 (was 1,288), police 4,793 (4,713), melee 5,587 (5,249), cordon 1,622 (2,047, fewer with soldiers at ease and barriers breached), SWAT 318, reservists alone 294, civilian guns 1,269, bare hands 1,665.
  - **The rescue, seeds 1–8:** 612–1,162 answer the broadcast. Of those, 27–196 get out, 157–245 die on the way and 216–325 turn; the trucks take 70–271. Seed 2 gets only 27 out. Seed 11 (of 20) is trucked none, with 809 cars abandoned against about 100–150 elsewhere: worth watching.
  - No stretch without a named person alive in the city in any run.
- **Four reservists in an armoury form a squad** (the user saw four sitting in one; `squads.ts formSquads`). Reservists stood down inside an armoury — their squad gone below two, or no weapon left when they came — now count toward a squad with those waiting there. Each takes what it can of the armoury's stock first (a firearm left there, rounds: `arms.ts restock`), and those armed form a squad at `squads.size` (4). Unarmed ones with nothing to take do not count.
- **Squad leaders route to a post they cannot see** (`sims.ts decideLeader`). A leader holding a post (the cordon, the Rangers) walked straight at it; with the post out of sight — across the river, round a block — it now goes by the streets.
- **Crowds of the dead circling the doors of empty buildings** (the user saw groups looping outside breached buildings; `zombies.ts crowdNearer`, `zombie.crowdArrive` 10, `heardForget` 600). A heard point counts as reached within `arriveRadius` (2 m); a crowd drawn to a door cannot all stand within 2 m of it, so all but the front went round and round behind, the point never reached and never cleared, and an awake zombie with a heard point never goes dormant. Found on seeds 1–4 to tick 20,000: zombies circling (path over 25 m in a minute, net under 0.3 of it) with a heard point at the door of a breached, empty building, and no sound there any more. Now, within `crowdArrive` of a point with another of the dead nearer it, and nobody living behind the door there, it has arrived; a door the living are behind is pressed on as before. And a heard point not heard again in `heardForget` is given up. **Result** (zombie-minutes circling, before → after): seed 1 1,587 → 96, seed 2 572 → 184, seed 3 444 → 99, seed 4 1,250 → 115. Fewer of the dead stay awake: dead and turned at tick 20,000 fell on three of four seeds (2,570 / 2,220 / 2,547 / 2,433 → 2,145 / 2,285 / 2,210 / 2,176); both rules contribute. Zombie moving-ticks in the movement check 1.35 M → 0.76 M, stuck about the same in number (1.0% → 1.6% of the fewer). Needs the sweep.
- **Traffic police and checkpoints** (the user's design; "Checkpoints"). One checkpoint on each exit's road, 350 m in; a unit of two traffic officers drives out to each when the first barrier closes and turns back anyone on foot making for that exit. On seeds 1–4: set by ticks 1,082–2,480; all twelve fell between ticks 7,459 and 44,558, before the Rangers come. People who know a way out is shut, at tick 20,000: 50 / 77 / 45 / 53 → 81 / 48 / 80 / 102. Dead and turned at tick 20,000 on seeds 1–4: 2,145 / 2,285 / 2,210 / 2,176 → 1,849 / 2,245 / 2,214 / 1,834. Found on the way: `squads.ts swatVan` took the first car of its kind belonging to the station, wherever it was parked; it now takes one standing free at the station. Needs the sweep.
- **Nobody in the rescue's queue stops to talk** (`encounters.ts canTalk`): found when the checkpoints shifted a test's run. Someone holding a place in the queue, or let through to a tent, joined a conversation and shuffled a metre off its place; gathered, the rows broke up.
- **The cordon squad advances at the broadcast; a fresh squad takes the gate** (the user's design; "The queue and the tents"). Full runs, before → after: seed 1 trucked 104 → 227, out 86 → 214, still in the queue at the end 152 → 11; seed 2 trucked 176 → 185, out 167 → 177. Why seed 1 drains so much faster is not yet traced. Needs the sweep.
- **Reservist squads man the checkpoints, in HMMWVs** (the user's redesign; "Squads", Targets). Their 911 calls and gunfire are gone (`squads.targetRadius`, `retargetInterval` removed). To tick 58,000, against 23d47b5: seed 1 — eight squads formed, HMMWVs driving 1,464 ticks; two checkpoints fell at about 43,500 and reservists set both again within 800 ticks; the third never fell; reservists alive at the end 11 → 22; dead and turned 2,299 → 2,498. Seed 2 — one checkpoint fell, at 53,776, set again at 55,957; reservists alive 4 → 13; dead and turned 2,694 → 2,456. The checkpoints now mostly stand when the Rangers come (they come at 50,400): the fallen checkpoints the user wanted the Rangers to find are rarer. Needs the sweep.
- **The unit's vehicle clear of the sawhorses** (the user saw a cruiser across one). Parked on the checkpoint itself, it overlapped them, and a second vehicle aiming for the same point (a HMMWV) could not reach it and was abandoned; parked behind the line instead, a HMMWV had to drive through the officers standing across the road and was abandoned short of it. Now short of the line on the city side, side by side, stepping back past anything already there. On seed 1 all three of the first HMMWVs park. Also: an armoury's HMMWVs could be taken by anyone before the call-up (no reservists of it yet, so none left alive): both of one armoury's were driven off at tick 942. Now none is taken before the call-up.
- **Cars drive round abandoned cars** (the user saw pile-ups; `driving.ts wreckAhead`, `passBy`, `laneDir`; `Car.passing`, `passSide`; `cars.passClear` 0.8, `passSpeed` 3, `queueLook` 4). A moving car with an abandoned car in its lane ahead drives round it on the other side of the carriageway — out to beside it while behind it, then on a car's length and a half past, at up to `passSpeed` — if that side is on the carriageway and no other car stands or moves there; the pass holds until it is a car's length past (let go earlier, cars turned back in at speed and into the wreck). Failing that it stops and, `rerouteAfter` later, turns back by the junction behind it — now also from anywhere in a stopped queue with a wreck at its head, up to `queueLook` cars on (before, only the car right behind the wreck did, and the queue was abandoned car by car); with no other way and making for a way off the map, it makes for the nearest other one still open. Abandoned last, as before. To tick 12,000, seeds 1 / 2, against a069738: abandoned 123 → 104 / 117 → 98; abandoned beside another 55 → 34 / 55 → 46; crashes 18 → 18 / 17 → 15; trips (parked, off the map) 493 + 41 → 482 + 55 / 349 + 46 → 367 + 54. Movement check: sims stuck 0.3%, zombies 1.2%. The rest of the abandonments beside a wreck are mostly on the exit highways, queues ending at the cordon's closed barriers.
- **Checkpoint fixes from watching** (the user's list). *Facing:* the units' vehicles park `traffic.parkBehind` (7) m behind the sawhorses on the exit's side, a cruiser behind one and a HMMWV behind the other (`parkAside` 3.25 m), so the line of officers faces the city with its vehicles at its back (parked in front, the checkpoint looked to face out); a unit's own vehicle drives through the officers standing there. *Stopping short:* civilian cars left at the line pushed the parking spot back past `squads.sceneRadius`, and the unit stood there for good (two police units and a reservist squad on seed 1); a leader now takes its post within the scene radius of the checkpoint or of its parking spot, and the spot steps back at most `parkTries` (3) times. *Vehicles:* a traffic unit's cruiser is its own (`Car.checkpoint`): before, the station's first responders took it on their calls, and the unit walked; a unit going to its checkpoint always drives, however near. *HMMWVs:* one armoury (`reservists.armouries` 1, `weaponStock` 24), chosen from the depots map generation gives a yard (`map.yard.depots` 1 — the map changes a little), with `hmmwvs` 4 in its bays. *Deserting:* a reservist called up and on its way to the armoury, or armed and waiting there, does not answer the rescue's broadcast; one stood down (its squad gone, or no weapon left) does, as anyone.
- **SWAT re-boards its van where it left it** (the user saw SWAT turning in place by their van at a scene): called on again, a squad took its van only if it stood at the station, so at the scene it stood beside it, then walked. Now a van within `swat.vanReach` (80) m of the leader will do.
- **Police drive home after a call** (the user's design; `dispatch.ts rideHome`, `police.carReturn` 120): a first responder heading back to its station takes one of its station's cars standing free within `carReturn`, with the station beyond `carBeyond`, together with its station's officers heading back within `carGather` of it, and the car waits at the station for the next call — a loop, where before the cars were left at the calls and the officers walked home. Seeds 1 / 2 to tick 8,000: 23 / 17 rides home.
- **Merged render/streetlights-subtle** (the render team; reviewed: check, night screenshots at near and mid zoom): softer lamp glows, radius 16×4/5.5 m, core alpha 0.22 at near zoom and no hot centre at mid ("Merged from the render and audio teams", street lamps).
- **Cars that never gave up** (the user saw a SWAT van penned in that was never abandoned; `driving.ts moveCars`, `decideCars`, `clearBehind`; `cars.backAfter` 15, `backTicks` 4). Decisions thought there was room, movement stopped the car on contact (a wreck's corner, a car beside it), and the next decision cleared its stopped mark: it bumped every tick for hours, never rerouted, never abandoned — 42 cars on seed 1 and 27 on seed 2 sat "driving" for 400 ticks or more, the longest for 13,862. Now a move stopped by contact marks the car stopped until a move goes ahead. And a car stopped `backAfter` ticks with the road behind it clear (no car, person or zombie within a car's length and gap and two ticks at full speed) backs off for `backTicks` at `reverseSpeed`: room to drive round, or to turn back. To tick 12,000, seed 1 / 2, against 3b7c0aa: stationary 400+ ticks 42 → 11 / 27 → 8; trips parked + off the map 537 → 566 / 421 → 589; abandoned 104 → 194 / 98 → 129 (cars that used to wait for ever, now given up where they stand, beside others); crashes 24 → 40 on seed 1 (the same junction crashes as before, and more traffic). Needs the sweep.
- **A cry when the dead attack** (the user saw someone killed in the rescue's queue a few metres behind soldiers who never turned): anyone the dead grab, bite or miss now cries out (`combat.ts`, a shout stimulus, heard by the dead as well), and a soldier at ease turns at once to a cry within shouting distance (`sims.ts atEase`), so what is there it sees the next tick. Dead and turned at tick 20,000, seeds 1 / 2: 2,267 → 2,051 / 1,650 → 1,794.
- **One of the gate's squad stands inside the line** (the user's design; `rescue.ts gateUsher`): its last member takes a place beside the gate across the line from the squad's post, as if directing those coming up.
- **The last leg to a door** (the user saw someone go round and round between a parked car and a building, short of the church it sheltered in; `steering.ts lastLeg`, `behaviour.doorStep` 1): with the route walked, a sim went straight for the door; with the door round the corner of its own building or behind another, it slid along the walls and the parked cars between. Now, unless a point a metre out from the door is in sight, it goes first to the street in front of the door. Movement check: sims stuck 0.3% → 0.1%.
- **Supplies are eaten** (the user's redesign; "Shelter", Supplies). Materials renamed supplies; the people in alerted buildings eat them; running out moves them on. Seeds 1 / 2 to tick 30,000, against dedf8eb: shelters running out 1,979 / 1,962; shelters established 902 → 1,643 / 926 → 1,828 (people moving on and settling again), fallen 506 → 565 / 524 → 655; outdoors at the end 54 → 104 / 58 → 117; dead 1,453 → 1,654 / 1,448 → 1,640, turned 863 → 553 / 695 → 617. Needs the sweep, and tuning: the drain ratio is the economy.
- **Supplies, over a whole run** (seeds 1 / 2 to tick 64,800; indoors at the end, then alive): before supplies 843 / 932 (891 / 1,004 alive). As first committed (half an hour without supplies, then moving on): 145 / 186 — nearly every alerted building runs out in time, workplaces first (dozens of people, a unit or two), and the people pushed out die in the streets. Household stocks of 20–40 instead of 2–6: no better (more scavenging trips, more scavengers lost). Four hours before moving on: 444 / 513 — now the default. With builders spending from any stock as well: 350 / 488 (breaches stay up, ~3,300–3,500 against ~2,600). With six hours to a load instead of three as well: 646 / 555. **Open, the user's call:** the drain rate (three hours a load, chosen), and whether everyone eating is the intended scale — a city that empties its shelters by the end of the run.
