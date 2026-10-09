// Colour carries state and nothing else. Agents are the brightest things on
// screen; the city sits near the noise floor beneath them.

export const BACKGROUND = '#06070a';
export const RIVER = 'rgba(70, 95, 130, 0.10)';
export const BUILDING_OUTLINE = 'rgba(150, 160, 175, 0.20)';
export const HELD = 'rgba(205, 215, 230, 0.55)'; // a held door: barricade bars, reinforced and fortified walls
export const BUILDING_FILL = [235, 240, 245] as const; // faint white, alpha tracks who is inside
export const CONTESTED = [255, 255, 255] as const; // pulsing outline
export const STREET_LIGHT = 'rgba(255, 190, 120, 0.045)'; // night only
export const LIVING = '#dfe7ef';
export const LIVING_RGB = [223, 231, 239] as const;
export const PROMOTED = '#ffffff';
export const POLICE = '#8cc8ff'; // light blue; whoever carries a firearm is a triangle, whatever its colour
export const POLICE_RGB = [140, 200, 255] as const; // the same, for a 911 call's flashing ring
export const INFECTED = '#e2a03f'; // amber: bitten, not yet turned — near zoom only
export const INFECTED_PALE = '#e9cf9c';
export const FIGHT = '#fff1b8'; // a bright warm outline: standing and fighting
export const SHOUT = [235, 240, 245] as const; // a warning shouted: a ring the size of earshot
export const FLASH = [255, 228, 170] as const; // a shot
export const SELECTION = 'rgba(255, 255, 255, 0.75)';
export const LABEL = 'rgba(235, 240, 245, 0.8)';
export const ZOMBIE = '#c03a43';
export const ZOMBIE_RGB = [192, 58, 67] as const;
export const ZOMBIE_DORMANT = '#6a2328';
export const CORPSE = [70, 72, 76] as const;
