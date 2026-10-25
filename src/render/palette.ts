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
// Road hierarchy — still near the noise floor; agents remain brightest.
// Fills are spaced around the existing #101218, not around the lighter #1a1d26.
export const ROAD_FILL_MAIN = '#12151a'; // wide streets: two or three levels above the standard
export const ROAD_FILL = '#101218'; // the standard carriageway, over the street surface
export const ROAD_FILL_ALLEY = '#0a0b0e'; // narrow alleys: several levels below the standard
export const ROAD_EDGE_MAIN = '#3e4450'; // a stronger kerb on wide streets
export const ROAD_EDGE = 'rgba(180, 190, 200, 0.15)'; // the standard kerb, where the road meets the ground
export const ROAD_EDGE_ALLEY = '#1e2228'; // a faint kerb on alleys
export const CENTER_LINE = '#2a2e38'; // a wide road's dashed centre line, near zoom only
export const STREET_LABEL = 'rgba(190, 200, 210, 0.55)'; // street name labels at mid/near zoom — dim so agents stay brightest
export const STREET_LIGHT = 'rgba(255, 190, 120, 0.10)'; // far zoom only: a faint warm stroke on lit streets
export const LAMP_GLOW_CORE = 'rgba(255, 214, 150, 0.22)'; // warm centre of the stamped glow, near zoom only, still darker than an agent dot
export const LAMP_GLOW_MID = 'rgba(255, 196, 130, 0.15)'; // the long falloff, at 22% of the radius; also the mid-zoom centre
export const LAMP_GLOW_EDGE = 'rgba(255, 180, 110, 0)'; // fades to nothing
export const LAMP_HEAD = 'rgba(255, 210, 140, 0.22)'; // the head at near zoom, no brighter than the glow's centre
export const LIVING = '#dfe7ef';
export const LIVING_RGB = [223, 231, 239] as const;
/** A plain rectangle's stroke: an abandoned wreck, and any car still drawn as a box. */
export const CAR = 'rgba(150, 160, 175, 0.45)';
/** Motorway scenery, and a plain rectangle while it is being driven. */
export const CAR_DRIVING = 'rgba(200, 208, 220, 0.75)';
/** Abandoned: a dark fill, then crossed. Ordinary cars wear this instead of their plan. */
export const CAR_ABANDONED = 'rgba(70, 72, 80, 0.9)';
/** A container on a truck's trailer, on the motorway: muted rust, a box among the cars. */
export const CONTAINER = 'rgba(160, 112, 88, 0.7)';
/** A conversation: the faint line joining the people in it. */
export const TALK = 'rgba(223, 231, 239, 0.4)';
export const PROMOTED = '#ffffff';
export const POLICE = '#8cc8ff'; // light blue; whoever carries a firearm is a triangle, whatever its colour
export const POLICE_RGB = [140, 200, 255] as const; // the same, for a 911 call's flashing ring
/** Police stations: the officers' blue, held back so the building stays quieter than the dot. */
export const STATION_OUTLINE = 'rgba(140, 200, 255, 0.55)';
export const STATION_FILL = 'rgba(140, 200, 255, 0.13)';
export const SIREN_RED = '#ff3b3b'; // a SWAT van's light bar, taking turns with blue
export const SIREN_BLUE = '#3b7bff';
export const SIREN_RED_GLOW = 'rgba(255, 59, 59, 0.28)';
export const SIREN_BLUE_GLOW = 'rgba(59, 123, 255, 0.28)';
export const AMBULANCE = '#f2f2ee'; // white
/** An ambulance's bonnet and roofs: a step under the white hull, and under a living dot. */
export const AMBULANCE_PANEL = '#d4d5cf';
/** Windscreen, rear doors and the cab light bar. */
export const AMBULANCE_SHADE = '#8e9088';
/** The cross on the box roof: a quiet red, not the siren. */
export const AMBULANCE_MARK = '#c45656';
export const EXIT = '#e8c35a'; // a way off the map: amber, like a road sign
/** The rescue's tents: military canvas, an outline and ridge, filled faintly while people wait in them. */
export const TENT = 'rgba(190, 200, 160, 0.7)';
export const TENT_FILL = 'rgba(190, 200, 160, 0.18)';
/** The gate in the rescue's barrier: two short black marks across the blue line. */
export const GATE = '#0b0b0b';
/** A fallen police checkpoint's sawhorses: grey, abandoned. */
export const CHECKPOINT_FALLEN = 'rgba(140, 150, 160, 0.5)';
export const GUARD = '#bfe8b4'; // pale green: a reservist armed at an armoury
/** Depots: the same pale green as a reservist. The outline is that colour; the fill is a faint wash of it. */
export const DEPOT_OUTLINE = GUARD;
export const DEPOT_FILL = 'rgba(191, 232, 180, 0.16)';
/** A reservists' HMMWV: hull in their green, a lighter bonnet and roof, a darker windscreen, cargo well and spare. */
export const HMMWV_PANEL = '#dcf3d4';
export const HMMWV_SHADE = '#5e8a58';
/**
 * Ordinary cars, in plan: hull, a lighter bonnet and roof, darker glass.
 * Muted, and each panel stays under a living dot. No greens or blues:
 * those belong to the reservists' HMMWVs and the police. Which one a car wears is
 * chosen in the renderer from its id.
 */
export const CIVILIAN = [
  { body: '#9aa3ae', panel: '#c5ced6', shade: '#343a42' }, // silver
  { body: '#8c6e70', panel: '#b29698', shade: '#3a2e30' }, // maroon
  { body: '#887a86', panel: '#aea2ac', shade: '#363038' }, // plum
  { body: '#a08880', panel: '#c4b0a8', shade: '#3e342f' }, // clay
  { body: '#a09480', panel: '#c4b8a4', shade: '#3e382e' }, // sand
  { body: '#6e7882', panel: '#98a2ac', shade: '#2a3036' }, // charcoal
] as const;

/** A police cruiser's bonnet and roof: lighter than the hull, still under a living dot. */
export const CRUISER_PANEL = '#b4d9ff';
/** Windscreen, rear glass and the roof light bar, held well under the hull. */
export const CRUISER_SHADE = '#3d6ea6';
/** A SWAT van's cab and box: the same police blue, a step darker, under a living dot. */
export const SWAT_PANEL = '#5f94c4';
/** Windscreen, rear doors, roof rib and the cab light bar. */
export const SWAT_SHADE = '#2f5274';
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
