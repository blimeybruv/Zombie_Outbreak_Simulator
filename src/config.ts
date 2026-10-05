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
    size: 3200, // m, square
    blockPitch: 80, // m, map default; a district kind's blockPitch overrides it
    streetWidth: { alley: 6, standard: 12, main: 20 }, // m
    spatialHashCell: 32, // m; the reference's 16 m is below every perception radius, and the per-rebuild cell scan dominated
    districtGrid: 3, // 3×3 districts of ~1067 m
    // Row-major from the top-left. Downtown centre, industrial in one corner, suburbs around.
    districtLayout: ['suburb', 'suburb', 'industrial', 'suburb', 'downtown', 'suburb', 'suburb', 'suburb', 'suburb'],
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
    dayLength: 7200, // ticks per day/night cycle; compressed, 3 cycles per run
    runLength: 36000, // ticks; the demo's one terminal condition: ten simulated hours, five day/night cycles
    sunrise: 0.25, // fraction of day (06:00)
    sunset: 0.75, // fraction of day (18:00)
    twilight: 0.04, // fraction of day over which perception interpolates (~1 h)
    // Hour boundaries of the four occupancy bands: night, morning, afternoon, evening.
    bandStartHours: [0, 6, 12, 18],
  },

  playback: {
    ticksPerSecondAt1x: 10,
    speeds: [0.25, 1, 2, 4, 8],
  },

  spawn: {
    // Share of population outdoors at tick 0, by occupancy band.
    outdoorShareByBand: [0.02, 0.12, 0.15, 0.1],
    streetSpawnWeight: { main: 3, standard: 1, alley: 0.2 }, // relative
    ageRange: [16, 85], // years
    originMinResidents: 30, // people; patient zero's building in `enclosed`, else the fullest eligible one
    originNeighbourhoodRadius: 300, // m; origins are weighted by the people living this close — guess
    multipleOriginCount: [3, 6], // sources in `multiple`
  },

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

  panic: {
    risePerEvent: 0.25, // added (clamped) per witnessed conversion or nearby noise
    decayRate: 0.004, // /tick toward 0
    encounterDamping: 0.3, // fraction of the gap closed toward the higher value per encounter
    routingCutoff: 0.55, // above: flight mode, no pathfinding, sprint
    memoryCutoff: 0.4, // above: direct mode, memory ignored, run
    expelThreshold: 0.7, // occupants above this are expelled
    noiseIntensityFloor: 0.2, // stimulus intensity at the sim needed to count as nearby noise — guess
  },

  perception: {
    dayRadius: { standard: 45, alley: 30, open: 60, bridge: 60 }, // m
    nightRadiusLit: 25, // m
    nightRadiusUnlit: 15, // m
    dormantThreatWeight: 0.25, // dormant zombies count a quarter in perceivedThreat
  },

  memory: {
    halfLife: 1800, // ticks; confidence = exp(-ln2 * age / halfLife)
    unknownStreetDanger: 0, // 0 = ignorance reads as safety; >0 = baseline pessimism (sweep both)
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
  },

  encounters: {
    radius: 4, // m
    cooldown: 30, // ticks between merges for one sim — guess (10 made merging the largest cost with crowds outdoors)
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
    staminaSpeedFloor: 0.5, // effectiveSpeed = gaitSpeed * (floor + (1-floor) * stamina) * ageFactor
    ageFactor: { atAge: [20, 80], value: [1.05, 0.75] }, // linear between, clamped outside
    concealment: 0.5, // detectability multiplier indoors, or on an unlit street at night
    slideSpeed: 0.7, // fraction of speed kept while sliding along a wall or bank
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
    dormantCheckInterval: 4, // ticks between a dormant zombie's wake checks, staggered by id
    idleCheckInterval: 3, // ticks between decisions for an awake zombie with nothing to follow, staggered by id
    cohesion: 0.05, // steering weight — guess
    alignment: 0.05, // steering weight — guess
    flockRadius: 12, // m — guess
    splinterCount: 12, // zombies within splinterRadius that switch on repulsion
    splinterRadius: 8, // m
    repulsion: 0.3, // steering weight above splinter density — guess
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
    indoorNoiseFactor: 0.5, // walls muffle
    weaponNoiseIntensity: 1, // at origin
    ranged: {
      // range m, cooldown ticks, baseKill per roll, ammo per attack, noise m, targets per attack, arc deg
      pistol: { range: 25, cooldown: 12, baseKill: 0.55, ammoPerAttack: 1, noise: 120, targets: 1, arc: 0 },
      smg: { range: 25, cooldown: 4, baseKill: 0.3, ammoPerAttack: 3, noise: 160, targets: 1, arc: 0 },
      shotgun: { range: 10, cooldown: 18, baseKill: 0.85, ammoPerAttack: 1, noise: 200, targets: 3, arc: 45 },
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
      corneredFactor: 1.4, // no escape vector
    },
    // Outcome of a successful zombie attack by zombies in contact (index 0 = one zombie,
    // last = that many or more): chance the victim is infected and released, else fed on.
    releasedChanceByContact: [0.8, 0.55, 0.25, 0.1],
    feedingTicks: [90, 150],
    drag: { speed: 0.6, stamina: 0.8 }, // speed × 1/(1 + k·n); stamina drain × (1 + k·n)
    ammoCap: 30, // rounds
  },

  infection: {
    turnDelay: [20, 40], // ticks from bite to conversion
  },

  startingKit: {
    // Police start with a pistol and 12 rounds. Engagement capacity is
    // floor(ammo * baseKill) + meleeCapacity = floor(12 * 0.55) = 6, enough to
    // contest a typical occupation of ~5. Clearing 5 at 0.55 per shot takes ~9
    // rounds, leaving ~3: capacity floor(3 * 0.55) = 1, below any occupation. One
    // engagement turns a capable officer into an ordinary person.
    policeAmmo: 12,
    meleeShare: { civilian: 0.08, police: 0, hunkerDown: 0.05, loner: 0.15, reckless: 0.5 }, // guess
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
    expelPerTick: 2, // residents leaving per building per tick
    residentExpelShare: 0.3, // of remaining residents expelled by nearby gunfire — guess
    breach: {
      interval: 10, // ticks; staggered by building id
      entranceRadius: 5, // m; zombies this close to an entrance roll
      maxRolls: 4, // per building per check
      // p per roll = base * (1 - integrity) / (1 + 2 * fortification): never zero, and a
      // fully fortified weak building (0.35) outlasts a bare strong one (0.7).
      base: 0.2, // swept (was 0.05, then 0.15 before subdivided blocks, 0.35 before the shelter economy)
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
  },
  flavourSizes: ['small', 'medium'], // footprint classes a flavour tag may occupy

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
    residential: ['retiree', 'parent', 'student', 'nightShiftWorker', 'homeless', 'longHaulDriver', 'accountant', 'offDutySoldier', 'drunk'],
    firearmsStore: ['retailAssistant', 'hunter', 'amateurSurvivalist', 'securityGuard'],
    policeStation: ['patrolOfficer', 'detective', 'receptionist', 'cleaner'],
    hardwareStore: ['retailAssistant', 'mechanic', 'caretaker', 'amateurSurvivalist'],
    workshop: ['mechanic', 'courier', 'deliveryDriver', 'nightCleaner'],
    warehouse: ['deliveryDriver', 'courier', 'securityGuard', 'longHaulDriver', 'nightCleaner'],
    supermarket: ['retailAssistant', 'chef', 'barista', 'bartender', 'cleaner', 'bouncer', 'tourist'],
    office: ['officeWorker', 'receptionist', 'accountant', 'cleaner', 'securityGuard'],
    school: ['teacher', 'student', 'caretaker', 'librarian', 'groundskeeper'],
    hospital: ['nurse', 'paramedic', 'cleaner', 'receptionist', 'firefighter'],
  },

  // The archetype each profession leans toward. A sim's archetype is drawn from the
  // scenario mix with this one's weight multiplied by professionBias, so labels shift
  // the odds without overriding the mix (police stay rare).
  professionArchetype: {
    officeWorker: 'civilian', retailAssistant: 'civilian', teacher: 'civilian', deliveryDriver: 'civilian',
    student: 'civilian', chef: 'civilian', cleaner: 'civilian', bartender: 'civilian', mechanic: 'civilian',
    courier: 'civilian', receptionist: 'civilian', barista: 'civilian',
    patrolOfficer: 'police', detective: 'police', securityGuard: 'police', paramedic: 'police', firefighter: 'police',
    retiree: 'hunkerDown', parent: 'hunkerDown', librarian: 'hunkerDown', accountant: 'hunkerDown',
    nurse: 'hunkerDown', nightShiftWorker: 'hunkerDown', caretaker: 'hunkerDown',
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
    civilian: { panicImmune: false, engageThreshold: 0, shelterSeekThreshold: 0.25, contestRatio: null, shelterWeights: { integrity: 0.5, fortification: 0.5, streetQuiet: 0.5, group: 1, materials: 0.5, distance: 3 } },
    police: { panicImmune: true, engageThreshold: 0.3, shelterSeekThreshold: 0.6, contestRatio: 1, shelterWeights: { integrity: 1.5, fortification: 1, streetQuiet: 1, group: 1, materials: 1, distance: 1 } },
    hunkerDown: { panicImmune: false, engageThreshold: 0, shelterSeekThreshold: 0.1, contestRatio: null, shelterWeights: { integrity: 1.5, fortification: 1.2, streetQuiet: 1.5, group: 1, materials: 1, distance: 1 } },
    loner: { panicImmune: false, engageThreshold: 0, shelterSeekThreshold: 0.3, contestRatio: null, shelterWeights: { integrity: 1, fortification: 1, streetQuiet: 1.2, group: -1, materials: 1, distance: 1 } },
    reckless: { panicImmune: false, engageThreshold: 1, shelterSeekThreshold: 0.9, contestRatio: 0.5, shelterWeights: { integrity: 0.5, fortification: 0.5, streetQuiet: 0.2, group: 1, materials: 0.5, distance: 1 } },
  },

  shelter: {
    // desirability = Σ weight × term; distance term is per kilometre.
    weights: { integrity: 2, fortification: 1.5, streetQuiet: 1.2, group: 0.8, materials: 0.6, distance: 1 },
    groupPeak: 8, // believed occupants at which groupTerm peaks
    materialsScale: 20, // materials at which the materials term saturates — guess
    closePassRadius: 15, // m; passing this close writes building memory — guess
    garrisonMin: 3, // holders (residents, plus tracked sims who have made it home) for an alerted, fortifying building to count as a shelter — guess
    garrisonFortification: 0.05, // fortification at which it counts — guess
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
    // has names for most of the run; a re-score once histories have had time to diverge,
    // which adds anyone who has since become remarkable. Nobody is ever un-named.
    // Each stage fires when unturned outdoors + indoors drops below its fraction of the
    // population, or at its fallback tick, whichever comes first.
    provisional: { livingFraction: 0.5, fallbackTick: 10000 },
    final: { livingFraction: 0.3, fallbackTick: 18000 },
    count: 12, // survivors named at each stage
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
