'use strict';
const $ = selector => document.querySelector(selector);
const list = $('#matchList');
const loading = $('#loadingState');
const errorBox = $('#errorState');
const countLabel = $('#matchCount');
const empty = $('#emptyState');
const refresh = $('#refresh');
const league = $('#league');
const period = $('#period');
let currentRequest = null;
let requestCounter = 0;

const esc = str => String(str ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const pct = n => Number(n).toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 }) + ' %';
const formatDate = date => new Date(date).toLocaleString('de-AT', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const formHtml = form => form?.map(g => `<span class="form-badge ${g === 'W' ? 'form-win' : g === 'D' ? 'form-draw' : 'form-loss'}" title="${g === 'W' ? 'Sieg' : g === 'D' ? 'Unentschieden' : 'Niederlage'}">${g === 'W' ? 'S' : g === 'D' ? 'U' : 'N'}</span>`).join('') || '';

function renderMatch(match) {
  const p = match.prediction;
  // Die angezeigten Prozentwerte haben eine Nachkommastelle.
  // Gleiche angezeigte Siegchancen erhalten auf beiden Seiten eine neutrale Farbe.
  const homePct = Math.round(Number(p.home) * 10);
  const awayPct = Math.round(Number(p.away) * 10);
  const homeColor = homePct > awayPct ? 'prob-favorite' : homePct < awayPct ? 'prob-underdog' : 'prob-even';
  const awayColor = awayPct > homePct ? 'prob-favorite' : awayPct < homePct ? 'prob-underdog' : 'prob-even';
  const scorePresent = match.homeScore != null && match.awayScore != null;
  const score = scorePresent && match.state !== 'scheduled' ? `${match.homeScore} : ${match.awayScore}` : 'VS';
  const date = formatDate(match.date);
  const badge = match.state === 'live' ? '<span class="status live-status"><i></i> LIVE</span>' : match.state === 'finished' ? '<span class="status finished">Beendet</span>' : '<span class="status scheduled">Bevorstehend</span>';
  const prediction = p.available
    ? `<div class="prob-head"><span>${p.predictionType === 'live' ? 'Live-Wahrscheinlichkeit' : 'Prognose vor Spielbeginn'}</span><span class="model-tag">FootPredict-Modell</span></div>
       <div class="probability" role="img" aria-label="Heimsieg ${pct(p.home)}, Remis ${pct(p.draw)}, Auswärtssieg ${pct(p.away)}"><span class="${homeColor}" style="width:${p.home}%"></span><span class="prob-draw" style="width:${p.draw}%"></span><span class="${awayColor}" style="width:${p.away}%"></span></div>
       <div class="prob-labels"><span class="${homeColor}">1 · ${pct(p.home)}</span><span class="prob-draw">X · ${pct(p.draw)}</span><span class="${awayColor}">2 · ${pct(p.away)}</span></div>
       <details class="details"><summary>Berechnung & Form ansehen</summary><div class="detail-content"><p><strong>${esc(match.home.name)}</strong> <span class="form-box">${formHtml(p.homeForm)}</span> (${p.counts.home} Spiele)</p><p><strong>${esc(match.away.name)}</strong> <span class="form-box">${formHtml(p.awayForm)}</span> (${p.counts.away} Spiele)</p><p>Erwartete Tore: ${p.expectedGoals.home.toFixed(2).replace('.', ',')} / ${p.expectedGoals.away.toFixed(2).replace('.', ',')}</p>${p.bonuses.length ? `<p>Serienbonus: ${esc(p.bonuses.join('; '))}</p>` : ''}<small>S = Sieg · U = Unentschieden · N = Niederlage. Neueste Partie links.</small></div></details>`
    : `<div class="unavailable">Noch keine seriöse Prognose: ${esc(p.reason)}<br><small>Verfügbare Spiele: ${p.counts.home} / ${p.counts.away}.</small></div>`;
  const logo = (team) => /^https:\/\//i.test(team.logo || '') ? `<img loading="lazy" src="${esc(team.logo)}" alt="" referrerpolicy="no-referrer">` : '<span>⚽</span>';
  return `<article class="match-card"><div class="match-meta"><span>${esc(match.leagueName)}</span>${badge}</div><p class="match-time">${esc(date)}${match.state === 'live' && match.clock ? ` · ${esc(match.clock)}` : ''}</p><div class="teams"><div class="team"><div class="team-logo">${logo(match.home)}</div><span>${esc(match.home.name)}</span></div><span class="score">${esc(score)}</span><div class="team"><div class="team-logo">${logo(match.away)}</div><span>${esc(match.away.name)}</span></div></div>${prediction}</article>`;
}

async function loadMatches(silent = false) {
  if (currentRequest) currentRequest.abort();
  const controller = new AbortController();
  currentRequest = controller;
  const serial = ++requestCounter;
  refresh.disabled = true;
  if (!silent) { loading.hidden = false; list.innerHTML = ''; countLabel.textContent = ''; }
  errorBox.hidden = true;
  empty.hidden = true;
  try {
    const d = new Date();
    const localDay = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
    const params = new URLSearchParams({ league: league.value, days: period.value, day: localDay, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Vienna' });
    const response = await fetch(`/api/matches?${params}`, { signal: controller.signal, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Abruf fehlgeschlagen');
    if (serial !== requestCounter) return;
    list.innerHTML = data.matches.map(renderMatch).join('');
    countLabel.textContent = `${data.matches.length} ${data.matches.length === 1 ? 'Spiel' : 'Spiele'} gefunden`;
    empty.hidden = data.matches.length !== 0;
    $('#updatedAt').textContent = `Aktualisiert: ${new Date(data.updatedAt).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}`;
    if (data.failedLeagues.length) {
      errorBox.textContent = `Einige Wettbewerbe konnten nicht geladen werden: ${data.failedLeagues.join(', ')}. Andere Ergebnisse werden angezeigt.`;
      errorBox.hidden = false;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    errorBox.textContent = `Die aktuellen Daten konnten nicht geladen werden: ${err.message}`;
    errorBox.hidden = false;
    if (!silent) countLabel.textContent = '';
    $('#updatedAt').textContent = 'Datenquelle nicht erreichbar';
  } finally {
    if (serial === requestCounter) { loading.hidden = true; refresh.disabled = false; currentRequest = null; }
  }
}

function navigate() {
  const current = location.hash === '#info' ? 'info' : 'spiele';
  document.querySelectorAll('.page').forEach(el => el.classList.toggle('active-page', el.id === current));
  document.querySelectorAll('[data-nav]').forEach(el => el.classList.toggle('active', el.dataset.nav === current));
}
league.addEventListener('change', () => loadMatches());
period.addEventListener('change', () => loadMatches());
refresh.addEventListener('click', () => loadMatches());
window.addEventListener('hashchange', navigate);
// Keine Aktualisierung für inaktive Tabs; beim Wiederaufklappen nachholen.
setInterval(() => { if (!document.hidden && !currentRequest) loadMatches(true); }, 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadMatches(true); });
navigate();
loadMatches();
