/**
 * Google resets Gemini's per-day request quota at midnight Pacific time (rate-limits page, 2026-10-16). When the API
 * says the daily quota is used up, AI stays paused until then. Uses the platform's time-zone database, so daylight-saving
 * changes are handled; works in Node, browsers and Workers.
 */
const PACIFIC = 'America/Los_Angeles';
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });

function msSinceLocalMidnight(t: number): number {
  const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return (Number(p['hour']) * 3600 + Number(p['minute']) * 60 + Number(p['second'])) * 1000 + (t % 1000 + 1000) % 1000;
}

/** The first instant strictly after `t` at which the Pacific clock reads 00:00:00. */
export function nextPacificMidnight(t: number): number {
  if (!Number.isFinite(t)) throw new RangeError('not a time');
  const day = 86_400_000;
  // Start from "t plus the rest of this local day" and correct for a 23- or 25-hour day.
  let candidate = t + (day - msSinceLocalMidnight(t));
  for (let i = 0; i < 4; i++) {
    const since = msSinceLocalMidnight(candidate);
    if (since === 0) return candidate;
    // Just before midnight (after a 25-hour day) or just after it (after a 23-hour day).
    candidate += since < day / 2 ? -since : day - since;
  }
  throw new RangeError('could not find the next Pacific midnight');
}
