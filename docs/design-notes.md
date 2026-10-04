# Zombie outbreak simulator — design notes

Sep 27, 2026 · @Trib

A spectator-only outbreak simulation: a top-down city of dots and building outlines, roughly 2,000 people, no player input beyond camera, roster and time controls. The core loop is a shelter economy — fortify, run out of materials, send someone out, and the retrieval trip brings the horde back.

## Concept and scope

The demo tests whether a population of dots, driven by archetype behaviour and a spreading infection, produces a story worth watching without any player agency at all.

There is no player. The viewer controls the camera, the roster and the speed of time, nothing else. This removes the two hardest parts of a simulation game — input design and balance — and leaves agents, rules, a renderer and a camera.

**The test every addition has to pass:** does it change which decision a sim makes, or only the noun describing it? Capabilities are expensive because each one requires the whole balance to be rechecked. Decisions are cheap and are what the viewer actually reads off the screen.

Deliberately out of scope: traffic modelling, fire and explosions, z-levels, health pools, wound and treatment mechanics, survivor-on-survivor combat, multi-slot inventory, line-of-sight rendering, isometric projection, and any authored art. The look comes from the simulation state, not from drawn assets. Reasons are recorded under Cut and deferred.

No engine. TypeScript, simulation as a pure module with no DOM dependency, rendering to a plain canvas — so the same code runs headless in Node and in the browser.

## Scenario progression

&#91;embedded content: phase stages · 4 stages, 2 triggers\]

**Phase exists to solve the cold-start problem.** Most of the population is an occupant count, and counts only become agents through local panic, so a district the infection has not reached is not quietly going about its business — it is not simulated at all. A viewer panning there sees a dead grid. Phase is the release valve that fixes this.

**It changes who exists, not what anyone decides.** The transition releases occupants as agents on ordinary routines — commuting, shopping, going home — with no knowledge of the outbreak. They learn the same way everyone else does, by seeing it or being told. That is not a city reacting to a global signal, it is a city where people have left the house, which is honest at every scale. A district still clear looks busy and normal, and the horror is that they do not know yet.

It also fixes something the design otherwise lacks. Panic is currently the only thing that turns counts into agents, so agents only ever appear frightened. A release valve puts people on the street *before* they know, which is the state in which motion trails and archetype differences read most clearly, and it makes the first conversion witnessed on a calm street land far harder.

**Release is by district and staggered**, never map-wide in one tick — for frame budget, because a city emptying instantaneously reads as a bug, and because a wave of people coming outside spreading across the map is better to watch and keeps the ticker honest about where things are happening.

**Nothing but the release may read the phase field.** No behaviour, no shelter criteria, no thresholds. Global percentages remain a poor trigger for spatial events: at 20% citywide one district may be untouched and another already gone. If phase ever appears in a decision, it has drifted back into being a driver and should be removed from that code path.

The four stages, and what moves between them:

1. **Dormant** — population held as occupant counts inside buildings. Only local panic turns a count into agents.
2. **Release** — districts release occupants onto ordinary routines, unaware of the outbreak. Staggered, never instant. *Trigger: the outbreak becomes public knowledge — a tick, or infection past a visible level.*
3. **Promotion** — the survivors with the most unusual histories are named, listed and trackable by the camera. *Trigger: living falls below a fraction of starting population, with a tick-based fallback.*
4. **Attrition** — map saturated. The ticker carries most of what is left of the story. *No trigger; descriptive only.*

## Population, buildings and the four counters

Most of the population is a number, not an agent. A building starts with an anonymous occupant count; sims are only instantiated when something makes them matter. This keeps agent counts low early, lets the city claim a larger population than it simulates, and gives the run its pacing for free — the opening is quiet because everyone is indoors, and the streets fill as the situation degrades.

**Expulsion.** Panic near a building expels a proportion of its occupants onto the street as individual sims. A remainder stays inside. Conversions are capped per tick and the overflow queued: a building emptying over several seconds reads as evacuation, all at once reads as a bug.

### Garrisoning and breach

**Breach.** When a zombie enters, remaining occupants convert over several ticks into a mix of zombies, dead, and expelled survivors. Never an instant number swap — each breach is a small visible event with a line in the ticker.

**Breach probability** is the building's structural soundness, derived from tag, reduced by its fortification value. This is the only pressure that acts on a sheltered group from outside, which is why breach frequency is the parameter that decides whether the city stays alive to watch: too low and everyone hides and the screen goes still, too high and shelter is pointless.

It should not have to carry that weight alone, and in the current design it does not. Material consumption puts a clock on hiding from the inside, and wandering zombies pressure the hidden from a third direction. With both in place breach frequency can come down, which is an improvement: a breach is a blunt instrument, and a wanderer finding a shelter is a story. All three are swept as a group.

**Shelter is two-way.** Sims can re-enter buildings, with entry criteria per archetype. A building therefore holds two populations: the anonymous occupant count, which can dissolve into a number, and a list of individually tracked sims who entered during the run and keep their identity and history counters. Sheltered sims tick cheaply — history accrues and they evaluate whether to leave — but skip movement and pathfinding.

**Tags.** Every building carries one tag, in two tiers. Functional tags change the simulation. Flavour tags are mechanically identical to one of the functional profiles and exist only to populate the map and say where a sim started.

