// When does the list unlock for the recipients? 06:00 the morning after the
// event date, in the venue's timezone. Computed here, on the server, from the
// stored date and zone. Never from a browser clock.

const UNLOCK_HOUR = 6;

const ZONES = new Set(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []);

function isValidZone(tz) {
  if (ZONES.size) return ZONES.has(tz);
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const d = new Date(s + "T00:00:00Z");
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

// Offset (ms) of `tz` from UTC at instant `utcMs`.
function offsetAt(tz, utcMs) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - utcMs;
}

// The instant of local `hour`:00 on the day after `dateISO` in `tz`.
function unlockAt(dateISO, tz, hour = UNLOCK_HOUR) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d + 1, hour, 0, 0); // treat the wall-clock time as if it were UTC
  let guess = wall - offsetAt(tz, wall);              // then correct by the zone's offset
  guess = wall - offsetAt(tz, guess);                 // twice, in case the first guess straddled a DST change
  return new Date(guess);
}

function isUnlocked(event, now = Date.now()) {
  return now >= unlockAt(event.date, event.timezone).getTime();
}

// "6am, 22 November 2026 — Central time"
function describeUnlock(dateISO, tz) {
  const at = unlockAt(dateISO, tz);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "long", year: "numeric" }).format(at);
  const zoneName = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "long" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value || tz;
  const short = zoneName.replace(/ (Standard|Daylight) Time$/, " time");
  return `${UNLOCK_HOUR}am, ${day} — ${short}`;
}

module.exports = { UNLOCK_HOUR, isValidZone, isValidDate, unlockAt, isUnlocked, describeUnlock };
