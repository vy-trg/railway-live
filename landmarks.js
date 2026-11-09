// Places people look for by name rather than by stop, like "Griffith University" on Google Maps.
// Each one is anchored on a real station or stop, so its position comes from TransLink's data,
// and the planner starts from (or walks to) every stop within 800 m of it.
// This is a short hand-picked list (universities, airports), not an address search.
export const LANDMARKS = [
  { id: 'griffith-nathan', name: 'Griffith University – Nathan campus', anchor: 'place_grunbs', words: ['griffith', 'nathan', 'gu'] },
  { id: 'griffith-mt-gravatt', name: 'Griffith University – Mt Gravatt campus', anchor: '10434', words: ['griffith', 'mt gravatt', 'mount gravatt', 'gu'] },
  { id: 'griffith-gold-coast', name: 'Griffith University – Gold Coast campus (Southport)', anchor: 'place_gristn', words: ['griffith', 'gold coast', 'southport', 'gu'] },
  { id: 'griffith-logan', name: 'Griffith University – Logan campus (Meadowbrook)', anchor: '310769', words: ['griffith', 'logan', 'meadowbrook', 'gu'] },
  { id: 'griffith-south-bank', name: 'Griffith University – South Bank campus', anchor: 'place_sbasta', words: ['griffith', 'south bank', 'conservatorium', 'gu'] },
  { id: 'uq-st-lucia', name: 'University of Queensland – St Lucia campus', anchor: 'place_uqlksa', words: ['uq', 'university of queensland', 'st lucia'] },
  { id: 'qut-gardens-point', name: 'QUT – Gardens Point campus', anchor: 'place_qutuft', words: ['qut', 'queensland university of technology', 'gardens point'] },
  { id: 'qut-kelvin-grove', name: 'QUT – Kelvin Grove campus', anchor: 'place_qukgbs', words: ['qut', 'queensland university of technology', 'kelvin grove'] },
  { id: 'bne-domestic', name: 'Brisbane Airport – Domestic terminal', anchor: 'place_domsta', words: ['airport', 'brisbane airport', 'domestic', 'bne'] },
  { id: 'bne-international', name: 'Brisbane Airport – International terminal', anchor: 'place_intsta', words: ['airport', 'brisbane airport', 'international', 'bne'] },
];

export const LANDMARK_PREFIX = 'landmark:';

// Pure: give each landmark its anchor's position; landmarks whose anchor isn't in the data are dropped
export function resolveLandmarks(stationsById, list = LANDMARKS) {
  return list
    .filter((l) => stationsById.has(l.anchor))
    .map((l) => {
      const s = stationsById.get(l.anchor);
      return { id: LANDMARK_PREFIX + l.id, name: l.name, words: l.words, lat: s.lat, lng: s.lng, modes: 'place' };
    });
}

// Pure: landmarks matching what was typed. "griffith" gives every Griffith campus;
// "griffith nathan" or "nathan" gives just Nathan. Every typed word must appear in the name or a keyword.
export function matchLandmarks(landmarks, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return landmarks.filter((l) => {
    const text = `${l.name} ${l.words.join(' ')}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