| Functional tag | Starting occupancy | Shelter quality | Holds |
| --- | --- | --- | --- |
| Residential | Medium | Sound, defensible | Some materials |
| Firearms store | Low | Defensible | Weapons, ammo |
| Police station | Low | Very defensible | Weapons, ammo |
| Hardware store | Low | Sound | Materials, improvised melee |
| Workshop | Low | Sound | Materials, improvised melee |
| Warehouse | Low | Sound, few entrances | Materials |
| Supermarket | Medium | Poor, large and open | Materials |
| Office | High by day | Poor, large and open | Little |
| School | High by day | Poor, many entrances | Little |
| Hospital | High | Poor, many entrances | Little of use here |

Flavour tags — café, restaurant, bar, barber, laundrette, bank, church, cinema, gym, garage, clinic, pharmacy, library, hotel, depot, nursery, dentist, bookshop, salon, takeaway — inherit a functional profile and hold nothing useful. A café and a barber behave the same, which is the point: the map needs texture, and only a few tags need to do mechanical work.

**Identity derives from tag, not from archetype.** A sim's profession label is drawn from where it started, and the label then biases which archetype it gets. A sim in a school is a teacher, a student or a caretaker; the caretaker leans hunker-down, the teacher civilian. One lookup table gives coherent identities and a plausible archetype distribution, rather than assigning profession randomly and hoping it does not clash with location.

**Time of day shifts occupancy by tag.** At 9am offices and schools are full and homes are empty; at 3am the reverse. One multiplier per tag per time band, which makes the start-time scenario setting meaningful rather than cosmetic.

Starting occupancy and structural soundness derive from tag, giving the map texture before anything happens: some blocks are dangerous because they were crowded, some are safe because nobody was there. Tags also feed archetype shelter criteria directly, so "defensible" is read off the building rather than invented per instance, and a tagged destination gives a survivor a reason to cross the map.

**The counters.** Six, and they must sum to a constant for the entire run:

| Counter | Holds |
| --- | --- |
| `living` | Survivors on the street |
| `indoors` | Anonymous occupants plus sheltered sims |
| `zombies` | Active and dormant infected |
| `dead` | Humans who died without converting |
| `destroyed` | Zombies killed |
| `rescued` | Survivors removed from the map by the v2 rescue |

`indoors` must be broken out or the numbers do not reconcile, and a drop in `living` is otherwise ambiguous between deaths and people going inside. `destroyed` must be its own term or the sum breaks the moment police kill something, and keeping it apart from `dead` makes the end statistics readable: total human loss is `dead` plus `destroyed`, since every zombie but patient zero was someone.

The constant sum is the cheapest and most useful invariant available, and the headless harness should assert it every tick.

## The map

What matters is the street graph's topology, not the terrain labels. A uniform grid produces uniform behaviour: every route is equivalent, every district equally reachable, hordes diffusing evenly. Variation in connectivity is what gives places distinct character, so the features worth building are the ones that change the graph.

| Feature | Effect | Why it earns its place |
| --- | --- | --- |
| Bridges and chokepoints | Few connections between districts | Blocked by abandoned vehicles, a district goes permanently dark — the irreversible structural change the design otherwise lacks |
| Dead ends and cul-de-sacs | Routes that terminate | A survivor fleeing into one is tragedy generated by topology alone, no rules required |
| Alleys | A secondary network, poorly lit, low wander traffic | Creates a real choice between the fast lit road and the slow dark shortcut |
| Open ground (parks, lots) | Long sightlines, no cover | Favours survivors by day and punishes them at night, since perception drops and zombie detection does not |
| Main street | High connectivity, well lit, high-value tags | Draws traffic, which makes it both the fastest route and the most contested |

Open ground is the most interesting of these because its meaning flips with time of day — one terrain flag, two opposite readings, tying directly into the day-night and lighting systems.

Agricultural land is cut: map area that costs simulation and render budget while producing no occupancy, no chokepoints and no decisions.

**Districts are parameter sets, not authored types.** Block size, building density, street spacing, lighting coverage and tag distribution. Suburb, downtown and industrial then fall out of one generator with different numbers, which keeps the map data rather than branching code and gives the generator the same config-object discipline as the rest of the simulation.

**Terrain effects stay a small fixed set of modifiers** — sightline radius, traversability, light coverage, wander traffic — rather than each feature carrying bespoke behaviour. Otherwise every terrain type has to be checked separately against day-night, lighting and memory, and the interaction surface grows faster than the feature list.

## Archetypes

Few profiles, not many job titles. Labels are free and profiles are expensive: each needs tuning and each interacts with every other, so five profiles is ten pairwise interactions and twelve is sixty-six.

**No axis is absolute.** This is the correction that matters most. An archetype defined as "approach threat" with no qualifier is a suicide instruction — police so defined engage the first horde they see and die in the opening minutes, removing the rarest and most capable sims before the run is interesting. Every axis takes a threshold instead:

- **Threat response** — approach below N nearby zombies, fall back above it.
- **Mobility** — settle when local threat is under a level, move when over.
- **Sociality** — seek or avoid groups, with a threat level that overrides the preference.
- **Capability** — ranged attack, building access. The one axis needing real code rather than parameter values.

Thresholds are what produce arcs. A sim whose behaviour never changes with circumstance cannot have a story, and three profiles with thresholds give more variety than six without.

| Archetype | Share | Threat response | Mobility | Shelter criteria | Capability |
| --- | --- | --- | --- | --- | --- |
| Civilian | \~68% | Flee at any level | Keep moving, no plan | Nearest building when threatened | None; may start with improvised melee |
| Police | \~2% | Engage below N, fall back above | Patrol toward disturbance | Holds out for defensible tags | Pistol, limited ammo |
| Hunker-down | \~26% | Avoid at all levels | Settle and fortify | Sound building in a quiet area | None |
| Loner | \~3% | Avoid | Keep moving, shelters alone | Shelters alone; will not join an occupied building | None |
| Reckless | \~1% | Engage, no fall-back threshold | Move toward events | Rarely shelters | Whatever it finds |

