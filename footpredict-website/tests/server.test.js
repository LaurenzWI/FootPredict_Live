const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../server');

function event(id, date, home, away, homeScore, awayScore, state = 'post') {
  return {
    id: String(id), date,
    competitions: [{ competitors: [
      { homeAway: 'home', team: { id: String(home), displayName: 'Home ' + home }, score: homeScore },
      { homeAway: 'away', team: { id: String(away), displayName: 'Away ' + away }, score: awayScore }
    ], status: { type: { state, completed: state === 'post' }, displayClock: '' } }]
  };
}
const past = [
  event(1, '2026-09-01T18:00:00Z', 1, 5, 2, 0),
  event(2, '2026-09-08T18:00:00Z', 1, 6, 0, 1),
  event(3, '2026-09-15T18:00:00Z', 1, 7, 4, 0),
  event(4, '2026-09-01T19:00:00Z', 2, 8, 2, 0),
  event(5, '2026-09-08T19:00:00Z', 2, 9, 2, 1),
  event(6, '2026-09-15T19:00:00Z', 2, 10, 2, 1)
];
const today = event(11, '2026-10-08T18:00:00Z', 1, 2, null, null, 'pre');
const requests = [];

// Den am 18.09.2026 entfernten ESPN-Datumsbereich bewusst mit HTTP 400 ablehnen.
const incoming = async url => {
  const month = new URL(url).searchParams.get('dates');
  requests.push(month);
  if (!/^\d{6}$/.test(month)) return new Response('Date ranges removed', { status: 400 });
  return new Response(JSON.stringify({ events: month === '202610' ? [today] : month === '202609' ? past : [] }), {
    status: 200, headers: { 'content-type': 'application/json' }
  });
};
async function withServer(handler, fn, date = '2026-10-08T12:00:00Z') {
  const server = createApp({ fetch: handler, now: () => new Date(date) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('website serves HTML, CSS, JS and refuses unknown paths', async () => withServer(incoming, async base => {
  for (const route of ['/', '/index.html', '/style.css', '/app.js']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200, route);
    assert.ok((await response.text()).length > 20, route);
  }
  assert.equal((await fetch(base + '/.env')).status, 404);
}));

test('old ESPN date ranges are never sent; monthly fixtures and forecasts work', async () => {
  requests.length = 0;
  await withServer(incoming, async base => {
    const response = await fetch(base + '/api/matches?league=ger.1&days=0&day=2026-10-08&tz=Europe/Vienna');
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.matches.length, 1);
    assert.equal(data.matches[0].state, 'scheduled');
    assert.equal(data.matches[0].prediction.available, true);
    const p = data.matches[0].prediction;
    assert.ok(Math.abs(p.home + p.draw + p.away - 100) < 0.001);
  });
  assert.deepEqual(requests, ['202606', '202607', '202608', '202609', '202610']);
});

test('today view excludes yesterday and fixtures outside the local calendar day', async () => withServer(async url => {
  const old = event(12, '2026-10-07T12:00:00Z', 3, 4, 2, 1);
  const future = event(13, '2026-10-09T10:00:00Z', 1, 2, null, null, 'pre');
  const month = new URL(url).searchParams.get('dates');
  if (!/^\d{6}$/.test(month)) return new Response('invalid', { status: 400 });
  return new Response(JSON.stringify({ events: month === '202610' ? [old, today, future] : month === '202609' ? past : [] }), { status: 200 });
}, async base => {
  const result = await (await fetch(base + '/api/matches?league=ger.1&days=0&day=2026-10-08&tz=Europe/Vienna')).json();
  assert.deepEqual(result.matches.map(x => x.id), ['11']);
}));

test('view across October/November loads future month and older form data', async () => withServer(async url => {
  const month = new URL(url).searchParams.get('dates');
  assert.match(month, /^\d{6}$/);
  const next = event(21, '2026-11-03T20:00:00Z', 1, 2, null, null, 'pre');
  const games = month === '202611' ? [next] : month === '202609' ? past : [];
  return new Response(JSON.stringify({ events: games }), {status: 200});
}, async base => {
  const response = await fetch(base + '/api/matches?league=ger.1&days=7');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(result.matches.map(x => x.id), ['21']);
  assert.equal(result.matches[0].prediction.available, true);
}, '2026-10-31T12:00:00Z'));

test('monthly requests are cached between page refreshes', async () => {
  let calls = 0;
  await withServer(async url => { calls += 1; return incoming(url); }, async base => {
    const uri = base + '/api/matches?league=ger.1';
    assert.equal((await fetch(uri)).status, 200);
    const before = calls;
    assert.equal((await fetch(uri)).status, 200);
    assert.equal(calls, before);
  });
});

test('upstream failure shows an actual error, never demo matches', async () => withServer(async () => new Response('Unavailable', {status:503}), async base => {
  const response = await fetch(base + '/api/matches?league=ger.1');
  assert.equal(response.status, 502);
  const data = await response.json();
  assert.match(data.error, /nicht erreichbar/);
  assert.equal(data.matches, undefined);
}));

test('invalid league rejected', async () => withServer(incoming, async base => {
  const response = await fetch(base + '/api/matches?league=bad');
  assert.equal(response.status, 400);
}));
