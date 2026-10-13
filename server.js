'use strict';
/** Start: node server.js – keine npm-Pakete und kein API-Schlüssel notwendig. */
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { normalizeEvent, predict } = require('./predictor');

const LEAGUES = Object.freeze({
  'ger.1': 'Bundesliga',
  'aut.1': 'Österreichische Bundesliga',
  'eng.1': 'Premier League',
  'esp.1': 'La Liga',
  'ita.1': 'Serie A',
  'fra.1': 'Ligue 1',
  'uefa.champions': 'Champions League',
  'uefa.europa': 'Europa League',
  'uefa.nations': 'Nations League'
});
const ROOT = __dirname;
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';
const FORM_TTL = 10 * 60 * 1000;
const CURRENT_TTL = 55 * 1000;
const TEAM_TTL = 10 * 60 * 1000;
const TEAM_BATCH_SIZE = 6;
const DAY = 86400000;
const FORM_DAYS = 110;
// Rueckblick ueber Saisonwechsel, begrenzt damit die kostenlose API nicht ueberlastet wird.
const MAX_HISTORY_MONTHS = 24;
// Zusätzliche Wettbewerbe dienen nur als Form-Datenquelle, nicht als Anzeige-Ligen.
// So erhalten z. B. Champions-League-Neulinge Formdaten aus der Heimatliga.
const OTHER_FORM_LEAGUES = Object.freeze({
  'por.1': 'Primeira Liga', 'ned.1': 'Eredivisie',
  'bel.1': 'Jupiler Pro League', 'tur.1': 'Süper Lig',
  'sco.1': 'Scottish Premiership', 'cze.1': 'Czech First League'
});
const HISTORY_LEAGUES = { ...LEAGUES, ...OTHER_FORM_LEAGUES };
const CLUB_CUPS = new Set(['uefa.champions', 'uefa.europa']);
// ESPN hat die Bereichsabfrage YYYYMMDD-YYYYMMDD im September 2026 abgeschaltet.
// Monatsabfragen (YYYYMM) funktionieren weiterhin; wir filtern die Daten lokal.
const asMonth = date => date.toISOString().slice(0, 7).replace('-', '');
function monthsBetween(start, end) {
  const months = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1);
  while (cursor.getTime() <= last) {
    months.push(asMonth(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}
function dayInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
const outputHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function createApp(options = {}) {
  const cache = new Map();
  const upstream = options.upstreamBase || ESPN;
  const now = options.now || (() => new Date());
  const upstreamFetch = options.fetch || fetch;
  async function fetchScoreboard(league, month, ttl) {
    const key = `${league}:${month}`;
    const cached = cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (cached?.pending) return cached.pending;
    const url = `${upstream}/${encodeURIComponent(league)}/scoreboard?dates=${month}&limit=500`;
    const promise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await upstreamFetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Datenanbieter antwortet mit HTTP ${response.status}`);
        const json = await response.json();
        if (!Array.isArray(json.events)) throw new Error('Unerwartetes Datenformat vom Anbieter');
        const events = json.events.map(e => normalizeEvent(e, league, HISTORY_LEAGUES[league])).filter(Boolean);
        cache.set(key, { value: events, expires: Date.now() + ttl });
        return events;
      } finally { clearTimeout(timeout); }
    })();
    cache.set(key, { pending: promise, expires: 0 });
    try { return await promise; }
    catch (error) {
      cache.delete(key);
      if (cached?.value) return cached.value; // letzte erfolgreiche Daten weiterreichen
      throw error;
    }
  }

  // ESPN bietet unter /all/teams/{id}/schedule einen Ergebnis-Spielplan
  // ueber Wettbewerbsgrenzen hinweg (nationale Liga, Pokal, Qualifikation).
  // Die Schnittstelle ist inoffiziell; bei Fehlern bleibt die Liga-Suche erhalten.
  async function fetchTeamSchedule(teamId, season = null) {
    const cacheKey = `team:${teamId}:${season === null ? 'recent' : season}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (cached?.pending) return cached.pending;
    const suffix = season === null ? '' : `?season=${season}`;
    const url = `${upstream}/all/teams/${encodeURIComponent(teamId)}/schedule${suffix}`;
    const pending = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await upstreamFetch(url, {
          signal: controller.signal, headers: { Accept: 'application/json' }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        if (!Array.isArray(json.events)) throw new Error('Unerwartetes Format im Team-Spielplan');
        // Die ESPN-IDs werden mitgeprueft, damit niemals Spiele eines
        // anderen Vereins die Vorhersage verfälschen.
        const games = json.events.map(e => {
          if (!e || typeof e !== 'object') return null;
          const league = e.league?.slug || e.competitions?.[0]?.league?.slug || 'all';
          const competitionInfo = [league, e.league?.name, e.season?.slug, e.competitions?.[0]?.league?.name]
            .filter(Boolean).join(' ').toLowerCase();
          // Vereinbarte Formbasis: Pflichtspiele, keine erkennbaren Test-/Freundschaftsspiele.
          if (/friendl|freundschaft|preseason|test.match/.test(competitionInfo)) return null;
          return normalizeEvent(e, league, HISTORY_LEAGUES[league] || 'Weitere Wettbewerbe');
        }).filter(game => game && (game.home.id === teamId || game.away.id === teamId));
        cache.set(cacheKey, { value: games, expires: Date.now() + TEAM_TTL });
        return games;
      } finally { clearTimeout(timeout); }
    })();
    cache.set(cacheKey, { pending, expires: 0 });
    try { return await pending; }
    catch (error) {
      cache.delete(cacheKey);
      if (cached?.value) return cached.value;
      throw error;
    }
  }

  // Nur Teams mit fehlender Datenbasis werden gezielt nachgeladen. Das
  // verhindert bei 100+ Spielen hunderte unnoetige API-Aufrufe pro Minute.
  async function allCompetitionHistory(matches, existing) {
    let history = existing;
    const missing = teamsWithShortHistory(matches, history);
    if (!missing.length) return history;
    const today = now();
    const minimumDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - MAX_HISTORY_MONTHS, 1)).toISOString();
    const years = [null, today.getUTCFullYear(), today.getUTCFullYear() - 1, today.getUTCFullYear() - 2];
    // Maximal sechs gleichzeitige externe Anfragen, mit begrenztem Rueckblick.
    for (let index = 0; index < missing.length; index += TEAM_BATCH_SIZE) {
      const batch = missing.slice(index, index + TEAM_BATCH_SIZE);
      const result = await Promise.all(batch.map(async item => {
        const found = [];
        for (const year of years) {
          try {
            const games = await fetchTeamSchedule(item.team.id, year);
            found.push(...games.filter(game => game.date >= minimumDate));
            const candidate = uniqueEvents([...history, ...found]);
            const eligible = candidate.filter(game =>
              game.state === 'finished' && game.date < item.cutoff &&
              game.homeScore !== null && game.awayScore !== null &&
              (game.home.id === item.team.id || game.away.id === item.team.id)
            );
            if (eligible.length >= 3) break;
          } catch (error) {
            console.warn(`Team-Historie ${item.team.name} (${year ?? 'aktuell'}): ${error.message}`);
          }
        }
        return found;
      }));
      history = uniqueEvents([...history, ...result.flat()]);
    }
    return history;
  }

  // Erst die Ansetzungen und laufenden Saisondaten laden; Prognosen werden
  // danach gemeinsam aus allen verfuegbaren Wettbewerben erstellt.
  async function getLeagueEvents(league, days, day, timeZone) {
    const current = now();
    // 'Heute' schliesst auch Ansetzungen spaeter am Tag ein.
    const until = new Date(current.getTime() + (days === 0 ? DAY : days * DAY));
    const previous = new Date(current.getTime() - FORM_DAYS * DAY);
    const thisMonth = asMonth(current);
    const months = monthsBetween(previous, until);
    const eventGroups = await Promise.all(months.map(month =>
      fetchScoreboard(league, month, month < thisMonth ? FORM_TTL : CURRENT_TTL)
    ));
    const history = uniqueEvents(eventGroups.flat());
    let visible = history.filter(e =>
      e.date >= new Date(current.getTime() - DAY).toISOString() &&
      e.date <= until.toISOString()
    );
    if (days === 0) {
      visible = visible.filter(e => dayInTimeZone(new Date(e.date), timeZone) === day);
    }
    return { visible, history };
  }

  // Eine Partie aus verschiedenen Datenquellen nie doppelt fuer die Form zaehlen.
  function uniqueEvents(events) {
    return [...new Map(events.map(e => [e.id, e])).values()];
  }

  // Ob auch nur eine Mannschaft weniger als drei echte vergangene Partien hat.
  function teamsWithShortHistory(matches, history) {
    const missing = new Map();
    for (const match of matches) {
      for (const team of [match.home, match.away]) {
        const count = history.filter(game =>
          game.state === 'finished' && game.date < match.date &&
          game.homeScore !== null && game.awayScore !== null &&
          (game.home.id === team.id || game.away.id === team.id)
        ).length;
        if (count < 3) {
          const item = missing.get(team.id);
          if (!item || match.date < item.cutoff) missing.set(team.id, { team, cutoff: match.date, matchLeague: match.leagueId });
        }
      }
    }
    return [...missing.values()];
  }

  // Aehnlich wie ein Sportkalender: in der aktuellen Saison zuerst ueber
  // Wettbewerb-Grenzen hinweg suchen. Besonders wichtig bei internationalen Cups.
  async function additionalClubHistory(matches, history, current, loadedLeagues) {
    if (!teamsWithShortHistory(matches, history).some(m => CLUB_CUPS.has(m.matchLeague))) return history;
    const months = monthsBetween(new Date(current.getTime() - FORM_DAYS * DAY), current);
    const thisMonth = asMonth(current);
    const leagues = Object.keys(HISTORY_LEAGUES).filter(l =>
      !loadedLeagues.includes(l) && l !== 'uefa.nations'
    );
    // Wenn nur Partien aus einer Liga ausgewaehlt wurden, laden wir fuer
    // internationale Pokalspiele weitere Ligen, soweit ESPN sie bereitstellt.
    const extra = await Promise.allSettled(leagues.flatMap(l => months.map(m =>
      fetchScoreboard(l, m, m < thisMonth ? FORM_TTL : CURRENT_TTL)
    )));
    const got = extra.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
    return uniqueEvents([...history, ...got]);
  }

  // Wenn selbst nach dem Mischen der aktuellen Wettbewerbe noch Formspiele
  // fehlen, monatsweise weiter in die Vorsaison(n) zurueckgehen.
  async function historicalBackfill(matches, existing) {
    let history = existing;
    const current = now();
    // Die 110-Tage-Anfangsmonate wurden beim ersten Abruf bereits geladen.
    // Juni/Oktober: vor dem Juni beginnt der Rueckblick also im Mai.
    const oldestInitial = new Date(current.getTime() - FORM_DAYS * DAY);
    let cursor = new Date(Date.UTC(oldestInitial.getUTCFullYear(), oldestInitial.getUTCMonth() - 1, 1));
    const stopAt = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - MAX_HISTORY_MONTHS, 1));
    // Jede Runde holt maximal drei Monate pro benoetigter Liga, danach wird
    // erneut geprueft. Ein mehrfaches Scrollen/Aktualisieren nutzt den Cache.
    while (cursor >= stopAt) {
      const missing = teamsWithShortHistory(matches, history);
      if (!missing.length) break;
      const relevant = new Set();
      for (const item of missing) {
        // Liga waehlen, in der das Team bisher am haeufigsten in unserer
        // Historie auftaucht; fuer Cup-Teams bevorzugt die Heimatliga.
        const counts = new Map();
        for (const game of history) {
          if (game.state !== 'finished' || game.date >= item.cutoff) continue;
          if (game.home.id !== item.team.id && game.away.id !== item.team.id) continue;
          counts.set(game.leagueId, (counts.get(game.leagueId) || 0) + 1);
        }
        const domestic = [...counts].filter(([id]) => !id.startsWith('uefa.'));
        const options = domestic.length ? domestic : [...counts];
        options.sort((a, b) => b[1] - a[1]);
        relevant.add(options[0]?.[0] || item.matchLeague);
      }
      const months = [];
      for (let n = 0; n < 3 && cursor >= stopAt; n++) {
        months.push(asMonth(cursor));
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1));
      }
      const results = await Promise.allSettled([...relevant].flatMap(l => months.map(m =>
        fetchScoreboard(l, m, FORM_TTL)
      )));
      const extra = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
      history = uniqueEvents([...history, ...extra]);
    }
    return history;
  }

  function json(res, status, data) {
    res.writeHead(status, outputHeaders);
    res.end(JSON.stringify(data));
  }

  async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Methode nicht erlaubt' });
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/matches') {
      const league = url.searchParams.get('league') || 'all';
      if (league !== 'all' && !Object.hasOwn(LEAGUES, league)) return json(res, 400, { error: 'Unbekannte Liga' });
      const days = url.searchParams.get('days') === '0' ? 0 : 7;
      const timeZone = url.searchParams.get('tz') || 'Europe/Vienna';
      let day = url.searchParams.get('day') || '';
      try { new Intl.DateTimeFormat('en-CA', { timeZone }).format(now()); }
      catch { return json(res, 400, { error: 'Ungültige Zeitzone' }); }
      if (days === 0 && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        day = dayInTimeZone(now(), timeZone);
      }
      const leagues = league === 'all' ? Object.keys(LEAGUES) : [league];
      const results = await Promise.allSettled(leagues.map(id => getLeagueEvents(id, days, day, timeZone)));
      const matches = [], histories = [], failedLeagues = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          matches.push(...result.value.visible);
          histories.push(...result.value.history);
        } else {
          failedLeagues.push(LEAGUES[leagues[index]]);
          console.warn(`ESPN ${leagues[index]}: ${result.reason?.message}`);
        }
      });
      if (!matches.length && failedLeagues.length === leagues.length) {
        return json(res, 502, { error: 'Die Fußball-Datenquelle ist aktuell nicht erreichbar. Bitte später neu laden.', failedLeagues });
      }
      let history = uniqueEvents(histories);
      if (teamsWithShortHistory(matches, history).length) {
        // Zuerst teamgenau ALLE ESPN-Wettbewerbe durchsuchen. Gerade die
        // Heimatliga kleinerer Clubs fehlt oft in unserer Liga-Auswahl.
        history = await allCompetitionHistory(matches, history);
        // Rueckfall, falls ESPN fuer ein Team keinen Spielplan anbietet.
        if (teamsWithShortHistory(matches, history).length) {
          history = await additionalClubHistory(matches, history, now(), leagues);
        }
        if (teamsWithShortHistory(matches, history).length) {
          history = await historicalBackfill(matches, history);
        }
      }
      const predicted = matches.map(match => ({ ...match, prediction: predict(match, history) }));
      predicted.sort((a, b) => {
        const order = { live: 0, scheduled: 1, finished: 2 };
        return (order[a.state] - order[b.state]) || a.date.localeCompare(b.date);
      });
      return json(res, 200, { matches: predicted, failedLeagues, updatedAt: now().toISOString(), provider: 'ESPN (öffentliche, nicht offiziell garantierte Schnittstelle)' });
    }
    const allowed = new Map([
      ['/', 'index.html'], ['/index.html', 'index.html'], ['/style.css', 'style.css'],
      ['/app.js', 'app.js'], ['/favicon.svg', 'favicon.svg']
    ]);
    if (!allowed.has(url.pathname)) return json(res, 404, { error: 'Nicht gefunden' });
    const filename = allowed.get(url.pathname);
    const mime = filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    const body = await fs.readFile(path.join(ROOT, filename));
    res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  return http.createServer((req, res) => Promise.resolve(handler(req, res)).catch(error => {
    console.error('Serverfehler:', error);
    if (!res.headersSent) json(res, 500, { error: 'Interner Serverfehler' });
    else res.end();
  }));
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, '0.0.0.0', () => {
    console.log(`\n  ⚽ FootPredict läuft auf http://localhost:${port}\n  Schließen mit STRG + C\n`);
  });
}
module.exports = { createApp, LEAGUES };
