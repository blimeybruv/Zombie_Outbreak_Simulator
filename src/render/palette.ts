// Colour carries state and nothing else. Agents are the brightest things on
// screen; the city sits near the noise floor beneath them.

export const BACKGROUND = '#06070a';
export const RIVER = 'rgba(70, 95, 130, 0.10)';
export const BUILDING_OUTLINE = 'rgba(150, 160, 175, 0.20)';
export const BORDER = 'rgba(150, 160, 175, 0.28)'; // the railway and the motorway's fences across the margin
export const HELD = 'rgba(205, 215, 230, 0.55)'; // a held door: barricade bars, reinforced and fortified walls
export const BUILDING_FILL = [235, 240, 245] as const; // faint white, alpha tracks who is inside
export const CONTESTED = [192, 58, 67] as const; // a faint red rim, the dead's colour: the living and the dead both inside
export const STREET = '#0d0e12'; // every street's surface, always: opaque, so crossings do not add up
export const ROAD_FILL = '#101218'; // PR #1's intended shade: above BACKGROUND (#06070a), below building outlines. Agents remain the brightest.
export const ROAD_EDGE = 'rgba(180, 190, 200, 0.15)'; // faint edge
export const CENTER_LINE = '#2a2e38'; // dashed center line on wide streets
export const STREET_LIGHT = 'rgba(255, 190, 120, 0.045)'; // night only
export const LIVING = '#dfe7ef';
export const LIVING_RGB = [223, 231, 239] as const;
/** Cars: parked (outline), driving (fill), abandoned (dark fill, crossed). */
export const CAR = 'rgba(150, 160, 175, 0.45)';
export const CAR_DRIVING = 'rgba(200, 208, 220, 0.75)';
export const CAR_ABANDONED = 'rgba(70, 72, 80, 0.9)';
/** A container on a truck's trailer, on the motorway: muted rust, a box among the cars. */
export const CONTAINER = 'rgba(160, 112, 88, 0.7)';
/** A conversation: the faint line joining the people in it. */
export const TALK = 'rgba(223, 231, 239, 0.4)';
export const PROMOTED = '#ffffff';
export const POLICE = '#8cc8ff'; // light blue; whoever carries a firearm is a triangle, whatever its colour
export const POLICE_RGB = [140, 200, 255] as const; // the same, for a 911 call's flashing ring
export const SIREN_RED = '#ff3b3b'; // a SWAT van's light bar, taking turns with blue
export const SIREN_BLUE = '#3b7bff';
export const SIREN_RED_GLOW = 'rgba(255, 59, 59, 0.28)';
export const SIREN_BLUE_GLOW = 'rgba(59, 123, 255, 0.28)';
export const AMBULANCE = '#f2f2ee'; // white
export const EXIT = '#e8c35a'; // a way off the map: amber, like a road sign
/** The rescue's tents: military canvas, an outline and ridge, filled faintly while people wait in them. */
export const TENT = 'rgba(190, 200, 160, 0.7)';
export const TENT_FILL = 'rgba(190, 200, 160, 0.18)';
export const GUARD = '#bfe8b4'; // pale green: a reservist armed at an armoury
/** A squad: the thin line from each follower to its leader (near zoom). */
export const SQUAD = 'rgba(223, 231, 239, 0.5)'; // neutral: SWAT and the Guard alike
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
/** Turned from one bite, at near zoom: the zombie red washed toward the living. */
export const ZOMBIE_INTACT = '#d49a9e';
export const CORPSE = [70, 72, 76] as const;
