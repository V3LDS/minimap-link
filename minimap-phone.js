// Phone side of the bike minimap: GPS and OpenStreetMap roads to the board over Bluetooth LE.
// Pure helpers are exported for tests (node); the page wires them to the browser.
const KINDS = {
  trunk: 0, trunk_link: 0, primary: 0, primary_link: 0, secondary: 0, secondary_link: 0,
  tertiary: 1, tertiary_link: 1, unclassified: 1,
  residential: 2, living_street: 2,
  cycleway: 3,
  path: 4, track: 4, bridleway: 4, pedestrian: 4,
};
const WATER = 5;
// when the board is full, nearer roads win; a kind's penalty (metres) pushes it back: streets and paths go first
const PENALTY = {0: 0, 1: 0, 3: 0, 5: 200, 2: 400, 4: 900};

function overpassQuery(lat, lon, radius) {
  const hw = Object.keys(KINDS).join('|');
  return `[out:json][timeout:25];(way["highway"~"^(${hw})$"](around:${radius},${lat},${lon});way["natural"="water"](around:${radius},${lat},${lon}););out geom tags;`;
}

// metres east/north of (lat0, lon0): the same formula as the firmware's local_m()
function project(lat0, lon0) {
  const R = 6371000, D = Math.PI / 180, c = Math.cos(lat0 * D);
  return (lat, lon) => [(lon - lon0) * D * R * c, (lat - lat0) * D * R];
}

function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / L;
      if (d > bd) { bd = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// join pieces of one road (same kind and name, end to end): OSM splits roads at every junction
function joinWays(ways) {
  const key = (p) => p[0] + ',' + p[1];
  const groups = new Map();
  for (const w of ways) { const g = w.kind + '|' + w.name; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(w); }
  const out = [];
  for (const list of groups.values()) {
    const byEnd = new Map(), used = new Set();
    list.forEach((w, i) => { for (const p of [w.pts[0], w.pts[w.pts.length - 1]]) { const k = key(p); if (!byEnd.has(k)) byEnd.set(k, []); byEnd.get(k).push(i); } });
    list.forEach((w, i) => {
      if (used.has(i)) return;
      used.add(i);
      let pts = w.pts.slice();
      for (let grew = true; grew && pts.length < 400;) {
        grew = false;
        for (const atEnd of [true, false]) {
          const end = atEnd ? pts[pts.length - 1] : pts[0];
          const j = (byEnd.get(key(end)) || []).find(j => !used.has(j));
          if (j === undefined) continue;
          used.add(j); grew = true;
          let q = list[j].pts.slice();
          if (atEnd) { if (key(q[0]) !== key(end)) q.reverse(); pts = pts.concat(q.slice(1)); }
          else { if (key(q[q.length - 1]) !== key(end)) q.reverse(); pts = q.concat(pts.slice(1)); }
        }
      }
      out.push({kind: w.kind, name: w.name, pts, d: Math.min(...pts.map(([x, y]) => Math.hypot(x, y)))});
    });
  }
  return out;
}

// OSM JSON -> ways in board units, trimmed to what the board can hold
function buildMap(osm, lat0, lon0, room = {points: 5000, ways: 1600}) {
  const proj = project(lat0, lon0);
  let ways = [];
  for (const el of osm.elements || []) {
    if (el.type !== 'way' || !el.geometry) continue;
    const t = el.tags || {};
    const kind = t.natural === 'water' ? WATER : KINDS[t.highway];
    if (kind === undefined) continue;
    const pts = el.geometry.map(g => proj(g.lat, g.lon)).map(([x, y]) => [Math.round(x), Math.round(y)]);
    if (pts.length >= 2) ways.push({kind, name: kind === WATER ? '' : (t.name || '').slice(0, 24), pts});
  }
  const total = ways.length;
  ways = joinWays(ways).map(w => ({...w, pts: simplify(w.pts, 2.5)})).filter(w => w.pts.length >= 2);
  ways.sort((a, b) => (a.d + PENALTY[a.kind]) - (b.d + PENALTY[b.kind]));
  const out = []; let points = 0;
  for (const w of ways) {
    if (out.length >= room.ways || points + w.pts.length > room.points) continue;
    out.push(w); points += w.pts.length;
  }
  const reach = out.length ? Math.max(...out.map(w => w.d)) : 0;
  return {ways: out, points, dropped: ways.length - out.length, total, joined: ways.length, reach};
}

// the text lines the firmware reads: MAP, N, W (split at 40 points, sharing the joint), MAPEND
function mapLines(map, lat0, lon0) {
  const lines = [`MAP ${lat0.toFixed(6)} ${lon0.toFixed(6)}`];
  const names = new Map();
  for (const w of map.ways) if (w.name && !names.has(w.name) && names.size < 399) { names.set(w.name, names.size + 1); lines.push(`N ${names.size} ${w.name}`); }
  for (const w of map.ways) {
    const ni = names.get(w.name) || 0;
    for (let i = 0; i < w.pts.length - 1; i += 39) {
      const part = w.pts.slice(i, i + 40);
      lines.push(`W ${w.kind} ${ni} ` + part.map(([x, y]) => `${x},${y}`).join(' '));
    }
  }
  lines.push('MAPEND');
  return lines;
}

// public Overpass servers, tried in order: the main one is often busy
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter',
                  'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

// onBytes(received): called as the download streams in (servers rarely say the total size up front)
async function fetchRoads(lat, lon, radius, log = () => {}, onBytes = () => {}) {
  const body = 'data=' + encodeURIComponent(overpassQuery(lat, lon, radius));
  let last = '';
  for (const url of OVERPASS) {
    try {
      // a server that has not started answering in 15 s is busy: move on. Once it answers, let the download run.
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(url, {method: 'POST', body, signal: ctl.signal, headers: {'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json'}});
      clearTimeout(timer);
      let text = '';
      if (r.body && r.body.getReader) {
        const reader = r.body.getReader(), dec = new TextDecoder();
        let got = 0;
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          got += value.length; text += dec.decode(value, {stream: true}); onBytes(got);
        }
        text += dec.decode();
      } else text = await r.text();
      if (r.ok && text.trim().startsWith('{')) return JSON.parse(text);
      last = `${new URL(url).host}: ${r.status}`;
    } catch (e) { last = `${new URL(url).host}: ${e.name === 'AbortError' ? 'timed out' : e.message}`; }
    log(`map server busy (${last}), trying the next one`);
  }
  throw new Error('no map server answered (' + last + ')');
}

function distance(lat1, lon1, lat2, lon2) {
  const [x, y] = project(lat1, lon1)(lat2, lon2);
  return Math.hypot(x, y);
}

if (typeof module !== 'undefined') module.exports = {fetchRoads, overpassQuery, project, simplify, buildMap, mapLines, distance, KINDS};