The last two are free: **loner** is the sociality axis at its other extreme, and **reckless** is an existing profile with the retreat threshold removed. No new code, just parameter values nothing else uses. Reckless earns its place by generating events — most sims make sensible decisions, which is correct but means the simulation can settle.

Police retreat *toward* something rather than simply away: a defensible building, other survivors, a position they have held. Retreat with intent reads far better than fleeing, and it gives them a natural role in the shelter loop as the ones who arrive with a weapon and a reason to hold the building. Their ammo state is the arc — an officer with rounds is special, an officer without is ordinary, and the transition happens on its own.

**Labels are free; profiles are not.** Many professions share one profile, differing only in the inspector panel. Assigned at tick zero from the starting building's tag, so a sim found in a hospital reads as staff rather than as a bartender.

| Profile | Labels |
| --- | --- |
| Civilian | Office worker, retail assistant, teacher, delivery driver, student, chef, cleaner, bartender, mechanic, courier, receptionist, barista |
| Police | Patrol officer, detective, security guard, paramedic, firefighter |
| Hunker-down | Retiree, parent, librarian, accountant, nurse, night-shift worker, caretaker |
| Loner | Night cleaner, long-haul driver, groundskeeper, homeless, tourist |
| Reckless | Off-duty soldier, hunter, bouncer, amateur survivalist, drunk |

The police list is not literally police — it is people who move toward trouble, which is what the profile actually encodes.

Age is displayed alongside profession and should carry a small speed modifier and shelter-preference bias rather than being purely cosmetic. A panel reading 71-year-old retiree attached to a dot outrunning a horde damages the fiction; one honest field is cheaper than the inconsistency.

Click-to-inspect works on anonymous sims too, not only promoted ones. The fields already exist, so it costs nothing, and it lets the viewer poke at the crowd rather than only the roster. Promotion then means tracking and ticker presence, not whether a sim has an identity at all.

**Roles are not archetypes.** Scavenger, builder and dispatcher are things a sim is doing right now, assigned dynamically from its shelter's situation, not entries in the list above. The same person fortifies until materials run out, goes to fetch more, and clears a zombie on the way back. Assignment stays individual — each sim evaluates whether it should be the one to go — so the aggregate reads as a division of labour with nothing dividing it.

The constraint on profile count is perceptual. The viewer is watching dots, so two profiles that do not produce visibly different movement at normal zoom do not exist. Before adding another: could it be told apart with the roster hidden?

Distribution matters as much as count. A heavy civilian majority with rare profiles at a few percent gives a legible mass with individuals standing out. If every sim is special, promotion scoring has nothing to distinguish.

## The shelter economy

This is the core loop, and the only cycle in the design. Everything else pushes one way — survivors hide, the map saturates, the run ends. This closes a circle, and the safe position generates its own threat.

1. **Fortify** — builders raise the fortification value.
2. **Materials run out** — fortification stalls without more.
3. **Scavenge run** — a sim leaves for a hardware store.
4. **Horde converges** — noise, or a tracked return, draws them.

Then back to the first, if the shelter holds and materials are needed again.

&#91;embedded content: shelter economy · 4 stages, one reinforcing loop\]

**Fortification** is one float per building, raised by time spent working on it, lowering breach probability. That single field turns the hunker-down archetype from a movement preference into an activity, and creates a real tradeoff: a sim fortifying is a sim not fleeing.

**Materials** are one abstract number. No types, no crafting. The interesting part is the retrieval trip, not the inventory, and tagged buildings already say where materials are.

**Barricades cut both ways.** A heavily fortified building is slow to leave. If a horde settles outside, the occupants are trapped by their own work, and the safest position becomes the one that cannot be escaped. Without this, hunkering down dominates.

**The cascade** is the payoff. A zombie finds the shelter or tracks a returning survivor, makes noise, and cohesion pulls its neighbours in secondhand. Above a local density threshold the crowd becomes self-sustaining — zombies attracted by other zombies rather than by the original sound. Below it, a returning survivor is a near miss. That threshold is the difference between an incident and the end of a shelter, and the crossing deserves its own ticker treatment and an automatic speed drop.

**The returning survivor is the danger.** Because zombies track rather than drift toward a last known position, a scavenger has to judge whether it is safe to come back at all. A survivor leading the horde to their own shelter is the best disaster available, and it costs nothing: sims already carry a destination and a memory table.

This loop also fixes the equilibrium trap from the inside, rather than relying on breach pressure applied from outside to keep the simulation alive. A material cost puts a clock on hiding by its own logic.

Coordination stays individual. Multiple sims contributing to one fortification value is addition and is fine; sims negotiating who goes out is a large system and is not built. Each decides alone, and the aggregate looks like cooperation.

## Information and perception

**Spatial knowledge is free, threat knowledge is not.** People know their own city: pathfinding uses the full street graph and sims know where tagged buildings are. What they do not know is where the zombies are right now. Threat perception is strictly local — sight radius and sound.

That asymmetry is the source of most of the drama. Omniscient sims produce optimal behaviour, which is boring to watch and impossible to empathise with; nobody is ever surprised and the horde's front edge stops mattering. Total ignorance is worse, because a sim groping at random has no trajectory to read. The split gives a survivor a legible route and an illegible danger.

