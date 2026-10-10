// Detail for the inspector: the world's ground truth about one building or one
// person, refreshed with every frame while the panel is open. The viewer knows
// more than the people do — that is the whole dramatic engine.

import { functionalProfile } from '../sim/mapgen/generate';
import type { Sim, World } from '../sim/state';
import { scoreLiving } from '../sim/systems/promotion';
import { backstory } from './backstory';
import { words } from './notes';
import type { Inspected } from './protocol';

export function inspect(w: World, target: { kind: 'sim' | 'building'; id: number }): Inspected | null {
  if (target.kind === 'building') {
    const b = w.buildings[target.id];
    if (!b) return null;
    return {
      kind: 'building',
      id: b.id,
      what: words(b.tag),
      street: w.streets[b.street]!.name,
      district: w.districts[b.district]!.name,
      integrity: w.config.tags[functionalProfile(b.tag, w.config)].integrity,
      fortification: b.fortification,
      materials: b.materials,
      breached: b.breached,
      garrisoned: b.garrisonedAt !== null,
      residents: b.residents,
      tracked: b.sheltered.map((id) => ({ id, name: w.sims[id]!.name })),
      occupiers: b.zombiesInside,
    };
  }
  const s = w.sims[target.id];
  if (!s) return null;
  const living = s.condition === 'healthy' || s.condition === 'infected';
  let story = '';
  if (living) {
    const e = scoreLiving(w).find((x) => x.sim.id === s.id);
    if (e) story = backstory(s, e.values, e.z, w.config);
  }
  const place = (id: number | null) => {
    if (id === null) return null;
    const b = w.buildings[id]!;
    return `the ${words(b.tag)} on ${w.streets[b.street]!.name}`;
  };
  return {
    kind: 'sim',
    id: s.id,
    name: s.name,
    profession: s.profession,
    age: s.age,
    archetype: s.archetype,
    caution: s.caution,
    condition: s.condition,
    bites: s.bites,
    insideBuilding: s.insideBuilding,
    weapon: s.weapon,
    ammo: s.ammo,
    materials: s.materials,
    role: s.role,
    doing: living ? doing(s) : null,
    home: place(s.home),
    shelter: place(s.shelter),
    streetsKnown: s.streetMemory.size,
    buildingsKnown: s.buildingMemory.size,
    knownInfected: s.knownInfected.size,
    backstory: story,
  };
}

/** What a living sim is doing, in words, from its intent. */
function doing(s: Sim): string | null {
  if (s.stand === 'fight') return 'standing to fight';
  if (s.stand === 'freeze') return 'frozen, hiding';
  if (s.sortieUntil !== null) return 'on a sortie';
  if (s.avoidUntil !== null) return 'backing off';
  switch (s.destinationKind) {
    case 'isolate':
      return 'going off alone to turn';
    case 'respond':
      return 'responding to trouble';
    case 'scavenge':
      return 'scavenging';
    case 'shelter':
      if (s.insideBuilding !== null) return s.shelter === s.insideBuilding ? 'sheltering' : null;
      return s.destinationBuilding !== null && s.destinationBuilding === s.home ? 'heading home' : 'heading for shelter';
    case 'routine':
      return s.awareAt === null ? 'errands, unaware' : 'patrolling';
    default:
      return null;
  }
}
