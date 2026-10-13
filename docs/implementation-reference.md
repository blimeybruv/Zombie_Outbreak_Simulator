# Zombie outbreak simulator — implementation reference

@Trib

Built from the ground up: each layer uses only terms the layers above it have defined. Companion to the design notes, which carry the reasoning behind these decisions.

## How to read this

This document defines the simulation from primitives upward. Each layer uses only terms defined above it, so it can be read start to finish without forward references.

It is the implementation reference. The companion design notes carry the reasoning — why decisions went the way they did, what was cut and why — and should be consulted before reversing anything here. Where the two disagree, this document is newer.

Numbers given as **defaults** are starting values, not findings. Every one of them belongs in the single config object and is expected to move under parameter sweeps. Numbers given as **fixed** are structural and changing them breaks other things.

Open decisions are marked inline rather than collected at the end, so they are visible at the point they matter.

### Field lists live in code

The entity field tables below are the original design. The authoritative field list is `src/sim/state/`, where every field declares its range, unit and readers, and `tests/state-gate.test.ts` fails if any field lacks one. Where a table here differs from the code, the code is newer. The rules and formulas in this document remain the specification.

### Revisions from the milestone 1 consultation

- **Knowing who is infected is local.** `infectionWitnessed` is gone. Each sim carries `knownInfected`, a set of sim ids it has seen bitten, merged by union on encounter. Admission checks the sets of the sims currently inside.
- **Building beliefs.** Each sim carries `buildingMemory`: building id → believed occupants, materials, fortification and `observedAt`, written on entry or a close pass and merged by recency like street memory. Shelter selection and migration read it.
- **Eight counter leaves.** `turned.symptomatic` joins the invariant now; the zombie leaf inside buildings is `turned.occupying`.
- **Sim `condition`** (`healthy`, `infected`, `dead`, `turned`) replaces `status`; location is `insideBuilding` alone. Turned sims keep their record so ids and history survive.
- **Zombie `state`** (`active`, `dormant`, `wandering`, `feeding`, `occupying`, `destroyed`) replaces separate flags, with `stateUntil` for the timed states. Destroyed zombies stay in `zombies[]`, so ids are stable. A converted sim gets a new zombie id, with `wasSim` set.
- **Two seeds.** `mapSeed` and `runSeed` seed two independent PRNG instances. A sweep varies `runSeed` against one fixed `mapSeed`, and editing generator code never shifts the simulation's draws.
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

**Tuning that passed the milestone 2 gate** (swept from the guessed defaults): zombie `dormantAfter` 300 → 1,200 ticks, `wanderRate` 0.0002 → 0.001, scent `idleDrift` 0.02 → 0.2, breach split 45/20/35 → 60/10/30 (turn/die/expel), and breach `base` 0.05 → 0.35 (0.15 passed on the old one-building-per-block map; subdivided blocks put most people in small houses, where a breach yields one or two conversions, so breaches had to come more often). On the current map at a population of 6,000, after the movement fixes (agents no longer stall against walls), mapSeed 1 has 20 of 20 runSeeds between 40% and 90% infection (65–68%, with about 24% dead without turning); the invariant held on every tick of every run, and no run resolved early. At the 36,000-tick run length the gate still passes 20 of 20 (72–74% turned, 23–26% dead; wall time about 20 minutes). The curve flattens after about 25,000 ticks, and from about tick 11,000 almost nobody is outdoors: with no shelter economy, nothing brings the sheltered back out — milestone 4's job. **Open:** the spread across seeds is now only about 2 points; the sweep targets treat low variance as the outcome being determined, so this is the first thing milestone 4 tuning should look at.

### Decisions made building milestone 4

Built ahead of the renderer: without it, a 36,000-tick run had almost nobody outdoors from tick 11,000. Audio belongs to milestone 4 in the build order but needs the browser, so it comes with or after the renderer. Everything below is in `systems/shelter.ts` and `systems/buildings.ts`, and every number is in `config.ts`.

