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
    case 'zombieDestroyed':
      return null;
  }
}
