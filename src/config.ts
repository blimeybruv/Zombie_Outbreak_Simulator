// Every tuning parameter, exported as one object. Imports nothing.
//
// Values come from docs/implementation-reference.md where it gives them; the rest
// are placeholders and are marked `guess`. All of them are starting points for
// the parameter sweep, not findings. Units are in the trailing comment: m (metres),
// tick (one simulated second), m/tick, /tick (fraction of remaining gap closed per
// tick, or probability per tick), scalar (0–1).
//
// Keys that name an enum value (archetype, weapon, tag, profession, terrain) are
// checked against the state enums by tests/config.test.ts.

export const config = {
  map: {
    size: 3520, // m, square: the city's 3,200 and the border's margin either side
    // The city's edge: an empty band `margin` m wide inside the map edge, with nothing in
    // it but the exits' stubs; across it a railway on two adjacent sides and a fenced
    // motorway on the other two (state/map.ts BORDER_KINDS), scenery that the stubs cross.
    // Impassable everywhere but on a stub, so the cordon at the exits seals the city — guess
    border: { margin: 160 },
    blockPitch: 80, // m, map default; a district kind's blockPitch overrides it
    streetWidth: { alley: 6, standard: 12, main: 20, highway: 28 }, // m
    // Ways off the map: `count` of the district-boundary arterials (which already run
    // edge to edge) become highways, each leaving the map at one end — the first end
    // drawn at random, each next at random among ends at least spreadFrom × the map from
    // those chosen (the farthest, failing any); ends in the river are passed over. A highway that
    // crosses the river is bridged there: the natural chokepoint. Everywhere else the
    // edge is a closed ring road — guess
    exits: { count: 3, spreadFrom: 0.5, reach: 8 }, // reach: m from the exit's node at which one on foot is through it
    spatialHashCell: 32, // m; the reference's 16 m is below every perception radius, and the per-rebuild cell scan dominated
    districtGrid: 3, // 3×3 districts of ~1067 m
    // Row-major from the top-left. Downtown centre, industrial in one corner, suburbs around.
    districtLayout: ['suburb', 'suburb', 'industrial', 'suburb', 'downtown', 'suburb', 'suburb', 'suburb', 'suburb'],
    // Churches are placed after the city is built, never drawn by weight: so many in
    // each district kind, spread one to a district before any gets a second, never more
    // than perDistrict in one, at least spacing apart. A church stands on a house or
    // flavour plot of minArea to maxArea m²; where no plot is that big (the suburbs), on
    // up to maxMerge neighbouring house plots of one frontage joined into one — guess
    churches: { count: { downtown: 2, suburb: 4 } as Partial<Record<string, number>>, perDistrict: 3, minArea: 600, maxArea: 2500, maxMerge: 4, spacing: 250 },
    river: {
      width: 40, // m — guess
      bridges: 3, // crossings in total, one of them on the crossing diagonal when there is one
      slope: [0.25, 0.45], // rise over run across the map: a diagonal river, not a horizontal one
      meander: 60, // m of sideways wander at interior bends — guess
      bankMargin: 8, // m of dry bank a non-bridge street stops short of
    },
    diagonals: {
      // Two short arms from one hub node (a landmark junction), and one separate
      // diagonal that crosses the river. Each runs about a third of the map and
      // starts and ends on existing grid nodes, so none becomes a through-route.
      armLength: [700, 1100], // m
      armSpread: [70, 110], // degrees between the two arms: they meet at an angle, never in a line
      crossingLength: [800, 1150], // m
      gridAngle: [30, 60], // degrees off the map axes
      minRiverAngle: 35, // degrees; no diagonal runs near-parallel to the river
      endpointSearch: 150, // m from the aimed point to the grid node it snaps to
      riverClearance: 200, // m from the river for the hub and arm ends
    },
    snap: 5, // m; crossings closer than this merge into one node
    setback: 2, // m between a building and the edge of its street
    minBlockArea: 250, // m²; smaller faces stay empty
    plazaArea: 1500, // m²; faces below this are plazas: no buildings, `open` streets
    sizeClasses: { medium: 250, large: 1200 }, // m² of footprint at which a building counts as medium, large
    parkShare: 0.04, // fraction of blocks left empty with `open` streets — guess
    offStreetLookup: 40, // m; perception reads the nearest street within this, else `standard`
    // One mall per map: the street between two neighbouring blocks is cut back to a
    // driveway, and the merged block becomes grounds — parking in front, one large
    // building behind. Pairs qualify whose blocks are each at least minBlock and
    // together at most maxArea, across a standard street at least minLength long, in one
    // of these district kinds; those meeting a main street come first, then the largest.
    // The best `tries` are tried in turn until the compound fits. driveway is its length
    // from the junction; the building stands apron beyond its end, at most maxWidth ×
    // maxDepth (at least minWidth × minDepth), sideYard clear of the grounds' sides. No
    // mall if nothing fits.
    // A yard beside each police station and hospital that has room on its frontage (a
    // whole-block one gives up the far end of its own): open ground with a driveway and
    // rows of bays, where its vehicles park — guess
    yard: { width: 30, depth: 18, gap: 2, minRest: 25 }, // a whole-block one is cut from the building, leaving it at least minRest wide
    mall: {
      districts: ['suburb'] as readonly string[], // malls are suburban; industrial blocks are larger and won every time
      minBlock: 8000, // m²
      maxArea: 50000, // m²
      minLength: 90, // m
      driveway: 45, // m
      apron: 8, // m
      maxWidth: 170, // m
      maxDepth: 80, // m
      sideYard: 8, // m
      minWidth: 80, // m; a smaller building is no mall
      minDepth: 40, // m
      tries: 12, // sites tried, best first, before the map goes without
    },
  },

  districtKinds: {
    // blockPitch overrides map.blockPitch; rotation is the grid's angle against the map
    // (degrees, random sign) so district seams show; plots are laid along each block's
    // street frontages (width along the street, depth into the block, metres); a plot
    // is built with probability buildingDensity, else left vacant; alleyShare is the
    // chance of a mid-block alley between two streets; tagWeights are relative — guess
    downtown: {
      blockPitch: 95,
      rotation: [0, 3],
      plot: { width: [25, 60], depth: [20, 45], gap: 3 },
      wholeBlockShare: 0.35, // blocks built as one large footprint (offices, hospitals, schools)
      buildingDensity: 0.95,
      lightingCoverage: 0.9,
      mainStreetShare: 0.3,
      alleyShare: 0.3,
      tagWeights: { residential: 3, office: 4, supermarket: 1, school: 0.5, hospital: 0.3, policeStation: 0.3, firearmsStore: 0.2, hardwareStore: 0.4, workshop: 0.2, warehouse: 0.2, flavour: 3 },
    },
    industrial: {
      blockPitch: 130,
      rotation: [3, 8],
      plot: { width: [40, 90], depth: [14, 24], gap: 8 },
      wholeBlockShare: 0.25,
      buildingDensity: 0.7,
      lightingCoverage: 0.4,
      mainStreetShare: 0.15,
      alleyShare: 0.2,
      tagWeights: { residential: 0.5, office: 0.5, supermarket: 0.2, school: 0.1, hospital: 0.05, policeStation: 0.1, firearmsStore: 0.2, hardwareStore: 1, workshop: 3, warehouse: 4, flavour: 0.5 },
    },
    suburb: {
      blockPitch: 100,
      rotation: [2, 8],
      plot: { width: [12, 18], depth: [12, 18], gap: 2 },
      wholeBlockShare: 0.03,
      buildingDensity: 0.7,
      lightingCoverage: 0.5,
      mainStreetShare: 0.1,
      alleyShare: 0.5,
      tagWeights: { residential: 10, office: 0.2, supermarket: 0.5, school: 0.4, hospital: 0.05, policeStation: 0.1, firearmsStore: 0.1, hardwareStore: 0.3, workshop: 0.3, warehouse: 0.1, flavour: 1.5 },
    },
  },

  time: {
    dayLength: 7200, // ticks per day/night cycle; compressed, 7 cycles per run
    startWeekday: 0, // the day a run starts on, for the status line: 0 Monday … 6 Sunday
    runLength: 64800, // ticks; the demo's one terminal condition: 18 simulated hours — the outbreak's fourteen (it was 50,400, before that 36,000), then the rescue's four
    sunrise: 0.25, // fraction of day (06:00)
    sunset: 0.75, // fraction of day (18:00)
    twilight: 0.04, // fraction of day over which perception interpolates (~1 h)
    // Hour boundaries of the four occupancy bands: night, morning, afternoon, evening.
    bandStartHours: [0, 6, 12, 18],
  },

  // Feature switches, for measuring what each costs and changes (bench and sweep take
  // --set features.cars=false). Each off restores the behaviour before it:
  //   conversations   every meeting trades everything, no stopping or gatherings
  //   unease          the first telling convinces; no unease from crowds, distant
  //                   gunfire or shouts, so no shortened errands or panic floor
  //   trust           everyone believes what they hear at face value
  //   reconsider      objectives held until arrival, refusal or diversion
  //   intactZombies   the one-bite dead are recognised like any other
  //   cars            no cars at all
  //   strangerVeto    the cautious let strangers in
  //   cautiousRouting the cautious take an unknown street for safe
  //   evacuation      districts never evacuate: the release at the start is the only one
  //   rescue          no company comes in at the end, no broadcast, no trucks
  //   exits           no highways out: the map is closed
  //   cordon          nobody outside notices: the exits stay open
  //   yards           no service yards: stations and hospitals park one vehicle at the kerb
  //   swat            no SWAT squads or vans
  //   emt             no ambulances: nobody calls one
  //   reservists      no armouries, so reservists are never called up: civilians
  //   relevanceTrim   street memory forgets its oldest, not its least relevant
  //   dropQuietHearsay everyone takes news of quiet streets they knew nothing of
  features: {
    cordon: true,
    exits: true,
    yards: true,
    emt: true,
    swat: true,
    rescue: true,
    evacuation: true, // on since evacuees leave by the exits and the cordon closes behind the first district (reference, "Evacuation")
    reservists: true,
    relevanceTrim: true,
    dropQuietHearsay: true,
    conversations: true,
    unease: true,
    trust: true,
    reconsider: true,
    intactZombies: true,
    cars: true,
    strangerVeto: true,
    cautiousRouting: true,
    company: true,
    carAlarms: true,
    sirens: true, // emergency vehicles' sirens draw the dead: the city hears what the viewer hears (reference, "Car alarms and sirens")
    traffic: true, // traffic police set checkpoints on the roads out once the cordon closes (reference, "Checkpoints")
  },

  // The setup screen's ranges (src/ui/setup.ts): survivors [min, max, step]; initial
  // zombies [min, max]. Above about 10,000 people, 8× falls behind on a busy run.
  setup: {
    population: [2000, 10000, 500],
    initialZombies: [1, 200],
  },

  playback: {
    ticksPerSecondAt1x: 10,
    speeds: [0.25, 1, 2, 4, 8],
    // A named survivor's death or conversion drops playback to 1× only if they had been
    // named this long: someone the viewer has had time to follow, not a name from a
    // minute ago. (With every death dropping it, 8× was interrupted every ~15 seconds.)
    dropTo1xNamedFor: 3600, // ticks
  },

  spawn: {
    // Share of population outdoors at tick 0, by occupancy band.
    outdoorShareByBand: [0.02, 0.12, 0.15, 0.1],
    streetSpawnWeight: { main: 3, standard: 1, alley: 0.2 }, // relative
    ageRange: [18, 67], // years: working age, for any profession without its own range below
    // Ages by profession, where the job implies one. Police are cops of working age.
    professionAge: {
      retiree: [65, 85], student: [16, 25], parent: [22, 50], patrolOfficer: [22, 58], detective: [28, 60],
      firefighter: [20, 55], paramedic: [21, 60], securityGuard: [20, 65], offDutySoldier: [19, 45],
      homeless: [18, 75], tourist: [18, 80], drunk: [18, 75], hunter: [18, 75], caretaker: [30, 75],
      firearmInstructor: [28, 70], trailGuide: [20, 60], homesteader: [25, 75], hamRadioOperator: [30, 80],
    } as Record<string, readonly [number, number]>,
    // Added to a sim's uniform sociality draw (clamped to 0–1): the jobs of people who
    // work among people go along with others more readily; solitary ones less. Small,
    // so the trait stays nearly independent of archetype — guess
    professionSociality: {
      bartender: 0.2, teacher: 0.15, parent: 0.15, barista: 0.1, nurse: 0.1, student: 0.1, receptionist: 0.1, retailAssistant: 0.05,
      nightCleaner: -0.2, longHaulDriver: -0.2, groundskeeper: -0.15, homesteader: -0.15, hamRadioOperator: -0.1, trailGuide: -0.1, homeless: -0.1,
    } as Record<string, number>,
    // Anyone who is police is a cop by profession, whatever building they came from.
    policeProfessions: ['patrolOfficer', 'detective'],
    originMinResidents: 25, // people; patient zero's building in `enclosed`, else the fullest eligible one (30 until the city was inset in its border, when map 1's fullest at 19:00 held 27)
    originNeighbourhoodRadius: 300, // m; origins are weighted by the people living this close — guess
  },

  // Evacuation, a second release apart from the first: a district that comes to know
  // — `threshold` of its buildings alerted, checked every `interval` ticks — sends
  // `share` of the residents still in each of its buildings out together, aware and
  // leaving, `perBuildingPerTick` at a time, each for a building between minDistance
  // and maxDistance away (the most robust of `sample` drawn at random; failing any in
  // range, the farthest) — with exits, the nearest exit instead (exits.ts). Driven by
  // the district's own state, not the clock, so it happens where and when the outbreak arrives, and a neighbourhood
  // empties onto the roads while the next is calm — guesses; threshold is for sweeping
  evacuation: { threshold: 0.07, interval: 30, share: 0.1, perBuildingPerTick: 1, minDistance: 800, maxDistance: 2000, sample: 8 },

  release: {
    atTick: 600, // tick
    jitter: 150, // ± ticks per district, from the run RNG
    residentShare: 0.3, // fraction of each building's residents released onto routines — guess
    perBuildingPerTick: 2, // people; staggered, never instant
  },

  routine: {
    idleTicks: [200, 600], // ticks at each stop
    professionStopWeight: 3, // multiplier on tags matching the sim's profession — guess
  },

  // Rising (systems/dead/rising.ts): of those the dead kill — fed on in the street or
  // indoors, or killed in a breach — `chance` get up again `delay` ticks later, where
  // they fell. A zombie destroyed stays destroyed, and so does anyone shot. The eaten
  // still rarely spread anything: bites stay the vector, but no place where people
  // died is safe for good — guesses (the user's: low and late, to avoid a late surge)
  // The rescue (rescue.ts; the user's design): the outbreak's fourteen hours, then the Army Rangers — a
  // company of `squads` squads comes in at `at` by the exit whose corridor holds the most
  // people still sheltering, and pushes up it — a corridor `halfWidth` either side of the
  // line from the exit toward the middle of the map — its front advancing `speed` m a
  // tick to at most `depth`, and never more than `lead` m ahead of the farthest living
  // soldier: with none left, the sweep stops. The soldiers shoot the dead, send back down the corridor
  // anyone who identifies itself (within `sendRadius`), and may shoot anyone who does
  // not — frozen, sprinting, or in the dark — at `misidentify` a look; buildings the
  // living hold behind the front give up `takeShare` of their residents. `broadcast`
  // ticks after the sweep began, a radio order tells everyone still hidden to make for
  // that exit (`broadcastShare` of the residents of every building still held). Answering
  // is a choice: a sceptic (trust under trustFloor) stays put, and so does anyone whose
  // caution × risk passes riskTolerance, risk growing with the uncleared ground between
  // it and the cleared corridor, full at farFrom. Trucks
  // come every `truckEvery` ticks, load for `truckLoad` and take up to `truckCapacity`
  // of those waiting; nobody is screened. The squads' line moves up in bounds of `bound`
  // m and holds between them; a squad whose place in the line has no street within
  // `snapReach` m (the river) holds where it is until the line is past — guesses
  // The rescue's line has a gate at the barrier's middle, `gate` m either side of it: the
  // cordon's squad stands in line just outside it, two of them flanking the gate, and
  // each person let through walks to the gate and stops there screenTicks ticks, being
  // looked over, before going on to a tent — guesses
  // A truck backs in from beyond the map's edge over truckDrive ticks before it is due, and
  // drives out the same way after it leaves: drawn only (the worker), the simulation's
  // truck stands at its spot while it loads — guess
  // The rescue's queue and tents: at its exit those waiting stand in rows across the road
  // behind the cordon line, cordon.queueSpacing m apart across it and queueRow m apart
  // along it, in the order they came. Every passEvery ticks (truckCapacity a truck's worth
  // each truckEvery) the soldiers let the front one through, to a tent: tents.count of
  // them, half each side of the road beyond the line, `length` × `width` m, `gap` m apart,
  // the nearest `from` m out from the barrier. Inside one (within `reach` of its door at
  // the road's edge) it is out of the city; the trucks take the tents' people away —
  // guesses
  rescue: { at: 50400, squads: 4, ammo: 120, halfWidth: 150, speed: 0.15, depth: 2200, lead: 60, bound: 30, snapReach: 30, sendRadius: 40, misidentify: 0.15, takeShare: 1, broadcast: 7200, trustFloor: 0.25, farFrom: 1500, riskTolerance: 0.3, broadcastShare: 0.5, truckEvery: 600, truckLoad: 180, truckCapacity: 25, truckDrive: 20, gate: 1.5, screenTicks: 6, passEvery: 24, queueRow: 1.5, tents: { count: 6, length: 7, width: 4, gap: 3, from: 8, reach: 2 } },

  rising: { chance: 0.25, delay: [1200, 2400] as [number, number] },

  // Nerve (Sim.nerve, a uniform draw): composure under terror. It breaks when panic
  // passes it (panic.ts breaks). Cornered, a sim whose nerve has gone freezes in shock,
  // armed or not; with the way blocked it will not stand to fight; exhausted (stamina
  // at most collapseStamina) with danger in sight, it gives up and stays down
  // collapseTicks. Those trained to it are held up to `floor` — guesses
  nerve: {
    floor: { police: 0.8, reservist: 0.6 } as Partial<Record<string, number>>,
    collapseStamina: 0.05,
    collapseTicks: 120,
  },

  panic: {
    risePerEvent: 0.25, // added (clamped) per witnessed conversion or nearby noise
    decayRate: 0.004, // /tick toward 0
    encounterDamping: 0.3, // fraction of the gap closed toward the higher value per encounter
    routingCutoff: 0.55, // above: flight mode, no pathfinding, sprint
    memoryCutoff: 0.4, // above: direct mode, memory ignored, run
    expelThreshold: 0.7, // occupants above this are expelled
    settleTicks: 120, // ...but not within this many ticks of coming in, nor the panic-immune
    noiseIntensityFloor: 0.2, // stimulus intensity at the sim needed to count as nearby noise — guess
  },

  // People running. Those running toward a sim are second-hand danger (and frighten
  // it: panic.ts); those running near it set the current it leans into when panicked.
  crowd: {
    // Contagion: people running toward a sim, within `fleeingRadius` and in sight, are
    // second-hand danger lying the way they came from — each counts `fleeingWeight` ×
    // (1 - d / radius) in perceived threat — and panic rises toward that sum ×
    // `fleeingGain` at `fleeingRate` a tick. A street of people running back turns
    // anyone arriving. Runners going the same way do not count for each other — guess
    fleeingRadius: 20, // m
    fleeingTowardCos: 0.5, // heading within 60° of straight at the observer
    fleeingWeight: 0.2,
    fleeingGain: 2,
    fleeingRate: 0.1,
    // Crowd alignment: a panicked sim (direct or flight) or one backing off blends its
    // heading toward the mean heading of people running within `crowdRadius`, weighted
    // by nearness, by `crowdAlignment` — so fleeing people converge into a current
    // instead of scattering radially, and a sim carried by the crowd stops recomputing
    // its own way out each tick — guess
    crowdRadius: 12, // m
    crowdAlignment: 0.35,
  },

  // Company (panic.ts breaks): calm people beside a sim — within `radius` and in sight,
  // neither running nor frozen — hold its nerve at the moment it is tested (cornered,
  // blocked, run to exhaustion): the panic it takes to break rises by up to `nerve` ×
  // sociality, in full with `cap` of them. Nothing about panic itself changes, so a calm
  // crowd can still tip, and a crowd running steadies nobody — guess
  company: {
    radius: 8, // m
    cap: 4, // companions for the full effect
    nerve: 0.3,
  },

  perception: {
    dayRadius: { standard: 45, alley: 30, open: 60, bridge: 60 }, // m
    nightRadiusLit: 25, // m
    nightRadiusUnlit: 15, // m
    dormantThreatWeight: 0.25, // dormant zombies count a quarter in perceivedThreat
    // Survivors face somewhere: their full radius within the cone (cos of its half-angle,
    // 0.34 ≈ ±70°) of their heading, `rear` of it outside — not blind behind, but what
    // closes from behind gets much nearer before it registers. Contact is felt — guesses
    coneCos: 0.34,
    rear: 0.3,
  },

  memory: {
    halfLife: 1800, // ticks; confidence = exp(-ln2 * age / halfLife)
    // The especially cautious do not take ignorance for safety: a street they know
    // nothing of reads as unknownStreetDanger, ramping in from caution
    // unknownDangerFrom (0 below it) to the full value at caution 1, and what they were
    // told or saw drifts back toward it as it ages (believed danger = confidence × seen +
    // (1 − confidence) × that prior). Everyone else reads an unknown street as safe and
    // an old report as fading to safe. So the cautious keep to streets known to be
    // quiet, and news of a quiet street is worth something to them — guess
    unknownStreetDanger: 0.15,
    unknownDangerFrom: 0.66,
    // Street danger rises at once and falls slowly (memory.ts settleDanger): a quiet
    // look moves a belief quietLook of the way toward what was seen, never to zero in
    // one pass. Some things are written where they happened, at a fixed danger: a
    // zombie sighted (and shouted) on a street, a bite or a turning seen there, a
    // shelter fallen — what happened, not the seer's distance from it — guesses
    quietLook: 0.5,
    sightedDanger: 0.8,
    witnessedDanger: 1,
    fellDanger: 1,
    // Street tables are trimmed by relevance (memory.ts trimStreets): a reserve of the
    // gravest warnings anywhere, then the nearest streets, distance from the
    // destination counting destinationWeight times distance from the sim — guesses
    relevance: { reserve: 10, destinationWeight: 2, dangerFloor: 0.05 },
    streetCap: 150, // entries; beyond this the oldest observation is forgotten
    buildingCap: 30, // entries; terraces put hundreds of buildings within a close pass
  },

  stimulus: {
    decay: 30, // ticks a noise event persists
  },

  behaviour: {
    waypointRadius: 3, // m; a route waypoint counts as reached within this
    arrivalRadius: 2.5, // m from an entrance to go inside
    doorSearchRadius: 30, // m; a sim in flight runs for the nearest door within this — guess
    shelterFallbackRadius: 150, // m; nearest building when no shelter is known — guess
    expelledPanic: 0.8, // panic of sims expelled into the street — guess
    routineSample: 8, // buildings considered when picking the next routine stop
    routineDistanceScale: 300, // m; stop weight falls as 1 / (1 + d / scale) — guess
    pathStreetSearch: 200, // m; widest search for the street a route starts or ends on
    observeInterval: 5, // ticks between close-pass building observations, staggered by id
    avoidHold: 15, // ticks a sim keeps avoiding after the threat drops out of sight
    turnedFromHold: 120, // ticks a door it turned from (its way blocked, or refused before the last refusal) is not run for again — guess
    // A warning is shouted out loud: it is a stimulus
    // (encounters.shoutNoiseRadius, by default the warning's), heard by the dead as well as the living — telling the
    // neighbours costs drawing the horde. Loudness at the source — guess
    shoutIntensity: 0.6,
    // Going somewhere with a zombie in the way: the heading blends in "away from the
    // danger", by this much at full threat dead ahead, so the sim goes round rather
    // than through. Danger behind or beside does not slow it — guess
    avoidWeight: 1.5,
    // Panicked, running for the nearest door: a door lying toward the danger (within
    // the cosine below of the threat's direction) counts as this many times as far — guess
    doorTowardThreatPenalty: 3,
    doorTowardThreatCos: 0.7,
  },

  // Fight, flight or freeze. Cornered — a zombie within `near`, perceived threat at least `threat`, and either
  // danger on several sides (|threat vector| / threat under `spread`) or no walkable
  // ground `probe` metres along the way out — a sim fights if armed, else takes any door
  // within doorSearchRadius, else freezes. With the way merely blocked (danger squarely
  // ahead: avoidWeight × threat × aheadness at least `blockedAt`), it fights if what it
  // carries can deal with the zombies within `fightRadius`, else takes a door that does
  // not lie toward them, else backs off for avoidHold ticks. Zombie attacks on a
  // cornered sim roll at combat.zombieAttack.corneredFactor.
  cornered: {
    threat: 0.4, // — guess
    spread: 0.5, // — guess
    probe: 6, // m
    near: 6, // m: cornered only with a zombie this close — about four times contact range
    blockedAt: 0.8, // — guess
    fightRadius: 15, // m
    fightTicks: 10, // a stand is reconsidered after this long
    freezeTicks: 20, // — guess
    refreeze: 120, // ticks after coming out of a freeze in which, cornered again, it runs rather than freezes — guess
  },

  // 911. Someone who gets indoors within `callWindow` ticks of seeing a zombie calls it
  // in. Every `interval` ticks, the nearest station within `radius` with first
  // responders inside, armed and free, sends up to `perCall` of them to the caller's
  // door; within `sceneRadius` of it they are on the scene, the call is answered, and
  // they go back. On a call they engage up to `engageThreshold`, not their usual. A call lapses after `timeout`. Stations
  // with at least `minResidents` start with `perStation` residents as first responders
  // (tracked police, garrisoned) — guess
  dispatch: { callWindow: 60, interval: 10, radius: 1000, perCall: 2, timeout: 600, minResidents: 4, perStation: 3, sceneRadius: 50, engageThreshold: 0.6 },

  // Police decide as a unit: officers within `unitRadius` of each other engage and fall
  // back on the danger the most exposed of them sees, and each officer beyond the first
  // raises the unit's engage threshold by `unitStrength` (up to `unitMaxThreshold`).
  // Officers sent to the same call keep together: the one ahead waits while it is more
  // than `pairGap` metres nearer the call than its partner. Police responding — to a call,
  // to shots, to trouble — stand like an officer on a call (dispatch.engageThreshold).
  // Shots fired: police outdoors with something to shoot, hearing gunfire more than
  // `shotIgnoreRadius` away (not their own, nor their neighbour's), drop their path and
  // run for the sound, standing like an officer on a call — guess
  // First responders drive to a call in their station's police car when it is at the
  // kerb (within carNear of the door) and the call is beyond carBeyond: to the car, and
  // in together once all sent are within carGather. One way, like the SWAT van — guesses
  // standRatio: a unit stands its ground, whatever the threat reads, while the dead in
  // sight number no more than this share of what its ammunition can expect to kill (its
  // summed capacity): threat rises with nearness, so one zombie close by read as too much
  // and a pair of armed officers fell back from it, firing as it followed — guess
  // Traffic police (services/traffic.ts): the city's own attempt at containment. A unit
  // of `officers` waits at the police station nearest each exit's checkpoint, with a
  // cruiser, until the first barrier closes; then it drives out and holds a checkpoint
  // across the exit's road, `inset` metres in from the barrier by the streets, turning
  // back anyone on foot making for that exit within stopRadius, every `every` ticks.
  // Nobody of its unit within holdRadius, and the checkpoint has fallen, for good — guesses
  traffic: { officers: 2, inset: 350, stopRadius: 12, holdRadius: 30, every: 5 },

  police: { unitRadius: 25, unitStrength: 0.25, unitMaxThreshold: 0.8, pairGap: 10, shotIgnoreRadius: 15, carNear: 40, carBeyond: 250, carGather: 10, standRatio: 0.25 },

  // Reservists (archetype 'reservist'; squads.ts): anonymous residents until the
  // reserve is activated, once callUpCalls 911 calls have come in (0: at once). Then
  // `share` of the residents still in buildings the living hold step out as reservists,
  // weighted toward buildings near an armoury (exp(-d / depotScale), normalised), and
  // make for their depot (the armoury nearest home), never stopping to shelter —
  // panicked, it gets clear of the danger first, then goes on — draw a weapon if any
  // are left, and wait. `armouries` depots, spread across the map (the one nearest the
  // middle, then each next the farthest from those chosen), hold `weaponStock` weapons
  // each. pistolShare of them carry a pistol of their own — guesses
  reservists: { callUpCalls: 300, share: 0.02, depotScale: 1500, armouries: 2, weaponStock: 12, weapon: 'rifle' as const, ammo: 20, pistolShare: 0.1, pistolAmmo: 12 },

  // Squads: reservists waiting armed at a depot deploy as a squad once there are
  // `size` of them, the lowest id leading. Only the leader plans a route; the others
  // steer for their slots: in file behind it along its path (a point every
  // fileSpacing metres) while travelling, and in a diamond around it (diamondRadius,
  // turned toward the danger) while any member has a zombie within engageRange of its
  // weapon's range, holding the diamond diamondHold ticks after. A cordon squad stands
  // in line abreast across its highway instead, lineSpacing metres apart, the leader in
  // the middle. A follower more than slotLost from its slot for slotPatience ticks
  // heads straight for the leader for directHold ticks, or until within rejoinRadius of it: without that, squads
  // deadlocked on corners. The leader waits while any follower is more than lagRadius
  // from its slot. A leader claims a 911 call within targetRadius (failing that, an
  // occupied building it knows of), nearest first, one squad to a target, and holds
  // it until it is resolved, judged too strong, or claimed staleAfter ticks ago; with
  // nothing to claim it looks again every retargetInterval ticks, from its depot.
  // Arriving at an occupied building, the squad goes in if its members' capacity,
  // summed, is at least contestRatio × the occupiers: the leader's decision, at the
  // door, not a vote. The leader falls: the lowest surviving id leads. Below two, the
  // squad dissolves and its members stand down, keeping their weapons — guesses
  squads: {
    size: 4,
    contestRatio: 1,
    targetRadius: 1200,
    staleAfter: 1800,
    retargetInterval: 30,
    sceneRadius: 30,
    fileSpacing: 3,
    diamondRadius: 3,
    lineSpacing: 3,
    engageRange: 0.8,
    diamondHold: 30,
    slotLost: 8,
    slotPatience: 20,
    directHold: 30,
    rejoinRadius: 4,
    lagRadius: 12,
    slotStill: 1.5,
    slotRun: 5,
  },

  // SWAT: the institution responding, where reservists are the city improvising. At
  // `stations` police stations (the one nearest the middle, then each next the farthest
  // from those chosen) a squad of squads.size is garrisoned from the start, armed with
  // `weapon` and `ammo` rounds each, a van at the kerb. Finite: once spent, that
  // station has no more. They answer no 911 call: an officer on a call who finds more
  // zombies in sight than its unit's capacity (× radioRatio), and at least radioMin,
  // radios for them, with what
  // it counted, at most once each radioCooldown ticks. A SWAT squad takes the nearest
  // unanswered radio within `radius`, if its own capacity, summed, is equal to the
  // count it was given — and acts on that report, however it has grown; a radio nobody
  // takes lapses after squads.staleAfter. From the station, with the van there and the
  // target beyond vanBeyond (shorter than anyone else drives: radios mostly come from
  // near the station whose officers took the call), they drive: the leader walks to the van, waits
  // while any member is more than vanGather from it, and all board together. One way:
  // the van is transport, not a base; where it stops it stays, for anyone to take —
  // guesses
  swat: { stations: 3, weapon: 'smg' as const, ammo: 60, radius: 1500, vanGather: 15, vanBeyond: 250, radioRatio: 1, radioMin: 4, radioCooldown: 600 },

  // Service yards (map.yard): a police station with one has policeCrews cars, each with
  // dispatch.perCall first responders; a hospital with one, hospitalCrews ambulances
  // and crews. Without a yard, one at the kerb. Finite either way: what is spent is gone
  // — guesses
  yards: { policeCrews: 2, hospitalCrews: 3 },

  // EMTs (emt.ts): a crew of `crew` with an ambulance at each hospital, from the start,
  // taken from its residents; finite, like SWAT. A bitten sim indoors that believes
  // itself only hurt — it has seen nobody bitten and nobody turn — calls an ambulance,
  // once. The call gets through at answer × ½^(tick / answerHalfLife), decided as it is
  // made: early calls are answered, late ones do not connect. The nearest idle crew within `radius` goes:
  // out to the ambulance, in together, there; in to fetch the patient; back out; and
  // home to the hospital, where the patient is admitted. EMTs never screen: they come
  // for an injury. A call nobody takes lapses after dispatch.timeout. Members within
  // `gather` of the ambulance board together; it counts as arrived when parked within
  // `arriveNear` of the job's door — guesses
  emt: { crew: 2, answer: 0.9, answerHalfLife: 9000, radius: 2500, gather: 10, arriveNear: 40 },

  // The cordon (cordon.ts): the world outside sealing the city. It notices when the
  // first district evacuates, and `delay` ticks later — that district through, the
  // next not — a squad of squads.size soldiers comes in at every exit, armed with the
  // rifle and `ammo` rounds. Each walks to its post `post` metres outside a barrier
  // `setback` metres in from the edge; once the leader is within postReach of it, the
  // barrier closes: the highway's last segment is impassable, and nobody passes.
  // The soldiers fire at everyone who comes near it (the user's design): anyone on foot
  // within `warnRadius` metres of the barrier, in sight, draws a warning shot — no
  // roll, the noise as any shot, once per person each `warnEvery` ticks — and anyone
  // within `fireRadius`, aimed fire: the rifle's ordinary roll, of whose hits `killShare`
  // kill and the rest wound (no wound state: the wounded turn back). Warned, a person
  // making for the exit gives it up for another, or for shelter — or, at
  // `defy` × (1 − trust), presses on round the barrier: along the kerb, `kerb` metres
  // outside the road's edge, and out at the edge, under fire. A car making for a closed
  // exit is left `warnRadius` metres short of the barrier; the cars behind it stop.
  // At the rescue's exit, once the rescue has come, nobody is fired on: those answering
  // the broadcast queue behind the line for the trucks, the front row `queueGap` metres
  // inside the barrier, in rows queueSpacing m apart across the road (rescue.queueRow
  // along it); they join it within queueRadius m of its last row. Soldiers are outsiders: the invariant counts them on top of the
  // population — guesses
  // breachRadius: a closed barrier with no living soldier within this many metres is
  // breached, and people on foot pass it (vehicles still stop) — guess
  // returnFor: an armed sim getting round the barrier fires back at the soldiers for this
  // many ticks after they fire on it; fireFirstBelow: one whose trust is below this fires
  // first (the user's third exception to no survivor-on-survivor combat) — guess
  // atEase: a cordon soldier with nothing in sight stays where it stands; each `period`
  // ticks (out of step with the others, from its id) it either holds still (at chance
  // `still`) or turns, at most `turn` rad a tick, to look up to `sweep` rad either side of
  // facing back into the city. Stood stock still, a line read as frozen; ambling about
  // its place, as jittery (the user's notes) — guess. soldierAge: the age range of every
  // soldier from outside (the cordon and the Rangers), shown by rank, not profession.
  cordon: { delay: 600, ammo: 120, setback: 40, post: 8, postReach: 6, warnRadius: 75, fireRadius: 25, warnEvery: 20, killShare: 0.5, defy: 0.5, kerb: 1.5, queueGap: 10, queueRadius: 20, queueSpacing: 1.2, returnFor: 60, fireFirstBelow: 0.15, breachRadius: 40, soldierAge: [19, 40] as [number, number], atEase: { period: 90, still: 0.35, turn: 0.02, sweep: 1.2 } },

  // The faithful: this share of people belong to a church (the nearest to home), know
  // it from the start, and shelter only in churches while they know one that has not
  // turned them away — guess
  faithful: { share: 0.08 },

  // Knowing there is an outbreak. Unaware, a sim keeps its routine; aware, it drops it
  // for an objective: respond to trouble (those who engage), go home (within the
  // archetype's homeReach, unless home is believed dangerous), or the best shelter it
  // knows. Awareness spreads by sight, sound and word of mouth (sim.awareAt).
  awareness: {
    homeSample: 8, // residential buildings sampled when a home is assigned at spawn
    homeDistanceScale: 400, // m; a sampled home's weight falls as 1 / (1 + d / scale) — guess
    // Home counts as dangerous, and is passed over, when its street is believed at least
    // this dangerous (danger × confidence) — guess
    homeDangerous: 0.3,
    // Already heading home and the threat crosses the shelter-seek threshold: a home
    // further than this is abandoned for the best shelter nearer to hand — guess
    divertBeyond: 250,
    respondRadius: 600, // m; those who engage go toward trouble they believe in within this — guess
    respondMin: 0.15, // believed danger × confidence for a street to be worth responding to — guess
    respondArrival: 8, // m from the trouble's street midpoint to count as arrived
    isolationRadius: 200, // m; a bitten sim going off alone looks this far for an empty building — guess
  },

  encounters: {
    radius: 4, // m
    cooldown: 30, // ticks between merges for one sim — guess (10 made merging the largest cost with crowds outdoors)
    warnRadius: 30, // m; a survivor who sights a zombie shouts a warning about its street to everyone outdoors this close — guess
    shoutNoiseRadius: 30, // m; how far the dead hear that shout — apart from warnRadius so either can be swept alone
  },

  // Conversations. Two who meet outdoors pass on fear whatever happens; they stop to
  // talk at `chance` × their mean sociality (up to 1), and only talking trades what
  // they know — the outbreak, streets, buildings, who is bitten. A sim stays from
  // ticks[0] (least sociable) to ticks[1] (most); a passer within joinRadius joins one
  // already going at joinChance × its sociality, up to `cap` people (a passer had to
  // come within the 4 m encounter radius of a pair standing still, and almost none
  // did); what the conversation knows is pooled every poolInterval ticks. Nobody stops
  // with danger in sight, in flight, or on a call, and a conversation breaks up when
  // anyone in it sees danger — guess
  talk: {
    chance: 1.5,
    ticks: [4, 20],
    joinChance: 1,
    joinRadius: 12, // m
    // Those in a conversation walk in until on the circle its people would stand on,
    // `spacing` apart (joiners came from up to joinRadius away, and stood where they
    // were). Each keeps the conversation's distance from the nearest other in it, fixed per
    // conversation between these (m): closer, it steps back; they met within the 4 m encounter
    // radius, often passing almost shoulder to shoulder, and stood there congealed.
    spacing: [1, 4],
    backOff: 0.7, // steps back below this share of its distance…
    spacingSlack: 0.75, // m; …and walks in only when the nearest is this much beyond it
    shuffleWithin: 2, // m; within this of its place it steps at the sneak's pace, not a walk
    cap: 10,
    poolInterval: 5,
  },

  // Hearsay, judged by the listener's trust (0–1). What it is told is taken as
  // (1 − trust) × ageShift ticks older than it is — at memory.halfLife, a sceptic
  // believes it half as much, and hearsay of hearsay grows staler at every telling.
  // Who is said to be bitten is taken on at chance `trust` each time it is heard — guess
  trust: {
    ageShift: 1800, // ticks
  },

  // Unease (0–1): belief short of knowing, in someone not yet aware of the outbreak.
  // Each telling from someone new (in conversation, or a shout heard but its shouter
  // not seen) closes tellingGain of the gap to 1, from tellingGain[0] for the least
  // trusting to [1] for the most; at believeAt it becomes awareness: one telling for
  // the trusting, two at middling trust, three for a sceptic. Being swept along by a
  // running crowd moves it toward fleeingShare × the crowd's pull, at the panic
  // contagion's rate — never far enough to know, only to be unsettled — and gunfire
  // too faint to know for what it is closes `distantNoise` of the gap. It fades by
  // `decay` of itself a tick. Meanwhile it shortens stops on errands (idle ×
  // 1 − idleCut × unease), draws the next stop toward home (home's weight × homePull ×
  // unease among the sampled stops), and holds panic up to unease × panicFloor — guess
  unease: {
    tellingGain: [0.4, 1],
    believeAt: 0.75,
    fleeingShare: 0.6,
    distantNoise: 0.3,
    decay: 0.0005, // /tick
    idleCut: 0.8,
    homePull: 3,
    panicFloor: 0.3,
    panicFloorRate: 0.05, // /tick toward the floor
  },

  // Cars (systems/services/cars.ts): a building with a velocity, not traffic. Parked at setup at
  // the kerb in front of a share of each tag's buildings (parkShare), on standard and
  // main streets only (an alley is too narrow to pass one), never within nodeClear of
  // a junction nor nearer than spacing to another, and in the mall's stalls (lotShare).
  // A car is length × width, and parked kerbInset in from the edge of the street.
  // Moving, it keeps laneOffset right of the centreline (at most a quarter of the
  // street's width), so opposing cars never meet, at up to maxSpeed, slowed by
  // congestion — 1 / (1 + congestion × cars within congestionRadius) — and it stops for
  // anything within `gap` ahead in its own path; when two stop for each other the
  // lower id yields. An aware sim heading for home or shelter more than driveBeyond
  // away, on foot and not in flight, takes the nearest free parked car it can see
  // within searchRadius; at boardRadius it gets in. It pulls up at the kerb by its
  // destination's door (arriveRadius) and everyone gets out. A car stopped behind
  // something for jamTicks is abandoned there: everyone gets out, and it stays —
  // guess, all of it
  cars: {
    parkShare: { residential: 0.45, office: 0.5, workshop: 0.5, warehouse: 0.5, hardwareStore: 0.4, supermarket: 0.4, school: 0.3, hospital: 0.4, policeStation: 0.5, firearmsStore: 0.4, mall: 0, flavour: 0.25 } as Record<string, number>,
    lotShare: 0.6,
    stall: { width: 2.7, depth: 5, aisle: 7, driveGap: 4.5 }, // m: the mall's stalls, as drawn
    length: 4.5, // m
    width: 1.9, // m
    kerbInset: 1.2, // m from the street's edge to the car's centreline
    nodeClear: 14, // m
    spacing: 6.5, // m between parked cars' centres
    laneOffset: 2.5, // m
    maxSpeed: 9, // m/tick, about 32 km/h
    // Driving like a vehicle: speed closes `accel` of the gap to its target a tick, `brake`
    // when slowing (a stop below stopBelow is a stop); it turns no faster than a circle of
    // turnRadius m allows at its speed (turnMin rad/tick at a crawl), its target scaled by
    // the cosine of how far it has to turn (at least turnSlow); and it eases off as it
    // closes on what is ahead, its target at most `approach` × the room left, stopping
    // personGap m short of anyone on foot. A driver in flight rams the dead instead:
    // each struck destroyed at ramKill, the car slowed to ramSlow of its speed — guess
    accel: 0.25,
    brake: 0.5,
    stopBelow: 0.2,
    turnRadius: 8,
    turnMin: 0.35,
    turnSlow: 0.2,
    approach: 0.35,
    personGap: 2,
    ramKill: 0.6,
    ramSlow: 0.6,
    // A struck zombie that survives is thrown `knockBack` m [min, max] along the car's
    // path, if it lands on open ground. A moving car swerves round the nearest person
    // in its path instead of braking — aiming to pass swerveClear m clear of them — if it
    // is doing at least swerveFrom m/tick and the ground beside them is clear. Moving
    // into a building or another car stops it where it is: at crashMin m/tick or more it
    // is wrecked (abandoned for good) and each person inside dies at crashKill ×
    // (speed / maxSpeed)²; slower, a bump. Parked cars count only at crashMin or more —
    // a car pulling out of a stall brushes its neighbours — guess
    knockBack: [4, 7] as [number, number],
    lookahead: 12, // m: a car steers for a point this far ahead along its lane
    swerveFrom: 1.5,
    swerveClear: 1,
    crashMin: 6,
    crashKill: 0.5,
    // Below crashMin a car keeps its body out of buildings: it takes the turn it wants, or
    // failing that each fraction of it in `wallTurn`, or turns either way by those
    // fractions of its full turn and then all of it — at its speed and then each fraction
    // of it in `wallSpeed`; boxed in, it backs out. Checked at
    // `bodySamples` points along its length by 3 across — guess
    wallTurn: [0.5, 0] as number[],
    wallSpeed: [0.5, 0] as number[], // (0: turning on the spot, at a crawl)
    bodySamples: 5,
    reverseSpeed: 1, // m/tick — guess
    congestion: 0.3,
    congestionRadius: 15, // m
    gap: 7, // m
    capacity: 4, // people
    driveBeyond: 500, // m
    searchRadius: 50, // m
    boardRadius: 3, // m
    arriveRadius: 6, // m
    parkWithin: 1, // m; a car parks once this close to its kerb spot (or stopped within arriveRadius of it)
    pullUpTries: 4, // kerb spots tried either way along the street from the door, spacing apart
    clearance: 0.5, // m kept bumper to bumper: a car never moves closer than this to one ahead
    waypointRadius: 4, // m; a junction counts as passed within this
    jamTicks: 180,
    // A car stopped rerouteAfter ticks turns back to the junction behind it and takes
    // another way, at most maxReroutes times; then jamTicks stopped and it is abandoned — guess
    rerouteAfter: 60,
    maxReroutes: 2,
    // Engines: a car being driven (moving or stuck) makes a noise every engineInterval
    // ticks, staggered by id, heard by the dead to engineNoise metres at
    // engineIntensity — a street of cars is a dinner bell. People ignore it.
    engineInterval: 10,
    engineNoise: 45, // m
    engineIntensity: 0.6,
    // Alarms: an armed share of ordinary cars (drawn at setup) goes off the first time
    // the car is taken, or the dead tear at it with people inside — loud and brief, a
    // blast every `every` ticks for `ticks`, heard by the dead to `noise` metres; then
    // spent. People ignore it — guess
    alarm: { share: 0.3, noise: 150, intensity: 0.9, every: 5, ticks: 30 },
    // Sirens (features.sirens): a police car, SWAT van or ambulance on
    // the move, heard by the dead to `noise` metres every `every` ticks — sparse and
    // modest, so it leaves a thin wake rather than a corridor — guess
    siren: { every: 15, noise: 100, intensity: 0.6 },
    // Each awake zombie at an occupied car (within half its length and contact range)
    // breaks in at breakIn a tick: the doors give, and everyone inside is out among
    // them. Someone who turns inside bites each of the others at turnInsideBite.
    breakIn: 0.02,
    turnInsideBite: 0.6,
  },

  pathfinding: {
    dangerWeight: 400, // m of detour one unit of believed danger is worth — guess
    // Multiplier on dangerWeight at caution 0 and 1, linear between: cautious sims pay
    // more to avoid streets they believe are bad. Averages 1 across the population — guess
    cautionDanger: [0.5, 1.5],
    repathCooldown: 30, // ticks
    repathQueueCap: 20, // sims per tick
  },

  movement: {
    gait: {
      // speed m/tick; stamina /tick; detectability multiplier on zombie sight; noise m
      still: { speed: 0, stamina: 0.004, detectability: 0.35, noise: 0 },
      sneak: { speed: 0.7, stamina: 0.001, detectability: 0.5, noise: 0 },
      walk: { speed: 1.4, stamina: 0.002, detectability: 1.0, noise: 0 },
      run: { speed: 2.2, stamina: -0.006, detectability: 1.3, noise: 8 },
      sprint: { speed: 2.9, stamina: -0.015, detectability: 1.6, noise: 15 },
    },
    staminaSpeedFloor: 0.5, // effectiveSpeed = gaitSpeed * (floor + (1-floor) * stamina) * ageFactor (fleeAgeFactor when running or sprinting)
    ageFactor: { atAge: [20, 80], value: [1.05, 0.75] }, // linear between, clamped outside
    // Running and sprinting age far worse than walking: at 80 a sprint is barely faster
    // than a shambler, a run slower. Replaces ageFactor for those gaits — guess
    fleeAgeFactor: { atAge: [30, 80], value: [1, 0.45] },
    concealment: 0.5, // detectability multiplier indoors, or on an unlit street at night
    slideSpeed: 0.7, // fraction of speed kept while sliding along a wall or bank
    // On foot, a sim blocked by a parked or abandoned car goes round it if a turn of at
    // most `turn` radians will do, else climbs straight over at `share` of its pace
    // (two cars nose to tail had people trapped between them, sliding back and forth).
    // The dead clamber over too, slower: kept out, they piled up behind any car the
    // living had climbed (zombies stuck 1.0% → 2.8% of moving ticks on seed 1) — guess
    climb: { share: 0.35, turn: 0.8 },
    // The living pick up speed and slow down rather than jump to the gait's: each tick
    // pace closes `accel` of the gap to it (`flightAccel` in flight, fear's spring),
    // `decel` when slowing — stopping is quicker than starting; below `rest` m/tick
    // toward a stop it is a stop. The user and B: people standing still went from
    // nothing to full speed in one tick — guess
    inertia: { accel: 0.35, flightAccel: 0.6, decel: 0.7, rest: 0.05 },
    climbDead: { share: 0.2, turn: 0.8 },
    gaitNoiseIntensity: 0.6, // at origin; heard by zombies within the gait's noise radius — guess
  },

  zombie: {
    speed: { shambler: 1.1, runner: 2.4 }, // m/tick
    sightRadius: 18, // m, times sim detectability; fixed regardless of light
    sightRamp: 0.2, // outer fraction of range over which detection probability ramps 0→1
    trackingLossTicks: 40, // unseen this long → target lost
    trackingLossRangeFactor: 2, // beyond this × effective range → target lost
    wakeThreshold: 0.2, // stimulus intensity needed to wake a dormant zombie
    dormantAfter: 1200, // ticks without stimulus or target before an active zombie goes dormant — swept (was 300)
    wanderRate: 0.001, // /tick spontaneous wake chance for a dormant zombie — swept (was 0.0002)
    wanderTicks: [300, 900], // ticks a wanderer drifts before re-dormanting — guess
    wanderSpeedFactor: 0.6, // of zombie speed — guess
    idleSpeedFactor: 0.3, // of zombie speed while awake with nothing to chase — guess
    arriveRadius: 2, // m; a heard point counts as reached within this
    crowdArrive: 10, // m; within this of a heard point with another of the dead nearer it, it counts as reached: a crowd cannot all stand on one door
    heardForget: 600, // ticks; a heard point not heard again this long is given up
    intactCompany: 5, // m: an intact zombie this near an ordinary one moving with it is seen for what it is, for good
    closeIn: 0.6, // closing on a target, it stops this share of contactRange short of it rather than overstep
    dormantCheckInterval: 4, // ticks between a dormant zombie's wake checks, staggered by id
    idleCheckInterval: 3, // ticks between decisions for an awake zombie with nothing to follow, staggered by id
    cohesion: 0.05, // steering weight — guess
    alignment: 0.05, // steering weight — guess
    flockRadius: 12, // m — guess
    splinterCount: 12, // zombies within splinterRadius that switch on repulsion
    splinterRadius: 8, // m
    repulsion: 0.3, // steering weight above splinter density — guess
    // A zombie that newly sights a survivor wakes the dormant and idle dead this close,
    // sending them toward the survivor — a sleeping cluster rises as one — guess
    alertRadius: 25, // m
    // A tracked survivor who goes indoors leaves the zombie holding that door this long
    // (it is the zombies at a door that make a building's breach rolls) — guess
    besiegeTicks: 600,
    // Turned from a single bite: survivors register it at intactSight × their sight
    // radius, but never nearer than intactGiveaway (its gait gives it away) — guess
    intactSight: 0.35,
    intactGiveaway: 8, // m
    cascadeCount: 15, // zombies within cascadeRadius of a shelter: self-sustaining crowd
    cascadeRadius: 30, // m
  },

  scent: {
    buildingMinLiving: 4, // people inside before a building emits scent
    buildingRadiusBase: 20, // m
    buildingRadiusPerOccupant: 4, // m
    buildingRadiusCap: 80, // m
    clusterMinSims: 6, // sims within clusterRadius before an outdoor cluster emits scent
    clusterRadius: 15, // m
    clusterScentRadius: 20, // m
    maxWakeMultiplier: 3, // on wanderRate at the source, falling to 1 at the edge
    idleDrift: 0.2, // steering weight up the gradient for awake idle zombies — swept (was 0.02)
    fieldCell: 20, // m; scent is sampled on a grid this fine
    refreshInterval: 30, // ticks between scent field rebuilds; occupancy changes slowly
  },

  combat: {
    contactRange: 1.5, // m, for melee and zombie attacks
    armedTargetStagger: 5, // armed sims pick targets when id % 5 === tick % 5
    rangedFalloff: 0.4, // kill = base * (1 - falloff * d / range)
    darkHit: 0.5, // a shot at a target in the dark (night, no streetlight) kills at this fraction — guess
    indoorNoiseFactor: 0.5, // walls muffle
    // Firing from inside: an armed sim sheltering in an alerted building fires on the dead
    // within this many metres of one of its doors, with the ordinary ranged roll from the
    // door. Defending the door, not sniping at the street (every shot draws more) — guess
    doorDefenceRadius: 20, // m
    weaponNoiseIntensity: 1, // at origin
    ranged: {
      // range m, cooldown ticks, baseKill per roll, ammo per attack, noise m, targets per attack, arc deg
      pistol: { range: 25, cooldown: 12, baseKill: 0.55, ammoPerAttack: 1, noise: 120, targets: 1, arc: 0 },
      smg: { range: 25, cooldown: 4, baseKill: 0.3, ammoPerAttack: 3, noise: 160, targets: 1, arc: 0 },
      shotgun: { range: 10, cooldown: 18, baseKill: 0.85, ammoPerAttack: 1, noise: 200, targets: 3, arc: 45 },
      // A reservist's service rifle, drawn at an armoury and nowhere else: reaches
      // furthest, kills most surely per round, and is the loudest thing on the map — guess
      rifle: { range: 40, cooldown: 8, baseKill: 0.6, ammoPerAttack: 1, noise: 220, targets: 1, arc: 0 },
    },
    melee: {
      // cooldown ticks, baseKill, infection chance on a miss, noise m, capacity for engagement
      sledgehammer: { cooldown: 20, baseKill: 0.8, infectionOnMiss: 0.5, noise: 15, capacity: 3 },
      club: { cooldown: 10, baseKill: 0.5, infectionOnMiss: 0.3, noise: 15, capacity: 2 },
      knife: { cooldown: 6, baseKill: 0.35, infectionOnMiss: 0.4, noise: 0, capacity: 1 },
      unarmed: { cooldown: 8, baseKill: 0.1, infectionOnMiss: 0.6, noise: 0, capacity: 0 },
    },
    zombieAttack: {
      cooldown: 10, // ticks, staggered by id
      baseInfection: 0.35, // against a stationary target
      movingFactor: 0.6, // target moving away at speed
      corneredFactor: 1.4, // against a victim cornered (sims.ts cornered): no escape vector
    },
    // Outcome of a successful zombie attack by zombies in contact (index 0 = one zombie,
    // last = that many or more): chance the victim is infected and released, else fed on.
    releasedChanceByContact: [0.8, 0.55, 0.25, 0.1],
    feedingTicks: [90, 150],
    drag: { speed: 0.6, stamina: 0.8 }, // speed × 1/(1 + k·n); stamina drain × (1 + k·n)
    ammoCap: 30, // rounds
  },

  infection: {
    // Ticks from bite to conversion: long enough for a bitten survivor to get home, be let
    // in, and turn behind the barricade — the admission nobody saw. (Was 20–40: most
    // turned before they reached a door.)
    turnDelay: [300, 1200],
    rebiteFactor: 0.5, // each further bite multiplies the time left to turning by this
  },

  startingKit: {
    // Police start with a pistol and 12 rounds. Engagement capacity is
    // floor(ammo * baseKill) + meleeCapacity = floor(12 * 0.55) = 6, enough to
    // contest a typical occupation of ~5. Clearing 5 at 0.55 per shot takes ~9
    // rounds, leaving ~3: capacity floor(3 * 0.55) = 1, below any occupation. One
    // engagement turns a capable officer into an ordinary person.
    policeAmmo: 12,
    meleeShare: { civilian: 0.08, police: 0, prepper: 0.05, loner: 0.15, reckless: 0.5, reservist: 0.08 }, // guess
    meleeWeights: { knife: 3, club: 2, sledgehammer: 1 }, // guess
    recklessFirearmShare: 0.15, // reckless sims who start with a found shotgun — guess
    recklessAmmo: 6, // guess
  },

  buildings: {
    materialsCap: 60, // per building
    carryCap: 8, // per sim
    fortifyRate: 0.002, // /tick per builder
    fortifyMaterialTicks: 50, // ticks of building per material consumed
    fortificationDecay: 0.0005, // /tick when unattended
    fortificationFloor: 0.001, // decayed below this, fortification is gone
    exitTicksPerFortification: 40, // exit costs fortification * this
    // Fortification stages. Barricaded: the people inside, knowing of the outbreak, have
    // shoved furniture against the door — `barricadeTicks` after anyone last came in or
    // went out; time only, no materials; undone whenever the door opens. Reinforced and
    // fortified: fortification at or above these, which is where materials and decay
    // belong. A break-in is attempted only by a crowd at the door at least the stage's
    // `minCrowd` (open — unaware, empty, or the door just opened — admits one); within a
    // stage the odds per roll are as before. Taking the barricade down to leave adds
    // `barricadeExitTicks` — guess
    stages: {
      barricadeTicks: 60,
      reinforcedAt: 0.3,
      fortifiedAt: 0.8,
      minCrowd: { open: 1, barricaded: 2, reinforced: 4, fortified: 15 },
      barricadeExitTicks: 10,
      // Integrity is what a building can be made into, not a multiplier on the odds: at
      // or above these it can be reinforced, fortified. A glass-fronted office stops at
      // reinforced, a supermarket at barricaded, however much work goes in.
      reinforcibleFrom: 0.4,
      fortifiableFrom: 0.7,
    },
    expelPerTick: 2, // residents leaving per building per tick
    residentExpelShare: 0.3, // of remaining residents expelled by nearby gunfire — guess
    breach: {
      interval: 10, // ticks; staggered by building id
      entranceRadius: 5, // m; zombies this close to an entrance roll
      maxRolls: 4, // per building per check
      // p per roll = base / (1 + 2 * fortification): never zero. Integrity no longer scales
      // it; it caps the stage a building can reach (stages, above).
      base: 0.06, // a bare house's odds as before (0.2 × (1 - 0.7)); swept as 0.2 × (1 - integrity) earlier
      split: { turn: 0.6, die: 0.1, expel: 0.3 }, // how residents resolve after a breach — swept (reference start 0.45/0.2/0.35)
      resolvePerTick: 2, // residents resolved per building per tick
    },
    spill: {
      interval: 10, // ticks; staggered by building id
      alertRadius: 40, // m; a stimulus this close releases the occupiers
      densityRadius: 24, // m around the building for the local density check — guess
      densityThreshold: 3, // zombies; below this nearby, occupiers spill — guess
      perTick: 2, // zombies re-instantiated per tick
    },
    lootChance: 0.3, // per entry into a tag that holds anything — guess
    lootAmmo: [4, 12], // rounds in one find of ammo, or with a found firearm — guess
    // Items each building holds at the start, drawn from its tag's loot table (weights,
    // materials aside): a house has one knife block, not an endless one. What is taken
    // is gone; a weapon given up for a better one, or carried by someone who dies or
    // turns, is left where it was (systems/fighting/arms.ts) — guesses
    lootStock: { residential: 1, firearmsStore: 8, policeStation: 5, hardwareStore: 6, workshop: 3, supermarket: 2, mall: 6 } as Record<string, number>,
    pickupRadius: 2, // m: a weapon on the ground is taken by someone passing this close who is better off with it
    // Residents never get positions, but fortification is addition: up to this many
    // of an alerted building's residents work as builders alongside tracked ones — guess
    residentBuilders: 2,
    reevaluateFortificationFloor: 0.2, // shelter re-evaluated when fortification decays below — guess
  },

  // One profile per functional tag. integrity is structural soundness (scalar).
  // occupancyWeight is relative occupancy per 100 m² of footprint at peak, and
  // bandMultiplier scales it per occupancy band (night, morning, afternoon, evening).
  // Starting residents are the indoor share of the population divided across buildings
  // in proportion to occupancyWeight × footprint area × bandMultiplier, so big buildings
  // hold more people and occupancy cannot disagree with the time of day. sizes are the
  // footprint classes (map.sizeClasses) the tag may occupy. Materials are the starting
  // stock range. Loot weights are relative.
  tags: {
    residential: { integrity: 0.7, entrances: 1, sizes: ['small', 'medium'], occupancyWeight: 1.2, bandMultiplier: [1, 0.3, 0.35, 0.9], materials: [2, 6], loot: { knife: 2, club: 1, materials: 2 } },
    firearmsStore: { integrity: 0.8, entrances: 1, sizes: ['small', 'medium'], occupancyWeight: 1, bandMultiplier: [0.05, 0.8, 1, 0.5], materials: [0, 2], loot: { pistol: 3, shotgun: 2, ammo: 6 } },
    policeStation: { integrity: 0.9, entrances: 2, sizes: ['medium', 'large'], occupancyWeight: 3, bandMultiplier: [0.5, 1, 1, 0.7], materials: [2, 5], loot: { pistol: 3, smg: 1, ammo: 4 } },
    hardwareStore: { integrity: 0.7, entrances: 1, sizes: ['medium', 'large'], occupancyWeight: 1, bandMultiplier: [0.02, 0.9, 1, 0.4], materials: [20, 40], loot: { club: 2, sledgehammer: 2, knife: 1, materials: 5 } },
    workshop: { integrity: 0.7, entrances: 1, sizes: ['medium', 'large'], occupancyWeight: 1, bandMultiplier: [0.02, 1, 1, 0.2], materials: [10, 25], loot: { club: 2, sledgehammer: 1, materials: 4 } },
    warehouse: { integrity: 0.75, entrances: 2, sizes: ['large'], occupancyWeight: 0.3, bandMultiplier: [0.1, 0.8, 0.8, 0.2], materials: [30, 60], loot: { materials: 6 } },
    supermarket: { integrity: 0.35, entrances: 3, sizes: ['medium', 'large'], occupancyWeight: 2, bandMultiplier: [0.02, 0.7, 1, 0.6], materials: [8, 16], loot: { knife: 1, materials: 3 } },
    office: { integrity: 0.4, entrances: 2, sizes: ['medium', 'large'], occupancyWeight: 5, bandMultiplier: [0.02, 1, 0.9, 0.1], materials: [0, 2], loot: {} },
    school: { integrity: 0.35, entrances: 4, sizes: ['large'], occupancyWeight: 8, bandMultiplier: [0, 1, 0.8, 0.05], materials: [0, 2], loot: {} },
    hospital: { integrity: 0.4, entrances: 4, sizes: ['large'], occupancyWeight: 10, bandMultiplier: [0.9, 1, 1, 0.9], materials: [0, 2], loot: {} },
    // Placed by the generator, never drawn by weight (map.mall). Glass-fronted but big:
    // reinforcible, never fortifiable. Stock for a whole district of builders.
    mall: { integrity: 0.5, entrances: 3, sizes: ['large'], occupancyWeight: 3, bandMultiplier: [0.01, 0.8, 1, 0.7], materials: [80, 150], loot: { knife: 2, club: 2, shotgun: 1, ammo: 2, materials: 8 } },
  },
  flavourSizes: ['small', 'medium'], // footprint classes a flavour tag may occupy
  // Relative odds of each flavour tag (1 if absent), and the least footprint (m²) some
  // need. Churches are never drawn (map.churches places them): drawn by weight they all
  // fell downtown, where the big plots are — 13 on map 1, none in the suburbs.
  flavourWeights: { church: 0 } as Record<string, number>,
  flavourMinArea: {} as Record<string, number>,

  // Each flavour tag behaves exactly like one functional profile but holds nothing useful.
  flavourProfiles: {
    cafe: 'supermarket', restaurant: 'supermarket', bar: 'supermarket', barber: 'residential',
    laundrette: 'residential', bank: 'office', church: 'school', cinema: 'school', gym: 'supermarket',
    garage: 'workshop', clinic: 'hospital', pharmacy: 'supermarket', library: 'office', hotel: 'residential',
    depot: 'warehouse', nursery: 'school', dentist: 'office', bookshop: 'supermarket', salon: 'residential',
    takeaway: 'supermarket',
  },

  // Professions a building's people are drawn from, per functional tag (flavour tags use their profile's list).
  tagProfessions: {
    residential: ['retiree', 'parent', 'student', 'nightShiftWorker', 'homeless', 'longHaulDriver', 'accountant', 'offDutySoldier', 'drunk', 'homesteader', 'hamRadioOperator', 'trailGuide'],
    firearmsStore: ['retailAssistant', 'hunter', 'amateurSurvivalist', 'securityGuard', 'firearmInstructor'],
    policeStation: ['patrolOfficer', 'detective', 'receptionist', 'cleaner'],
    hardwareStore: ['retailAssistant', 'mechanic', 'caretaker', 'amateurSurvivalist', 'locksmith'],
    workshop: ['mechanic', 'courier', 'deliveryDriver', 'nightCleaner'],
    warehouse: ['deliveryDriver', 'courier', 'securityGuard', 'longHaulDriver', 'nightCleaner', 'reseller'],
    supermarket: ['retailAssistant', 'chef', 'barista', 'bartender', 'cleaner', 'bouncer', 'tourist'],
    office: ['officeWorker', 'receptionist', 'accountant', 'cleaner', 'securityGuard'],
    school: ['teacher', 'student', 'caretaker', 'librarian', 'groundskeeper'],
    hospital: ['nurse', 'paramedic', 'cleaner', 'receptionist', 'firefighter'],
    mall: ['retailAssistant', 'securityGuard', 'cleaner', 'barista', 'chef', 'parent', 'student', 'tourist', 'reseller'],
  },

  // The archetype each profession leans toward. A sim's archetype is drawn from the
  // scenario mix with this one's weight multiplied by professionBias, so labels shift
  // the odds without overriding the mix (police stay rare).
  professionArchetype: {
    officeWorker: 'civilian', retailAssistant: 'civilian', teacher: 'civilian', deliveryDriver: 'civilian',
    student: 'civilian', chef: 'civilian', cleaner: 'civilian', bartender: 'civilian', mechanic: 'civilian',
    courier: 'civilian', receptionist: 'civilian', barista: 'civilian',
    // Only cops lean police (and a cop is always police, spawn.ts): police carry pistols.
    patrolOfficer: 'police', detective: 'police', securityGuard: 'reckless', paramedic: 'civilian', firefighter: 'reckless',
    parent: 'civilian', librarian: 'civilian', accountant: 'civilian',
    nurse: 'civilian', nightShiftWorker: 'civilian', caretaker: 'civilian',
    retiree: 'prepper', firearmInstructor: 'prepper', reseller: 'prepper', trailGuide: 'prepper',
    hamRadioOperator: 'prepper', homesteader: 'prepper', locksmith: 'prepper',
    nightCleaner: 'loner', longHaulDriver: 'loner', groundskeeper: 'loner', homeless: 'loner', tourist: 'loner',
    offDutySoldier: 'reckless', hunter: 'reckless', bouncer: 'reckless', amateurSurvivalist: 'reckless', drunk: 'reckless',
  },
  professionBias: 3, // multiplier — guess

  archetypes: {
    // panicImmune: panic never gates mode. engageThreshold: approach zombies while
    // perceivedThreat is below this (0 = never engage, 1 = never fall back).
    // shelterSeekThreshold: perceivedThreat that starts shelter-seeking.
    // contestRatio: contest an occupation if capacity >= zombiesInside × ratio (null = never).
    // shelterWeights multiply the desirability weights below; loners invert groupTerm.
    // homeReach: once aware, go home if it is within this many metres (0 = never: police
    // and the reckless respond, loners keep their own counsel and pick a shelter).
    // sociality: chance, on meeting someone bound for a nearer shelter, of going with
    // them, for a sim of middling sociality (0.5); the sim's own trait scales it,
    // 2 × trait × this, up to 1 (0 = never, whatever the trait; loners) — guess
    // isolates: chance a bitten sim goes off alone to an empty building to turn, rather
    // than carrying on as if nothing happened — guess
    civilian: { isolates: 0.25, sociality: 0.8, homeReach: 1200, panicImmune: false, engageThreshold: 0, shelterSeekThreshold: 0.25, contestRatio: null, shelterWeights: { integrity: 0.5, fortification: 0.5, streetQuiet: 0.5, group: 1, materials: 0.5, distance: 3 } },
    police: { isolates: 0.6, sociality: 0, homeReach: 0, panicImmune: true, engageThreshold: 0.3, shelterSeekThreshold: 0.6, contestRatio: 1, shelterWeights: { integrity: 1.5, fortification: 1, streetQuiet: 1, group: 1, materials: 1, distance: 1 } },
    prepper: { isolates: 0.1, sociality: 0.3, homeReach: 3200, panicImmune: false, engageThreshold: 0, shelterSeekThreshold: 0.1, contestRatio: null, shelterWeights: { integrity: 1.5, fortification: 1.2, streetQuiet: 1.5, group: 1, materials: 1, distance: 1 } },
    loner: { isolates: 0.7, sociality: 0, homeReach: 0, panicImmune: false, engageThreshold: 0, shelterSeekThreshold: 0.3, contestRatio: null, shelterWeights: { integrity: 1, fortification: 1, streetQuiet: 1.2, group: -1, materials: 1, distance: 1 } },
    reckless: { isolates: 0.4, sociality: 0.3, homeReach: 0, panicImmune: false, engageThreshold: 1, shelterSeekThreshold: 0.9, contestRatio: 0.5, shelterWeights: { integrity: 0.5, fortification: 0.5, streetQuiet: 0.2, group: 1, materials: 0.5, distance: 1 } },
    // A civilian until called up (reservists, squads): the same figures throughout.
    reservist: { isolates: 0.25, sociality: 0.8, homeReach: 1200, panicImmune: false, engageThreshold: 0, shelterSeekThreshold: 0.25, contestRatio: null, shelterWeights: { integrity: 0.5, fortification: 0.5, streetQuiet: 0.5, group: 1, materials: 0.5, distance: 3 } },
  },

  shelter: {
    // Strangers at the door. In a building that knows of the outbreak, each especially
    // cautious person sheltering inside refuses a stranger at strangerVeto, ramping in
    // from caution strangerVetoFrom (none below) to the full chance at caution 1. Not a
    // stranger: someone coming home, one of the congregation at its church, an officer
    // at its station. A veto by whoever is inside, like the one on someone known to be
    // bitten: a cautious shelter is one with cautious people in it — guess
    strangerVeto: 0.5,
    strangerVetoFrom: 0.66,
    // desirability = Σ weight × term; distance term is per kilometre.
    weights: { integrity: 2, fortification: 1.5, streetQuiet: 1.2, group: 0.8, materials: 0.6, distance: 1 },
    groupPeak: 8, // believed occupants at which groupTerm peaks
    materialsScale: 20, // materials at which the materials term saturates — guess
    closePassRadius: 15, // m; passing this close writes building memory — guess
    garrisonMin: 3, // holders (residents, plus tracked sims who have made it home) for a barricaded building to count as a shelter — guess
    cascadeInterval: 10, // ticks between cascade checks on a garrison, staggered by id
  },

  migration: {
    baseDelta: 0.25, // requiredDelta = base + fortification×k + caution×k
    fortificationWeight: 0.5,
    cautionWeight: 0.3,
    cooldown: 600, // ticks
  },

  roles: {
    interval: 30, // ticks; re-evaluation cadence, staggered by id
    minTenure: 60, // ticks before a role may change — guess
    doorWatchRadius: 30, // m around each entrance the people inside can see from the door — guess
    scavengeMaxDoorThreat: 0.2, // nobody goes out for materials while the door reads busier than this — guess
    scavengeFortificationFloor: 1, // a scavenger goes out only while fortification is below this — guess
    scavengerNerve: 0.3, // added to the shelter-seek threshold while on a trip: they push on past a little danger — guess
    scavengeDistanceScale: 300, // m; a target's appeal falls as 1 / (1 + d / scale) — guess
    usefulnessCaution: 1, // "least useful" = capacity + this × caution: the incautious go out first — guess
    minStayBehind: 0, // people who must stay inside for anyone to go out — swept (1 left lone residents sitting out the run)
    sortieTicks: 300, // a dispatcher's time on the street before going back in — guess
    residentKnowledgeRadius: 250, // m; a resident who steps out knows the buildings this close — guess
  },

  promotion: {
    // Two stages. A provisional roster when half the population is gone, so the viewer
    // has names for most of the run. Then a re-score once histories have had time to
    // diverge, which tops the living cast back up to `count` with whoever is now most
    // remarkable — and keeps doing so every `topUpEvery` ticks as the pool thins, so the
    // roster always holds a current cast as well as a record of the lost. Nobody is ever
    // un-named. Each stage fires when unturned outdoors + indoors drops below its
    // fraction of the population, or at its fallback tick, whichever comes first.
    provisional: { livingFraction: 0.5, fallbackTick: 10000 },
    final: { livingFraction: 0.3, fallbackTick: 18000, topUpEvery: 1800 },
    count: 12, // living named survivors the roster aims to hold
    rosterCap: 96, // names in all; past this nobody new is named (nobody is ever un-named)
    // 'totals' scores accumulated counters as they stand; 'rates' divides the ones that
    // accumulate with exposure (conversions witnessed, near misses, kills, streets,
    // materials) by time on record, so a short eventful life can outscore a long quiet one.
    // Judged offline against 20 runs (scripts/roster-eval.ts): rates, capped, without
    // streetsVisited, nobody already bitten — the named then live as long as anyone in
    // the pool rather than shorter, and stand out for a wider spread of reasons.
    scoring: 'rates' as 'totals' | 'rates',
    rateFloor: 1800, // ticks; exposure below this counts as this much, so a newcomer's one event is not a record
    zCap: 3, // no single counter contributes more than this many standard deviations: one outlier cannot swamp the rest
    unscored: ['streetsVisited'] as string[], // tracks time on record (r = 0.9), so it counted age twice
    nameBitten: false, // false: someone already bitten is not newly named (they turned within seconds; read as a glitch)
    // History counters scored for unusualness (see promotion.ts), plus caution.
    cautionBands: [0.33, 0.66], // band edges for end-of-run survival by caution
  },

  stalemate: {
    window: 600, // ticks without a conversion
    stepInterval: 60, // ticks between promotions of dormant zombies — guess
    wakeFraction: 0.02, // of dormant zombies woken per step — guess
  },
};

export type Config = typeof config;
