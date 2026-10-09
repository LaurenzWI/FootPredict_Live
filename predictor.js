/* FootPredict – reine, testbare Berechnungslogik. Keine erfundenen Quoten. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FootPredictModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const clamp = (number, min, max) => Math.max(min, Math.min(max, number));
  const numberOrNull = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'object' ? Number(value.value ?? value.displayValue) : Number(value);
    return Number.isFinite(n) ? n : null;
  };

  function normalizeEvent(event, leagueId, leagueName) {
    const competition = event?.competitions?.[0];
    if (!competition) return null;
    const members = competition.competitors || [];
    const home = members.find(p => p.homeAway === 'home');
    const away = members.find(p => p.homeAway === 'away');
    if (!home?.team?.id || !away?.team?.id || !event?.id) return null;
    const date = new Date(event.date || competition.date);
    if (Number.isNaN(date.getTime())) return null;
    const status = competition.status || event.status || {};
    const state = status.type?.state || '';
    const completed = status.type?.completed === true || state === 'post';
    const live = state === 'in';
    const homeScore = numberOrNull(home.score);
    const awayScore = numberOrNull(away.score);
    return {
      id: String(event.id), leagueId, leagueName, date: date.toISOString(),
      home: { id: String(home.team.id), name: home.team.displayName || home.team.name || 'Heimteam', logo: home.team.logo || home.team.logos?.[0]?.href || '' },
      away: { id: String(away.team.id), name: away.team.displayName || away.team.name || 'Auswärtsteam', logo: away.team.logo || away.team.logos?.[0]?.href || '' },
      state: completed ? 'finished' : live ? 'live' : 'scheduled',
      homeScore, awayScore,
      clock: status.displayClock || event.status?.displayClock || '',
      statusText: status.type?.shortDetail || status.type?.detail || event.status?.type?.detail || ''
    };
  }

  function recentGames(teamId, events, kickoff, limit = 5) {
    return events.filter(match =>
      match.state === 'finished' &&
      match.date < kickoff &&
      (match.home.id === teamId || match.away.id === teamId) &&
      match.homeScore !== null && match.awayScore !== null
    ).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit).map(match => {
      const isHome = match.home.id === teamId;
      const scored = isHome ? match.homeScore : match.awayScore;
      const conceded = isHome ? match.awayScore : match.homeScore;
      return { result: scored > conceded ? 'W' : scored === conceded ? 'D' : 'L', scored, conceded, date: match.date };
    });
  }

  function poisson(goals, expected) {
    let factorial = 1;
    for (let i = 2; i <= goals; i++) factorial *= i;
    return Math.exp(-expected) * Math.pow(expected, goals) / factorial;
  }

  function resultProbabilities(homeLambda, awayLambda, startingHomeGoals = 0, startingAwayGoals = 0) {
    let home = 0, draw = 0, away = 0;
    for (let h = 0; h <= 12; h++) {
      for (let a = 0; a <= 12; a++) {
        const p = poisson(h, homeLambda) * poisson(a, awayLambda);
        if (startingHomeGoals + h > startingAwayGoals + a) home += p;
        else if (startingHomeGoals + h === startingAwayGoals + a) draw += p;
        else away += p;
      }
    }
    const total = home + draw + away;
    return { home: home / total, draw: draw / total, away: away / total };
  }

  function predict(match, historicalEvents) {
    const homeForm = recentGames(match.home.id, historicalEvents, match.date);
    const awayForm = recentGames(match.away.id, historicalEvents, match.date);
    const counts = { home: homeForm.length, away: awayForm.length };
    if (counts.home < 3 || counts.away < 3) {
      return { available: false, reason: 'Für diese Partie sind nicht mindestens drei abgeschlossene Ligaspiele pro Team verfügbar.', counts };
    }

    const average = (games, key) => games.reduce((sum, game) => sum + game[key], 0) / games.length;
    const homeExpectedGoals = clamp(((average(homeForm, 'scored') + average(awayForm, 'conceded')) / 2) * 1.1, 0.25, 3.5);
    const awayExpectedGoals = clamp(((average(awayForm, 'scored') + average(homeForm, 'conceded')) / 2) * 0.95, 0.25, 3.5);
    let values = resultProbabilities(homeExpectedGoals, awayExpectedGoals);
    const count = (form, result) => form.filter(g => g.result === result).length;
    values.home += count(homeForm, 'W') * 0.02 + count(awayForm, 'L') * 0.02;
    values.draw += (count(homeForm, 'D') + count(awayForm, 'D')) * 0.01;
    values.away += count(awayForm, 'W') * 0.02 + count(homeForm, 'L') * 0.02;

    const streak = (form, result) => form.slice(0, 3).every(g => g.result === result);
    const bonuses = [];
    if (streak(homeForm, 'W')) { values.home += 0.10; bonuses.push('Heimteam: 3 Siege in Folge'); }
    if (streak(awayForm, 'W')) { values.away += 0.10; bonuses.push('Auswärtsteam: 3 Siege in Folge'); }
    if (streak(homeForm, 'L')) { values.away += 0.10; bonuses.push('Heimteam: 3 Niederlagen in Folge'); }
    if (streak(awayForm, 'L')) { values.home += 0.10; bonuses.push('Auswärtsteam: 3 Niederlagen in Folge'); }

    const total = values.home + values.draw + values.away;
    const preMatch = { home: values.home / total * 100, draw: values.draw / total * 100, away: values.away / total * 100 };
    let prediction = preMatch;
    let predictionType = 'pre-match';

    // Ein laufendes Match erhält *nur bei bekannten Ergebnissen UND Spielminute*
    // eine neue In-Play-Schätzung für verbleibende Tore.
    const minute = /^\s*(\d{1,3})/.exec(match.clock || '');
    if (match.state === 'live' && minute && match.homeScore !== null && match.awayScore !== null) {
      const elapsed = clamp(Number(minute[1]), 0, 90);
      const left = (90 - elapsed) / 90;
      const conditioned = resultProbabilities(homeExpectedGoals * left, awayExpectedGoals * left, match.homeScore, match.awayScore);
      prediction = { home: conditioned.home * 100, draw: conditioned.draw * 100, away: conditioned.away * 100 };
      predictionType = 'live';
    }
    return {
      available: true, ...prediction, predictionType, counts,
      expectedGoals: { home: homeExpectedGoals, away: awayExpectedGoals },
      homeForm: homeForm.map(g => g.result), awayForm: awayForm.map(g => g.result),
      bonuses
    };
  }

  return { normalizeEvent, recentGames, resultProbabilities, predict };
});
