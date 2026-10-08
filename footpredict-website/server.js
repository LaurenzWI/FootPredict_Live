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
const TWO_DAYS = 2 * 86400000;
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
        const events = json.events.map(e => normalizeEvent(e, league, LEAGUES[league])).filter(Boolean);
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

  async function getLeagueEvents(league, days, day, timeZone) {
    const current = now();
    const localStart = new Date(current.getTime() - TWO_DAYS);
    // A 'today' filter must include fixtures later today, not only games before the current clock time.
    const until = new Date(current.getTime() + (days === 0 ? 86400000 : days * 86400000));
    const previous = new Date(current.getTime() - 110 * 86400000);
    // Historische Ergebnisse niemals mit der aktuellen Livescore-Aktualisierung verwechseln.
    const thisMonth = asMonth(current);
    const months = monthsBetween(previous, until);
    // Historische Monate bleiben länger im Cache. Für aktuelle und künftige
    // Spiele wird mindestens einmal pro Minute erneut nachgesehen.
    const eventGroups = await Promise.all(months.map(month =>
      fetchScoreboard(league, month, month < thisMonth ? FORM_TTL : CURRENT_TTL)
    ));
    const allEvents = [...new Map(eventGroups.flat().map(e => [e.id, e])).values()];
    let visible = allEvents.filter(e =>
      e.date >= new Date(current.getTime() - 86400000).toISOString() &&
      e.date <= until.toISOString()
    );
    if (days === 0) {
      visible = visible.filter(e => dayInTimeZone(new Date(e.date), timeZone) === day);
    }
    return visible.map(match => ({ ...match, prediction: predict(match, allEvents) }));
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
      const matches = [], failedLeagues = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') matches.push(...result.value);
        else {
          failedLeagues.push(LEAGUES[leagues[index]]);
          console.warn(`ESPN ${leagues[index]}: ${result.reason?.message}`);
        }
      });
      if (!matches.length && failedLeagues.length === leagues.length) {
        return json(res, 502, { error: 'Die Fußball-Datenquelle ist aktuell nicht erreichbar. Bitte später neu laden.', failedLeagues });
      }
      matches.sort((a, b) => {
        const order = { live: 0, scheduled: 1, finished: 2 };
        return (order[a.state] - order[b.state]) || a.date.localeCompare(b.date);
      });
      return json(res, 200, { matches, failedLeagues, updatedAt: now().toISOString(), provider: 'ESPN (öffentliche, nicht offiziell garantierte Schnittstelle)' });
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
  createApp().listen(port, '127.0.0.1', () => {
    console.log(`\n  ⚽ FootPredict läuft auf http://localhost:${port}\n  Schließen mit STRG + C\n`);
  });
}
module.exports = { createApp, LEAGUES };
