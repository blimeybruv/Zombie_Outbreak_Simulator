// Ticker copy. Promoted survivors by name; anyone else is "a survivor", never a
// number. Places are streets and buildings, so a line about somewhere off-screen
// still means something.

import type { SimEvent } from '../sim/state';
import type { EventNote } from '../worker/protocol';

function who(n: EventNote): string {
  return n.name ?? (n.armed ? 'An armed survivor' : 'A survivor');
}

/** One ticker line, or null for events that never make one. */
export function line(e: SimEvent, n: EventNote): string | null {
  switch (e.type) {
    case 'simTurned':
      return n.name ? `${n.name} turned on ${n.place}.` : `A survivor turned on ${n.place}.`;
    case 'simDied':
      if (e.cause === 'mistaken') return `Rangers shot ${n.name ?? 'a survivor'} on ${n.place}, taking them for one of the dead.`;
      if (e.cause === 'shot') return `Soldiers shot ${n.name ?? 'a survivor'} trying to get around the cordon on ${n.place}.`;
      if (e.cause === 'returned') return `A soldier at the cordon on ${n.place} was shot by someone getting around it.`;
      if (!n.name) return `A survivor died on ${n.place}.`;
      return e.cause === 'breach' ? `${n.name} died when ${n.place} was overrun.` : `${n.name} was pulled down on ${n.place}.`;
    case 'cascadeCrossed':
      return `A horde is massing outside ${n.place}.`;
    case 'occupationContested':
      return `${who(n)} is fighting the dead inside ${n.place}.`;
    case 'buildingBreached':
      return `The dead broke into ${n.place}.`;
    case 'shelterFell':
      return `The shelter in ${n.place} has fallen.`;
    case 'shelterEstablished':
      return `Survivors are holding ${n.place}.`;
    case 'buildingRetaken':
      return `${who(n)} cleared the dead out of ${n.place}.`;
    case 'materialsDelivered':
      return `${who(n)} brought ${e.amount} materials back to ${n.place}.`;
    case 'weaponFound':
      return `${who(n)} found a ${e.weapon} in ${n.place}.`;
    case 'districtChanged':
      return n.name ? `${n.name} crossed into ${n.district}.` : null;
    case 'policeDispatched':
      return `${e.officers === 1 ? 'An officer is' : 'Officers are'} on the way to ${n.place}.`;
    case 'simIsolating':
      return `${n.name ?? 'A survivor'}, bitten, is going off alone to ${n.place}.`;
    case 'strangerRefused':
      return `${who(n)} was turned away from ${n.place}.`;
    case 'carAbandoned':
      return `A car was abandoned on ${n.place}.`;
    case 'carAlarm':
      return `A car alarm went off on ${n.place}.`;
    case 'cordonFiredOn':
      return e.first
        ? `${n.name ?? 'Someone'} opened fire on the soldiers on ${n.place} while getting around their barrier.`
        : `${n.name ?? 'Someone'} fired back at the soldiers shooting at them on ${n.place}.`;
    case 'vehicleTaken': {
      const what = e.kind === 'ambulance' ? 'an ambulance' : e.kind === 'cruiser' ? 'a police car' : 'a SWAT van';
      return `${n.name ?? 'Someone'} drove off in ${what} on ${n.place}${e.leaving ? ', making for the way out' : ''}. There was nobody left to drive it.`;
    }
    case 'cordonClosed':
      return `Soldiers have closed the road out on ${n.place}. Nobody is getting through.`;
    case 'rescueSweep':
      return `Army Rangers are coming into the city from ${n.place}, street by street. Anyone they find is being sent back to the road out.`;
    case 'rescueBroadcast':
      return `A radio message on every frequency: anyone still alive is to make for ${n.place}. Trucks are taking people out.`;
    case 'truckLeft':
      return e.count > 0 ? `A truck has left ${n.place} with ${e.count} aboard.` : null;
    case 'bodyRose':
      return n.name ? `${n.name}, killed on ${n.place}, has got up again.` : null;
    case 'cordonEvaded':
      return `${n.name ?? 'Someone'} got around the soldiers on ${n.place} and out of the city.`;
    case 'simLeft':
      return n.name ? `${n.name} got out of the city on ${n.place}.` : null;
    case 'ambulanceDispatched':
      return `An ambulance is on its way to ${n.place}.`;
    case 'patientAdmitted':
      return `${who(n)} was brought into ${n.place} by ambulance.`;
    case 'swatDeployed':
      return `A SWAT team is on its way to ${n.place}, where an officer counted ${e.count}.`;
    case 'policeRadio':
      return `An officer on ${n.place} is outnumbered — ${e.count} of them — and radios for SWAT.`;
    case 'districtEvacuating':
      return e.first
        ? `${n.district} is the first to leave: its people are out on the roads. The world outside will not leave the roads open long.`
        : `${n.district} is leaving: its people are out on the roads.`;
    case 'reservistsCalledUp':
      return 'The National Guard reserve has been called up. Reservists are to report to their armories.';
    case 'squadFormed':
      return `${e.members} reservists, armed at the depot on ${n.place}, have formed a squad.`;
    case 'squadEngaged':
      return `A squad has formed up to fight on ${n.place}.`;
    case 'squadDissolved':
      return e.members === 1 ? `The last of a squad stands down on ${n.place}.` : `What is left of a squad stands down on ${n.place}.`;
    case 'zombieDestroyed':
      return null;
  }
}
