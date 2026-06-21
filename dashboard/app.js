/**
 * Rubber Tracker — Dashboard Application
 *
 * Loads data (API or sample), runs analyzer, renders stats/charts/anomalies.
 */

import { analyzeRubberUsage } from './analyzer.js';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const elSheetSelect    = document.getElementById('rubber-sheet-select');
const elErrorBanner    = document.getElementById('error-banner');
const elAnomaliesWrap  = document.getElementById('anomalies-section');
const elAnomalyList    = document.getElementById('anomaly-list');
const elSummaryText    = document.getElementById('summary-text');
const elApiUrlInput    = document.getElementById('api-url-input');
const elBtnSaveApi     = document.getElementById('btn-save-api');
const elBtnClearApi    = document.getElementById('btn-clear-api');

// Chart instances (so we can destroy before re-rendering)
let cumulativeChart = null;
let sessionChart    = null;

// Current loaded data
let appData = null;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  // Restore saved API URL
  const savedUrl = localStorage.getItem('rubber_tracker_api_url');
  if (savedUrl) elApiUrlInput.value = savedUrl;

  // Load data
  await loadData();

  // Event listeners
  elSheetSelect.addEventListener('change', () => {
    if (appData) renderAll(appData, elSheetSelect.value || undefined);
  });

  elBtnSaveApi.addEventListener('click', async () => {
    const url = elApiUrlInput.value.trim();
    if (url) {
      localStorage.setItem('rubber_tracker_api_url', url);
    } else {
      localStorage.removeItem('rubber_tracker_api_url');
    }
    await loadData();
  });

  elBtnClearApi.addEventListener('click', async () => {
    elApiUrlInput.value = '';
    localStorage.removeItem('rubber_tracker_api_url');
    await loadData();
  });
});

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadData() {
  hideError();
  try {
    const apiUrl = localStorage.getItem('rubber_tracker_api_url');
    const url = apiUrl || '../sample-data.json';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    appData = await res.json();
    populateSheetSelector(appData.rubber_sheets);
    renderAll(appData, elSheetSelect.value || undefined);
  } catch (err) {
    showError(`Failed to load data: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Rendering orchestration
// ---------------------------------------------------------------------------
function renderAll(data, sheetId) {
  // Handle empty sessions gracefully
  const ttSessions = (data.sessions || []).filter(s => s.activity_type === 'table_tennis');
  if (ttSessions.length === 0) {
    showEmptyState();
    return;
  }
  hideEmptyState();

  const result = analyzeRubberUsage(data, sheetId);
  renderStats(result.keyStats, result.priorSheet, result.bladeStats);
  renderCumulativeChart(result.chartData.cumulative_chart);
  renderSessionChart(result.chartData.session_chart);
  renderAnomalies(result.anomalies);
  elSummaryText.textContent = result.summary;
}

// ---------------------------------------------------------------------------
// Populate rubber sheet selector
// ---------------------------------------------------------------------------
function populateSheetSelector(sheets) {
  elSheetSelect.innerHTML = '';
  sheets.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    const status = s.replaced_date === null ? '● Active' : `Replaced ${s.replaced_date}`;
    opt.textContent = `${s.name}  (${status})`;
    elSheetSelect.appendChild(opt);
  });
  // Default to active sheet
  const active = sheets.find((s) => s.replaced_date === null);
  if (active) elSheetSelect.value = active.id;
}

// ---------------------------------------------------------------------------
// Stats rendering with animated counters
// ---------------------------------------------------------------------------
function renderStats(stats, priorSheet, bladeStats) {
  // Blade play time
  const elBladeCard = document.getElementById('stat-blade');
  if (bladeStats) {
    elBladeCard.classList.remove('hidden');
    document.getElementById('stat-blade-label').textContent = `Blade: ${bladeStats.name}`;
    animateValue('stat-blade-value',
      `${bladeStats.totalPlayTime.hours}h ${bladeStats.totalPlayTime.minutes}m`,
      bladeStats.totalPlayTime.hours * 60 + bladeStats.totalPlayTime.minutes,
      (v) => `${Math.floor(v / 60)}h ${Math.round(v % 60)}m`
    );
    document.getElementById('stat-blade-sub').textContent = `Active for ${bladeStats.daysInUse} days (installed ${formatDate(bladeStats.installedDate)})`;
  } else {
    elBladeCard.classList.add('hidden');
  }

  // Total play time
  animateValue('stat-total-time-value',
    `${stats.totalPlayTime.hours}h ${stats.totalPlayTime.minutes}m`,
    stats.totalPlayTime.hours * 60 + stats.totalPlayTime.minutes,
    (v) => `${Math.floor(v / 60)}h ${Math.round(v % 60)}m`
  );
  const totalDecimal = (stats.totalPlayTime.hours + stats.totalPlayTime.minutes / 60).toFixed(1);
  document.getElementById('stat-total-time-sub').textContent = `${totalDecimal} hours total`;

  // Sessions logged
  animateValue('stat-sessions-value',
    String(stats.sessionsLogged),
    stats.sessionsLogged,
    (v) => String(Math.round(v))
  );
  if (priorSheet) {
    document.getElementById('stat-sessions-sub').textContent =
      `Prior sheet: ${priorSheet.name} (${priorSheet.totalHours}h)`;
  } else {
    document.getElementById('stat-sessions-sub').textContent = 'No prior sheet on record';
  }

  // Avg session
  animateValue('stat-avg-session-value',
    `${stats.avgSessionMinutes}`,
    stats.avgSessionMinutes,
    (v) => String(Math.round(v))
  );

  // Days since install
  animateValue('stat-days-install-value',
    String(stats.daysSinceInstall),
    stats.daysSinceInstall,
    (v) => String(Math.round(v))
  );
  const weeks = (stats.daysSinceInstall / 7).toFixed(1);
  document.getElementById('stat-days-install-sub').textContent = `≈ ${weeks} weeks`;

  // Play frequency
  animateValue('stat-frequency-value',
    String(stats.sessionsPerWeek),
    stats.sessionsPerWeek,
    (v) => v.toFixed(2)
  );

  // Date range
  document.getElementById('stat-date-range-value').textContent =
    `${formatDate(stats.dateRange.first)} → ${formatDate(stats.dateRange.last)}`;
  const spanDays = daysBetween(stats.dateRange.first, stats.dateRange.last);
  document.getElementById('stat-date-range-sub').textContent = `${spanDays} days span`;
}

function animateValue(elementId, _finalText, targetNumber, formatter, duration = 800) {
  const el = document.getElementById(elementId);
  if (!el) return;

  // Force re-trigger CSS fade-in animation
  el.style.animation = 'none';
  // eslint-disable-next-line no-unused-expressions
  el.offsetHeight; // reflow
  el.style.animation = '';

  const start = performance.now();
  const from = 0;

  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    const current = from + (targetNumber - from) * eased;
    el.textContent = formatter(current);
    if (progress < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Cumulative line chart
// ---------------------------------------------------------------------------
function renderCumulativeChart(data) {
  const canvas = document.getElementById('chart-cumulative');
  if (cumulativeChart) cumulativeChart.destroy();

  const ctx = canvas.getContext('2d');

  // Gradient fill under line
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.parentElement.clientHeight || 300);
  gradient.addColorStop(0, 'rgba(20, 240, 213, 0.30)');
  gradient.addColorStop(0.6, 'rgba(20, 240, 213, 0.06)');
  gradient.addColorStop(1, 'rgba(20, 240, 213, 0.00)');

  cumulativeChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map((d) => d.date),
      datasets: [{
        label: 'Cumulative Hours',
        data: data.map((d) => d.cumulative_hours),
        borderColor: '#14f0d5',
        backgroundColor: gradient,
        borderWidth: 2.5,
        pointBackgroundColor: '#14f0d5',
        pointBorderColor: '#0b0e1a',
        pointBorderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 6,
        tension: 0.35,
        fill: true,
      }],
    },
    options: chartOptions('Hours'),
  });
}

// ---------------------------------------------------------------------------
// Session duration bar chart
// ---------------------------------------------------------------------------
function renderSessionChart(data) {
  const canvas = document.getElementById('chart-sessions');
  if (sessionChart) sessionChart.destroy();

  const ctx = canvas.getContext('2d');

  // Per-bar gradient
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.parentElement.clientHeight || 300);
  gradient.addColorStop(0, 'rgba(20, 240, 213, 0.85)');
  gradient.addColorStop(1, 'rgba(99, 102, 241, 0.45)');

  sessionChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map((d) => d.date),
      datasets: [{
        label: 'Duration (min)',
        data: data.map((d) => d.duration_minutes),
        backgroundColor: gradient,
        borderColor: 'rgba(20, 240, 213, 0.50)',
        borderWidth: 1,
        borderRadius: 6,
        borderSkipped: false,
        maxBarThickness: 28,
      }],
    },
    options: chartOptions('Minutes'),
  });
}

// ---------------------------------------------------------------------------
// Shared Chart.js options (dark theme)
// ---------------------------------------------------------------------------
function chartOptions(yLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: {
      duration: 900,
      easing: 'easeOutQuart',
    },
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: 'rgba(17, 21, 41, 0.92)',
        titleColor: '#eaf0ff',
        bodyColor: '#8892b0',
        borderColor: 'rgba(20, 240, 213, 0.25)',
        borderWidth: 1,
        cornerRadius: 8,
        padding: 12,
        titleFont: { family: 'Inter', weight: '600' },
        bodyFont: { family: 'Inter' },
        callbacks: {
          label(ctx) {
            const v = ctx.parsed.y;
            return yLabel === 'Hours'
              ? `${v.toFixed(2)} hours`
              : `${v} minutes`;
          },
        },
      },
    },
    scales: {
      x: {
        ticks: {
          color: '#505a78',
          font: { family: 'Inter', size: 10 },
          maxRotation: 45,
          maxTicksLimit: 12,
        },
        grid: { color: 'rgba(255,255,255,0.04)' },
        border: { color: 'rgba(255,255,255,0.06)' },
      },
      y: {
        beginAtZero: true,
        title: {
          display: true,
          text: yLabel,
          color: '#505a78',
          font: { family: 'Inter', size: 11, weight: '500' },
        },
        ticks: {
          color: '#505a78',
          font: { family: 'Inter', size: 10 },
        },
        grid: { color: 'rgba(255,255,255,0.04)' },
        border: { color: 'rgba(255,255,255,0.06)' },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Anomalies
// ---------------------------------------------------------------------------
function renderAnomalies(anomalies) {
  if (!anomalies || anomalies.length === 0) {
    elAnomaliesWrap.classList.add('hidden');
    return;
  }
  elAnomaliesWrap.classList.remove('hidden');
  elAnomalyList.innerHTML = anomalies
    .map((a) => {
      const icon = a.type === 'long gap' ? '📅' : '⏱';
      return `
        <div class="anomaly-item">
          <span class="anomaly-item__icon">${icon}</span>
          <div>
            <span class="anomaly-item__type">${a.type}</span>
            <p>${a.description}</p>
            <p class="anomaly-item__date">${a.date}</p>
          </div>
        </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
function showError(msg) {
  elErrorBanner.textContent = msg;
  elErrorBanner.classList.add('visible');
}

function hideError() {
  elErrorBanner.textContent = '';
  elErrorBanner.classList.remove('visible');
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
function showEmptyState() {
  elSummaryText.innerHTML =
    '<strong>No sessions recorded yet.</strong><br>' +
    'Connect your Apps Script API URL in the <em>Data Source</em> settings below, ' +
    'or run <code>syncSessions()</code> in your Apps Script to pull data from Google Fit. ' +
    'Once sessions are synced, stats and charts will appear here automatically.';

  // Clear stats
  ['stat-total-time-value', 'stat-sessions-value', 'stat-avg-session-value',
   'stat-days-install-value', 'stat-frequency-value'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '—';
  });
  document.getElementById('stat-date-range-value').textContent = 'No data yet';

  // Clear charts
  if (cumulativeChart) { cumulativeChart.destroy(); cumulativeChart = null; }
  if (sessionChart) { sessionChart.destroy(); sessionChart = null; }

  // Hide anomalies
  elAnomaliesWrap.classList.add('hidden');
}

function hideEmptyState() {
  // No special cleanup needed — renderAll populates everything
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysBetween(a, b) {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round(Math.abs(db - da) / 86_400_000);
}
