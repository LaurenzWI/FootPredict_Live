const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeEvent, recentGames, resultProbabilities, predict } = require('../../predictor');

function event(id, date, home, away, hs, as, state = 'post', clock = '') {
  return normalizeEvent({
    id: String(id), date,
    competitions: [{
      status: { type: { state, completed: state === 'post' }, displayClock: clock },
      competitors: [
        { homeAway: 'home', team: { id: String(home), displayName: `Team ${home}` }, score: hs },
        { homeAway: 'away', team: { id: String(away), displayName: `Team ${away}` }, score: as }
      ]
    }]
  }, 'ger.1', 'Bundesliga');
}

const matches = [
  event(1, '2026-09-01T12:00:00Z', 10, 11, 2, 0),
  event(2, '2026-09-07T12:00:00Z', 10, 12, 3, 0),
  event(3, '2026-09-14T12:00:00Z', 13, 10, 0, 1),
  event(4, '2026-09-21T12:00:00Z', 14, 10, 2, 1),
  event(5, '2026-09-28T12:00:00Z', 10, 15, 4, 0),
  event(6, '2026-09-01T16:00:00Z', 20, 21, 0, 2),
  event(7, '2026-09-07T16:00:00Z', 22, 20, 1, 0),
  event(8, '2026-09-14T16:00:00Z', 20, 23, 1, 1),
  event(9, '2026-09-21T16:00:00Z', 24, 20, 0, 2),
  event(10, '2026-09-28T16:00:00Z', 20, 25, 1, 0)
];
const fixture = event(11, '2026-10-08T17:00:00Z', 10, 20, null, null, 'pre');

test('ESPN events: scheduled games do not turn absent scores into 0:0', () => {
  assert.equal(fixture.homeScore, null);
  assert.equal(fixture.awayScore, null);
  assert.equal(fixture.state, 'scheduled');
});

test('ESPN events: clear home-away ordering', () => {
  assert.equal(matches[0].home.id, '10');
  assert.equal(matches[0].away.id, '11');
  assert.equal(matches[0].state, 'finished');
});

test('form: sorted newest first, match history excludes the current match', () => {
  const form = recentGames('10', [...matches, fixture], fixture.date);
  assert.equal(form.length, 5);
  assert.deepEqual(form.map(g => g.result), ['W', 'L', 'W', 'W', 'W']);
});

test('forecast: percentages always add up to 100', () => {
  const p = predict(fixture, matches);
  assert.equal(p.available, true);
  assert.ok(p.home > 0 && p.away > 0 && p.draw > 0);
  assert.ok(Math.abs(p.home + p.draw + p.away - 100) < 0.000001);
  assert.deepEqual(p.counts, { home: 5, away: 5 });
});

test('no fake forecast with insufficient actual match history', () => {
  const p = predict(fixture, matches.slice(0, 3));
  assert.equal(p.available, false);
  assert.match(p.reason, /mindestens drei/);
});

test('live 90th minute with winning score has nearly certain winner', () => {
  const live = event(11, '2026-10-08T17:00:00Z', 10, 20, 2, 1, 'in', "90'");
  const p = predict(live, matches);
  assert.equal(p.predictionType, 'live');
  assert.ok(p.home > 99.99);
});

test('live without minute is correctly labeled pre-match', () => {
  const live = event(11, '2026-10-08T17:00:00Z', 10, 20, 2, 1, 'in', '');
  assert.equal(predict(live, matches).predictionType, 'pre-match');
});

test('Poisson method gives normalized probabilities', () => {
  const p = resultProbabilities(1.5, 0.8);
  assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 0.000001);
});