**Streets are named, and memory is keyed by street.** Every street segment carries a generated name, which does three jobs at once: it makes the ticker legible ("panic spreading on Rowan Street"), it gives destinations and waypoints something to refer to, and it is the key for what a sim believes about the city.

Each sim holds a small table: street name to danger value and the tick it was last observed. Not a list of remembered coordinates. Streets are already the graph's edges, so memory becomes an edge weight and routing with knowledge is A\* with a per-sim cost function — no new machinery, no spatial search per node. It is bounded by map size rather than by time, and it is inspectable, so the click panel can show what a survivor believes.

**Confidence decays continuously** rather than expiring. Store the observation tick and derive age from it, so an old belief still influences routing while being overridden by anything fresher.

**Merging on proximity.** When two sims meet, for each street take whichever record is newer. Symmetric, no conflict resolution, no ownership. Information then spreads through the population by contact, which is what makes grouping an advantage rather than a preference.

**Recomputing a route is the expensive part, not the merge,** so it is gated four ways:

1. Fleeing does not use pathfinding at all. A panicking sim moves away from a threat vector — local steering, no A\*. Only sims with a destination route: scavengers, police falling back, survivors converging on a broadcast. That is dozens of agents, not thousands, and it is why phase-one crowds are cheap.
2. Gate on relevance, not decay. The merge returns which streets changed; the sim intersects that against its current route and recomputes only on a hit. A list comparison, not a search.
3. A per-sim cooldown, so nobody repaths more than once every N ticks regardless.
4. A global repath queue with a per-tick cap, drained in priority order, so the worst case is bounded however many meetings happen at once. A few ticks of stale route is invisible.

Danger seen directly ahead bypasses the queue. A sim walking into a horde it can now see should not wait its turn.

### Panic

One scalar per sim, kept separate from memory. Panic is internal state, memory is belief about the world, and conflating them would mean a calm survivor cannot deliver bad news.

**It rises** from witnessing a conversion, nearby noise, and proximity to other panicked sims. **It decays** slowly toward zero, so a sim that gets clear of trouble settles rather than staying frightened for the rest of the run.

**It transmits on the same proximity check as memory** — one meeting handler serves both. Panic averages toward the higher value with a damping factor, so calm spreads too, but more slowly than fear.

**It gates exactly three things:**

1. Whether a sim uses local steering instead of pathfinding. This is the main compute saving: panicked sims do not route.
2. Whether it consults its memory table at all. A panicked sim acts on what it can see, not on what it knows.
3. Whether occupants are expelled from a building.

Nothing else reads it, for the same reason nothing but the release reads phase.

**Police are immune.** Panic never gates their behaviour, which is what makes the rest of their profile work: they keep pathfinding, so retreating *toward* a defensible position is possible rather than being indistinguishable from fleeing. It also makes them the population's information carriers, since they go on consulting and updating their memory tables while everyone around them is running blind. Reckless sims are the obvious alternative, but they already ignore threat thresholds, so immunity there would change almost nothing.

**Day and night** is one global value modulating existing parameters. Sim perception radius drops at night; zombie detection does not change, since they are not using sight in any meaningful sense. The survivors' disadvantage is not that zombies get stronger, it is that people stop seeing them coming. Scavenging becomes a daytime activity by pressure rather than by rule.

Cycle length is a pacing parameter, not a simulation of time — two or three cycles per run, derived from expected run length rather than from realism.

**Street lighting** makes night spatial rather than global. A static lit-or-not flag on street segments, sampled like any terrain, so perception radius is a property of where a sim is standing. The map develops safe-ish corridors and dark gaps, and survivors routing along lit streets is legible movement with a visible reason.

On a near-black map a faint warm glow reads at a glance without competing with the white-red-grey population palette, because it is terrain rather than state. Resist dimming the map itself at night — render what sims cannot see rather than what is dark, or the feature costs the legibility it was meant to add.

The grid failing is a scenario setting for now, not an event: a run starts with power or without, and the difference between those runs is comparable. Progressive district-by-district failure is the better version and earns itself only if lit and dark runs look meaningfully different.

**The one global channel** is the rescue broadcast, and it should stay the only one. Radio earns the exception because a broadcast genuinely is global, but it fires as a single explicit event rather than opening an information channel other systems can use.

## Zombies

Zombies carry almost no state: position, heading, a dormancy flag and a couple of timers. No archetype, no history counters, no shelter logic, no names. They are the cheapest agents on the map, which is convenient, because by the end of the run they are most of them.

**Movement.** Slow random walk plus short-range attraction to stimulus, plus weak cohesion and weak heading alignment with nearby zombies. Cohesion alone produces a slow gravitational drift toward the middle; alignment turns that into flow, which is what reads well behind motion trails.

Keep cohesion weak. Strong cohesion collapses the horde into a single blob that sweeps the map, which reads as one object rather than a population and removes any chance of a survivor slipping between groups. Weak cohesion plus short detection gives local clumps that merge when they meet, a front edge where the density gradient is steep, and gaps. The gaps matter as much as the mass — they are what makes an individual survivor's route legible.

**Splintering.** Cohesion needs an upper bound or piles grow without limit. A repulsion term that activates above a local density threshold gives splintering as emergence rather than as a scripted rule, and stops single blobs forming. Local crowding pressure is better than a rule that splits a horde in a set direction, which looks too neat.

**Dormancy.** Zombies with no recent stimulus go idle; noise wakes them. One flag doing three jobs: dormant clusters tick cheaply, which buys back the performance that fast-forward costs; a still crowd that suddenly animates is the best visual moment in the design; and quiet movement becomes genuinely viable, which retroactively justifies melee weapons and the loner profile.

