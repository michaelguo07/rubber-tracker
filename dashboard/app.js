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
const elHRZoneBars      = document.getElementById('hr-zone-bars');
const elHRZoneTotal     = document.getElementById('hr-zone-total');

// Chart instances (so we can destroy before re-rendering)
let cumulativeChart = null;
let sessionChart    = null;
let hrChart         = null;

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
});

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadData() {
  hideError();
  showLoader();
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
  } finally {
    hideLoader();
  }
}

function showLoader() {
  const loader = document.getElementById('loading-overlay');
  if (loader) loader.classList.remove('hidden');
}

function hideLoader() {
  const loader = document.getElementById('loading-overlay');
  if (loader) loader.classList.add('hidden');
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
  renderStats(result.keyStats, result.priorSheet, result.bladeStats, result.weeklyStats);
  renderCumulativeChart(result.chartData.cumulative_chart);
  renderSessionChart(result.chartData.session_chart);
  renderAnomalies(result.anomalies);
  elSummaryText.textContent = result.summary;
  renderHeartRate(data.heart_rate_sessions || [], data.sessions || []);
}

// ---------------------------------------------------------------------------
// Populate rubber sheet selector
// ---------------------------------------------------------------------------
function populateSheetSelector(sheets) {
  elSheetSelect.innerHTML = '';
  sheets.forEach((s, index) => {
    const opt = document.createElement('option');
    opt.value = s.id;

    // Resolve replacement date
    let resolvedDate = s.replaced_date;
    if (resolvedDate === 'replaced' || resolvedDate === '' || resolvedDate === null) {
      const isFH = s.name.includes('(FH)') || s.name.toLowerCase().includes('fh');
      const isBH = s.name.includes('(BH)') || s.name.toLowerCase().includes('bh');
      for (let i = index + 1; i < sheets.length; i++) {
        const nextSheet = sheets[i];
        const nextIsFH = nextSheet.name.includes('(FH)') || nextSheet.name.toLowerCase().includes('fh');
        const nextIsBH = nextSheet.name.includes('(BH)') || nextSheet.name.toLowerCase().includes('bh');
        if ((isFH && nextIsFH) || (isBH && nextIsBH)) {
          resolvedDate = nextSheet.installed_date;
          break;
        }
      }
    }

    const isActive = (s.replaced_date === null) && (resolvedDate === s.replaced_date);
    const status = isActive ? '● Active' : `Replaced ${formatDate(resolvedDate)}`;
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
function renderStats(stats, priorSheet, bladeStats, weeklyStats) {
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

  // Weekly stats
  if (weeklyStats) {
    animateValue('stat-weekly-time-value',
      `${weeklyStats.playTime.hours}h ${weeklyStats.playTime.minutes}m`,
      weeklyStats.playTime.hours * 60 + weeklyStats.playTime.minutes,
      (v) => `${Math.floor(v / 60)}h ${Math.round(v % 60)}m`
    );
    const rangeText = weeklyStats.startDate ? `Sunday, ${formatDate(weeklyStats.startDate)} → ${formatDate(weeklyStats.endDate)}` : 'No data';
    document.getElementById('stat-weekly-time-sub').textContent = rangeText;

    animateValue('stat-weekly-calories-value',
      `${weeklyStats.calories} kcal`,
      weeklyStats.calories,
      (v) => `${Math.round(v)} kcal`
    );
    document.getElementById('stat-weekly-calories-sub').textContent = rangeText;

    animateValue('stat-weekly-steps-value',
      weeklyStats.steps.toLocaleString(),
      weeklyStats.steps,
      (v) => Math.round(v).toLocaleString()
    );
    document.getElementById('stat-weekly-steps-sub').textContent = rangeText;
  }
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
  gradient.addColorStop(0, 'rgba(255, 107, 0, 0.30)');
  gradient.addColorStop(0.6, 'rgba(255, 107, 0, 0.06)');
  gradient.addColorStop(1, 'rgba(255, 107, 0, 0.00)');

  cumulativeChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map((d) => d.date),
      datasets: [{
        label: 'Cumulative Hours',
        data: data.map((d) => d.cumulative_hours),
        borderColor: '#ff6b00',
        backgroundColor: gradient,
        borderWidth: 2.5,
        pointBackgroundColor: '#ff6b00',
        pointBorderColor: '#08090d',
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
  gradient.addColorStop(0, 'rgba(255, 107, 0, 0.85)');
  gradient.addColorStop(1, 'rgba(255, 255, 255, 0.20)');

  sessionChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map((d) => d.date),
      datasets: [{
        label: 'Duration (min)',
        data: data.map((d) => d.duration_minutes),
        backgroundColor: gradient,
        borderColor: 'rgba(255, 107, 0, 0.50)',
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
        backgroundColor: 'rgba(14, 16, 22, 0.95)',
        titleColor: '#ffffff',
        bodyColor: '#9ca3af',
        borderColor: 'rgba(255, 107, 0, 0.25)',
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
// Heart Rate Zones
// ---------------------------------------------------------------------------

/** Zone metadata for display. */
const HR_ZONE_META = [
  { zone: 1, name: 'Light',    color: '#3b82f6', pctRange: '<50%' },
  { zone: 2, name: 'Moderate', color: '#22c55e', pctRange: '50–69%' },
  { zone: 4, name: 'Vigorous', color: '#f97316', pctRange: '70–84%' },
  { zone: 5, name: 'Peak',     color: '#ef4444', pctRange: '85%+' },
];

/**
 * Populates the HR session selector and sets up event handling.
 */
function renderHeartRate(hrSessions, allSessions) {
  const selectEl = document.getElementById('hr-session-select');
  if (!selectEl) return;

  selectEl.innerHTML = '<option value="">Select a session\u2026</option>';

  if (!hrSessions || hrSessions.length === 0) {
    selectEl.innerHTML = '<option value="">No heart rate data yet</option>';
    showHREmpty();
    return;
  }

  // Sort by date descending (most recent first) for dropdown selection.
  const sorted = [...hrSessions].sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));

  sorted.forEach((hr, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);

    // Calculate total session minutes from start/end times if available
    let sessionMins = 0;
    if (hr.start_time && hr.end_time) {
      const start = new Date(hr.start_time);
      const end = new Date(hr.end_time);
      if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
        sessionMins = Math.round((end - start) / 60000);
      }
    }
    if (sessionMins <= 0) {
      sessionMins = (Number(hr.zone1_mins) || 0) +
                    (Number(hr.zone2_mins) || 0) +
                    (Number(hr.zone3_mins) || 0) +
                    (Number(hr.zone4_mins) || 0);
    }

    const durLabel = sessionMins > 0 ? ` (${sessionMins} min)` : '';
    opt.textContent = `${formatDate(hr.date)}${durLabel} \u2014 Avg ${hr.avg_bpm} bpm`;
    selectEl.appendChild(opt);
  });

  // Render trend chart for all sessions
  renderHRTrendChart(hrSessions);

  // Remove old listener by replacing node
  const newSelect = selectEl.cloneNode(true);
  selectEl.parentNode.replaceChild(newSelect, selectEl);
  const selectRef = document.getElementById('hr-session-select');

  selectRef.addEventListener('change', () => {
    const idx = selectRef.value;
    if (idx === '') {
      showHREmpty();
      return;
    }
    renderHRSession(sorted[parseInt(idx, 10)], allSessions);
  });

  // Auto-select the most recent session.
  selectRef.value = '0';
  renderHRSession(sorted[0], allSessions);
}

/**
 * Renders heart rate data for a single session.
 */
function renderHRSession(hr, allSessions) {
  hideHREmpty();

  animateValue('hr-avg-bpm', String(hr.avg_bpm), hr.avg_bpm, v => String(Math.round(v)));
  animateValue('hr-max-bpm', String(hr.max_bpm), hr.max_bpm, v => String(Math.round(v)));
  animateValue('hr-min-bpm', String(hr.min_bpm), hr.min_bpm, v => String(Math.round(v)));

  // Find matching exercise session to display calories and steps
  const totalMins = (Number(hr.zone1_mins) || 0) +
                    (Number(hr.zone2_mins) || 0) +
                    (Number(hr.zone3_mins) || 0) +
                    (Number(hr.zone4_mins) || 0);

  const sessionMatch = allSessions.find(s => 
    s.start_time === hr.start_time || 
    (s.date === hr.date && Math.abs(s.duration_minutes - totalMins) < 5)
  );

  const calories = sessionMatch ? Number(sessionMatch.calories) || 0 : 0;
  const steps = sessionMatch ? Number(sessionMatch.steps) || 0 : 0;

  animateValue('hr-calories', String(calories), calories, v => v > 0 ? `${Math.round(v)} kcal` : '—');
  animateValue('hr-steps', String(steps), steps, v => v > 0 ? Math.round(v).toLocaleString() : '—');

  renderZoneBars(hr);
}

/**
 * Renders the zone breakdown horizontal bars.
 */
function renderZoneBars(hr) {
  const zoneMinutes = [
    Number(hr.zone1_mins) || 0,
    Number(hr.zone2_mins) || 0,
    Number(hr.zone3_mins) || 0,
    Number(hr.zone4_mins) || 0,
  ];

  const totalMins = zoneMinutes.reduce((a, b) => a + b, 0);
  const maxMins = Math.max(...zoneMinutes, 1);

  elHRZoneBars.innerHTML = '';

  HR_ZONE_META.forEach((meta, i) => {
    const mins = zoneMinutes[i];
    const pct = totalMins > 0 ? (mins / maxMins) * 100 : 0;

    const row = document.createElement('div');
    row.className = `hr-zone-row hr-zone--${meta.zone}`;
    row.innerHTML = `
      <div class="hr-zone-row__label">
        <span class="hr-zone-row__dot"></span>
        ${meta.name}
      </div>
      <div class="hr-zone-row__bar-track">
        <div class="hr-zone-row__bar-fill" style="width: 0%"></div>
      </div>
      <span class="hr-zone-row__minutes">${mins} min</span>
    `;
    elHRZoneBars.appendChild(row);

    // Animate bar width after a brief delay for each bar.
    requestAnimationFrame(() => {
      setTimeout(() => {
        const fill = row.querySelector('.hr-zone-row__bar-fill');
        if (fill) fill.style.width = pct + '%';
      }, 80 * i);
    });
  });

  elHRZoneTotal.textContent = `Total tracked time: ${totalMins} min`;
}

/**
 * Renders a Line Chart showing average and max HR trend over time.
 */
function renderHRTrendChart(hrSessions) {
  const canvas = document.getElementById('chart-hr-trend');
  if (!canvas) return;
  if (hrChart) hrChart.destroy();

  const ctx = canvas.getContext('2d');

  // Sort chronologically (oldest first)
  const sorted = [...hrSessions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  hrChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: sorted.map((d) => formatDate(d.date)),
      datasets: [
        {
          label: 'Avg BPM',
          data: sorted.map((d) => Number(d.avg_bpm) || null),
          borderColor: '#f97316', // Orange
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointBackgroundColor: '#f97316',
          pointBorderColor: '#0b0e1a',
          pointBorderWidth: 1.5,
          pointRadius: 4,
          pointHoverRadius: 6,
          tension: 0.3,
        },
        {
          label: 'Max BPM',
          data: sorted.map((d) => Number(d.max_bpm) || null),
          borderColor: '#ef4444', // Red
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointBackgroundColor: '#ef4444',
          pointBorderColor: '#0b0e1a',
          pointBorderWidth: 1.5,
          pointRadius: 4,
          pointHoverRadius: 6,
          tension: 0.3,
        }
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            color: '#8b95b0',
            font: { family: 'Inter', size: 10, weight: '500' }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(14, 16, 22, 0.95)',
          titleColor: '#ffffff',
          bodyColor: '#9ca3af',
          borderColor: 'rgba(255, 107, 0, 0.25)',
          borderWidth: 1,
          cornerRadius: 8,
          padding: 12,
          titleFont: { family: 'Inter', weight: '600' },
          bodyFont: { family: 'Inter' }
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#505a78',
            font: { family: 'Inter', size: 9 }
          },
          grid: { display: false }
        },
        y: {
          ticks: {
            color: '#505a78',
            font: { family: 'Inter', size: 9 }
          },
          grid: { color: 'rgba(80, 90, 120, 0.08)' },
          title: {
            display: true,
            text: 'BPM',
            color: '#8b95b0',
            font: { family: 'Inter', size: 9, weight: '500' }
          }
        }
      }
    }
  });
}

function showHREmpty() {
  const emptyEl = document.getElementById('hr-empty-state');
  const statsRow = document.getElementById('hr-stats-row');
  const zonesCard = document.getElementById('hr-zones-card');
  const chartCard = document.getElementById('hr-chart-card');
  if (emptyEl)  emptyEl.classList.remove('hidden');
  if (statsRow) statsRow.style.display = 'none';
  if (zonesCard) zonesCard.style.display = 'none';
  if (chartCard) chartCard.style.display = 'none';
  if (hrChart) { hrChart.destroy(); hrChart = null; }
}

function hideHREmpty() {
  const emptyEl = document.getElementById('hr-empty-state');
  const statsRow = document.getElementById('hr-stats-row');
  const zonesCard = document.getElementById('hr-zones-card');
  const chartCard = document.getElementById('hr-chart-card');
  if (emptyEl)  emptyEl.classList.add('hidden');
  if (statsRow) statsRow.style.display = '';
  if (zonesCard) zonesCard.style.display = '';
  if (chartCard) chartCard.style.display = '';
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

  // Clear HR section
  showHREmpty();
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
