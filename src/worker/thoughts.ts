// Thoughts for the inspector: what a person believes, in their own words. Each is a
// sentence form filled from a field the sim really holds: its intent, its memory of
// the streets ahead, its own state of mind and body, what it was told. Never a pool
// of flavour lines, and never the world's truth: a thought reads only this sim's own
// fields, so a sim can think a street is quiet while the map shows the dead on it.
// That gap between belief and world is the point of the panel.
//
// The one exception is the sim's own body: the bitten know they were bitten.

import { confidence } from '../sim/derived';
import type { Sim, World } from '../sim/state';
import { modeOf } from '../sim/systems/panic';
import { words } from './notes';

/** At most this many, most pressing first. */
const MAX = 4;
/** Believed danger (after ageing) above which a street ahead is "bad". */
const BAD = 0.3;
/** A street believed quiet if seen this recently (ticks) with no danger. */
const QUIET_WITHIN = 1800;

/** How long ago, on the viewer's clock (a day every time.dayLength ticks). */
function ago(w: World, ticks: number): string {
  const minutes = Math.round((ticks * 86400) / w.config.time.dayLength / 60);
  if (minutes < 10) return 'just now';
  if (minutes < 50) return `${Math.round(minutes / 5) * 5} minutes ago`;
  if (minutes < 90) return 'an hour ago';
  if (minutes < 60 * 20) return `${Math.round(minutes / 60)} hours ago`;
  return minutes < 60 * 36 ? 'yesterday' : `${Math.round(minutes / 1440)} days ago`;
}

function place(w: World, id: number | null): string | null {
  if (id === null) return null;
  const b = w.buildings[id]!;
  return `the ${words(b.tag)} on ${w.streets[b.street]!.name}`;
}

/** What it believes of the streets ahead on its route: the first that stands out. */
function ahead(w: World, s: Sim): string | null {
  const { config, tick } = w;
  const next = s.route.slice(s.routeIndex + 1, s.routeIndex + 4);
  for (const id of next) {
    const name = w.streets[id]!.name;
    const b = s.streetMemory.get(id);
    if (b) {
      const age = tick - b.observedAt;
      if (b.danger * confidence(b.observedAt, tick, config) >= BAD) return `${name} was bad ${ago(w, age)}.`;
      if (b.danger === 0 && age <= QUIET_WITHIN) return `${name} was quiet ${ago(w, age)}.`;
    } else if (s.caution >= config.promotion.cautionBands[1]! && s.awareAt !== null) {
      return `Don't know ${name}. Don't like that.`;
    }
  }
  return null;
}

/** Where it is going, and why, as it would put it. */
function intent(w: World, s: Sim): string | null {
  const to = place(w, s.destinationBuilding);
  switch (s.destinationKind) {
    case 'leave': {
      if (s.answeredAt !== null && w.rescueExit !== null) return `The radio said ${w.streets[w.exits[w.rescueExit]!.street]!.name}. Have to get there.`;
      return 'Getting out of the city.';
    }
    case 'car':
      return 'If I can get to that car…';
    case 'isolate':
      return to ? `Going to ${to}. Nobody will be there.` : 'Somewhere nobody will be.';
    case 'respond':
      return to ? `Call at ${to}.` : 'Answering a call.';
    case 'scavenge':
      return to ? `Maybe there's something at ${to}.` : 'We need materials.';
    case 'shelter':
      if (s.insideBuilding !== null) return null;
      if (s.destinationBuilding !== null && s.destinationBuilding === s.home) return 'Home. Just get home.';
      return to ? `Heading for ${to}.` : 'Need somewhere to hide.';
    case 'routine':
      return to ? `Errand at ${to}.` : null;
    default:
      return null;
  }
}

export function thoughts(w: World, s: Sim): string[] {
  const out: string[] = [];
  const say = (t: string | null) => {
    if (t !== null && out.length < MAX && !out.includes(t)) out.push(t);
  };
  if (s.condition !== 'healthy' && s.condition !== 'infected') return out;
  if (s.sweep) return ['Clear it street by street. Send them back.'];
  if (s.outsider) return ['Nobody gets past the barrier.'];

  // The body and the moment, first.
  if (s.stand === 'freeze') say("Don't move. Don't breathe.");
  if (s.stand === 'fight') say('Nowhere left to run.');
  const mode = modeOf(s, w.config);
  if (s.insideBuilding === null && s.car === null && s.stand === null) {
    if (mode === 'flight') say("Can't think straight. Just away.");
    else if (mode === 'direct') say('Fastest way. No time to think about it.');
    if (s.avoidUntil !== null) say('Not that way.');
    if (s.stamina < 0.2) say("Can't run much further.");
  }
  if (s.condition === 'infected') {
    if (s.infectedChoice === 'isolate') say("I've been bitten. Better nobody's near when it happens.");
    else if (s.infectedChoice === 'conceal') say('Something bit me. Nobody needs to know.');
    else say('Something bit me.');
  }

  // Not yet aware of the outbreak: only unease, and the day going on.
  if (s.awareAt === null) {
    if (s.unease >= 0.2) say("Something's off today.");
    say(intent(w, s));
    return out;
  }

  // The radio, believed or not.
  const rc = w.config.rescue;
  if (w.rescueExit !== null && w.tick >= rc.at + rc.broadcast && s.answeredAt === null && s.trust < rc.trustFloor) say("Heard the radio. Don't believe a word of it.");

  say(intent(w, s));
  if (s.insideBuilding === null) say(ahead(w, s));

  // Inside: who it knows to be bitten among those sheltering with it.
  if (s.insideBuilding !== null) {
    const b = w.buildings[s.insideBuilding]!;
    if (b.sheltered.some((id) => id !== s.id && s.knownInfected.has(id))) say("Someone in here's been bitten.");
    if (s.role === 'builder') say('Need to shore up that door.');
    else if (s.role === 'scavenger') say("We're running out. Someone has to go out.");
    else if (s.role === 'dispatcher') say("Someone has to keep them off the door.");
    else if (s.insideBuilding === s.home) say('At least I made it home.');
  }
  if (s.gathering !== null) say('Comparing notes.');
  // Unarmed, and afraid: only then does it wish it were not.
  if (s.weapon === null && s.insideBuilding === null && mode !== 'informed') say('Wish I had something to fight with.');
  return out;
}