**Wanderers.** A small proportion wake spontaneously and drift before going dormant again wherever they end up, so the wandering population turns over rather than forming a permanent caste on fixed paths. This is necessary, not decorative. Universal dormancy makes quiet stable: shelters that avoid noise are never found, the map settles into static clusters, and the stalemate ending arrives by construction. Wanderers also make dormancy legible, since a field where nothing moves reads as paused rather than sleeping.

Wander rate is swept alongside breach frequency and material consumption, since all three push on the same equilibrium from different directions.

**Detection.** A radius shorter than sim daytime vision. Long detection turns every zombie into a heat-seeker and the run becomes a straight line to total conversion.

**Speed.** Slower than a fleeing sim. The single most sensitive parameter in the model.

**Noise.** Stimulus events with a radius and a decay. Cohesion means a stimulus pulls not only the zombies that heard it but their neighbours too, so the effective radius is much larger than the number set.

**Tracking.** A zombie that detects a survivor follows them rather than moving toward the last known position. This is what makes a scavenging run a dilemma rather than a dice roll, and what lets a survivor lead the horde to their own shelter.

**Permanence.** Killed zombies move to the `dead` counter rather than being removed, so the four counters still reconcile. They persist rather than decaying.

The spatial hash needed for infection radius serves the flocking neighbour query and the density check too, so cohesion, alignment and splintering cost one extra vector term each.

## Combat, infection and inventory

Six weapons sounds like six systems and is four numbers each. Noise carries the most consequence, more than lethality, because noise is what recruits the horde.

| Weapon | Range | Rate | Reliability | Noise | Note |
| --- | --- | --- | --- | --- | --- |
| Pistol | Medium | Slow | High | Loud | Police default, limited rounds |
| SMG | Medium | Fast | Low per shot | Very loud | Burns ammo quickly |
| Shotgun | Short | Slow | Very high | Loudest | Hits an arc, not a point |
| Knife | Contact | Fast | Low | Silent | Desperate option, not a stealth one |
| Club | Contact | Medium | Medium | Quiet | Middle ground |
| Sledgehammer | Contact | Slow | High | Silent | Leaves the sim committed for a beat |

**Melee needs a real failure mode** or it is just a quiet gun. A missed swing against a zombie in contact range risks infection. That makes an unarmed civilian genuinely doomed rather than mildly disadvantaged.

**Resolution is probabilistic and instant.** No health pools, no damage numbers, on either side. A sim kills the zombie or does not, and a failed melee may infect. Health bars would be invisible at dot scale regardless.

**Infection is one flag and one countdown.** No wounds, no HP, no bandages, no healer archetype. What makes it interesting is not treatment but **who knows**: the infected sim knows, and others know only if they witnessed the bite. Perception radius and conversion-witnessing are already in the model, so the check is free.

That asymmetry produces the best scene in the design. Someone arrives at a shelter, is admitted because nobody saw it happen, and turns inside a fortified building the occupants cannot quickly leave. It also creates a decision rather than a mechanic: an infected sim with a timer can head for shelter anyway or move away from the group, and archetype can drive which.

**Inventory is one weapon slot, one ammo count and one materials-carried count.** Not a list, not slots, not item objects. Most sims carry nothing. Police start with a pistol and limited rounds; a few civilians start with improvised melee. Materials accumulate on buildings, but a scavenger has to carry them back, so the sim needs its own count — capped, so a single trip cannot resupply a shelter indefinitely.

Looting is a chance on building entry, weighted by tag. At zero ammo a firearm is dead weight unless dropped — and a sim dropping an empty pistol that someone else later picks up is a good ticker line for almost no code.

Guns are a door rather than a field. Firing saves a sim now and draws the horde later, which is the cleanest source of emergent drama in the design. The wildcard worth building is not firepower but brevity: someone who finds a shotgun, holds a street, runs dry, and is then an ordinary person surrounded by what they attracted. That arc is already expressible with the table above and the ammo model.

## Rendering, interface and audio

Top-down on a canvas, not isometric. With dots and building outlines, isometric buys almost nothing visually and costs coordinate transforms and occlusion logic.

**The visual language.** Near-black background. Buildings as thin single-pixel outlines in dim grey, unfilled, so the city reads as a wireframe plan rather than an illustration. Streets are negative space. Nothing textured, nothing shaded.

**Colour carries state and nothing else.** Living sims a cool desaturated white, zombies a dim red, dead a dark grey that stays on the map as a stain. The arc of the scenario is then legible at a glance as a field of white draining to red, with grey accumulating where it went badly. Building occupancy is a faint fill whose opacity tracks the count, so a block emptying is visible as it dims. Street lighting is the one terrain colour, kept faint and warm.

**Zoom changes representation, not just scale.** Three render modes on thresholds:

1. Zoomed out — a density field, no individuals. Two thousand one-pixel dots is mush.
2. Mid — individual dots.
3. Close — dots plus a short motion trail, and labels on named survivors only.

The motion trail is the cheapest way to make the thing feel alive. A dot is static information; a dot with two seconds of fading history behind it shows panic as a shape, and crowds fleeing a breach become visible as flow. A slow pulse on newly converted zombies makes conversions register as events rather than silent colour swaps.

**The camera is free, not directed.** The viewer pans and zooms at will. Because nothing automatically frames the interesting thing, the ticker and roster carry the directorial load instead.

**The ticker** runs along the bottom as a news feed, reporting events the camera may not be looking at. Every entry is a button: clicking it centres and tracks the subject. That click-to-follow is worth more than any automatic camera logic, since it lets the viewer choose to care rather than being moved around.

