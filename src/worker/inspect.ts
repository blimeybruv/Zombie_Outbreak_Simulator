// Detail for the inspector: the world's ground truth about one building or one
// person, refreshed with every frame while the panel is open. The viewer knows
// more than the people do — that is the whole dramatic engine.

import { functionalProfile } from '../sim/mapgen/generate';
import type { Sim, World } from '../sim/state';
import { scoreLiving } from '../sim/systems/story/promotion';
import { backstory, callingOf } from './backstory';
import { endingOf } from './endings';
import { thoughts } from './thoughts';
import { words } from './notes';
import type { Inspected, SimDetail } from './protocol';

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
      tracked: b.sheltered.map((id) => {
        const t = w.sims[id]!;
        // The map's rule (sim-worker.ts flags): police by archetype, anyone with a rifle pale green.
        return { id, name: t.name, kind: t.archetype === 'police' ? ('police' as const) : t.weapon === 'rifle' ? ('guard' as const) : null };
      }),
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
    profession: callingOf(s),
    age: s.age,
    archetype: s.sweep ? 'Army Ranger' : s.outsider ? 'soldier' : s.checkpoint !== null ? 'traffic police' : s.archetype, // those from outside are not reservists of the city
    caution: s.caution,
    sociality: s.sociality,
    trust: s.trust,
    nerve: s.nerve,
    unease: s.unease,
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
    thoughts: living ? thoughts(w, s) : [],
    knownBitten: knownBitten(w, s),
    ending: ending(w, s.id),
    kills: s.history.kills,
  };
}

/** Ticks as hours on the viewer's clock (a day every time.dayLength ticks). */
function hours(w: World, ticks: number): number {
  return (ticks * 24) / w.config.time.dayLength;
}

function ending(w: World, id: number): SimDetail['ending'] {
  const e = endingOf(id);
  if (!e) return null;
  return { how: e.how, place: e.place, hoursIn: hours(w, e.tick), roseAfter: e.roseAt === null ? null : hours(w, e.roseAt - e.tick) };
}

function knownBitten(w: World, s: Sim): SimDetail['knownBitten'] {
  const names: string[] = [];
  for (const id of [...s.knownInfected].sort((a, b) => a - b)) {
    const n = w.sims[id]!.name;
    if (n !== null && names.length < 3) names.push(n);
  }
  return { names, count: s.knownInfected.size };
}

/** What a living sim is doing, in words, from its intent. */
function doing(s: Sim): string | null {
  if (s.stand === 'fight') return 'standing to fight';
  if (s.stand === 'freeze') return 'frozen, hiding';
  if (s.sortieUntil !== null) return 'on a sortie';
  if (s.avoidUntil !== null) return 'backing off';
  if (s.gathering !== null) return 'stopped to talk';
  if (s.car !== null) return 'in a car';
  if (s.sweep) return s.squadLeader === s.id ? 'Army Ranger, leading a squad up the corridor' : 'Army Ranger, sweeping the corridor';
  if (s.outsider) return 'soldier, holding the cordon';
  if (s.checkpoint !== null) return s.post !== null ? 'manning a checkpoint, turning people back' : s.insideBuilding !== null ? 'waiting at the station for orders' : 'on the way to set up a checkpoint';
  if (s.squadLeader === s.id) return s.diamondUntil !== null ? 'leading a squad, engaged' : 'leading a squad';
  if (s.squadLeader !== null) return s.directUntil !== null ? 'catching up with its squad' : 'in a squad';
  if (s.muster === 'mobilised') return 'called up, making for the armory';
  if (s.muster === 'waiting') return 'armed, waiting at the armory for a squad';
  if (s.destinationKind === 'car') return 'going for a car';
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
      if (s.awareAt !== null) return 'patrolling';
      return s.unease >= 0.2 ? 'errands, uneasy' : 'errands, unaware';
    default:
      return null;
  }
}
