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
- **Not built yet:** the cornered modifier (needs an escape-vector test). The shelter economy and roles followed in milestone 4, below. (The escape-vector test now exists, for the fight, flight or freeze rule under "Survivor behaviour revisions"; the ×1.4 on the zombie's roll is still not applied.)
- **Reaching a door ends the flight.** Entering a building caps panic just below `panicExpelThreshold`. Otherwise a sim who ran in panicked is expelled by that same panic the next tick and bounces in and out of the door; expulsion is meant to come from panic that rises inside.
- **Memory is capped.** With terraced streets a close pass touches dozens of buildings, so building memory holds the 30 newest beliefs and street memory the 150 newest; older observations are forgotten, which reads exactly like an unknown entry.
- **Movement follows walls with hysteresis.** A blocked agent slides along the obstacle at 70% speed, keeping to the side it chose until its direct way opens (`Sim.slide`, `Zombie.slide`). Scaling progress by the cosine of the deflection left agents heading into a wall nearly stationary (9% of moving sims, 27% of zombies), and choosing a side afresh each tick made them zig-zag.
- **Avoidance holds.** A sim that steps away from a threat keeps going for 15 ticks after the threat drops out of sight (`Sim.avoidUntil`). Without it, a zombie flickering at the edge of view flipped the sim between avoiding it and walking its route every tick — the visible zig-zag. Re-planning the route on sight was tried and made reversals more frequent.
- **A refusal is remembered.** The building that last turned a sim away is excluded from its door and shelter choices (`Sim.refusedBy`). A panicked sim otherwise ran back to the same occupied door every tick, taking a contact roll each time.
- **Idle agents tick cheaply.** Dormant zombies check for waking every 4 ticks; awake zombies with nothing tracked, heard or seen re-decide every 3 ticks (sight still interrupts immediately); scent is a grid rebuilt every 30 ticks. Memory merges are limited to one per sim per 30 ticks.
- **Spatial hash cell is 32 m,** not 16: the per-rebuild cell scan dominated the profile, and the reference also asks for a cell above the largest query radius.
- **State added:** `Sim.street` (the street the sim is on, kept while within half its width), `Building.pendingSpill`, and `World.residentDeaths` (anonymous residents killed in a breach — the only record the full recount can count them from).

### Revisions after milestone 2

- **Run length is 36,000 ticks** (was 21,600): five whole day/night cycles at `dayLength` 7,200, so the run ends at the same time of day it began.
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
- **Frame counter** (development): top centre, on under the dev server, F toggles, `?fps` shows it in a build. Over the last second: frames per second, the worst frame, the main thread's draw time, and the simulation's achieved tick rate against its target; amber below 30 fps or 90% of the target rate. Draw time counts only issuing the drawing — rasterising happens after it — so frames per second is the number that decides.
- **The density blur is done small.** Blurring the density field at screen resolution every frame took mid zoom from 30 to 11 fps in the build container once the underlay was added; it is now blurred on a canvas of four pixels per 80 m cell and scaled up with smoothing, which looks the same (24 fps there).
- **Measuring:** `scripts/view.ts` screenshots far, mid and near zoom from a fast-forwarded run (`?advance=N`); `scripts/fps.ts` measures frame rate, draw time and the tick rate achieved at 8×. In the build container (software rendering, shared CPU) draws cost about 5.5 ms a frame and the simulation reaches only 19 of 80 ticks a second at the busiest stretch, so the 30 fps gate has to be measured on a real machine.

### Survivor behaviour revisions

After milestone 3, watching the viewer: survivor behaviour felt lacklustre. Outdoors a survivor was either running an errand, unaware, or reacting to a zombie in sight; nothing between. Measured on seed 1 before changing anything: up to 131 survivors at a time walked their errands within 60 m of a zombie, oblivious; and survivors heading for shelter with a zombie in view reversed direction on 17% of their moves.

- **Awareness of the outbreak** (`Sim.awareAt`). A sim becomes aware by seeing a zombie, seeing a bite or a conversion, hearing gunfire or a shout, meeting someone who knows (an encounter merge passes it on), entering a building that has been alerted, or being inside one when it is. Unaware, it keeps its routine. Aware, it drops the routine for an objective, chosen once and kept (`systems/awareness.ts`): those who engage, armed, go toward the trouble they believe in nearby (`respond`, a street within 600 m whose believed danger × confidence is at least 0.15; on arrival what they see is written as that street's danger, so they do not return to an empty street); everyone else goes home if it is within the archetype's `homeReach` (civilians 1,200 m, hunker-down anywhere, police, loners and the reckless never) and home is not believed dangerous; otherwise the best shelter it knows. Someone heading home who meets danger enough to seek shelter gives up a home more than 250 m off for the nearest good shelter. Released residents leave unaware, as before; expelled residents and resident scavengers start aware. Awareness spreads fast by word of mouth in crowds: on seed 1, 157 of 722 survivors outdoors were still unaware at tick 2,400, and almost none from 3,600. Oblivious walkers near zombies fell to almost none.
- **Homes** (`Sim.home`). Everyone has one at spawn: the residential building they came out of, or else one of eight sampled residential buildings, nearer ones likelier (`awareness.homeDistanceScale`, 400 m). The homeless have none. A home is not a shelter until the sim gets there.
- **Limited sociality** (`archetypes.*.sociality`). When two aware sims meet outdoors, one bound for a shelter it has not yet made its own goes along with the other if the other's shelter is nearer to it than its own goal, at the archetype's chance (civilians 0.8, hunker-down and reckless 0.3, police and loners never), and never with danger in sight. That is all the grouping there is: shared destinations, so knots of survivors walk the same way. No leader, formation or keeping together: those are the squads deferred to v2.
- **Fight, flight or freeze** (`Sim.stand`, `config.cornered`). Cornered — perceived threat at least 0.4, and either danger on several sides (`threatFocus`, the threat vector's length over its summed weights, under 0.5) or no walkable ground 6 m along the way out — a sim stands and fights if it carries anything, else dashes for a door (the one it already chose, else any in reach, whichever way it lies), else freezes. Freezing is still gait: detectability 0.35, so a zombie that has not locked on may pass, and a tracker loses it beyond twice that range. A stand is reconsidered after 10 ticks (fight) or 20 (freeze). Anyone standing to fight uses its weapon at range whatever its archetype, and in a panic; a frozen sim does not strike.
- **A blocked way is a decision, not a hover.** Survivors going round danger (`goRound`) used to bend further the closer it was, so with a zombie between them and their door they backed off until the bend weakened, then came on again: the beelining back and forth. Now danger squarely ahead (blend weight at least 0.8) is a decision (`wayBlocked`): fight if what it carries is up to the zombies within 15 m; else take a door that does not lie toward them; else back off for the avoid hold, giving up a shelter not yet its own to choose afresh. During the hold the way out is kept and turned only for danger ahead, and the hold comes before every other rule (a panicked sim otherwise ran for the same door again, and an engager turned back in). Panicked flight keeps the door it chose while it is in reach. An engager that has fallen back toward shelter does not turn to engage again on the way. Heading reversals by a sim that had reversed within the previous ten ticks, seed 1, 6,000 ticks: heading for shelter with a zombie in sight 4,525 → 172, panicked flight 1,164 → 249, scavenging with a zombie in sight 333 → 2.
- **The bitten choose** (`Sim.infectedChoice`, `systems/bitten.ts`). At its first decision after the bite, a sim chooses by archetype (`isolates`: loners 0.7, police 0.6, the reckless 0.4, civilians 0.25, hunker-down 0.1) to go off alone to the nearest building within 200 m that looks empty from outside — leaving its shelter and its role — and turn there; otherwise, or if there is none, it conceals, carrying on as if nothing happened. Isolating emits `simIsolating` (salience 30): "A survivor, bitten, is going off alone to the house on Mill Avenue."
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
- **Sweep after the second and third rounds** (mapSeed 1, 20 runSeeds): running; recorded here when it finishes.

## The concept in brief

A spectator-only outbreak simulation. A top-down city of dots and building outlines, roughly 2,000 people, rendered to a plain canvas. There is no player: the viewer controls the camera, a survivor roster, a news ticker and the speed of time, nothing else.

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
| Run length | 36,000 ticks | Ten simulated hours: five day/night cycles, 60 min at 1×, 7.5 min at 8× (was 21,600) |
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
| `archetype` | `enum` | 5 values | Civilian, police, hunkerDown, loner, reckless |
| `profession` | `enum` | Label set | Display only; derived at spawn from starting building tag |
| `age` | `int` | 16–85 years | Small speed modifier and shelter-preference bias |
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
| `turnsAt` | `int?` | Tick | Conversion tick; default delay 20–40 ticks |
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
| `tick` | `int` | 0–36,000 | Simulated seconds elapsed |
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
| `unturned` | `rescued` | Removed from the map by the v2 rescue |
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
unturned.outdoors + unturned.indoors + unturned.dead + unturned.rescued
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

Archetype sets the weights, never the logic: hunker-down leans on integrity and street quiet, police on integrity and defensible tags, civilians almost entirely on distance, loners invert `groupTerm` entirely.

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
| Flagging | `infected` set, `turnsAt` = tick + 20–40 (seeded) |
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

Everything in the tuning tables stays in `config.ts`. Those interact chaotically and thirty sliders produce frustration rather than agency.

### Ending

One terminal condition for the demo: the timer, at 36,000 ticks. Stalemate is handled by the controller rather than by ending the run. The rescue is a v2 ending and is not built.

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

Read from the same place as the sweep metrics, so the end screen and the headless output cannot disagree: rescued versus dead, peak horde size, largest survivor group, longest-surviving named sim, highest kills by one survivor, shelters established and lost, survival rate by caution band, and the infection curve over time.

## Build order

Each gate is a question with a yes or no answer. A milestone is not done because its code exists; it is done when its gate passes.

1. **State shape** — types for Sim, Zombie, Building, Street, District, World, plus `config.ts`. No behaviour, no rendering.
2. **Headless loop** — tick order, movement, infection, perception, threat. Prints the eight counters. Text output only.
3. **Renderer** — canvas, three zoom modes, trails, free camera, ticker with salience, roster, time controls.
4. **Shelter economy** — roles, fortification, materials, scavenging, occupations, memory merging, promotion, audio. Built before 3 (except audio, which needs the browser): without it a full run empties the streets.
5. **Cars** — mobile occupancy containers on the street graph. Jams and abandonment, not traffic modelling.

&#91;embedded content: build order · 5 milestones, 4 gates\]

**Milestone 2 is the one that matters.** The deliverable is a script that runs a full run (36,000 ticks) from a fixed seed and prints the eight counters every 600. A text dump takes seconds to read; a renderer takes hours to build, and the question it answers — whether the infection curve has any shape — is answerable without one.

That output doubles as the first test. The invariant assertion runs every tick, which is what keeps a growing simulation from silently rotting.

### What the gates mean

| Gate | Passes when |
| --- | --- |
| After 1 | Every field has a type, a range and a unit. Coordinates and tick length are settled. No field exists that nothing reads |
| After 2 | The invariant holds for a full run (36,000 ticks) across 20 runSeeds on one mapSeed; infection reaches 40–90% of population in at least 15 of them; no seed resolves in under 3,000 ticks |
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