Logging is easy; filtering is the work. Two thousand sims generate thousands of events per tick and almost none deserve a line, so events need a salience score weighted by rarity, proximity to camera, and whether a named survivor is involved. Entity IDs read as debug output — named survivors use their names, and anonymous ones are "a survivor", not a number.

**The roster** lists promoted survivors; clicking one centres and tracks them. After the broadcast it doubles as a countdown.

**Ticks and frames are different units.** Nothing in the simulation reads wall-clock or frame time, so fast-forward is four ticks per frame and slow motion is one tick every four frames, and the simulation cannot tell the difference. This is also what keeps runs deterministic from a seed.

Fast-forward exposes performance problems slow motion hides: at 8x every per-tick cost is multiplied. Stagger the expensive paths — armed sims evaluating targets every fifth tick, on an offset — and cap speed around 10x. Scale the salience threshold with speed, and let significant events auto-drop it: a named survivor dying at 8x should pull the viewer back to 1x. Add pause and step-one-tick; both are nearly free and invaluable for debugging.

**Audio reads off the stimulus system** rather than sitting beside it. The gunshot that recruits the horde is the same event that plays, so the soundscape is a readout of the simulation: ambient city noise, gunshots, gasps on panic transitions, zombie moans, the helicopter.

**Format.** Author as `.wav`, ship as `.ogg` or `.m4a`. Uncompressed masters are fine on disk and wrong over the wire — a handful of ambient loops runs to tens of megabytes and all of it blocks playback until downloaded. Decoded audio in memory is identical either way, so convert at build time.

**Playback is Web Audio, not `<audio>` elements.** The requirements are dozens of overlapping one-shots without allocating an element each time, panning and distance attenuation relative to the camera, and a master gain that can duck with speed. Decode each file once into an AudioBuffer at load; every event creates a throwaway source node routed through a panner set from position relative to camera, then a category gain (ambient, weapons, voices, zombies), then master. Source nodes are meant to be created and discarded constantly — this is the intended pattern, not an optimisation.

**The event-to-sound funnel is the real work,** because the simulation generates far more sound events than can be played. Same problem as the ticker and the same solution: score events and play only the top handful per frame. Cull anything outside the viewport, cap concurrent voices per category, and for zombie ambience play no per-agent sounds at all — drive one looping moan bed whose gain tracks local zombie density. That single decision removes most of the problem.

Above a speed threshold, thin or mute everything: at 8x the triggers overlap into mush. Add slight random pitch variation per one-shot, or identical gunshots become obviously synthetic within seconds. Browsers block audio until the user interacts with the page, so resume the context on first click — the scenario should start paused regardless.

**End-of-run statistics.** Most of these already accrue in the history counters: highest kills by one survivor, largest horde, largest survivor group, longest-surviving named sim, rescued versus dead. They double as sweep metrics, so the end screen and the headless output should read from the same place.

## Scenario setup and endings

**One map, one generator, seed exposed.** The generator runs from a pinnable seed, so the default is a fixed city but a new number gives a different one. Holding the map still is what makes comparison meaningful: with a different city each run you cannot tell whether an outbreak fizzled because the parameters are wrong or because that seed put the source in a low-density corner. It also makes regression testing possible.

Full procedural variety is a later addition, not a hard one. The reason to defer it is that generation quality is its own tuning problem, and tuning two unknown systems at once is what this design avoids everywhere else.

**Scenario settings** belong in front of the viewer: population, initial infected count, outbreak origin, archetype mix, power on or off, time of day at start. The tuning parameters below stay in the config file — they are a developer surface, they interact chaotically, and thirty sliders produce frustration rather than agency.

Outbreak origin is the highest-leverage setting. A single patient zero in a dense block gives a slow visible bloom with a clear front; several simultaneous sources give a city already lost and a story about survival rather than spread. Those are nearly different scenarios, and flipping between them is probably the most useful control on screen.

**The demo has one terminal ending: the timer.** One in-game month elapses and the run stops.

Stalemate is handled as a controller rather than an ending. If the map settles — no conversions for a sustained window — the wander rate is raised until movement resumes, promoting dormant zombies into wanderers a fraction at a time. Someone stepping out to scavenge then risks meeting one, which is not stalemate, it is a slow leak.

The controller must be toggleable and **off during sweeps**. A stalemate is a true finding about the parameters, and a simulation that silently corrects for bad tuning hides exactly the result the sweep was run to get. On for viewing, off for measuring.

**The rescue is the v2 ending**, and the better one. A team secures an open area, a helicopter is scheduled, and a radio broadcast alerts every survivor on the map, who converge on the point. The run ends when no survivors remain on the map, resolving either way — rescued or dead — with the counters reconciling at zero and the split between the two being the run's score.

It converts the ending from a fade-out into a convergence: every thread suddenly shares a destination and the roster becomes a countdown. What stops it being a cliché is cost. The broadcast draws survivors out of shelters they had fortified, across districts they had learned to avoid, and the helicopter is the loudest stimulus in the game. The rescue should kill most of the people it saves.

Two routes to triggering it, still undecided: off-map on a timer, which makes the ending fixed and survivors race a clock they cannot affect; or earned by a group surviving long enough, which makes it contingent but needs a fallback for runs where every group collapses early.

## Cars — deferred expansion

A car is a mobile occupancy container, which means it reuses the building system with a velocity added: a number inside, entry criteria per archetype, breach behaviour, conversion over several ticks. Not a new subsystem, a parameterised one.