- **Residents take part, anonymously.** Mid-run about nine in ten of the indoor living are anonymous residents, spread one or two to a house. An economy run only by tracked sims would leave them sitting until a breach. So a building is **alerted** once its people learn of the outbreak: a zombie seen from the door (within 30 m of an entrance, no line of sight needed — they look out of the windows), gunfire within 40 m, or a frightened arrival. Only an alerted building fortifies or sends anyone out. Up to two residents work as builders, since fortification is addition and needs no identity. When the building needs materials and has no tracked sim to send, one resident steps out and becomes a tracked sim, keeping its identity from then on. It knows the 30 buildings nearest home within 250 m as they stand — residents choose better than newcomers, as the shelter section expects.
- **Fortification approaches 1 asymptotically** while there are materials: `f += (1 − f) × 0.002 × crew` per tick, with `crew` materials consumed every 50 ticks. Unattended, `f −= f × 0.0005` per tick, and below 0.001 it is gone.
- **Roles.** Builder while there are materials and fortification is below 1. Scavenger when materials are at 0, the door is quiet (door threat under 0.2), nobody is already out for this building (`scavengerOut`, one at a time), and this sim is the least useful inside: usefulness is engagement capacity plus caution, so the unarmed and incautious go first, ties to the lower id. Dispatcher: an armed engager while door threat is above 0 and under its engage threshold; it holds by the door for 300 ticks engaging what it can see, and goes back in early if outmatched or out of ammunition.
- **The trip.** The target is the remembered building with the best believed stock (up to one load of 8) over distance. On the way the scavenger pushes on past 0.3 more threat than its archetype's shelter-seek threshold before turning for home, which is how it brings the horde to the door. Materials are delivered to whichever shelter it ends up in. Buildings' stock is finite, so over a run the city is stripped.
- **Nobody has to stay behind.** One person staying was the first rule; it left lone residents — a large share of the indoor living — sitting out the run in houses whose fortification decayed. Swept to 0: a lone resident goes out and the house stands empty meanwhile.
- **Loot:** one roll at 0.3 per entry on a scavenging trip; a weapon is taken when it raises engagement capacity, ammunition comes in finds of 4–12 rounds. The `materials` loot entries are ignored, since stock models materials.
- **Arms are finite and move about** (`systems/arms.ts`, after the melee breakdown, "Where melee kills come from"). Each building holds a few things from the start (`Building.stock`, `buildings.lootStock` items drawn by the tag's loot weights: a house 1 — one knife block, not an endless one — a firearms store 8, a police station 5, a hardware store 6, a workshop 3, a supermarket 2, the mall 6); the roll on entry takes one of them, and what is taken is gone. Nothing is destroyed either: a weapon given up for a better one is left in the building's stock; one carried by someone who dies or turns stays where they fell — in the stock indoors, on the ground outdoors (`World.drops`), where the nearest living sim within `buildings.pickupRadius` (2 m) that it would make more capable picks it up, leaving its own. So the city's arms move about rather than only running down. A reservist drawing a rifle leaves its own pistol at the depot. Stocks are drawn from a copy of the run's stream, so setup is otherwise unchanged.
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

**Tuning with the economy in place:** breach `base` 0.35 → 0.2 and `minStayBehind` 1 → 0. With the economy at the old breach rate, survivors were about 3% at the end and the streets emptied by tick 25,000. On 20 runSeeds of mapSeed 1 the tuned values pass both gates. All 20 are at 58–61% turned and 32–34% dead without turning, with the invariant holding throughout. Each run establishes 740–820 garrisons, of which 500–560 fall. There is no stasis (the longest quiet stretch was 1,164 ticks). Survival by caution band is 8.5% / 9.6% / 9.6% from least to most cautious (z 4.7). Wall time is about 28 minutes. **Open:** the caution effect is real but modest, about a point, and comes from the low band doing worse rather than the high band doing better. Seed spread is still only about 3 points; and the economy raised the peak cost to about 10 ms per tick, which the renderer's 8× budget has to absorb.

### Movement revisions after milestone 4

Found by watching the viewer, then measured before changing anything.

- **Survivors no longer walk back into what they fled.** The zig-zag seen by the river was the common case of a loop: a sim sees a zombie, avoids it, holds that course for 15 ticks after losing sight of it, then resumes a route that still runs through the zombie. Over seeds 1–3, 0.71–0.77 loops per 1,000 moving sim-ticks; only about 5% were near the river, and the zombie was visible only about 9% of the time. Fleeing sims were almost never cornered (under 1% of fleeing ticks made no progress, none by the river), and water was already excluded from steering. Now, on a fresh sighting, a sim records the zombie's street as dangerous (an observation), anyone heading somewhere other than a routine stop re-plans at once with that knowledge (danger seen ahead skips the repath queue), and a walker on a routine who has just stopped avoiding picks a new stop, weighting stops behind it at 0.1 (`behaviour.scaredBehindWeight`). (Superseded: a sim that has seen a zombie is now aware of the outbreak and drops its routine altogether; see "Survivor behaviour revisions".)
- **Sightings are shouted.** Everyone outdoors within 30 m (`encounters.warnRadius`) learns the street is dangerous, heard in the encounters step so decisions stay decide-then-apply; anyone whose route uses that street queues a re-plan. The shout is a stimulus (kind `shout`, intensity 0.6, `behaviour.shoutIntensity`): the dead hear it too, nearby survivors are frightened by it as by gunfire, occupiers nearby may spill. It alerts buildings but, unlike gunfire, drives no residents out.
- **Survivors go round danger they can see.** Of first contacts between a survivor and an awake zombie (seed 1), 77% were the survivor walking in, nearly all having seen it — 42% while heading for shelter (that branch had no avoidance at all) and 30% in panicked flight to the nearest door. Anyone following a route or running for a door now bends its heading away from visible danger ahead (`behaviour.avoidWeight` × threat × how directly ahead it is; head-on, to the side away from it; danger behind or beside changes nothing), and a panicked sim's nearest door counts three times as far if it lies toward the threat. Walk-ins halved (1,022 → 513) and loops fell to 0.11 per 1,000 moving sim-ticks. **Open:** most remaining walk-ins are panicked sims already inside a crowd (threat ≥ 0.6) — the cornered case. The reference's cornered modifier, and a rule for having nowhere to go (fight if armed, take any door, or freeze), would be the fix.
- **Sweep after these changes** (mapSeed 1, 20 runSeeds): both gates pass 20 of 20. 59–62% turned, 32–35% dead; about 940 shelters established per run (shouts alert more buildings early); survival by caution band 7.1% / 7.7% / 8.5% (z 6.6).

### Decisions made building milestone 3

The viewer, built after the shelter economy. Everything here is presentation: none of it changes what the simulation does.

- **The simulation runs in a Web Worker** (`src/worker/sim-worker.ts`), which owns the World and the wall clock, as the headless harness does. It steps at the requested rate in slices of at most 10 ms so messages are handled between them, and if it falls more than a quarter of a second behind it drops the debt rather than bursting: the run slows, it never skips ticks. The main thread asks for a snapshot each animation frame; positions, kinds, building fill and flags travel as transferred typed arrays, so the page never holds simulation state.
- **Events are annotated in the worker, when they happen:** who (a name only if promoted), armed or not, and where in words — "the hardware store on Elm Street", with the district. The ticker composes copy from those notes. A few tags get nouns: residential is "a house", firearmsStore "a gun shop", office "an office block".
- **Salience** is as specified, with three event kinds the table does not list: `buildingRetaken` 50, `shelterEstablished` 10, an anonymous death 1. The bar is 10 at 1× and scales with speed. A repeat of the same kind at the same building within the 600-tick rarity window is suppressed — a breach and a conversion inside the same house otherwise read as two breaches. A cascade drops playback to 1×, and so does a named survivor's death or conversion — but only if they had been named for at least 3,600 ticks (`playback.dropTo1xNamedFor`), someone the viewer has had time to follow. Dropping for every named death interrupted an 8× run about every 15 seconds once the roster tops up; now 11 times in a run, about every 41 seconds. Measured headlessly over a full run of seed 1 with every event counted as on screen (`scripts/ticker-rate.ts`): 0.12 lines a second on average at 1×, 3 in the busiest second (gate: under 6).
- **Static city:** building outlines one device pixel wide at 0.2 alpha, cached and redrawn only when the view or the light changes; lit streets drawn faintly warm at night only; the river a faint band. At far zoom the outlines drop to under half strength so the density field leads.
- **Occupancy fill** is bucketed into six alpha levels (one fill call each), saturating at 24 inside and peaking at about 0.06 alpha — near the noise floor, so the agents are the brightest things on screen. **Open:** at this strength a block emptying may be too subtle to see.
- **Far zoom** bins the living and the dead on an 80 m grid and draws it blurred: a pale haze where people are, red where the dead outnumber them.
- **Mid zoom** sits between reading the city as density and following people, and borrows from both: the far-zoom density field at half strength under the dots, short trails (the last five samples, about 0.8 s), names on promoted survivors, and dots at least 2.5 px. On its own the dot layer was too sparse to read as density and too far out to follow anyone.
- **Corpses** are painted into world-space buffers at half a pixel per metre: a floor layer at 0.25 and a recent layer that is faded as a whole every 120 ticks, reaching about 5% after 1,200.
- **Trails** sample snapshot positions every 160 ms of wall time into a ring of 12 per agent (about two seconds of history, whatever the speed) and are drawn at near zoom only, batched by age. Steps over 12 m (appearing, going inside) are not motion.
- **Tracking:** clicking a roster name or a ticker line centres on its subject and follows it while it is on the map; dragging lets go.
- **The inspector** is as specified. Detail is built by the worker and sent with every frame while the panel is open; a building's history is the ticker copy of its own events, kept on the page. The backstory moved to `src/worker/`, where the state is.
- **Audio** has no assets yet: gunfire (by weapon), melee thuds and the moan bed are synthesised into buffers at start. It plays the weapon noise in each snapshot — the stimuli that draw the dead — on screen only, loudest first, at most four a frame (two above 4×, one at 8×), with per-category voice caps and ±6% pitch jitter. The bed's gain follows the square root of the awake dead on screen. M mutes. **Open:** real recorded sounds.
- **The view opens where it began:** centred on patient zero's building at mid zoom, with a red ☣ in a ring pinging over it — the two shrinking together onto the building, over and over — until tick 120 (twelve seconds at 1×; the run opens paused, so it waits). The worker notes the buildings occupied at tick 0 for the map snapshot (`MapSnapshot.origins`); no simulation state.
- **Frame counter** (development): top centre, on under the dev server, F toggles, `?fps` shows it in a build. Over the last second: frames per second, the worst frame, the main thread's draw time, and the simulation's achieved tick rate against its target; amber below 30 fps or 90% of the target rate. Draw time counts only issuing the drawing — rasterising happens after it — so frames per second is the number that decides.
- **The density blur is done small.** Blurring the density field at screen resolution every frame took mid zoom from 30 to 11 fps in the build container once the underlay was added; it is now blurred on a canvas of four pixels per 80 m cell and scaled up with smoothing, which looks the same (24 fps there).
- **Measuring:** `scripts/view.ts` screenshots far, mid and near zoom from a fast-forwarded run (`?advance=N`); `scripts/fps.ts` measures frame rate, draw time and the tick rate achieved at 8×. In the build container (software rendering, shared CPU) draws cost about 5.5 ms a frame and the simulation reaches only 19 of 80 ticks a second at the busiest stretch, so the 30 fps gate has to be measured on a real machine.

### Survivor behaviour revisions

After milestone 3, watching the viewer: survivor behaviour felt lacklustre. Outdoors a survivor was either running an errand, unaware, or reacting to a zombie in sight; nothing between. Measured on seed 1 before changing anything: up to 131 survivors at a time walked their errands within 60 m of a zombie, oblivious; and survivors heading for shelter with a zombie in view reversed direction on 17% of their moves.

- **Awareness of the outbreak** (`Sim.awareAt`). A sim becomes aware by seeing a zombie, seeing a bite or a conversion, hearing gunfire or a shout, meeting someone who knows (an encounter merge passes it on), entering a building that has been alerted, or being inside one when it is. Unaware, it keeps its routine. Aware, it drops the routine for an objective, chosen once and kept (`systems/awareness.ts`): those who engage, armed, go toward the trouble they believe in nearby (`respond`, a street within 600 m whose believed danger × confidence is at least 0.15; on arrival what they see is written as that street's danger, so they do not return to an empty street); everyone else goes home if it is within the archetype's `homeReach` (civilians 1,200 m, preppers anywhere, police, loners and the reckless never) and home is not believed dangerous; otherwise the best shelter it knows. Someone heading home who meets danger enough to seek shelter gives up a home more than 250 m off for the nearest good shelter. Released residents leave unaware, as before; expelled residents and resident scavengers start aware. Awareness spreads fast by word of mouth in crowds: on seed 1, 157 of 722 survivors outdoors were still unaware at tick 2,400, and almost none from 3,600. Oblivious walkers near zombies fell to almost none.
- **Homes** (`Sim.home`). Everyone has one at spawn: the residential building they came out of, or else one of eight sampled residential buildings, nearer ones likelier (`awareness.homeDistanceScale`, 400 m). The homeless have none. A home is not a shelter until the sim gets there.
- **Limited sociality** (`archetypes.*.sociality`). When two aware sims meet outdoors, one bound for a shelter it has not yet made its own goes along with the other if the other's shelter is nearer to it than its own goal, at 2 × its own sociality × the archetype's figure, up to 1 (civilians 0.8, preppers and the reckless 0.3, police and loners never — the figure is the chance at middling sociality), and never with danger in sight. (Per-sim sociality since the fourth round; before, the archetype's figure was the chance for all.) That is all the grouping there is: shared destinations, so knots of survivors walk the same way. No leader, formation or keeping together: those are the squads deferred to v2.
- **Fight, flight or freeze** (`Sim.stand`, `config.cornered`). Cornered — a zombie within `cornered.near` (6 m), perceived threat at least 0.4, and either danger on several sides (`threatFocus`, the threat vector's length over its summed weights, under 0.5) or no walkable ground 6 m along the way out — a sim stands and fights if it carries anything, else dashes for a door (the one it already chose, else any in reach, whichever way it lies), else freezes. Freezing is still gait: detectability 0.35, so a zombie that has not locked on may pass, and a tracker loses it beyond twice that range. A stand is reconsidered after 10 ticks (fight) or 20 (freeze). Anyone standing to fight uses its weapon at range whatever its archetype, and in a panic; a frozen sim does not strike.
- **Nerve** (`Sim.nerve`, `config.nerve`; panic.ts `breaks`). Competence under terror is not universal: every sim had acted as a sensible agent, so everyone with a knife could stand and kill. Nerve is a per-sim uniform draw, like caution and trust (police held up to 0.8, reservists to 0.6); it breaks when panic passes it — the one question about panic the cornered, blocked and exhausted ask, answered in panic.ts so the restricted read stays there. Cornered with its nerve gone, a sim freezes in shock, armed or not (before, it stood and fought if it carried anything). With the way blocked, it will not stand to fight. Run to exhaustion (stamina at most 0.05) with the dead in sight and its nerve gone, it gives up: frozen for 120 ticks. The melee kills then come from the part of the population that would plausibly manage them. The sweep reports survival by nerve band.
- **Rising** (`systems/rising.ts`, `config.rising`; the user's design, after the burnout measurements). Of those the dead kill — a tracked sim fed on in the street or indoors (`Sim.risesAt`), a resident killed in a breach (`Building.risings`) — a quarter (`rising.chance` 0.25) get up again 1,200–2,400 ticks (20–40 minutes) later, where they fell: in the street an awake zombie where the body lay, indoors an occupier of the building, which is then treated as newly occupied. Low and late on purpose, so as not to set off a late-run surge. A zombie destroyed stays destroyed, and anyone shot stays dead: only the dead's own kills rise, so combat keeps its meaning. Feeding keeps its character — bites stay the vector, the swarm mostly kills — but the eaten are no longer lost to the outbreak for good, and nowhere people died is safe for good. Step 8, after conversions. A named survivor getting up again makes a ticker line (`bodyRose`).
- **A shot in the dark** (`combat.darkHit` 0.5). Ranged combat had distance falloff and nothing else: a pistol at 20 m worked the same at noon and at 3 a.m. in an unlit alley. Now every ranged roll — in the street, from a door, the cordon's — is scaled by how well the target can be made out: fully in daylight or wherever its street is lit, down to `darkHit` in the dark, ramping through each twilight. On the shot only: perception already has its day and night radii, and melee is at arm's length. The armed response — police the largest sink — weakens after dark, and unevenly: a lit arterial is the one place it works properly at night. Three nights a run, three windows for the outbreak.
- **Survivors see ahead of them** (`perception.coneCos` 0.34 ≈ ±70°, `perception.rear` 0.3; perception.ts `viewFactor`). Sim perception was a radius with a line-of-sight test and no facing: an armed sim engaging what was in front saw everything behind it as well, so nothing ever closed on it unobserved — competence that should not exist, like the cornered bug. Now the full radius holds within the cone of its heading and 0.3 of it outside: not blind behind, but what comes from behind gets much nearer before it registers — and no one aims at what it has not seen (the same rule picks targets at range). Contact is felt, whatever the facing. Facing now means something on screen (the triangle), and two people back to back cover each other: the first mechanical case for company the design has had. Hearing is unchanged — the dead still make no sound of their own; to add if the cone makes the sneak-up unsurvivable.
- **A blocked way is a decision, not a hover.** Survivors going round danger (`goRound`) used to bend further the closer it was, so with a zombie between them and their door they backed off until the bend weakened, then came on again: the beelining back and forth. Now danger squarely ahead (blend weight at least 0.8) is a decision (`wayBlocked`): fight if what it carries is up to the zombies within 15 m; else take a door that does not lie toward them; else back off for the avoid hold, giving up a shelter not yet its own to choose afresh. During the hold the way out is kept and turned only for danger ahead, and the hold comes before every other rule (a panicked sim otherwise ran for the same door again, and an engager turned back in). Panicked flight keeps the door it chose while it is in reach. An engager that has fallen back toward shelter does not turn to engage again on the way. Heading reversals by a sim that had reversed within the previous ten ticks, seed 1, 6,000 ticks: heading for shelter with a zombie in sight 4,525 → 172, panicked flight 1,164 → 249, scavenging with a zombie in sight 333 → 2.
- **The bitten choose** (`Sim.infectedChoice`, `systems/bitten.ts`). At its first decision after the bite, a sim chooses by archetype (`isolates`: loners 0.7, police 0.6, the reckless 0.4, civilians 0.25, preppers 0.1) to go off alone to the nearest building within 200 m that looks empty from outside — leaving its shelter and its role — and turn there; otherwise, or if there is none, it conceals, carrying on as if nothing happened. Isolating emits `simIsolating` (salience 30): "A survivor, bitten, is going off alone to the house on Mill Avenue."
- **Responders' and walkers' dead ends.** Wall-following tried deflections up to 115°, so in a slit between buildings where the only way out lay behind, an agent stood for the rest of the run (one walker for 5,400 ticks on seed 1). When every deflection on both sides fails, a fine sweep all the way round at half a step now finds the way out. Movement check, seed 1: sims stuck 0.0%, reversals 0.1%; zombies 0.0% and 1.2%.
- **Shown to the viewer:** a shouted warning is a faint ring growing to earshot (30 m), a shot a brief flash, at mid and near zoom; a frozen survivor is drawn dim; at near zoom a bitten survivor carries an amber ring (`?infected=fill` tries a pale amber dot instead, which read as barely different from white at dot size; `?infected=off` hides it). The inspector says what someone is doing in words — heading home, responding to trouble, frozen, hiding, going off alone to turn, errands, unaware — and where they live and shelter. The bridges are drawn: a deck that cuts the river and a rail either side; before, a crossing showed only where lights or buildings framed it.
- **Sweep after these changes** (mapSeed 1, 20 runSeeds): both gates pass 20 of 20, invariant holding throughout. 53–57% turned (was 59–62%), 25–32% dead (was 32–35%); survival by caution band 17.3% / 18.3% / 19.4% (z 6.4; was 7.1 / 7.7 / 8.5). 509–700 shelters established per run (was about 940: survivors now head home rather than into the nearest door), no stasis (longest quiet stretch 404 ticks). Named survivors live a median 7,954 ticks after naming (was about 2,000), and 34% are alive at the end. The curve still rises steadily to the end of the run. **Open:** the seed spread is still about 4 points; and survival roughly doubling may want the pressure turned back up (breach rate, wander rate) once it has been watched.

### Second round of revisions after watching

Floated by the user after the survivor revisions; each was measured on seed 1 before and after.

- **Zombies wake their neighbours.** A zombie that newly sights a survivor wakes the dormant and idle dead within 25 m (`zombie.alertRadius`) and sends them toward that survivor. Applied after every zombie has decided, in sighting order, so the order zombies decide in does not matter. Dormant clusters are seldom near a fresh sighting, so the effect is modest: dormant zombies woken by tick 9,000 rose from 60 to 77.
- **Zombies besiege.** A tracked survivor who goes indoors leaves the zombie holding that building's door (`Zombie.besieging`) for 600 ticks (`zombie.besiegeTicks`), ignoring sound, until the building empties or falls or it sights someone else. It is the zombies at a door that make a building's breach rolls, so a siege is a breach attempt: breaches by tick 9,000 rose from 754 to 971, with up to 89 zombies at doors at once.
- **Age tells when running.** Running and sprinting use their own age curve (`movement.fleeAgeFactor`: full speed to 30, 0.45 at 80) in place of the gentle walking one (1.05 at 20 to 0.75 at 80). At 80 a sprint is 1.3 m/tick and a run 1.0, against a shambler's 1.1.
- **Panic is contagious, and crowds flow** (`config.crowd`). People running toward a sim, within 20 m and in sight, are second-hand danger lying the way they came from (0.2 × nearness each, in perceived threat), and panic rises toward twice that sum. Runners going the same way do not count for each other, so there is no runaway: panicked flight stayed under 1% of outdoor sim-ticks, and flight with no zombie within 100 m under 2% of it. Survivors who ever came into contact with a zombie fell from 989 to 840. Panicked sims, and those backing off, lean their heading toward the mean heading of people running within 12 m (alignment 0.35), from start-of-tick headings in perception, so a fleeing crowd moves as a current: repeated reversals while panicked fell from 14.2 to 11.1 per 1,000 moves. Checked for mass pile-ups: water is not walkable (nobody drowns; they slide along the bank), runners pressed against a wall or bank stayed about a fifth of panicked moves, and those pressed against the river bank fell from 473 to 48.
- **The faithful** (`Sim.church`, `faithful.share` 0.08). They belong to the church nearest home, know it from the start, and shelter only in churches while they know one that has not turned them away; then anywhere. They do not go home, and sociality never takes them anywhere but a church. Churches (41 on map 1, small, about 16 × 12 m) are drawn as an oval in their footprint with a spire off the eastern end.
- **911 and first responders** (`systems/dispatch.ts`, `config.dispatch`). Each police station with at least four residents starts with three of them as first responders: tracked police, garrisoned there (`Sim.station`), as opposed to patrol officers out on the streets (30 on map 1). Someone who gets indoors within 60 ticks of seeing a zombie calls it in (`Building.callAt`). Every 10 ticks each waiting call goes to the nearest station within 1 km with responders inside, armed and free, which sends two to the caller's door. Within 50 m of it they are on the scene: the call is answered and they go back. On a call they engage up to threat 0.6, not their usual 0.3; above it they fall back and the call is given up. A call lapses after 600 ticks. Seed 1, 9,000 ticks: 98 officers dispatched, 28 reached the scene, 69 turned back from a horde, none died on the way. The telephone is the one piece of knowledge that travels further than a shout, and it carries only where the trouble is.
- **Shown:** police are light blue; anyone who can shoot back (a firearm with ammunition) is a triangle pointing the way they face, whatever their colour; police on their way to a 911 call show as a light blue ring that shrinks onto the caller's building and vanishes, like a ping, over and over, at every zoom (every waiting call, drawn at first, swamped the outbreak's neighbourhood); "Officers are on the way to the house on Mill Avenue." Positions are interpolated between ticks at every speed (`src/render/interpolate.ts`): drawing runs one snapshot behind and blends over the time the ticks take, so dots no longer step at 1× (ten ticks a second) or 0.25×.
- **Sweep:** not run separately; the third round below changed the map and police before it finished, and one sweep covers both.

### Third round of revisions after watching

- **Officers act as a unit.** Deciding alone, the officer in front fell back while those behind, not yet seeing what it saw, walked on past it. Now police within 25 m of each other with something to shoot (`config.police`) engage and fall back on the danger the most exposed of them sees (the perception snapshot, so all decide on the same numbers in the same tick), share the higher threshold if any of them is on a call, and stand longer for numbers: each officer beyond the first raises the threshold by a quarter, up to 0.8. Officers sent to the same call keep together: the one ahead waits while it is more than 10 m nearer the call than its partner, or its partner is still leaving the station. Officer fall-backs with another officer within 25 m not falling back, seed 1, 9,000 ticks: 15 of 174 → 8 of 169 (most of the rest have no ammunition and are in no unit).
- **Police are cops.** The archetype is drawn from the scenario mix whatever the profession (a bias, as decided in milestone 2), so police included receptionists, cleaners and tourists, and age was uniform 16–85. Police now always have a cop's profession (`spawn.policeProfessions`: patrol officer, detective) and a cop's age, and every cop is police; paramedics, firefighters and security guards no longer lean police (they would carry pistols). Ages come from the profession (`spawn.professionAge`: retirees 65–85, students 16–25, patrol officers 22–58...), working age 18–67 otherwise. There are 44 police on map 1, 30 of them first responders.
- **Churches** need at least 400 m² of footprint (`flavourMinArea`, more than nine houses in ten) and weigh 16 against the other flavour tags: 11 on map 1, 700–1,200 m², mostly long plots like 48 × 17 m. Drawn in plan: a nave narrower than the plot, rounding into an apse at the east end, with a square tower about as wide as the nave at the west end.
- **Doors.** Every entrance has a small step, 1.8 × 0.9 m, standing proud of the wall, drawn at near zoom only (less than a pixel further out): it shows where people go in and out. A church's plot doors would float beside the narrower drawn church, so it gets one wider door on the west face of its tower instead.
- **Police run toward gunfire.** Officers outdoors with something to shoot, hearing a shot more than 15 m off (not their own nor their neighbour's), drop their path and run for the sound, re-planning at once, unless already on their way to trouble — re-aiming at every louder shot re-planned every tick and halved the simulation's speed. It overrides a fall-back while their unit sees less than it would stand on a call. Police responding to anything — a call, shots, trouble — stand like officers on a call (0.6), and so does any unit with one of them in it. Officers who fell back one by one used to scatter to their own shelters and re-emerge piecemeal; now they converge where the shooting is. Seed 1, 9,000 ticks: mean officers within 25 m of one firing 1.17 → 1.32, firing alone 84% → 78%, police kills 163 → 177, police alive at the end 30 → 27.
- **Fight, flight and freeze are shown.** Fighting — standing its ground, or having struck or fired within its weapon's cooldown — is a bright warm outline round the dot or triangle. Flight — panicked, or backing off — leaves a long bright streak, at mid zoom too. Freeze is dim and pulses slowly. The streak is drawn only for those fleeing: about 0.2–0.4 ms a frame at near zoom.
- **Sweep with police running toward gunfire** (mapSeed 1, runSeeds 1–8; before firing from inside): both gates pass on all eight. 55–59% turned, 30–34% dead; survival by caution band 11.9% / 12.9% / 13.4% (z 3.2); no stasis; named survivors live a median 5,118 ticks after naming, 34% alive at the end. The curve keeps its shape: the gunfire response changes the small picture, not the big one.
- **Sweep after the second and third rounds** (mapSeed 1, 20 runSeeds; before police ran toward gunfire): both gates pass, invariant holding throughout. Nineteen runs at 55–58% turned and 29–34% dead; survival by caution band 13.6% / 14.7% / 15.2% (z 5.2); 460–560 shelters established per run, no stasis (longest quiet 521 ticks); named survivors live a median 3,486 ticks after naming, 31% alive at the end. **Seed 19 smouldered:** 4% turned, 2% dead. Not police clearing it at birth: about 30 zombies stayed out for hours, killed about as fast as they spread (by tick 7,200, 107 destroyed — 53 by civilians, 22 by police and first responders), no building held by the dead for long, deaths levelling at 65. The first run in any sweep to end differently from the rest — the seed spread was the open complaint — and kept as a real outcome, not a bug.

### Firing from inside

An armed sim sheltering in a building that knows about the outbreak fires on the dead within 20 m of one of its doors (`combat.doorDefenceRadius`), on the armed sims' staggered cycle: the ordinary ranged roll, measured from the door, the noise muffled by the walls, not while the dead are inside. It defends the door rather than sniping at the street, because every shot draws more. A shot fired from a building alerts it but does not drive its own residents out (`Stimulus.from`). No other new state: the building already knows who is inside. A defended building is now different from an empty barricaded one, and police have a reason to hold a station. Seed 1, 9,000 ticks: breaches 810 → 686, shelters fallen 154 → 125, dead 1,183 → 929, turned 1,372 → 1,078, police alive at the end 27 → 34.

### Fortification stages

Fortification was one number dividing the breach odds, and integrity multiplied them: one zombie at the door of a bare house got in within about 170 ticks, and a besieging zombie (600 ticks at the door) got into an unfortified house 97.5% of the time and a fully fortified one 70%. Nothing made a building safe from one zombie. Now there are stages (`buildings.stages`), derived, never stored (`common.ts stageOf`):

- **Open:** the people inside do not know of the outbreak, nobody is inside, or the door has been opened in the last `barricadeTicks` (60). One zombie may try.
- **Barricaded:** they know, someone is inside, and nobody has come in or gone out for 60 ticks: furniture against the door. Time only, no materials. Undone whenever the door opens — anyone entering or leaving, a resident released or driven out (`Building.doorOpenedAt`) — so a scavenger coming home, or one leading the dead home, leaves the door open behind it. It takes two zombies at the door to try.
- **Reinforced:** fortification at least 0.3. Takes five. This is where materials and decay belong, as before.
- **Fortified:** fortification at least 0.8. Takes fifteen — the crowd a cascade means.

Integrity no longer scales the odds; it caps the stage (the user's suggestion): reinforcible from 0.4, fortifiable from 0.7. Houses, warehouses, workshops, hardware stores, gun shops and police stations can be fortified; offices and hospitals stop at reinforced; supermarkets and schools, glass-fronted, at barricaded. Within a stage the odds per roll are `breach.base` / (1 + 2 × fortification), with `base` 0.06 so a bare house keeps its old odds. Leaving through a barricade takes 10 ticks more. A garrison now forms on a barricaded door (it was fortification 0.05).

Drawn at near zoom: a bar across each door step when barricaded; a heavier outline as well when reinforced; an inner outline too when fortified.

Seed 1, 9,000 ticks: breaches 686 → 363, dead 929 → 633, turned 1,078 → 702. At tick 3,000, of 2,068 peopled buildings 1,838 were open (most never learned of the outbreak), 38 barricaded, 171 reinforced, 21 fortified; by 9,000, 201 barricaded, 135 reinforced, 2 fortified, as materials ran out.

- **Sweep** (mapSeed 1, runSeeds 1–8): **gate 2 fails**, as expected. Six runs end at 31–36% turned and 22–27% dead, below the 40–90% band; two smoulder out (seed 3 resolved at tick 2,962, seed 8 at 12,435, both at 1–2%). Gate 4 passes: shelters form, fall and re-form in all eight, no stasis, survival by caution band 37.9% / 40.2% / 41.4% (z 4.5); named survivors live a median 18,000 ticks after naming, 54% alive at the end. **Open:** retune — the levers are the turn delay, the breach base, and the stage thresholds.
- **Retune 1: turn delay 300–1,200 ticks (was 20–40), reinforced takes 4 (was 5)** (runSeeds 1–8): gate 2 still fails, and further: six runs at 21–31% turned, 20–26% dead; two smoulder out at 2–3%. The longer delay slows the epidemic more than admission speeds it — a conversion now comes minutes after the bite, not seconds, so each generation of the outbreak takes ten times as long. Gate 4 passes (survival by caution 43.1% / 44.2% / 45.2%, z 2.6).
- **The gate measures loss, not infection** (decided after the exploration below): gate 2 is now total human loss — dead plus turned — 40–95% of the population (`scripts/sweep.ts`). With feeding, most of the swarmed are eaten rather than turned, and a city where everyone dies and few turn is still falling; the turned share alone capped below the band once feeding and stages were in, and tuning the turn delay to it would have tuned a side effect. The long delay stays: it is what makes the unwitnessed bite dangerous. On the retune-1 sweep, loss was 41–57% in six of eight runs (two smouldered), so it would pass as tuned; not yet re-swept.
- **Bites add up** (`Sim.bites`, `infection.rebiteFactor` 0.5): each bite after the first halves the time left to turning — someone who got away from a crowd is further gone — and the inspector shows the count. It also plugs part of a leak: an infected sim lingering near the dead was more likely to be eaten (counted dead) before it turned.
- **Exploring the breach base on top of retune 1** (runSeeds 1–4, not adopted): 0.15 gives 30–32% turned, 0.25 gives 31–38%; gate 2 fails at both, gate 4 passes. The crowd minimums now decide most break-ins, so the per-roll odds have little left to move: raising them two- to fourfold buys only a few points.

### Fourth round

- **Hunker-down is now the prepper** (`prepper` in `ARCHETYPES`; the user's choice of name): same weights, same mix share (0.26). Its professions other than retiree — parent, librarian, accountant, nurse, night-shift worker, caretaker — now lean civilian, and six new ones lean prepper: firearm instructor (gun shops), reseller (warehouses), trail guide, ham radio operator and homesteader (houses), and locksmith (hardware stores). Firearm instructor, trail guide, homesteader and ham radio operator have their own age ranges. The design notes keep the old name where they record the reasoning.
- **A mall** (`mall`, a functional tag the generator places rather than draws by weight; `map.mall`). Pairs of suburban blocks qualify across a standard street when each block is at least 8,000 m² and the pair at most 50,000 m²; those whose street meets a main street come first, then the largest. The best is cut back to a 45 m driveway from its main-street end: the two blocks become one, reached by the driveway, a dead end with `open` terrain. The grounds fill the merged block inside its streets; the building — at most 170 × 80 m, centred on the driveway where the grounds allow — stands 8 m beyond the driveway's end with its three doors facing the parking. A site the compound does not fit (an irregular block) is put back and the next tried, up to 12. Integrity 0.5 (glass-fronted, so reinforcible, never fortifiable), 80–150 materials, a few shotguns and some ammunition among the loot, and staff drawn from retail, security, cleaning, catering and shoppers. The grounds are state only to be drawn (`World.lots`): their edge, broken where the driveway enters, and at near zoom double rows of stalls either side of it. There is no commercial district kind: the map is a downtown, one industrial district and seven suburbs, and a retail park belongs on a suburban arterial. Maps 1–8 each get one in a suburb, its driveway on a main street, the building 152–170 × 80 m on grounds of 168–192 × 150–167 m. (Industrial districts were allowed at first; their blocks are larger and won every time.)
- **Sociality is per sim** (`Sim.sociality`), as caution is: a uniform draw at spawn, independent of archetype, so a gregarious prepper and a solitary civilian are both possible and the high and low tails are present in every archetype that joins anyone. The archetype scales it into the joining chance — 2 × trait × the archetype's figure, up to 1 — so the average civilian joins as before (a little less: the cap trims the top), the most sociable always do, the least never; loners and police, whose figure is 0, never join whatever their trait. Profession nudges the draw a little (`spawn.professionSociality`, clamped to 0–1): bartenders +0.2; teachers and parents +0.15; baristas, nurses, students, receptionists +0.1; retail assistants +0.05; night cleaners and long-haul drivers −0.2; groundskeepers and homesteaders −0.15; ham radio operators, trail guides and the homeless −0.1. Since profession also leans archetype, the trait is very nearly but not exactly independent of it. The inspector shows it beside caution. The sweep reports survival by sociality band, ungated, over sims whose archetype joins anyone (for the rest the trait does nothing): whether going along with others helps or hurts — crowds share memory and defend better, but are found sooner and die together when a shelter falls. The extra draw at spawn shifts every run's random sequence. Not yet swept.
- **Conversations** (`config.talk`, `Sim.gathering`, `Sim.talkUntil`; encounters.ts). Meeting no longer trades everything. Two who pass within 4 m still pass on panic and that there is an outbreak; only if they stop to talk do they trade street and building memory and who is known to be bitten. They stop at 1.5 × their mean sociality, up to 1 (the average pair three times in four, two of the most sociable always), unless either has danger in sight, is in flight, fighting, backing off, on a sortie or on a call. A conversation is named by the sim that started it. Each member stays 4–20 ticks, longer the more sociable, so the least sociable drift off first. A passer within 12 m of one may join it at its own sociality, up to 10 people; members walk in until close (1.5 m + 0.4 m a head from its middle), then stand still facing the middle. What a conversation knows is pooled every 5 ticks. Decisions break it up the moment anyone in it sees danger (`ctx.talkAlarm`, from the perception snapshot, so all decide alike). The invitation to come along ("come with us") still happens on any meeting. Drawn at mid and near zoom: a faint line from each member to the middle, and for three or more a ring at least 5 px across. Seed 1, 3,000 ticks: 6.6% of outdoor sim-ticks spent talking; about 4,760 conversations, a quarter reaching three people, 6% four, 65 five, 17 six, 4 eight and 2 the cap of ten. Joining only within the 4 m encounter radius gave almost no gatherings (a passer seldom comes that close to a pair standing still), hence the 12 m reach. On three runSeeds of mapSeed 1 at 9,000 ticks, against the commit before: seed 1 lost more (1,854 dead or turned, was 1,019), seed 3 fewer (779, was 1,672), seed 2 smouldered either way; awareness spread about as fast. Seed spread swamps it: not yet swept. (These comparisons were before members closed in; sims stuck 0.0%, reversals 0.2% after.)
- **The outbreak is news only in conversation.** Passing someone now passes on only fear (panic, damped); that there is an outbreak travels by word of mouth only when two stop to talk, or inside a building (the merge on entering). Everything else that makes a sim aware is unchanged and direct: seeing a zombie, a bite or a conversion, gunfire or a shout, an alerted building, a dispatch. A crowd running toward someone frightens it (panic contagion) but, as before, does not tell it why. Against conversations alone, mapSeed 1, runSeeds 1–4: awareness spreads markedly slower — unaware outdoors at tick 1,800 were 224–707 of 721–1,026, now 444–1,148 of 851–1,194; at 3,000, 40–123 were 57–200 now 167–555 — and more people are still out on the streets on their routines. Loss by tick 9,000 fell in three of four (seed 1 1,446 → 282, seed 3 1,532 → 1,267, seed 4 1,326 → 828; seed 2, which smoulders, 83 → 174). The likely reading, not yet checked: the unaware keep their routines rather than converging on homes and shelters, so fewer crowded buildings fall in the first hours; seed 1 now nearly smoulders (267 lost by 3,000, 282 by 9,000). That pulls against gate 2 (loss 40–95%): not yet swept.
- **Trust** (`Sim.trust`, `config.trust`): a third per-sim trait, a uniform draw independent of archetype, judged by the listener alone — sociality is whether you talk, trust whether you believe what you hear, caution how much risk you take on it. Hearsay is taken as (1 − trust) × 1,800 ticks older than it is (`ageShift`, one memory half-life): a sceptic believes what it is told about streets and buildings half as much, the trusting at face value, and a rumour grows staler at every telling. It costs nothing new: `observedAt` already ages beliefs, and merging compares beliefs as heard. Believing in the outbreak took 1 + round((1 − trust) × 2) tellings from different people (`Sim.toldBy`, emptied once aware): one for the trusting, three for a sceptic (now unease, below). Who is said to be bitten is taken on at chance `trust` at each telling, so a sceptic may let someone in whom the others knew was bitten. Shouted warnings and everything seen or heard directly are unchanged. The inspector shows trust; the sweep reports survival by trust band, ungated. Against step 2, mapSeed 1, runSeeds 1–4: awareness slower again — unaware outdoors at tick 3,000 were 167–555, now 580–952 — and outcomes split further: loss by 9,000 seed 1 282 → 150, seed 2 174 → 1,718, seed 3 1,267 → 1,454, seed 4 828 → 63. Two of four now smoulder through 9,000 and two take off: whether a run takes off is decided in the first hour or two, and the levers for that are the opening zombie mechanics (to be reworked) and here `unease.tellingGain` and `talk.chance`. Not yet swept.
- **Release from an alerted building.** Residents released from a building that knows of the outbreak no longer walk out unaware: an alerted household keeps its people home (its pending release is dropped), and people at work leave aware, so their first decision outdoors sends them home — the same bodies on the street at release, knowing, on a different errand.
- **Unease** (`Sim.unease`, `config.unease`) in place of the telling count: belief short of knowing, 0–1, in someone not yet aware. Each telling from someone new closes 0.4 (least trusting) to 1 (most) of the gap to 1, and at 0.75 it becomes awareness — one telling for the trusting, two at middling trust, three for a sceptic, as before. Being swept along by a running crowd moves it toward 0.6 × the crowd's pull (never far enough to know); gunfire too faint to know for what it is closes 0.3 of the gap. It fades by 0.0005 of itself a tick. Meanwhile it does something: stops on errands are shortened (idle × 1 − 0.8 × unease), home joins the sampled next stops weighted by 3 × unease, and panic is held up to 0.3 × unease. The inspector shows "errands, uneasy" from 0.2. Disbelief degrades into unease rather than flipping.
- **A shout carries danger, not the outbreak.** Hearing a warning still marks the street dangerous and frightens (panic); it tells the hearer there is an outbreak only if the hearer can see the shouter (within its sight radius, line of sight) — otherwise it is a telling, raising unease. Shouts no longer alert buildings (gunfire still does): through a wall a shout says something is wrong, not what. People flee a street they now believe dangerous without knowing why — and may run toward somewhere nothing has happened yet.
- **Objectives are weighed again with migration's rules** (`awareness.ts reconsider`). An aware sim outdoors heading for shelter weighs its objective every 30 ticks (staggered by id, as roles and migration) and at once when news of its target's street or the building comes in (`Sim.reconsider`, set when a conversation or a shout changes those beliefs). Home is given up once believed dangerous. A shelter is given up only for one better by more than migration's margin (0.25 + 0.5 × the target's believed fortification + 0.3 × caution), and never within migration's cooldown (600 ticks) of the last change (`Sim.lastMigratedAt`, shared). First responders returning to their station are left alone.
- **Measured together** (release, unease and shouts, objectives) against trust alone, mapSeed 1, runSeeds 1–4, loss by 9,000: 150 → 141, 1,718 → 950, 1,454 → 2,097, 63 → 210; unaware outdoors at 3,000 a little fewer in seeds 2 and 3 (447 and 403, were 730 and 580). Movement: sims stuck 0.0%, reversals 0.1%. Seed spread still dominates; not yet swept.
- **The intact dead** (`Zombie.intact`, `zombie.intactSight` 0.35, `intactGiveaway` 8 m; `perception.ts recognisedWithin`). A sim who turns from a single bite has no wounds or torn clothes to give it away: survivors register it at 0.35 of their sight radius, but never nearer than 8 m (or their sight, if less), because the way it moves gives it away — recognisability shortens the range, it does not allow a clean approach. The same range applies wherever survivors notice the dead: perception and threat, an armed survivor picking a target, watching from a door, firing from inside. It is lost on the zombie's first attack, bite or miss: the first grab is when people notice. Perception is rebuilt every tick, so the next tick everyone near sees it at full range, and a fresh sighting shouts as usual. More than one bite, or turned in a breach, and it is marked like any other. The asymmetry about who knows now outlasts the moment of turning: the zombies hardest to spot are the ones made by the quietest encounters — the same ones that carry infection into shelters. Drawn paler (#d49a9e) at near zoom only, where the viewer is told; the city is not. Against the commit before, mapSeed 1, runSeeds 1–4, loss by 9,000: 141 → 109, 950 → 347, 2,097 → 1,434, 210 → 147 — lower in all four, not the expected direction; unexamined (one guess: armed survivors no longer shoot an intact zombie at range, so less gunfire draws the dead). Only 1–8 are still intact at 9,000: the camouflage is spent quickly. Not yet swept. (Zombie types — a slow shambler among others — remain a scenario-wide gait, not per zombie.)
- **Sweep after the fourth round** (mapSeed 1, runSeeds 1–8, commit 8fdc86a; 526 s wall, about 7 ms a tick). **Gate 2 fails** (loss 40–95% in 5 of 8: seeds 3, 5, 6, 7, 8 at 48–70%; seed 2 at 21%; seeds 1 and 4 smoulder at 2–3%, seed 4 resolving at tick 9,805). **Gate 4 fails on caution:** shelters form, fall and re-form in all eight and there is no stasis, but survival by caution band is 40.7% / 41.0% / 41.1% (z 0.5; it was z 2.6–6.6 in every earlier sweep). Survival now differs by trust instead (39.4% / 41.2% / 42.2%, z 3.6), not by sociality (z −1.3). Named survivors: 45% alive at the end, a median 14,822 ticks lived after naming.
  - **Why runs smoulder:** the early dead are killed as fast as they are made. In seeds 1 and 4, zombies destroyed over the run match conversions almost one for one (88 of 90, 84 of 83); where the outbreak takes off it is about seven in ten (571 of 677 to 1,546 of 2,145). Both smouldering origins were small (51–55 conversions in the first hour, against 102–229), and awake zombies peaked at 28–29 within 20 minutes and fell to none.
  - **Awareness is slow:** at 30 minutes 70–99% of people outdoors are unaware, at an hour 60–80% (447–934 of 613–1,235). Conversations are many early (69–133 people talking at 30 minutes) and thin out as the streets empty (12–63 at an hour).
  - **Caution lost its grip, probably because danger knowledge now travels slowly:** caution acts through how much believed danger costs a route, migration's margin and who is sent out, and all three need believed danger; since only talk trades it, and sceptics discount it, there is less to be cautious about. Trust, which decides what reaches a sim, now separates survival. The gate (caution, |z| ≥ 2) was written to show that a per-sim trait matters; whether it should now read "some per-sim trait" is the user's call — not changed.
  - **What there is to watch:** at 1×, with every event treated as on screen (an upper bound), a median 8–9 ticker lines per 10 minutes once an outbreak has taken off — one a minute or so — and 1–2 in a smouldering run, where 12–18 of 54 ten-minute windows after the first hour have no line at all ("dead air"); taking-off runs have none. The first hour reads alike in every seed (52–83 lines), before the runs part ways. Awake zombies peak late in several runs (seeds 2, 5, 6 at ticks 17,400–34,800) as dormant hordes build (250–350 dormant at the end where it took off).
  - The sweep now records this timeline per run (`scripts/lib/run-one.ts TimelineEntry`) and prints it per seed.

### The especially cautious and unknown streets

Caution had stopped separating survival (z 0.5 and 1.5 in the last two sweeps, and z −0.9 among the asocial, so not sociality standing in for it). Quiet streets were already remembered (every street walked is written with the danger seen there) and passed on in conversation; but an unknown street also read as danger 0 (`memory.unknownStreetDanger` was 0: ignorance reads as safety), and caution only scales believed danger, so with danger news slow there was almost nothing for it to act on. Now, for the especially cautious only (the user's call), an unknown street reads as 0.15 — ramping in from caution 0.66, the top band's edge, to the full value at caution 1 — and a report drifts back toward that prior as it ages instead of toward safe: believed danger = confidence × seen + (1 − confidence) × prior (`pathfinding.ts believedDanger`; routing only). Everyone below 0.66 routes exactly as before. So the cautious keep to streets they or those they talk to know are quiet, paying detours for it, and news of a quiet street is worth something to them; a sceptic, hearing it as older than it is, takes less reassurance from it. Bad news still never turns good.

- **Sweep with the cautious change, the first at 50,400 ticks** (mapSeed 1, runSeeds 1–8, commit 9554f8d; 1,744 s). **Gate 2 passes** (loss 40–95% in 7 of 8: 64–73% in seven; seed 3 smoulders at 15%). **Gate 4 still fails on caution:** 26.4% / 26.9% / 26.7% (z 0.5); among the asocial z 1.1; by trust z 3.6. Named survivors: 38% alive at the end, median 12,031 ticks after naming. Curves keep rising slowly to the end (seeds 2, 5, 8 add 4–8 points of turned after tick 36,000); awake zombies peak at ticks 33,000–37,800 in four seeds. Dead air: none where the outbreak took off.
- **Why caution still does not show — where people are lost** (seed 1, first 20,000 ticks, tracked sims): more than half of bites (219–269 per caution band) and killings (252–268) happen indoors, in shelters; outdoors, the bands fare alike — about 20% of each band bitten outside, about 19% killed outside, the most cautious no better than the boldest. Caution's levers are route cost and migration's margin; neither reaches the shelter, where most die, and outdoors the danger that bites people is the danger nobody yet knew of, so routing on belief, cautious or not, avoids little of it. The routing change is kept (it is principled, and costs nothing for most); making caution matter needs it to act on what a sim sees and on the shelter — the user's decision.

### Strangers at the door

Since most survivors are lost indoors, caution now acts at the door (`buildings.ts refusedAsStranger`, `shelter.strangerVeto` 0.5, `strangerVetoFrom` 0.66). In a building that knows of the outbreak, each especially cautious person sheltering inside refuses a stranger at 0.5, ramping in from caution 0.66 to the full chance at caution 1; with several of them inside, a stranger seldom gets in. Not a stranger: someone coming home, one of the congregation at its church, an officer at its station. No groups were needed: admission was already a veto by whoever is inside (anyone who knows the newcomer is bitten keeps them out), and a cautious shelter is simply one with cautious people in it, changing as they come and go. Nobody reads the stranger's infection — a stranger is refused for being one, which is the point: a cautious house keeps out the hidden bite along with everyone else, and the people it turns away take their chances outside. Ticker line "A survivor was turned away from …" (salience 12). On one 20,000-tick probe (seed 1, which smouldered under this change's random sequence) strangers were refused 2,961 times; whether that saves or costs lives is for the sweep.

- **Sweep with the stranger veto** (mapSeed 1, runSeeds 1–8, 50,400 ticks, commit 3b5f3bd). **Both gates pass**, the first time since fortification stages. Gate 2: loss 40–95% in 6 of 8 (59–64% in six; seeds 1 and 5 smoulder at 2% and 12%, seed 1 resolving at tick 4,168). Gate 4: shelters form, fall and re-form in all eight, no stasis, and survival by caution band 38.5% / 38.7% / 40.8% (z 3.0) — the most cautious band now does better, as the veto's design intended. Among the asocial z 1.8 (39.0% / 38.1% / 41.3%); by trust z 1.4 (was 3.6–4.2: caution at the door has taken part of trust's place); by sociality z 0.1. Survival overall rose (about 39% of tracked sims alive at the end, was about 27%); named survivors: 42% alive at the end, a median 22,309 ticks lived after naming (was 12,031). Strangers were refused 3,000–9,000 times a run; the ticker's salience absorbs it (median 8–10 lines per 10 minutes, as before). Two smouldering runs of eight is the opening's problem, still to be reworked.

### Run length 50,400

At the user's request, the run is now 50,400 ticks (was 36,000): 14 simulated hours, seven whole day/night cycles, ending at the hour it began. The sweep after the fourth round showed runs unfinished at 36,000 — awake zombies peaking at ticks 17,400–34,800 and 250–350 dormant at the end where the outbreak took off — and the late rise of dormant hordes needed room. (48,000, ending at night, was tried first; whole days were kept, and a night ending left for later.) Nothing but the stopping point reads the run length (viewer, harness); the roster's stages, the release and the day all run on their own ticks. Sweeps run about 40% longer. The loss gate is measured at the end, so it reads higher than at 36,000 for the same run; earlier sweeps in this document are at 36,000.

### Cars

Built at the user's request ahead of the sequencing in the design notes (cars were the second expansion, after the base dynamics proved out): gridlock as a vector for infection, and engines as a dinner bell for an opening that smoulders. Jams and abandonment, not traffic modelling (`state/car.ts`, `systems/cars.ts`, `config.cars`).

- **A car is a building with a velocity.** `Car`: parked, driving or abandoned; occupants (the driver first), a claim by whoever is walking to it, a destination building and kerb point, a route of streets, and since when it has been blocked. `Sim.car` marks someone inside: counted outdoors (or symptomatic) as before, so the population invariant is unchanged, and out of reach of everything that acts on people on foot (`isOutdoorLiving` excludes them: hashing, perception, combat, encounters, decisions). `Sim.boarding` marks the car someone is walking to.
- **Parked at setup** (run RNG): at the kerb in front of a share of each tag's buildings (houses 0.45, workplaces 0.3–0.5, flavour 0.25), on standard streets only (an alley is too narrow to pass one; never on a bridge or open ground), at least 14 m from a junction and 6.5 m from another car; and in 60% of the mall's stalls. About 2,600 on map 1, 138 in the mall lot. Every car is a 4.5 × 1.9 m rectangle nobody on foot walks through (`CarIndex`: standing cars on a grid rebuilt only when one starts, stops or is abandoned; moving ones checked directly — rebuilding the grid every tick cost 4–5 ms a tick).
- **Who drives:** an aware sim on foot heading for home or shelter more than 500 m away, not in flight, checking on the 30-tick cadence, takes the nearest free parked car it can see within 50 m and walks to it (giving it up, back on foot, if it is taken or it panics). At the car it gets in with any aware companions on foot beside it bound for the same building, up to four, and plans the drive with its own memory.
- **Driving:** toward the next junction along the street, kept right of the centreline (2.5 m, at most a quarter of the street's width) so opposing cars never meet; a junction counts as passed once the car has drawn level with it (the first version aimed at a point offset across the line to the junction, which turned as the car closed in, and cars orbited junctions for ever). Up to 9 m a tick, slowed by congestion (1 / (1 + 0.3 × cars driving within 15 m)). It stops for anything in its own path within 9.25 m — people, the dead, abandoned cars, moving cars — and when two moving cars stop for each other the lower id yields. It pulls up at the kerb by the destination's door and everyone gets out; the car is parked there, free for anyone.
- **Jams and abandonment:** a car stopped behind something for 180 ticks is abandoned where it stands, for good, and its people walk on; another car stopped behind it is abandoned in turn. Ticker line "A car was abandoned on …" (salience 25). Drawn dark and crossed.
- **Under siege:** a car being driven, moving or stuck, makes engine noise every 10 ticks (45 m, intensity 0.6) that the dead hear and people ignore (no panic, unease or alert). Each awake zombie at an occupied car breaks in at 0.02 a tick: the car is abandoned and everyone inside is out among them. Someone who turns inside bites each of the others at 0.6, and the car is abandoned.
- **Drawn:** a rectangle along its heading — parked, a dim outline at near zoom; abandoned, dark and crossed at mid and near; driving, filled, every frame. Standing cars are drawn into the cached static layer (drawing all 2,600 every frame took 37 ms).
- **Measured** (mapSeed 1, 9,000 ticks, invariant checked every tick): 355–544 trips per run, 332–512 completed, 14–31 cars abandoned, at most 28–33 driving at once; loss by 9,000 for runSeeds 1, 3, 5: 1,634, 629, 483 (seed 1 smouldered at 109 before cars). On seed 1 by tick 6,000 a line of five abandoned cars stands across a bridge: the river crossing is closed, as the design notes foresaw. About 7.9 ms a tick against 6.8 without cars (3,000-tick bench). No gridlock yet: with awareness slow, too few drive at once for the roads to choke. Not yet swept.
- **Sweep with cars** (mapSeed 1, runSeeds 1–8, still at 36,000 ticks; commit dcbf643). **Gate 2 passes** (loss 40–95% in 7 of 8: 57–69% in seven; seed 5 smoulders at 10%). The car placement shifts every run's random sequence, so seed numbers do not match the sweep before; across the eight, one smoulders where two did and a third limped to 21%. **Gate 4 fails on caution again:** shelters form, fall and re-form in all eight, no stasis, but survival by caution band is 29.1% / 29.9% / 30.1% (z 1.5). Among the asocial (sociality < 0.33) caution makes no difference either (30.0% / 29.4% / 29.0%, z −0.9): it is not sociality standing in for caution. Trust still separates survival (28.3% / 29.5% / 31.2%, z 4.2); sociality does not (z 0.5). Survival overall fell (about 30% of tracked sims alive at the end, was about 41%); named survivors live a median 6,060 ticks after naming (was 14,822), 37% alive at the end. Cars: at most 15–27 driving at once, 15–68 abandoned per run — no gridlock. Awareness is still slow: at an hour 60–95% of people outdoors are unaware. Ticker: a median 8–9 lines per 10 minutes, dead air only in the smouldering run (4 of 54 windows). Awake zombies still peak late (ticks 16,800–34,800 where the outbreak took off), 264–393 dormant at the end. Wall time 1,390 s, 16–22 ms a tick: this host is about twice as slow as the last (the code before cars runs 6,000 ticks at 12.2 ms a tick here, after at 12.8 — cars cost about 4%).

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

**Layout.** Fixed. Districts are a 3×3 grid of ~1,067 m cells: downtown in the centre, industrial in one corner, suburbs on the rest of the ring. District boundaries and the map edge are straight continuous streets; inside each district the street grid is rotated a few degrees against its neighbours, so the seams show where grids meet. Everything is edge-based: a park is a block with no building whose bounding streets carry terrain `open`; there is no area primitive. A sim off any street (rare; only while steering) reads perception from the nearest street within 40 m, falling back to `standard`.

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

**Open:** all six default values are guesses and are the first thing the sweep should move. The ranges and the pattern are fixed; the numbers are not.

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

**Open:** whether counters live inline on the Sim or in a parallel structure indexed by id. Inline is simpler; parallel is better for cache locality if the tick loop is ever restructured as structure-of-arrays. Not worth deciding until profiling says so.

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

**Open:** whether residents should be instantiated as tracked sims when a building is breached, rather than resolving statistically. It would make interior events legible person by person on the panel, at the cost of spawning forty agents at the worst possible moment for the frame budget. The count classes shown when inspecting depend on this: five if residents, symptomatic sims and bodies are tracked separately, two if everything indoors collapses to living and occupying.

Two groups, each with its own terminal leaf, plus rescue. Leaves are updated incrementally at each transition; the headless harness recounts them from entity state every tick and asserts the recount matches (not in the browser). Group totals are sums, never stored — deriving them removes a whole class of desynchronisation bug.

| Group | Leaf | Holds |
| --- | --- | --- |
| `unturned` | `outdoors` | Survivors on the street |
| `unturned` | `indoors` | Anonymous residents plus tracked sims inside buildings |
| `unturned` | `dead` | Died without converting |
| `unturned` | `evacuated` | Left the map by an exit (`systems/exits.ts`), bitten or not |
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

### Engagement capacity

The number a sim believes it can handle, used by police `engageThreshold` and by the occupation contest rule. Not a perception value — a rough self-assessment:

```
capacity = floor(ammo * baseKill) + meleeCapacity
```

where `meleeCapacity` is 3 for sledgehammer, 2 for club, 1 for knife, 0 unarmed. A police officer with 12 rounds reads as capacity 6 and will contest an occupation of five; the same officer at 2 rounds reads as 1 and will not.

**Open:** every number in this section is a starting guess. The ones most likely to be wrong are base infection chance, which sets how survivable contact is at all, and the melee miss penalties, which decide whether unarmed survivors have any agency.

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

**Open:** whether drag applies to a sim inside an occupied building. It probably should, and it would make withdrawing from a bad contest much harder than entering it — which is either good drama or an unfair trap, and only playing it will say which.

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

**Open:** whether runners should also detect at a longer radius. Probably not — fast and blind is more interesting than fast and aware, and keeps sneaking meaningful.

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

**Sight requires line of sight.** A wall blocks it. Combined with the indoor `detectability` halving, a sim inside a building is effectively invisible to sight — which is intended, and is why discovery of shelters runs through the other two channels.

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

### Pathfinding

A\* over the shared street graph with a per-sim cost function:

```
cost(street) = length + dangerWeight * danger * confidence
```

**Unknown streets cost pure distance,** because an absent memory entry means `danger` is 0. The consequence is deliberate and worth stating: ignorance reads as safety. A sim routes happily through territory it knows nothing about and detours around the one street it personally watched go bad. The best-informed survivors take the longest paths; naive ones walk confidently into the unknown.

**Open:** the alternative is a small baseline pessimism for unvisited streets, which makes sims hug familiar routes instead. Both are defensible and they look different on screen. Worth running both in a sweep.

Movement runs in two layers. Strategically, A\* returns a sequence of street ids cached in `route`. Tactically, the sim steers along that route in continuous space, avoiding what it can actually see — which is where float coordinates earn themselves.

**Repathing is gated four ways,** because this is the expensive part:

1. Fleeing does not path at all. Only sims with a destination route: scavengers, police falling back, survivors converging on a broadcast. Dozens of agents, not thousands.
2. A merge triggers a repath only if a changed street is on the current route. A list intersection, not a search.
3. `repathCooldown` blocks repathing more than once every 30 ticks.
4. A global `repathQueue` with a cap of 20 sims per tick, drained in id order. A few ticks of stale route is invisible.

Danger seen directly ahead bypasses the queue. A sim walking into a horde it can now see does not wait its turn.

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
2. **Re-score** — when the living fall below 0.3 (fallback tick 18,000), scoring runs again over the survivors, and the most unusual of the unnamed are named until 12 of the named are alive again. The same top-up then repeats every 1,800 ticks as the pool thins, so the roster always carries a current cast of living people as well as the record of the lost. (Measured on two runs: from the re-score to the end, 8–12 of the named are alive at any time, and 40–44 names accumulate in all; the roster stops adding at 96.) **Open:** between the provisional names dying off and the 30% threshold the living cast can run out — seed 2 had none alive from about tick 13,000 to 15,800.

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
- No rule makes the provisional roster durable: at around tick 7,600 the scored pool is the tracked sims — those released, expelled or out scavenging — and half of any of them are gone within half an hour. The final stage fares better (median 5,180 ticks left in the pool, 28% alive at the end). **Open:** whether to change when the provisional stage fires, or accept a roster that is mostly a record.
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

### Reservists and squads

The only mechanism that makes an armed group mid-run (`systems/squads.ts`). Police are placed at tick zero and spent; reservists are the city organising itself after collapse. This builds the squads the design notes deferred to v2, keeping what made them cheap: no negotiation. The one joining rule is forming at a depot; members leave only by dying; succession is fixed (the lowest surviving id); squads never meet squads.

- **Reservists** (archetype `reservist`, `config.reservists`): anonymous residents until the order — nobody is a reservist before it. They were first placed from the residents at setup and tracked from the start, which made them 12% of everyone tracked at tick zero against 2% of the city: 56 pistols on the street, as many as the police, an armed population nobody designed, with outsized weight in the first hour. Then drawn like any archetype at instantiation (2%): seeds 1 and 3 to tick 24,000 instantiated 32–44, 2–3 ever waited armed at a depot, and no squad formed — too few and too scattered (as when drawn at 1.5% before the order existed).
- **Armouries.** Two of the map's `depot` buildings (about 60 per map, a flavour tag), the one nearest the middle and then the farthest from it, each holding 12 rifles (`Building.weaponStock`). Two, not more: with three or four the same ten or so arrivals split across depots that rarely gather four (three seeds each: two armouries formed 2 squads every time; three, 0–2; four, 0–2).
- **The order and the muster** (`squads.ts callUp`, `muster`; the user's design): the reserve is activated once `reservists.callUpCalls` (300) 911 calls have come in (`World.callsTaken`, `World.calledUpAt`, `reservistsCalledUp` — a ticker line that drops playback to 1×): what the authorities know, not the outbreak itself. Reservists at their strength could not deal with a city already lost, and a call-up from the first bite put the outbreak down before it had a shape. At the order, `reservists.share` (2%) of the residents **still in buildings the living hold** step out as tracked reservists — a district already gone produces none, so the order depends on how bad things already are — weighted toward buildings near an armoury (`exp(−d / depotScale)`, 1,500 m, normalised so the share overall is unchanged): the lever for how many arrive, without changing what the journey costs. A tenth (`pistolShare` 0.1) carry a pistol of their own (12 rounds). Each makes for its depot (the armoury nearest home) at once. The journey stays lethal: not a guaranteed delivery of squads. Measured (seeds 1 and 3, to tick 18,000): ordered at ticks 5,016 and 2,155; 65 and 75 mustered; 6 squads formed each (the rifles run out at 24); by tick 3,600 on seed 3, 19 of 75 had died; by tick 18,000, 15 and 55 dead, 24 and 16 turned.
- **No local call-up any more.** A bite or a turning seen, or a shelter falling within sight, used to call a reservist up; with the muster they are not needed, and they are gone (`witnessFall` removed). Called up (`muster` mobilised), a reservist makes for its depot, never stopping to shelter — panicked, it gets clear of the danger first, then goes on.
- **At the depot** it draws a rifle while any are left (`waiting`), or stands down and shelters there. Not a stranger at its own depot.
- **The service rifle** (`combat.ranged.rifle`): 40 m, 0.6 per round, 8-tick cooldown, noise 220 m — the loudest weapon. Found only in armouries; 20 rounds each.
- **A squad** is no object: each member carries `squadLeader` (its leader's id, its own for the leader) and `squadSlot`. Four waiting at one depot form one, the lowest id leading, and wait inside for a target. Later arrivals wait for the next four (reinforcing a squad in the field is not built).
- **Formation** (`squadPass`, before decisions): file while travelling — slots back along the leader's trail, a point each 3 m; diamond while any member has a zombie within 0.8 of its weapon's range, held 30 ticks after — slots 3 m out ahead, to either side and behind, turned toward the danger the leader sees. File to diamond is a ticker line (`squadEngaged`).
- **Only the leader routes**; followers steer for their slots. A follower more than 8 m from its slot for 20 ticks makes straight for the leader for 30 ticks or until within 4 m: the same hold-and-release that stopped fleeing sims swinging back and forth. The leader waits while a follower lags more than 12 m.
- **Targets** (`squadTarget`): a 911 call within 1,200 m that no other squad holds, nearest first; failing that, the loudest gunfire heard since it last looked (beyond 15 m: not its own). Held until resolved, judged too strong at the door, or 1,800 ticks old; looked for every 30 ticks, from the depot when there is none. Occupied buildings are not targets in themselves: memory does not record who is inside, so the leader cannot know.
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

A vector dressed as a rescue (`systems/emt.ts`, `config.emt`). A bitten sim calls for help; an ambulance comes, its crew fetches the patient and drives it to a hospital — one of the fullest buildings on the map — where it turns, inside, among everyone. Nobody involved does anything wrong, and hospitals gain a part mid-run beyond being an origin.

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

### Exits

The map had none: its edge is a ring road, and nothing left. Evacuation therefore sent people to buildings far across the city, scattering in every direction (measured: with evacuation at 10%, never more than three cars stopped on any one street at once, the same as without it; abandoned cars piled up one at a time, up to ten on a street, not in a queue). What a jam, and a cordon, need is scarcity: a few ways out, each fed by an arterial that converges on it.

So the generator marks `map.exits.count` (3) of the district-boundary arterials — which already run straight from edge to edge — as highways (28 m, always lit), each leaving the map at one end (`World.exits`: the edge node, the last segment, the outward direction). The first end is drawn at random, each next at random among ends at least half the map from those chosen (one a line); ends where the river meets the edge are passed over. A highway that crosses the river is bridged there — the natural chokepoint, where a cordon would stand and abandoned cars could close the way out (two of three highways cross it on maps 1–5). Exits differ by map seed, not by run. Drawn as an amber arrow at the edge, pointing out, with the word, at every zoom.

**Leaving** (`systems/exits.ts`). Evacuees now make for the nearest exit (the highways out are signposted: common knowledge), destination kind `leave`: on foot, or in a car if one is at hand (any free parked car within reach, with companions making for the same exit; `Car.exit`). Someone on foot within 8 m of an exit's node is through it; a car reaching it takes everyone inside out, and is gone (`Car.state` gone: out of play, off the obstacle grid, not drawn). Either way the sim is out of play (condition `evacuated`) and counted in `unturned.evacuated` — the bitten too: nobody at the exit looks for a bite yet, and those are also counted in `World.escapedInfected`, the number a cordon would exist to keep down. A named survivor getting out makes a ticker line. Without an exit on the map, evacuees go to a far building as before. Measured, evacuation on at 10% (seed 1, to tick 12,000): 130 evacuated, 103 cars driven off the map, none bitten; at worst 11 cars stopped behind another at once (3 before), 3 of them within 400 m of an exit. Off with `features.exits`.

### The cordon

The world outside sealing the city (`systems/cordon.ts`, `config.cordon`): an outside authority, arriving late, from off the map — not the city containing itself, which would make its own reservists the antagonists of the people they came from, and would compete with the depots' supply.

- **Notice.** The first district to evacuate is what the world outside reacts to (`release.ts updateEvacuation` sets `World.noticedAt`; the user's): one district gets out, the authorities react, the barriers close, and every district after that meets a sealed road — the same legible pattern every run. That first evacuation has its own ticker line, which drops playback to 1× (`districtEvacuating` with `first`). Before this, the outside noticed once 20 had come out by the exits; before that, at the first officer to radio for SWAT, a fixed lag after the outbreak, so the evacuees were mostly out before the barriers closed. With evacuation off, nobody leaves and the cordon never comes.
- **Arrival.** `cordon.delay` (600) ticks later — enough for that district to get through, not the next — a squad of four soldiers comes in at every exit: reservists by archetype, pale green, rifles and 40 rounds, `outsider`. **The invariant is amended**: soldiers are counted in the leaves like anyone (they can be bitten, die, turn), so the sum of the eight leaves is `scenario.population + World.outsiders` (the user's choice; the alternatives were a barrier with nobody holding it, or an abstract guard that cannot die). Their losses are derivable from entity state.
- **The barrier.** Each squad walks to its post, 8 m outside a barrier 40 m in from the edge; when the leader is there, the barrier closes (`Exit.closedAt`, `cordonClosed`, a ticker line that drops playback to 1×): the highway's last segment is `blocked` 1 for good, so route-finding treats it as impassable whether or not anyone is left to hold it. Drawn as a hard bright bar across the road in the institutional blue — the one thing in the city an outside authority put there — drawing itself across from the middle when it first appears. The squad holds its post (its leader's `post`, carried to a successor) in line abreast across the highway, `squads.lineSpacing` 3 m apart with the leader in the middle, and fights from the line rather than the diamond — it marches in that line too, from the edge to the post.
- **No screening, and the belief in it.** Nobody is let through, and there is no infection check (a cordon that could detect infection would know more than anyone inside). But those making for a closed exit do not know it is closed until they get there, and then they wait 10 m inside it, believing they will be screened and let through — `cordon.patience` (900) × (½ + their trust) ticks: the trusting wait longest. Then they give it up (`Sim.knownClosed`) for the nearest exit they have not found closed — a long way, through whatever the outbreak now holds — or, with none left, for shelter. Panic breaks the queue sooner (flight takes them to a door). A car reaching a closed barrier is left there, and those in it walk on to wait; the cars behind stop behind it and are abandoned in their turn: the queue becomes a jam that stays.
- **The barrier's geometry.** The exit's outward direction runs along the highway's last segment, not square to the map edge (the two differ where the road meets the edge at an angle, and the barrier then stopped short of one kerb). The bar is drawn kerb to kerb and 0.5 m past, square-ended, so the blockage is plain before anyone queues; the exit arrow and its label are signage, small and faint (alpha 0.4 and 0.6), so the barrier is the dominant mark.
- **Getting round it.** When patience runs out, a waiting sim tries to get round instead of giving the exit up, at `cordon.cross` (0.5) × (1 − trust): the sceptical try, the trusting go elsewhere (`Sim.crossing`, the side of the road it is already on). It walks to the kerb level with the barrier's end (`cordon.kerb` 1.5 m outside the road's edge, between the bar and the frontages), then along it to the edge, and is out — evacuated, bitten or not (`cordonEvaded`, a ticker line, then `simLeft`).
- **Whether the soldiers fire is the unit's, not a global switch.** Each unit draws it once when it arrives (`cordon.fireShare` 0.5; `Sim.firesOnCrossers`, the same for all four): some hold their fire and bleed people round the flanks, others do not, and across twenty seeds both happen — the design's usual answer to a binary question, a per-agent trait the sweep reports on. A unit that fires shoots at anyone getting round once within `cordon.fireLine` (2 m) of the barrier — trying to pass it, not just stepping out of the queue — with the rifle's ordinary roll, range and noise (`simDied` cause `shot`, a ticker line). Neither is safe: the gunfire recruits the dead to the biggest gathering of people on the map; the held fire leaks people, and the bitten among them, out of the city. **The viewer is not told which kind of unit holds an exit** — nothing in the drawing or the inspector differs; you find out when someone tries. This is the one place a survivor is shot at by anyone: the "survivor-on-survivor combat" exclusion stands everywhere else (the user's decision).
- **Anyone at the barrier.** Whoever reaches a closed exit's queue (within `cordon.queueRadius`), whatever brought them there, joins it — destination kind `leave`, with the same patience and the same chance at the flank — unless they have already given that exit up; not police, crews, their patients or soldiers. Otherwise the crowd that gathers has no agency and simply waits to be caught. And the dead in sight end the wait at once: nobody stands in a queue to be caught.
- **Measured** (seeds 1–4, evacuation on at 10%, to tick 15,000): noticed at ticks 349–807, first barrier closed at 967–1,426; 98–131 out before it, 5–16 after (round the flanks); peak waiting 8–28; 8–17 tried the flank, 2–4 shot, 5–15 got round; units drawn hhF, hhF, Fhh, Fhh; soldiers alive 9–12 of 12. The later districts' evacuations (ticks ~9,000–11,000) all meet closed exits.
- **Not built yet:** whether seeing someone shot, or seeing someone get through, changes what the rest of the queue does.
- **Measured with the radio trigger** (seed 1, evacuation on at 10%, to tick 12,000): noticed at tick 177; barriers closed at 1,996–1,999; 128 evacuated, every one before the first closure; at most 5 waiting — the window backwards, which is why the trigger moved. Off with `features.cordon`.

### The rescue

The ending (`systems/rescue.ts`, `config.rescue`; the user's design, after B's ordering). The run is 64,800 ticks: the outbreak keeps its fourteen hours, so its tuning stays valid, and the rescue has four. Sweep first, broadcast second: a broadcast first would empty the city of everyone who could move, and the sweep would clear an empty map; a sweep first makes the convergence, a flow across ground nobody has crossed in hours, against the way the soldiers came.

- **The company** comes in at `rescue.at` (50,400) by the exit whose corridor holds the most people still sheltering (`World.rescueExit`, `rescueSweep` — a ticker line that drops playback to 1×): `rescue.squads` (4) squads of soldiers from outside (`Sim.sweep`, outsiders like the cordon's, through the same `spawnSquad`), rifles and 120 rounds.
- **The corridor and its front.** The corridor runs from the exit toward the middle of the map, `halfWidth` (150 m) either side. The front advances `speed` (0.15 m a tick, about 540 m an hour) to at most `depth` (2,200 m), and never more than `lead` (60 m) ahead of the farthest living soldier: it is where the company has got to, and with none left the sweep stops. Soldiers from outside — the company and the cordon — never panic (panic.ts: their mode is always informed, and their nerve never breaks); panicking, the first company stopped firing and was eaten in an hour and a half: slow and incomplete — it takes a corridor, not the city, and districts away from it are never reached, which is the ending most of the roster gets. Each squad leader's post is its lane of the front line, snapped to the street; the squads fight as squads do.
- **Sending back.** Every 30 ticks, anyone outdoors within `sendRadius` (40 m) of a soldier who identifies itself makes for the exit; buildings the living hold behind the front give up their residents (`takeShare` 1, as evacuees) and their tracked people (`Building.sweptAt`).
- **The unidentified** (combat.ts `sweepFire`; the user's: only those). A soldier with no dead in reach looks at the nearest person in sight and range who does not identify itself — frozen, sprinting in a panic, or in the dark — and at `misidentify` (0.15) a look takes it for one of the dead and shoots (`simDied` cause `mistaken`). Nobody tells the living from the bitten: a sweep that did would know what nobody knows. The bitten are sent back like anyone. This widens the cordon's exception to the no-survivor-on-survivor rule, at the scale of the ending.
- **The broadcast**, `broadcast` (7,200) ticks after the sweep began (`rescueBroadcast`, a ticker line): everyone tracked and free to — not police, crews, their patients, squads, those from outside — makes for the exit, and keeps doing so, setting out again once calm if it ran for a door on the way; buildings still held let out `broadcastShare` (half) of their residents. Those far from the corridor cross uncleared ground.
- **Trucks**, at the exit, every `truckEvery` (600) ticks: one pulls up beyond the barrier, loads for `truckLoad` (180), and takes up to `truckCapacity` (25) of those waiting at the barrier, longest waiting first (`truckLeft`). The wait at the rescue's exit has no patience and no flank: it is for a truck, among soldiers. Nobody is screened; the bitten get out with everyone else (`World.escapedInfected`). When the run ends, those still in the queue are left behind.
- Off with `features.rescue`.

### Evacuation

The release at tick 600 was a cold-start fix — people onto the streets so the map is not dead — and it stays exactly as it was. But at tick 600 only 77 of 8,592 buildings know of the outbreak (seed 1), so release and awareness are two unrelated things at the same moment by accident: 674 of 883 released walked out unaware. Traffic was sparse (at most about 30 cars driving) because people learned in a trickle and left one at a time; a jam needs simultaneity.

So a second, separate event (`release.ts updateEvacuation`, the only other reader of district release state, `District.evacuatedAt`): every 30 ticks, a district with `evacuation.threshold` (7%) of its buildings alerted evacuates — half the residents still in each of its buildings leave together (one a tick per building), aware, each for a building 800–2,000 m away (the most robust of 8 drawn at random; failing any in range, the farthest drawn), far enough to drive. It happens where and when the outbreak arrives, per district, so a neighbourhood empties onto the roads while the next is still calm (`districtEvacuating`, a ticker line). Nothing is learnt by proximity: a building knowing does not tell the house next door; shouts and conversation still carry news.

Measured (seeds 1–2, to tick 15,000, against evacuation off): peak cars driving 28–29 → 44–48, peak stopped behind another 8–11 → 13–16, abandoned 9–21 → 34–83. Four to six districts evacuate per run; the first can go within 120 ticks where the outbreak starts. The threshold is a sweep parameter (5–10% the plausible range). Off with `features.evacuation`.

**Swept, and switched off by default** (8 seeds, with reservists and squads in): evacuation off, survival ~31%, both gates pass, caution z 5.0. On, at thresholds 5% / 7% / 10%: survival ~59% / ~62% / ~55%, loss in range only 3–4 of 8 seeds (gate 2 fails), stasis in 1–2, caution z 1.5 / 1.4 / −0.1 (gate 4 fails); cars abandoned per run 20–140. Half of each district's remaining residents leaving for far buildings takes away the people whose buildings would be breached and turned: the outbreak runs out of fuel, and survival no longer depends on caution. The jams are there; the share is far too large. To revisit: a share nearer 10–20%, or where evacuees go. **Switched on by default at a tenth** (`evacuation.share` 0.1; the user's, commit after d5fb65b): with evacuees leaving the map rather than crossing it, and the cordon closing behind the first district, both gates pass with it on (8 seeds: loss in range 8 of 8, no stall, turned 37–44%, caution z 7.6).

**Feature switches** (`config.features`), so each later addition can be benchmarked and swept with it off: `conversations` (off: every meeting trades everything, as before the fourth round), `unease` (off: the first telling convinces), `trust` (off: everything heard is taken at face value), `reconsider` (off: objectives are held once chosen), `intactZombies` (off: the one-bite dead are recognised like any other), `cars` (off: none are placed), `strangerVeto` (off: strangers are let in), `cautiousRouting` (off: unknown streets read as safe). All default on. Timing: `npx tsx scripts/bench.ts --ticks 15000 --runs 3 --set features.cars=false`, interleaved with a run at the defaults; behaviour: `npm run sweep -- --seeds 8 --set features.conversations=false`.

Everything in the tuning tables stays in `config.ts`. Those interact chaotically and thirty sliders produce frustration rather than agency.

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

Read from the same place as the sweep metrics, so the end screen and the headless output cannot disagree: evacuated versus dead, peak horde size, largest survivor group, longest-surviving named sim, highest kills by one survivor, shelters established and lost, survival rate by caution band, and the infection curve over time.

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

- Survivors alive at the end, and variance across seeds — low variance means the outcome is determined, which is the failure mode to avoid
- Duration of the middle phase, from first cascade to promotion
- Count of events above salience 40 per 1,000 ticks
- Peak horde size, and whether splintering bounds it
- Shelters established, and the ratio that fall to occupation contest rather than breach

### Scope note

Milestone 2 with three archetypes and no shelter economy is already a complete test of whether the core idea works. Everything after is an addition to make or not make. If the project starts feeling large, cut scope rather than changing approach.

Before any of it, a `CLAUDE.md` carrying the fixed constraints from this document — the invariant, the module boundaries, the config rule, what may read `phase` and `panic` — so they survive across sessions.
