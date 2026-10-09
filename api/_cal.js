// Mo's calendar via Google's private iCal link (env CAL_ICS_URL, comma-separated
// for several calendars). Read-only, no login flow.

function zonedToUtc(y, mo, d, h, mi, s, tz) {
  // Treat the wall time as UTC, then correct by the zone's offset at that moment.
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const asTz = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return guess - (asTz - guess);
  } catch (_) { return guess; }
}

function parseDate(prop, val) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(val.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (!h) return { ms: Date.UTC(+y, +mo - 1, +d), allDay: true };
  if (z) return { ms: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) };
  const tz = (/TZID=([^;:]+)/.exec(prop) || [])[1];
  return { ms: tz ? zonedToUtc(+y, +mo, +d, +h, +mi, +s, tz) : Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) };
}

function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { ev = {}; continue; }
    if (line === 'END:VEVENT') { if (ev && ev.start) out.push(ev); ev = null; continue; }
    if (!ev) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const prop = line.slice(0, i), val = line.slice(i + 1);
    const name = prop.split(';')[0];
    if (name === 'DTSTART') ev.start = parseDate(prop, val);
    else if (name === 'DTEND') ev.end = parseDate(prop, val);
    else if (name === 'SUMMARY') ev.title = val.replace(/\\([,;\\])/g, '$1').replace(/\\n/g, ' ');
    else if (name === 'STATUS') ev.status = val;
    else if (name === 'RRULE') ev.recurring = true;
  }
  return out.filter((e) => e.status !== 'CANCELLED');
}

const offMin = (off) => {
  const m = /^([+-])(\d\d):(\d\d)$/.exec(off || '');
  return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
};
const hhmm = (ms, off) => new Date(ms + offMin(off) * 6e4).toISOString().slice(11, 16);

// Events in Mo's "day": local 5am today to 5am tomorrow (his calls run late).
export async function calendarToday(tzOffset) {
  const urls = String(process.env.CAL_ICS_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!urls.length) return null;
  const texts = await Promise.all(urls.map((u) => fetch(u).then((r) => (r.ok ? r.text() : '')).catch(() => '')));
  const now = Date.now(), om = offMin(tzOffset) * 6e4;
  const localNow = new Date(now + om);
  let dayStart = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), 5) - om;
  if (now < dayStart) dayStart -= 864e5;
  const dayEnd = dayStart + 864e5;
  const events = texts.flatMap(parseIcs)
    .filter((e) => !e.start.allDay && e.start.ms >= dayStart && e.start.ms < dayEnd)
    .sort((a, b) => a.start.ms - b.start.ms)
    .map((e) => ({
      title: e.title || 'Busy', start: hhmm(e.start.ms, tzOffset), end: e.end ? hhmm(e.end.ms, tzOffset) : null,
      start_iso: new Date(e.start.ms).toISOString(), past: (e.end ? e.end.ms : e.start.ms + 18e5) < now
    }));
  const next = events.find((e) => !e.past) || null;
  return { events, next };
}