What earns its place: cars are the only thing in the design that moves faster than a horde, making them the sole mechanism for crossing a lost district. They also produce the best failure mode available — a blocked road turns a car from an escape into a sealed box with zombies converging on the noise, and the occupants have to decide whether to break for it.

**Avoid traffic simulation proper.** Lane discipline, intersections, right-of-way, following distance and collision resolution are a project in themselves, invisible at dot scale, and unrelated to what is being tested. Cars follow the street graph toward a destination at a speed scaled by congestion, where congestion is a count of nearby cars. No lanes. Cars sit offset from the road centreline by direction of travel, so opposing traffic passes without contending at all.

**A deadlock is not a jam.** A jam is cars stopped because the cars ahead are stopped, and it clears when the front clears — that is the wanted behaviour. A deadlock is two cars meeting head-on, each yielding to the other, forever, and on a bidirectional road with no side convention it appears within the first minute, long before panic. Three rules prevent it without a lane system:

1. The lateral offset above, which keeps opposing traffic from ever testing the collision rule.
2. A deterministic tiebreak on yields — lower id yields. A symmetric rule stops both cars and builds the deadlock it was meant to prevent, and determinism is required for seeded reproducibility regardless.
3. A timeout: a car blocked for N ticks stops trying. The occupants bail out and the vehicle becomes a permanent obstacle.

That third rule turns the failure state into content. Gridlock becomes the mechanism by which districts close themselves off, rather than something to engineer around. Intersections stay unsolved deliberately — cars entering the same junction contend under the same yield-and-timeout rule, which produces the right snarl at the moment everyone leaves at once.

**Jams are the point.** A free-flowing city makes escape trivial. Panic should produce gridlock: everyone leaving at once, roads choking, stationary cars becoming containers under siege. This is a density threshold, not a traffic model.

Two knock-on effects. Cars make noise, so a street full of engines is a citywide dinner bell — probably correct, but it needs tuning alongside gunfire. And abandoned cars should persist as obstacles, since a road blocked by dead vehicles is how a district becomes permanently cut off, and permanent structural change over a run is worth a lot for a spectator piece.

Sequencing: this is the second expansion, after the base dynamics prove out. Adding cars before the infection curve is understood means tuning two coupled systems that are both unknown.

## Tuning parameters

The actual work on this project is tuning, not code. These interact chaotically, and small changes flip the outcome between a city falling in forty ticks and an infection fizzling at six percent.

All of them live in a single exported config object so they can be swept headlessly without touching simulation code. Claude Code will scatter them through the codebase unless told otherwise.

| Parameter | Governs | Failure at too low | Failure at too high |
| --- | --- | --- | --- |
| Zombie speed vs sim speed | Whether fleeing works | Infection cannot cross open ground | Nothing survives panic |
| Detection radius | Whether hiding is meaningful | Infection stays local and stalls | Every zombie is a heat-seeker |
| Cohesion weight | Whether a horde has a front edge | Scattered dots, no mass | One blob sweeping the map |
| Alignment weight | Whether movement reads as flow | Gravitational drift | Rigid shoal |
| Splinter density threshold | Upper bound on pile size | Hordes fragment constantly | Unbounded piles |
| Noise radius and decay | Cost of firing a weapon | Guns have no downside | Every shot ends the district |
| Wander rate | Pressure on hidden shelters | Quiet becomes permanently safe | Dormancy is pointless |
| Breach frequency | Pressure on sheltered groups | Everyone hides, screen goes still | Shelter is pointless |
| Fortification rate | Value of building up | Barricading is futile | Shelters become impregnable |
| Material consumption | Clock on hiding | No reason to scavenge | Constant, suicidal trips |
| Retreat threshold (police) | Whether the capable survive | Police never engage | Police die in the first minutes |
| Conversion delay | Whether conversions register | Silent instant swaps | Bites stop feeling fatal |
| Memory decay | Value of stale information | Sims forget instantly | Sims are effectively omniscient |
| Day-night cycle length | Run rhythm | Strobing | Flavour rather than pacing |

**Coupled, not independent.** Wander rate, breach frequency, fortification rate and material consumption all push on the same equilibrium, and night pushes everyone toward shelter as well. Sweep them as a group. With wandering and material cost in place, breach frequency should be able to come down.

**Sweep needs a target.** "Interesting" is not measurable, but proxies are: survivors alive at the end, duration of the middle phase, count of high-salience events, peak horde size, variance across seeds. Without something like this you are eyeballing hundreds of runs. The end-of-run statistics and the sweep metrics are the same numbers.

Build the sweep tooling in week one. A run that plots infection over time across a grid of parameter values teaches more than any amount of watching.

## State shape

The complete list of facts the program holds at any moment: what exists and what is recorded about it. If the simulation were frozen at tick 300, this is everything needed to resume it exactly. It is the first artifact to write, because every other system reads from it, and defining it late means defining it implicitly and inconsistently across four systems.

**Building.** Outline, tag, anonymous occupant count, materials, fortification value, breached flag, lit flag, and the list of individually tracked sims sheltering inside. Starting occupancy and structural soundness derive from tag rather than being stored.

**Sim.** Position, heading, alive-or-zombie, archetype, profession label, age, weapon slot, ammo count, materials carried, panic level, infection flag and countdown, current destination, current route as a list of street ids, current shelter role, a memory table keyed by street name holding a danger value and the tick last observed, and the history counters (ticks survived, conversions witnessed, buildings entered, streets visited, time since last proximity to another sim, near-misses, kills).

**Zombie.** Position, heading, dormancy flag, wandering flag, tracked-target reference, timers. Nothing else.

**Building.** Outline, tag, anonymous occupant count, materials, fortification value, breached flag, lit flag, and the list of individually tracked sims sheltering inside. Starting occupancy and structural soundness derive from tag rather than being stored.

**Street.** Name, endpoints, lit flag, terrain class. The graph's edges, and the key space for sim memory.

**World.** Tick, seed, time of day, the six counters, promoted survivors, the repath queue, and the config object holding every tuning parameter.

Three decisions this exercise must surface rather than assume: whether coordinates are continuous or grid cells, which changes pathfinding, collision and infection radius; how a building's anonymous count relates to the named survivors inside it; and whether history counters live on the sim or in a parallel structure indexed by sim id.

Memory is the only non-scalar here and the only thing that is not trivially cheap, which is why it is bounded. Everything else is numbers and flags — two thousand sims with twenty integer fields each is forty thousand values, which costs nothing. Per-tick work is the expense, not state.

## Build sequence

&#91;embedded content: build order · 4 steps, 3 gates\]

The first deliverable is a script that runs 500 ticks from a fixed seed and prints the four population numbers every 50. A text dump takes seconds to read; a renderer takes hours to build, and the question it answers — whether the infection curve has any shape to it — is answerable without one.

That output doubles as the first test. The four counters summing to a constant is an assertion that can run after every subsequent change, which is what keeps a growing simulation from silently rotting.

Scope note: the headless loop with civilian, police and hunker-down only, and no shelter economy is already a complete test of whether the core idea works. Everything added since — materials, memory, dormancy, lighting, roles — is an addition to make afterwards or not at all. If the project starts feeling large, cut scope rather than changing approach.

Before any of it, one page of notes in `CLAUDE.md` covering the decisions in this document, so they survive across sessions and do not have to be re-derived.

## Cut and deferred

Recorded so they are not re-litigated.

| Idea | Status | Reason |
| --- | --- | --- |
| Fire, petrol stations, tankers | Cut | Wants to be the star. A propagating terrain system with its own physics competes with the survivors rather than serving them, and produces spectacle rather than decisions. A different game. |
| Z-levels, rooftop movement | Cut | Not a building attribute but a second map: multi-layer pathfinding, a level dimension on every proximity check, render ordering. A roof is also a place where nothing happens. Achievable cheaply as a shelter state or a perception bonus instead. |
| Survivor-on-survivor combat, psychopath archetype | Cut | Introduces a second hostility relation, touching threat response, shelter entry, grouping and memory. Also invites expectations of motive that a dot cannot deliver. The cheap version is a sim that refuses to share shelter. |
| Wounds, HP, bandages, healer archetype | Cut | Replaced by one infection flag and a witness check, which produces the interesting scene without the system. |
| Heavy weapons, grenades | Cut | Changes capability rather than decisions, and one sim able to clear crowds breaks the one-way infection curve. |
| Building on Project Zomboid | Rejected | Wants the opposite half of that engine: mass agents and a spectator camera rather than one deep character. No headless harness, and the core parameters would not be reachable. |
| Cars and traffic | Deferred | Second expansion, after base dynamics prove out. |
| Memory sharing between sims | Deferred | Now core rather than deferred: street-keyed memory makes merging a recency comparison, and it is what makes grouping an advantage. |
| Procedural map variety | Deferred | Generation quality is its own tuning problem. |
| Rescue ending | Deferred to v2 | The better ending; the demo uses timer and stalemate. |
| Progressive grid failure | Deferred | A scenario setting first; earns itself if lit and dark runs differ. |

**Squads — v2.** A small number of pre-placed survivors moving in formation: file when travelling, diamond when engaged. Deliberately not dynamic. Emergent grouping needs joining rules, leaving rules, leadership succession and group-meets-group arbitration, all of which is negotiation; a pre-placed squad has fixed membership and a fixed leader, and dissolves into ordinary sims if the leader dies.

Cheap because formations only look like coordination. One leader runs pathfinding; followers steer toward fixed slot offsets and never route at all, which the repath budget benefits from. What it buys is a contrast nothing else in the design can show — discipline moving through panic — and the first unit with enough engagement capacity to take a garrisoned building, so shelters could change hands both ways. The real work is making slot-keeping and obstacle avoidance read well together rather than rigid or broken. Five weapons firing is also the loudest thing in the design, so a squad probably cannot win by force for long.

## Open questions

- [ ] What fraction of starting population triggers promotion, and how long the tick-based fallback waits.
- [ ] Panic thresholds: how high it must run to switch off pathfinding, how fast it decays, and the damping factor on transmission.
- [ ] City scale. Roughly 2,000 people across a 40x40 block grid is a placeholder.
- [ ] Coordinates: continuous or grid cells?
- [ ] Where history counters live — on the sim, or in a parallel structure indexed by sim id.
- [ ] Rescue trigger: off-map timer or earned by a surviving group, and what the fallback is.
- [ ] Promotion count. A dozen named survivors is a guess; the right number is however many the camera can meaningfully visit.
- [ ] The salience scoring function for the ticker.
- [ ] Whether the dispatcher role is worth having, given it needs a weapon and weapons are loud. Depends on how common quiet melee is.
- [ ] How an infected sim decides whether to seek shelter or move away from its group.
- [ ] Stalemate controller thresholds: how long a settled map is tolerated, and what fraction of dormant zombies is promoted per step.
- [ ] Whether information spreading by contact collapses route variety, since a group converging on shared beliefs will tend to walk the same streets.
