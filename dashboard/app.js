/**
 * TTInsights — Dashboard & Training Analytics Application
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
const elDefaultLifespanInput = document.getElementById('default-lifespan-input');
const elAthleteAgeInput = document.getElementById('athlete-age-input');
const elBtnSaveApi     = document.getElementById('btn-save-api');
const elHRZoneBars      = document.getElementById('hr-zone-bars');
const elHRZoneTotal     = document.getElementById('hr-zone-total');

// Login and Profile DOM element references
const elLoginOverlay   = document.getElementById('login-overlay');
const elLoginForm       = document.getElementById('login-form');
const elLoginEmail      = document.getElementById('login-email');
const elLoginCode       = document.getElementById('login-code');
const elLoginRole       = document.getElementById('login-role');
const elLoginError      = document.getElementById('login-error');
const elUserProfileBadge = document.getElementById('user-profile-badge');
const elUserProfileName  = document.getElementById('user-profile-name');
const elPlayerSelectorContainer = document.getElementById('player-selector-container');
const elPlayerSelect    = document.getElementById('player-select');
const elBtnLogout       = document.getElementById('btn-logout');

// Chart instances (so we can destroy before re-rendering)
let cumulativeChart = null;
let sessionChart    = null;
let hrChart         = null;
let drillChartInstance = null; // Coaching drills distribution chart

// Current loaded data
let appData = null;

// Authenticated user state
let currentUser = null;
let activePlayerId = null;

// Mock data profiles for local preview / testing fallback
const MOCK_PLAYERS = [
  { player_id: 'player-001', name: 'Michael Guo', email: 'michael@ttinsights.com', access_code: '1234', default_lifespan: '80', athlete_age: '18' },
  { player_id: 'player-002', name: 'Sarah Connor', email: 'sarah@ttinsights.com', access_code: '5678', default_lifespan: '100', athlete_age: '25' }
];

const MOCK_COACHES = [
  { coach_id: 'coach-001', name: 'Coach Waldner', email: 'waldner@ttinsights.com', access_code: '9999' }
];

const MOCK_PARENTS = [
  { parent_id: 'parent-001', name: 'Mr. Guo', email: 'parent.guo@ttinsights.com', access_code: '1111', linked_player_ids: 'player-001' },
  { parent_id: 'parent-002', name: 'Mrs. Connor', email: 'parent.connor@ttinsights.com', access_code: '2222', linked_player_ids: 'player-002' },
  { parent_id: 'parent-003', name: 'Super Parent', email: 'super@ttinsights.com', access_code: '3333', linked_player_ids: 'player-001,player-002' }
];

// Coaching state variables
let currentCoachingSessions = [];
let activeFeedbackSession = null;
let feedbackList = [];
let feedbackDraftDrills = [];

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  if (!elSheetSelect) return;

  // Restore saved API URL
  const savedUrl = localStorage.getItem('rubber_tracker_api_url');
  if (savedUrl && elApiUrlInput) elApiUrlInput.value = savedUrl;
  
  const loginApiUrlInput = document.getElementById('login-api-url');
  if (savedUrl && loginApiUrlInput) loginApiUrlInput.value = savedUrl;

  const btnToggleLoginConfig = document.getElementById('btn-toggle-login-config');
  const loginConfigFields = document.getElementById('login-config-fields');
  if (btnToggleLoginConfig && loginConfigFields) {
    btnToggleLoginConfig.addEventListener('click', () => {
      loginConfigFields.classList.toggle('hidden');
    });
  }

  // Check authentication session
  const storedUser = localStorage.getItem('rubber_tracker_user');
  if (storedUser) {
    try {
      currentUser = JSON.parse(storedUser);
      initializeSession();
    } catch (e) {
      console.error('Failed to parse user session', e);
      showLoginScreen();
    }
  } else {
    showLoginScreen();
  }

  // Login form submit handler
  if (elLoginForm) {
    elLoginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = elLoginEmail.value.trim();
      const code = elLoginCode.value.trim();

      const loginApiUrlInput = document.getElementById('login-api-url');
      if (loginApiUrlInput) {
        const url = loginApiUrlInput.value.trim();
        if (url) {
          localStorage.setItem('rubber_tracker_api_url', url);
          if (elApiUrlInput) elApiUrlInput.value = url;
        } else {
          localStorage.removeItem('rubber_tracker_api_url');
          if (elApiUrlInput) elApiUrlInput.value = '';
        }
      }

      console.log('--- Login attempt: submit handler triggered ---', { username });
      if (elLoginError) elLoginError.classList.add('hidden');
      showLoader();
      try {
        console.log('Calling handleLogin...');
        const user = await handleLogin(username, code);
        console.log('handleLogin success, returned user:', user);
        localStorage.setItem('rubber_tracker_user', JSON.stringify(user));
        currentUser = user;
        
        // Hide login overlay
        if (elLoginOverlay) elLoginOverlay.classList.add('hidden');
        
        console.log('Initializing session for user:', user.email || user.name);
        initializeSession();
      } catch (err) {
        console.error('Login submit handler caught error:', err);
        if (elLoginError) {
          elLoginError.textContent = err.message || 'Login failed.';
          elLoginError.classList.remove('hidden');
        }
      } finally {
        hideLoader();
      }
    });
  }

  // Logout handler
  if (elBtnLogout) {
    elBtnLogout.addEventListener('click', (e) => {
      e.preventDefault();
      console.log('--- Logout clicked ---');
      logoutUser();
    });
  }

  // Header Player selection dropdown change
  if (elPlayerSelect) {
    elPlayerSelect.addEventListener('change', () => {
      const selectedId = elPlayerSelect.value;
      switchToPlayer(selectedId, getActiveTabName());
    });
  }

  // Header Rubber Sheet selection dropdown change
  if (elSheetSelect) {
    elSheetSelect.addEventListener('change', () => {
      console.log('Rubber sheet dropdown changed. Selected ID:', elSheetSelect.value);
      if (appData) {
        showLoader();
        setTimeout(() => {
          try {
            renderAll(appData, elSheetSelect.value || undefined);
          } catch (err) {
            console.error('Error rendering selected sheet:', err);
            showError('Failed to display stats for selected sheet: ' + err.message);
          } finally {
            hideLoader();
          }
        }, 300);
      } else {
        console.warn('Cannot render: appData is null');
      }
    });
  }

  // Save Preferences settings button click
  if (elBtnSaveApi) {
    elBtnSaveApi.addEventListener('click', async () => {
      const url = elApiUrlInput.value.trim();
      const loginApiUrlInput = document.getElementById('login-api-url');
      if (url) {
        localStorage.setItem('rubber_tracker_api_url', url);
        if (loginApiUrlInput) loginApiUrlInput.value = url;
      } else {
        localStorage.removeItem('rubber_tracker_api_url');
        if (loginApiUrlInput) loginApiUrlInput.value = '';
      }

      if (elDefaultLifespanInput) {
        const val = parseInt(elDefaultLifespanInput.value, 10);
        if (!isNaN(val) && val > 0) {
          localStorage.setItem('rubber_tracker_default_lifespan', val);
        } else {
          localStorage.removeItem('rubber_tracker_default_lifespan');
        }
      }

      if (elAthleteAgeInput) {
        const val = parseInt(elAthleteAgeInput.value, 10);
        if (!isNaN(val) && val > 0 && val < 120) {
          localStorage.setItem('rubber_tracker_athlete_age', val);
        } else {
          localStorage.removeItem('rubber_tracker_athlete_age');
        }
      }

      // Force reload data logs from the new/updated data source
      await loadData(true);
    });
  }

  // Navigation tab links
  const navRoster = document.getElementById('nav-roster');
  const navDashboard = document.getElementById('nav-dashboard');
  const navCoaching = document.getElementById('nav-coaching');

  if (navRoster) {
    navRoster.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab('roster');
    });
  }

  if (navDashboard) {
    navDashboard.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab('dashboard');
    });
  }

  if (navCoaching) {
    navCoaching.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab('coaching');
    });
  }

  // Comments form controls
  const btnEditComments = document.getElementById('btn-edit-comments');
  const btnSaveComments = document.getElementById('btn-save-comments');
  const btnCancelComments = document.getElementById('btn-cancel-comments');
  const btnAddDrill = document.getElementById('btn-add-drill');
  const drillSelect = document.getElementById('editor-drill-select');
  const customDrillGroup = document.getElementById('editor-custom-drill-group');
  const durationSlider = document.getElementById('editor-drill-duration');
  const durationVal = document.getElementById('editor-duration-val');

  if (btnEditComments) btnEditComments.addEventListener('click', enterCommentsEditMode);
  if (btnSaveComments) btnSaveComments.addEventListener('click', saveSessionComments);
  if (btnCancelComments) btnCancelComments.addEventListener('click', cancelCommentsEditMode);
  if (btnAddDrill) btnAddDrill.addEventListener('click', addDrillToSession);

  if (drillSelect) {
    drillSelect.addEventListener('change', () => {
      if (drillSelect.value === 'custom') {
        if (customDrillGroup) customDrillGroup.classList.remove('hidden');
      } else {
        if (customDrillGroup) customDrillGroup.classList.add('hidden');
      }
    });
  }

  if (durationSlider && durationVal) {
    durationSlider.addEventListener('input', () => {
      durationVal.textContent = durationSlider.value;
    });
  }
});

// ---------------------------------------------------------------------------
// Authentication & Roster Helper Functions
// ---------------------------------------------------------------------------
async function handleLogin(username, accessCode) {
  const apiUrl = localStorage.getItem('rubber_tracker_api_url');
  console.log('handleLogin active, apiUrl is:', apiUrl);
  
  if (apiUrl) {
    try {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
        },
        body: JSON.stringify({
          action: 'login',
          username,
          access_code: accessCode
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      if (data.success && data.user) {
        return data.user;
      } else {
        throw new Error(data.message || 'Invalid name or access code.');
      }
    } catch (e) {
      console.warn('API login failed, checking local fallback...', e);
    }
  }

  // Fallback check against mock profiles
  console.log('Performing mock profiles fallback check...', { username, accessCode });
  let found = null;

  // 1. Search Players
  console.log('Searching MOCK_PLAYERS...', MOCK_PLAYERS);
  found = MOCK_PLAYERS.find(u => 
    (u.name.toLowerCase() === username.toLowerCase() || u.email.toLowerCase() === username.toLowerCase()) && 
    String(u.access_code) === accessCode
  );
  console.log('Found player match:', found);
  if (found) {
    return {
      id: found.player_id,
      name: found.name,
      email: found.email,
      role: 'player',
      default_lifespan: found.default_lifespan,
      athlete_age: found.athlete_age
    };
  }

  // 2. Search Coaches
  console.log('Searching MOCK_COACHES...', MOCK_COACHES);
  found = MOCK_COACHES.find(u => 
    (u.name.toLowerCase() === username.toLowerCase() || u.email.toLowerCase() === username.toLowerCase()) && 
    String(u.access_code) === accessCode
  );
  console.log('Found coach match:', found);
  if (found) {
    return {
      id: found.coach_id,
      name: found.name,
      email: found.email,
      role: 'coach'
    };
  }

  // 3. Search Parents
  console.log('Searching MOCK_PARENTS...', MOCK_PARENTS);
  found = MOCK_PARENTS.find(u => 
    (u.name.toLowerCase() === username.toLowerCase() || u.email.toLowerCase() === username.toLowerCase()) && 
    String(u.access_code) === accessCode
  );
  console.log('Found parent match:', found);
  if (found) {
    return {
      id: found.parent_id,
      name: found.name,
      email: found.email,
      role: 'parent',
      linked_player_ids: found.linked_player_ids
    };
  }

  throw new Error('Invalid name or access code.');
}

function showLoginScreen() {
  if (elLoginOverlay) elLoginOverlay.classList.remove('hidden');
  if (elUserProfileBadge) elUserProfileBadge.classList.add('hidden');
}

function logoutUser() {
  console.log('--- logoutUser executing ---');
  localStorage.removeItem('rubber_tracker_user');
  localStorage.removeItem('rubber_tracker_cached_data');
  currentUser = null;
  activePlayerId = null;
  
  const navRoster = document.getElementById('nav-roster');
  if (navRoster) navRoster.classList.add('hidden');

  showLoginScreen();
}

function initializeSession() {
  if (!currentUser) return;

  // Hide login overlay on successful session initialization/restore
  if (elLoginOverlay) elLoginOverlay.classList.add('hidden');

  if (elUserProfileBadge && elUserProfileName) {
    elUserProfileName.textContent = `${currentUser.name} (${currentUser.role.toUpperCase()})`;
    elUserProfileBadge.classList.remove('hidden');
  }

  if (currentUser.role === 'player') {
    if (elDefaultLifespanInput && currentUser.default_lifespan) {
      elDefaultLifespanInput.value = currentUser.default_lifespan;
    }
    if (elAthleteAgeInput && currentUser.athlete_age) {
      elAthleteAgeInput.value = currentUser.athlete_age;
    }
  }

  applyRoleVisibility();

  // Route user to appropriate tab depending on role
  if (currentUser.role === 'coach') {
    switchTab('roster');
  } else {
    switchTab('dashboard');
  }

  loadData();
}

function getActiveTabName() {
  const navDashboard = document.getElementById('nav-dashboard');
  const navCoaching = document.getElementById('nav-coaching');
  const navRoster = document.getElementById('nav-roster');
  
  if (navRoster && navRoster.classList.contains('nav-link--active')) return 'roster';
  if (navCoaching && navCoaching.classList.contains('nav-link--active')) return 'coaching';
  return 'dashboard';
}

function switchTab(tabName) {
  const navRoster = document.getElementById('nav-roster');
  const navDashboard = document.getElementById('nav-dashboard');
  const navCoaching = document.getElementById('nav-coaching');
  const viewRoster = document.getElementById('view-coach-roster');
  const viewDashboard = document.getElementById('view-dashboard');
  const viewCoaching = document.getElementById('view-coaching');

  if (navRoster) navRoster.classList.remove('nav-link--active');
  if (navDashboard) navDashboard.classList.remove('nav-link--active');
  if (navCoaching) navCoaching.classList.remove('nav-link--active');

  if (viewRoster) viewRoster.classList.add('hidden');
  if (viewDashboard) viewDashboard.classList.add('hidden');
  if (viewCoaching) viewCoaching.classList.add('hidden');

  if (tabName === 'roster') {
    if (navRoster) navRoster.classList.add('nav-link--active');
    if (viewRoster) viewRoster.classList.remove('hidden');
    renderCoachRoster();
  } else if (tabName === 'dashboard') {
    if (navDashboard) navDashboard.classList.add('nav-link--active');
    if (viewDashboard) viewDashboard.classList.remove('hidden');
    if (appData) renderAll(appData, elSheetSelect.value || undefined);
  } else if (tabName === 'coaching') {
    if (navCoaching) navCoaching.classList.add('nav-link--active');
    if (viewCoaching) viewCoaching.classList.remove('hidden');
    renderCoachingTab();
  }
}

function setupPlayerSelector() {
  if (!elPlayerSelect || !appData) return;

  const playersTable = appData.players && appData.players.length > 0 ? appData.players : MOCK_PLAYERS;

  if (currentUser.role === 'player') {
    activePlayerId = currentUser.id;
    elPlayerSelectorContainer.classList.add('hidden');
  } else if (currentUser.role === 'coach') {
    elPlayerSelect.innerHTML = '';
    playersTable.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.player_id;
      opt.textContent = p.name;
      elPlayerSelect.appendChild(opt);
    });
    document.getElementById('player-select-label').textContent = 'Student:';
    elPlayerSelectorContainer.classList.remove('hidden');
    if (!activePlayerId && playersTable.length > 0) {
      activePlayerId = playersTable[0].player_id;
    }
    elPlayerSelect.value = activePlayerId;
  } else if (currentUser.role === 'parent') {
    const childIds = String(currentUser.linked_player_ids || '').split(',').map(s => s.trim());
    const linkedPlayers = playersTable.filter(p => childIds.includes(p.player_id));
    
    if (linkedPlayers.length > 1) {
      elPlayerSelect.innerHTML = '';
      linkedPlayers.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.player_id;
        opt.textContent = p.name;
        elPlayerSelect.appendChild(opt);
      });
      document.getElementById('player-select-label').textContent = 'Child:';
      elPlayerSelectorContainer.classList.remove('hidden');
      if (!activePlayerId && linkedPlayers.length > 0) {
        activePlayerId = linkedPlayers[0].player_id;
      }
      elPlayerSelect.value = activePlayerId;
    } else if (linkedPlayers.length === 1) {
      activePlayerId = linkedPlayers[0].player_id;
      elPlayerSelectorContainer.classList.add('hidden');
    } else {
      activePlayerId = 'player-001';
      elPlayerSelectorContainer.classList.add('hidden');
    }
  }
}

function switchToPlayer(playerId, tab) {
  activePlayerId = playerId;
  if (elPlayerSelect) elPlayerSelect.value = playerId;

  populateSheetSelector(appData.rubber_sheets);
  
  if (tab === 'dashboard' || tab === 'roster') {
    switchTab('dashboard');
  } else if (tab === 'coaching') {
    switchTab('coaching');
  }
}

function applyRoleVisibility() {
  const settingsCard = document.querySelector('.settings-card');
  if (settingsCard) {
    if (currentUser && (currentUser.role === 'player' || currentUser.role === 'parent')) {
      settingsCard.style.display = 'none';
    } else {
      settingsCard.style.display = 'block';
    }
  }

  const navRoster = document.getElementById('nav-roster');
  if (navRoster) {
    if (currentUser && currentUser.role === 'coach') {
      navRoster.classList.remove('hidden');
    } else {
      navRoster.classList.add('hidden');
    }
  }
}

function getActiveRubberHealth(playerData, hand, defaultLifespan) {
  const list = playerData.rubber_sheets || [];
  const active = list.find(s => {
    const matchesHand = hand === 'FH' ? (s.name.includes('(FH)') || s.name.toLowerCase().includes('fh')) : (s.name.includes('(BH)') || s.name.toLowerCase().includes('bh'));
    return matchesHand && (!s.replaced_date || s.replaced_date === '');
  });
  if (!active) return null;
  const result = analyzeRubberUsage(playerData, active.id, defaultLifespan);
  return result.rubberHealth;
}

function renderCoachRoster() {
  const tbody = document.getElementById('roster-table-body');
  if (!tbody || !appData) return;

  tbody.innerHTML = '';

  const players = appData.players && appData.players.length > 0 ? appData.players : MOCK_PLAYERS;

  players.forEach(player => {
    const playerData = {
      rubber_sheets: (appData.rubber_sheets || []).filter(r => (r.player_id || 'player-001') === player.player_id),
      sessions: (appData.sessions || []).filter(s => (s.player_id || 'player-001') === player.player_id),
      feedback: (appData.feedback || []).filter(f => (f.player_id || 'player-001') === player.player_id)
    };

    const playerTtSessions = playerData.sessions
      .filter(s => s.activity_type === 'table_tennis')
      .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
    
    const lastSession = playerTtSessions[0];
    const lastActiveStr = lastSession ? formatDate(lastSession.date) : 'No sessions';

    let feedbackStatus = 'Logged';
    let statusClass = 'roster-badge--success';
    if (lastSession) {
      const fb = playerData.feedback.find(
        f => f.session_date === lastSession.date && Number(f.session_duration) === lastSession.duration_minutes
      );
      
      let hasFeedback = false;
      if (fb) {
        let drillsCount = 0;
        if (fb.drills) {
          try {
            drillsCount = (typeof fb.drills === 'string' ? JSON.parse(fb.drills) : fb.drills).length;
          } catch(e) {}
        }
        hasFeedback = fb.coaches_comments || drillsCount > 0;
      }

      if (hasFeedback) {
        feedbackStatus = 'Feedback Logged';
        statusClass = 'roster-badge--success';
      } else {
        feedbackStatus = 'Needs Feedback';
        statusClass = 'roster-badge--warning';
      }
    } else {
      feedbackStatus = 'No Session';
      statusClass = 'roster-badge--warning';
    }

    const defaultLifespan = Number(player.default_lifespan) || 80;
    const fhHealth = getActiveRubberHealth(playerData, 'FH', defaultLifespan);
    const bhHealth = getActiveRubberHealth(playerData, 'BH', defaultLifespan);

    let fhHtml = '<span style="color:var(--text-muted);">—</span>';
    if (fhHealth) {
      const colorClass = fhHealth.healthPercent > 50 ? 'roster-health-text--success' : (fhHealth.healthPercent > 20 ? 'roster-health-text--warning' : 'roster-health-text--danger');
      fhHtml = `<span class="roster-health-text ${colorClass}">${fhHealth.healthPercent}%</span>`;
    }

    let bhHtml = '<span style="color:var(--text-muted);">—</span>';
    if (bhHealth) {
      const colorClass = bhHealth.healthPercent > 50 ? 'roster-health-text--success' : (bhHealth.healthPercent > 20 ? 'roster-health-text--warning' : 'roster-health-text--danger');
      bhHtml = `<span class="roster-health-text ${colorClass}">${bhHealth.healthPercent}%</span>`;
    }

    const firstLetter = (player.name || '?').charAt(0).toUpperCase();

    const row = document.createElement('tr');
    row.innerHTML = `
      <td style="padding: 16px 20px;">
        <div class="roster-avatar-cell">
          <div class="roster-avatar">${firstLetter}</div>
          <span style="font-weight:600; color:var(--text-primary);">${escapeHtml(player.name)}</span>
        </div>
      </td>
      <td style="padding: 16px 20px; color:var(--text-secondary);">${escapeHtml(player.email)}</td>
      <td style="padding: 16px 20px; color:var(--text-secondary);">${lastActiveStr}</td>
      <td style="padding: 16px 20px;">
        <span class="roster-badge ${statusClass}">${feedbackStatus}</span>
      </td>
      <td style="padding: 16px 20px;">${fhHtml}</td>
      <td style="padding: 16px 20px;">${bhHtml}</td>
      <td style="padding: 16px 20px; text-align:right;">
        <button class="btn btn--secondary btn--sm btn-roster-view" data-player-id="${player.player_id}" style="margin-right:8px; height:32px; padding:0 12px;">Stats</button>
        <button class="btn btn--primary btn--sm btn-roster-feedback" data-player-id="${player.player_id}" style="height:32px; padding:0 12px;">Feedback</button>
      </td>
    `;

    row.querySelector('.btn-roster-view').addEventListener('click', () => {
      switchToPlayer(player.player_id, 'dashboard');
    });

    row.querySelector('.btn-roster-feedback').addEventListener('click', () => {
      switchToPlayer(player.player_id, 'coaching');
    });

    tbody.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
async function loadData(forceRefresh = false) {
  hideError();
  showLoader();
  try {
    const apiUrl = localStorage.getItem('rubber_tracker_api_url');
    const url = apiUrl || 'sample-data.json';
    
    let cachedData = null;
    if (!forceRefresh) {
      try {
        const stored = localStorage.getItem('rubber_tracker_cached_data');
        if (stored) {
          cachedData = JSON.parse(stored);
        }
      } catch (e) {
        console.error('Failed to parse cached data from localStorage', e);
      }
    }

    if (cachedData) {
      appData = cachedData;
    } else {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      appData = await res.json();
      
      // Cache the loaded data
      try {
        localStorage.setItem('rubber_tracker_cached_data', JSON.stringify(appData));
      } catch (e) {
        console.error('Failed to save data to localStorage cache', e);
      }
    }

    // Load feedback data, merging API/sample payload with local storage overrides
    let localFeedback = [];
    try {
      const stored = localStorage.getItem('rubber_tracker_feedback');
      if (stored) localFeedback = JSON.parse(stored);
    } catch (e) {
      console.error('Failed to parse local storage feedback', e);
    }

    const apiFeedback = appData.feedback || [];
    
    // Combine lists, preferring local feedback overrides
    const combinedFeedback = [...apiFeedback];
    localFeedback.forEach(lf => {
      const existingIdx = combinedFeedback.findIndex(
        f => (f.player_id || 'player-001') === (lf.player_id || 'player-001') &&
             f.session_date === lf.session_date && 
             Number(f.session_duration) === Number(lf.session_duration)
      );
      if (existingIdx !== -1) {
        combinedFeedback[existingIdx] = lf;
      } else {
        combinedFeedback.push(lf);
      }
    });

    appData.feedback = combinedFeedback;
    feedbackList = combinedFeedback;

    setupPlayerSelector();
    populateSheetSelector(appData.rubber_sheets);

    const activeTab = getActiveTabName();
    if (currentUser && currentUser.role === 'coach' && activeTab === 'roster') {
      switchTab('roster');
    } else {
      renderAll(appData, elSheetSelect.value || undefined);
    }
  } catch (err) {
    console.error(err);
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
  // Filter all data arrays by activePlayerId!
  const filteredData = {
    rubber_sheets: (data.rubber_sheets || []).filter(r => (r.player_id || 'player-001') === activePlayerId),
    blades: (data.blades || []).filter(b => (b.player_id || 'player-001') === activePlayerId),
    sessions: (data.sessions || []).filter(s => (s.player_id || 'player-001') === activePlayerId),
    heart_rate_sessions: (data.heart_rate_sessions || []).filter(h => (h.player_id || 'player-001') === activePlayerId),
    feedback: (data.feedback || []).filter(f => (f.player_id || 'player-001') === activePlayerId)
  };

  // Handle empty sessions gracefully
  const ttSessions = (filteredData.sessions || []).filter(s => s.activity_type === 'table_tennis');
  if (ttSessions.length === 0) {
    showEmptyState();
    return;
  }
  hideEmptyState();

  const result = analyzeRubberUsage(filteredData, sheetId, getDefaultRubberLifespan());
  renderStats(result.keyStats, result.priorSheet, result.bladeStats, result.weeklyStats, result.rubberHealth);
  renderCumulativeChart(result.chartData.cumulative_chart);
  renderSessionChart(result.chartData.session_chart);
  renderAnomalies(result.anomalies);
  elSummaryText.textContent = result.summary;
  renderHeartRate(filteredData.heart_rate_sessions || [], filteredData.sessions || []);
}

// ---------------------------------------------------------------------------
// Populate rubber sheet selector
// ---------------------------------------------------------------------------
function populateSheetSelector(sheets) {
  elSheetSelect.innerHTML = '';
  // Filter sheets by activePlayerId!
  const list = (sheets || []).filter(s => (s.player_id || 'player-001') === activePlayerId);

  // Group sheets by hand to identify the latest installed sheet
  const fhSheets = list.filter(s => s.name.includes('(FH)') || s.name.toLowerCase().includes('fh'));
  const bhSheets = list.filter(s => s.name.includes('(BH)') || s.name.toLowerCase().includes('bh'));

  const latestFH = fhSheets.length > 0 ? fhSheets[fhSheets.length - 1].id : null;
  const latestBH = bhSheets.length > 0 ? bhSheets[bhSheets.length - 1].id : null;

  list.forEach((s, index) => {
    const opt = document.createElement('option');
    opt.value = s.id;

    const isFH = s.name.includes('(FH)') || s.name.toLowerCase().includes('fh');
    const isBH = s.name.includes('(BH)') || s.name.toLowerCase().includes('bh');
    const isLatestOfHand = (isFH && s.id === latestFH) || (isBH && s.id === latestBH);

    // Resolve replacement date and active status
    let resolvedDate = s.replaced_date;
    let isActive = false;

    if (!resolvedDate || resolvedDate === 'replaced' || resolvedDate === '') {
      if (isLatestOfHand) {
        isActive = true;
      } else {
        // Find next sheet's install date as replacement date
        for (let i = index + 1; i < list.length; i++) {
          const nextSheet = list[i];
          const nextIsFH = nextSheet.name.includes('(FH)') || nextSheet.name.toLowerCase().includes('fh');
          const nextIsBH = nextSheet.name.includes('(BH)') || nextSheet.name.toLowerCase().includes('bh');
          if ((isFH && nextIsFH) || (isBH && nextIsBH)) {
            resolvedDate = nextSheet.installed_date;
            break;
          }
        }
      }
    } else {
      isActive = false;
    }

    // Format option text
    const statusLabel = isActive ? `Glued on ${formatDate(s.installed_date)}` : `Replaced ${formatDate(resolvedDate)}`;
    opt.textContent = `${s.name}  (${statusLabel})`;
    elSheetSelect.appendChild(opt);
  });

  // Default to active sheet
  const active = list.find(s => {
    const isFH = s.name.includes('(FH)') || s.name.toLowerCase().includes('fh');
    const isBH = s.name.includes('(BH)') || s.name.toLowerCase().includes('bh');
    const isLatest = (isFH && s.id === latestFH) || (isBH && s.id === latestBH);
    return isLatest && (!s.replaced_date || s.replaced_date === 'replaced' || s.replaced_date === '');
  });
  if (active) {
    elSheetSelect.value = active.id;
  } else if (list.length > 0) {
    elSheetSelect.value = list[list.length - 1].id;
  }
}

// ---------------------------------------------------------------------------
// Stats rendering with animated counters
// ---------------------------------------------------------------------------
function renderStats(stats, priorSheet, bladeStats, weeklyStats, rubberHealth) {
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

  // Render rubber health
  renderRubberHealth(rubberHealth);
}

function getDefaultRubberLifespan() {
  if (elDefaultLifespanInput) {
    const val = parseInt(elDefaultLifespanInput.value, 10);
    if (!isNaN(val) && val > 0) return val;
  }
  return 60;
}

function renderRubberHealth(health) {
  const elCard = document.getElementById('stat-rubber-health');
  if (!elCard) return;

  const elBadge = document.getElementById('rubber-health-badge');
  const elFill = document.getElementById('rubber-health-bar-fill');
  const elSub = document.getElementById('stat-rubber-health-sub');

  if (!health) {
    elCard.classList.add('hidden');
    return;
  }

  elCard.classList.remove('hidden');

  if (health.isActiveSheet) {
    elBadge.textContent = `${health.healthPercent}% Health`;
    elBadge.className = 'rubber-health-badge';
    
    if (health.healthPercent > 50) {
      elBadge.style.color = '#10b981';
      elBadge.style.borderColor = 'rgba(16, 185, 129, 0.3)';
      elBadge.style.background = 'rgba(16, 185, 129, 0.08)';
      elFill.style.background = 'linear-gradient(90deg, #10b981, #34d399)';
    } else if (health.healthPercent > 20) {
      elBadge.style.color = '#f59e0b';
      elBadge.style.borderColor = 'rgba(245, 158, 11, 0.3)';
      elBadge.style.background = 'rgba(245, 158, 11, 0.08)';
      elFill.style.background = 'linear-gradient(90deg, #f59e0b, #fbbf24)';
    } else {
      elBadge.style.color = '#ef4444';
      elBadge.style.borderColor = 'rgba(239, 68, 68, 0.3)';
      elBadge.style.background = 'rgba(239, 68, 68, 0.08)';
      elFill.style.background = 'linear-gradient(90deg, #ef4444, #f87171)';
    }

    setTimeout(() => {
      elFill.style.width = `${health.healthPercent}%`;
    }, 50);

    const basisInfo = health.historicalLifespansCount > 0
      ? `based on player's average historical lifespan of ${health.avgLifespanHours}h`
      : `based on default baseline lifespan of ${health.avgLifespanHours}h`;

    const estReplaceFormatted = health.estReplaceDate ? formatDate(health.estReplaceDate) : 'N/A';
    elSub.textContent = `Used ${health.currentPlayHours}h. Remaining: ~${health.remainingHours}h of play (est. replace date: ${estReplaceFormatted}), ${basisInfo}.`;

  } else {
    elBadge.textContent = `Retired`;
    elBadge.className = 'rubber-health-badge';
    elBadge.style.color = 'var(--text-secondary)';
    elBadge.style.borderColor = 'var(--border-subtle)';
    elBadge.style.background = 'rgba(255, 255, 255, 0.04)';
    
    elFill.style.width = '100%';
    elFill.style.background = 'rgba(255, 255, 255, 0.15)';
    
    elSub.textContent = `Lasted ${health.currentPlayHours} hours before replacement. Average lifespan on this side: ${health.avgLifespanHours} hours.`;
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
        titleFont: { family: 'Space Grotesk', weight: '700' },
        bodyFont: { family: 'Manrope' },
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
          font: { family: 'Manrope', size: 10 },
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
          font: { family: 'Space Grotesk', size: 11, weight: '700' },
        },
        ticks: {
          color: '#505a78',
          font: { family: 'Manrope', size: 10 },
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
  { zone: 1, name: 'Light',    color: '#3b82f6' },
  { zone: 2, name: 'Moderate', color: '#22c55e' },
  { zone: 3, name: 'Hard',     color: '#eab308' },
  { zone: 4, name: 'Vigorous', color: '#f97316' },
  { zone: 5, name: 'Peak',     color: '#ef4444' },
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
function getAthleteAge() {
  if (elAthleteAgeInput) {
    const val = parseInt(elAthleteAgeInput.value, 10);
    if (!isNaN(val) && val > 0 && val < 120) return val;
  }
  return 18;
}

function renderZoneBars(hr) {
  const zoneMinutes = [
    Number(hr.zone1_mins) || 0,
    Number(hr.zone2_mins) || 0,
    Number(hr.zone3_mins) || 0,
    Number(hr.zone4_mins) || 0,
    Number(hr.zone5_mins) || 0,
  ];

  const totalMins = zoneMinutes.reduce((a, b) => a + b, 0);
  const maxMins = Math.max(...zoneMinutes, 1);

  elHRZoneBars.innerHTML = '';

  const age = getAthleteAge();
  const maxHR = 220 - age;
  
  const z1Min = Math.round(maxHR * 0.50);
  const z1Max = Math.round(maxHR * 0.60);
  const z2Min = z1Max;
  const z2Max = Math.round(maxHR * 0.70);
  const z3Min = z2Max;
  const z3Max = Math.round(maxHR * 0.80);
  const z4Min = z3Max;
  const z4Max = Math.round(maxHR * 0.90);
  const z5Min = z4Max;

  HR_ZONE_META.forEach((meta, i) => {
    const mins = zoneMinutes[i];
    const pct = totalMins > 0 ? (mins / maxMins) * 100 : 0;

    let boundsLabel = '';
    if (i === 0) boundsLabel = `${z1Min}–${z1Max - 1} bpm`;
    else if (i === 1) boundsLabel = `${z2Min}–${z2Max - 1} bpm`;
    else if (i === 2) boundsLabel = `${z3Min}–${z3Max - 1} bpm`;
    else if (i === 3) boundsLabel = `${z4Min}–${z4Max - 1} bpm`;
    else if (i === 4) boundsLabel = `${z5Min}+ bpm`;

    const row = document.createElement('div');
    row.className = `hr-zone-row hr-zone--${meta.zone}`;
    row.innerHTML = `
      <div class="hr-zone-row__label">
        <span class="hr-zone-row__dot" style="background-color: ${meta.color};"></span>
        <div class="hr-zone-row__label-text">
          <span class="hr-zone-row__name">${meta.name}</span>
          <span class="hr-zone-row__range">${boundsLabel}</span>
        </div>
      </div>
      <div class="hr-zone-row__bar-track">
        <div class="hr-zone-row__bar-fill" style="width: 0%; background-color: ${meta.color};"></div>
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
            font: { family: 'Manrope', size: 10, weight: '500' }
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
          titleFont: { family: 'Space Grotesk', weight: '700' },
          bodyFont: { family: 'Manrope' }
        }
      },
      scales: {
        x: {
          ticks: {
            color: '#505a78',
            font: { family: 'Manrope', size: 9 }
          },
          grid: { display: false }
        },
        y: {
          ticks: {
            color: '#505a78',
            font: { family: 'Manrope', size: 9 }
          },
          grid: { color: 'rgba(80, 90, 120, 0.08)' },
          title: {
            display: true,
            text: 'BPM',
            color: '#8b95b0',
            font: { family: 'Space Grotesk', size: 9, weight: '700' }
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

// ---------------------------------------------------------------------------
// Coaching Tab & Drill Breakdown Rendering
// ---------------------------------------------------------------------------

function renderCoachingTab() {
  if (!appData) return;

  const filteredData = {
    rubber_sheets: (appData.rubber_sheets || []).filter(r => (r.player_id || 'player-001') === activePlayerId),
    blades: (appData.blades || []).filter(b => (b.player_id || 'player-001') === activePlayerId),
    sessions: (appData.sessions || []).filter(s => (s.player_id || 'player-001') === activePlayerId),
    heart_rate_sessions: (appData.heart_rate_sessions || []).filter(h => (h.player_id || 'player-001') === activePlayerId),
    feedback: (appData.feedback || []).filter(f => (f.player_id || 'player-001') === activePlayerId)
  };

  const result = analyzeRubberUsage(filteredData, elSheetSelect.value || undefined, getDefaultRubberLifespan());
  currentCoachingSessions = [...(result.filteredSessions || [])].reverse(); // Most recent first for feed

  // Render drill stats chart
  renderDrillDistributionChart(result.drillStats || []);

  // Render coaching session timeline feed
  renderCoachingSessionFeed(currentCoachingSessions);

  // Default select first session in the list
  if (currentCoachingSessions.length > 0) {
    const stillExists = currentCoachingSessions.some(
      s => s.date === (activeFeedbackSession && activeFeedbackSession.date) &&
           s.duration_minutes === (activeFeedbackSession && activeFeedbackSession.duration_minutes)
    );
    if (!stillExists) {
      activeFeedbackSession = currentCoachingSessions[0];
    }
    selectCoachingSession(activeFeedbackSession);
  } else {
    activeFeedbackSession = null;
    showEmptyFeedbackDetail();
  }
}

function renderDrillDistributionChart(drillStats) {
  const canvas = document.getElementById('chart-drill-distribution');
  if (!canvas) return;

  if (drillChartInstance) {
    drillChartInstance.destroy();
  }

  const ctx = canvas.getContext('2d');

  if (drillStats.length === 0) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#9ca3af';
    ctx.font = '14px Inter';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No drills logged yet.', canvas.width / 2, canvas.height / 2);
    return;
  }

  const drillColors = {
    // New categorized drills
    '(Single) Warmup': '#3b82f6',
    '(Single) Forehand 1-1': '#f97316',
    '(Single) 1 Forehand 1 Backhand': '#f59e0b',
    '(Single) Falkenberg': '#10b981',
    '(SR) Serve and Attack': '#ec4899',
    '(SR) Serve and Flick': '#14b8a6',
    '(Multi) Falkenberg': '#eab308',
    '(Multi) Underspin Loop': '#fbbf24',
    '(Multi) Push/Flick': '#ca8a04',
    'Match Play': '#6366f1',

    // Legacy support
    'Warmup / Drive': '#3b82f6',
    'Warmup': '#3b82f6',
    'Forehand Loop': '#f97316',
    'Backhand Loop / Drive': '#ef4444',
    'Backhand Loop': '#ef4444',
    'Footwork (Falkenberg)': '#22c55e',
    'Footwork (3-Point)': '#10b981',
    'Block / Defend': '#a855f7',
    'Serve & Attack': '#ec4899',
    'Receive & Flick': '#14b8a6',
    'Multiball': '#eab308'
  };

  const colors = drillStats.map(d => drillColors[d.name] || '#6b7280');

  drillChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: drillStats.map(d => d.name),
      datasets: [{
        data: drillStats.map(d => d.duration),
        backgroundColor: colors,
        borderColor: '#0f1016',
        borderWidth: 2,
        hoverOffset: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 900,
        easing: 'easeOutQuart'
      },
      plugins: {
        legend: {
          display: true,
          position: 'right',
          labels: {
            color: '#9ca3af',
            font: { family: 'Manrope', size: 10 },
            padding: 8,
            boxWidth: 10
          }
        },
        tooltip: {
          backgroundColor: 'rgba(14, 16, 22, 0.95)',
          titleColor: '#ffffff',
          bodyColor: '#9ca3af',
          borderColor: 'rgba(255, 107, 0, 0.25)',
          borderWidth: 1,
          cornerRadius: 8,
          padding: 10,
          titleFont: { family: 'Space Grotesk', weight: '700' },
          bodyFont: { family: 'Manrope' },
          callbacks: {
            label(ctx) {
              const val = ctx.parsed;
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = Math.round((val / total) * 100);
              return ` ${ctx.label}: ${val} mins (${pct}%)`;
            }
          }
        }
      },
      cutout: '65%'
    }
  });
}

function renderCoachingSessionFeed(sessions) {
  const container = document.getElementById('coaching-session-list');
  if (!container) return;

  container.innerHTML = '';

  if (sessions.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted); font-size: 0.9rem; text-align: center; margin-top: 20px;">No table tennis sessions logged.</p>';
    return;
  }

  sessions.forEach(session => {
    const fb = feedbackList.find(
      f => (f.player_id || 'player-001') === activePlayerId && f.session_date === session.date && Number(f.session_duration) === session.duration_minutes
    );

    const item = document.createElement('div');
    item.className = 'coaching-session-item';
    if (activeFeedbackSession && activeFeedbackSession.date === session.date && activeFeedbackSession.duration_minutes === session.duration_minutes) {
      item.classList.add('coaching-session-item--active');
    }

    let drillsHtml = '';
    if (fb && fb.drills) {
      try {
        let drillsArray = [];
        if (typeof fb.drills === 'string') {
          drillsArray = JSON.parse(fb.drills);
        } else if (Array.isArray(fb.drills)) {
          drillsArray = fb.drills;
        }

        drillsArray.slice(0, 3).forEach(d => {
          const typeClass = getDrillTypeClass(d.name, d.category);
          drillsHtml += `<span class="drill-badge ${typeClass}">${d.name} (${d.duration}m)</span>`;
        });
        if (drillsArray.length > 3) {
          drillsHtml += `<span class="drill-badge">+${drillsArray.length - 3} more</span>`;
        }
      } catch (e) {
        console.error(e);
      }
    }

    if (!drillsHtml) {
      drillsHtml = '<span class="drill-badge" style="opacity: 0.5;">No drills logged</span>';
    }

    let commentsPreview = 'No comments logged for this session.';
    if (fb && fb.coaches_comments) {
      commentsPreview = fb.coaches_comments;
    }

    item.innerHTML = `
      <div class="coaching-session-item__header">
        <span class="coaching-session-item__date">${formatDate(session.date)}</span>
        <span class="coaching-session-item__duration">${session.duration_minutes} min</span>
      </div>
      <p class="coaching-session-item__preview">${escapeHtml(commentsPreview)}</p>
      <div class="coaching-session-item__drills">
        ${drillsHtml}
      </div>
    `;

    item.addEventListener('click', () => {
      document.querySelectorAll('.coaching-session-item').forEach(el => {
        el.classList.remove('coaching-session-item--active');
      });
      item.classList.add('coaching-session-item--active');
      
      cancelCommentsEditMode();
      selectCoachingSession(session);
    });

    container.appendChild(item);
  });
}

function selectCoachingSession(session) {
  activeFeedbackSession = session;
  if (!session) {
    showEmptyFeedbackDetail();
    return;
  }

  document.getElementById('feedback-detail-date').textContent = formatDate(session.date);
  document.getElementById('feedback-detail-duration').textContent = `${session.duration_minutes} minutes lesson duration`;

  const fb = feedbackList.find(
    f => (f.player_id || 'player-001') === activePlayerId && f.session_date === session.date && Number(f.session_duration) === session.duration_minutes
  );

  let drills = [];
  if (fb && fb.drills) {
    try {
      drills = typeof fb.drills === 'string' ? JSON.parse(fb.drills) : fb.drills;
    } catch (e) {
      console.error(e);
    }
  }

  renderSessionDrillsBreakdown(drills, session.duration_minutes);

  // Show the drills section and comments section
  const drillsSec = document.getElementById('coaching-drills-section');
  const divider = document.getElementById('coaching-divider');
  const commentsSec = document.getElementById('coaching-comments-section');
  if (drillsSec) drillsSec.style.display = 'block';
  if (divider) divider.style.display = 'block';
  if (commentsSec) commentsSec.style.display = 'block';

  // Update duration slider limit
  const durationSlider = document.getElementById('editor-drill-duration');
  if (durationSlider) {
    durationSlider.max = String(session.duration_minutes);
    durationSlider.value = String(Math.min(15, session.duration_minutes));
    const valText = document.getElementById('editor-duration-val');
    if (valText) valText.textContent = durationSlider.value;
  }

  // Render comments blockquote
  const blockquote = document.getElementById('feedback-coaches-comments');
  if (blockquote) {
    if (fb && fb.coaches_comments) {
      blockquote.textContent = fb.coaches_comments;
      blockquote.style.opacity = '1';
      blockquote.style.fontStyle = 'italic';
    } else {
      blockquote.textContent = 'No coach\'s comments recorded for this session. Click "Edit Comments" to add comments.';
      blockquote.style.opacity = '0.5';
      blockquote.style.fontStyle = 'normal';
    }
  }

  // Hide comments editor wrap
  cancelCommentsEditMode();

  // Apply read-only mode based on user role
  const isWritable = currentUser && currentUser.role === 'coach';
  const editBtn = document.getElementById('btn-edit-comments');
  const drillForm = document.getElementById('editor-drill-form');
  if (editBtn) {
    if (isWritable) editBtn.classList.remove('hidden');
    else editBtn.classList.add('hidden');
  }
  if (drillForm) {
    if (isWritable) drillForm.classList.remove('hidden');
    else drillForm.classList.add('hidden');
  }
}

function renderSessionDrillsBreakdown(drills, totalDuration) {
  const progressBar = document.getElementById('feedback-drill-progress-bar');
  const tableTbody = document.getElementById('feedback-drill-list-table');
  const summaryText = document.getElementById('editor-drill-summary-text');

  if (!progressBar || !tableTbody) return;

  progressBar.innerHTML = '';
  tableTbody.innerHTML = '';

  const sumDuration = drills.reduce((sum, d) => sum + (Number(d.duration) || 0), 0);
  const remainingMins = totalDuration - sumDuration;

  // Update slider text summary
  if (summaryText) {
    if (remainingMins < 0) {
      summaryText.innerHTML = `<span style="color:var(--error); font-weight:700;">Over-allocated by ${Math.abs(remainingMins)} mins! Total: ${sumDuration} / ${totalDuration} mins</span>`;
    } else {
      summaryText.innerHTML = `Total allocated: ${sumDuration} / ${totalDuration} mins (${remainingMins} mins remaining)`;
    }
  }

  if (drills.length === 0) {
    progressBar.parentElement.style.display = 'none';
    tableTbody.innerHTML = '<p style="color: var(--text-muted); font-size: 0.88rem; font-style: italic; text-align: center; margin: 20px 0;">No training drills logged for this session yet. Allocate drills using the form above.</p>';
    return;
  }

  progressBar.parentElement.style.display = 'flex';

  drills.forEach(d => {
    const dur = Number(d.duration) || 0;
    const pct = totalDuration > 0 ? (dur / totalDuration) * 100 : 0;
    
    if (pct > 0) {
      const segment = document.createElement('div');
      segment.className = 'drill-progress-segment';
      segment.classList.add(getDrillSegmentColorClass(d.name, d.category));
      segment.style.width = `${pct}%`;
      segment.setAttribute('data-label', `${d.name}: ${dur}m (${Math.round(pct)}%)`);
      progressBar.appendChild(segment);
    }
  });

  const isWritable = currentUser && currentUser.role === 'coach';

  let tableHtml = `
    <table>
      <thead>
        <tr>
          <th>Drill Name</th>
          <th>Duration</th>
          <th>Allocation</th>
          <th style="text-align:right;">${isWritable ? 'Action' : ''}</th>
        </tr>
      </thead>
      <tbody>
  `;

  drills.forEach((d, idx) => {
    const dur = Number(d.duration) || 0;
    const pct = totalDuration > 0 ? Math.round((dur / totalDuration) * 100) : 0;
    tableHtml += `
      <tr>
        <td style="font-weight: 600; color: var(--text-primary);">
          <span style="display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:8px;" class="${getDrillSegmentColorClass(d.name, d.category)}"></span>
          ${escapeHtml(d.name)}
        </td>
        <td>${dur} mins</td>
        <td>${pct}%</td>
        <td style="text-align:right;">
          ${isWritable ? `<button type="button" class="btn-delete-drill btn-delete-drill-direct" data-index="${idx}">🗑️</button>` : ''}
        </td>
      </tr>
    `;
  });

  if (totalDuration > sumDuration) {
    const unallocatedMins = totalDuration - sumDuration;
    const pct = Math.round((unallocatedMins / totalDuration) * 100);
    tableHtml += `
      <tr style="opacity: 0.5; font-style: italic;">
        <td><span style="display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:8px; background-color:#6b7280;"></span>Unallocated time</td>
        <td>${unallocatedMins} mins</td>
        <td>${pct}%</td>
        <td></td>
      </tr>
    `;
  }

  tableHtml += '</tbody></table>';
  tableTbody.innerHTML = tableHtml;

  // Bind direct drill delete action listeners
  if (isWritable) {
    tableTbody.querySelectorAll('.btn-delete-drill-direct').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        if (confirm(`Remove the drill "${drills[idx].name}" from this session?`)) {
          const updatedDrills = [...drills];
          updatedDrills.splice(idx, 1);
          await saveSessionDrills(activeFeedbackSession, updatedDrills);
        }
      });
    });
  }
}

function enterCommentsEditMode() {
  if (!activeFeedbackSession) return;
  const isWritable = currentUser && currentUser.role === 'coach';
  if (!isWritable) return;

  const blockquote = document.getElementById('feedback-coaches-comments');
  const editBtn = document.getElementById('btn-edit-comments');
  const editorWrap = document.getElementById('comments-editor-wrap');

  if (blockquote && editBtn && editorWrap) {
    blockquote.classList.add('hidden');
    editBtn.classList.add('hidden');
    editorWrap.classList.remove('hidden');

    const fb = feedbackList.find(
      f => (f.player_id || 'player-001') === activePlayerId && f.session_date === activeFeedbackSession.date && Number(f.session_duration) === activeFeedbackSession.duration_minutes
    );
    document.getElementById('editor-comments').value = fb ? fb.coaches_comments || '' : '';
  }
}

function cancelCommentsEditMode() {
  const blockquote = document.getElementById('feedback-coaches-comments');
  const editBtn = document.getElementById('btn-edit-comments');
  const editorWrap = document.getElementById('comments-editor-wrap');

  if (blockquote && editBtn && editorWrap) {
    blockquote.classList.remove('hidden');
    
    const isWritable = currentUser && currentUser.role === 'coach';
    if (isWritable) {
      editBtn.classList.remove('hidden');
    } else {
      editBtn.classList.add('hidden');
    }
    
    editorWrap.classList.add('hidden');
  }
}

async function saveSessionComments() {
  if (!activeFeedbackSession) return;

  const comments = document.getElementById('editor-comments').value.trim();
  
  // Find or create feedback
  let fb = feedbackList.find(
    f => (f.player_id || 'player-001') === activePlayerId && f.session_date === activeFeedbackSession.date && Number(f.session_duration) === activeFeedbackSession.duration_minutes
  );

  const drills = fb ? fb.drills || '[]' : '[]';

  await saveFeedbackObject({
    session_date: activeFeedbackSession.date,
    session_duration: activeFeedbackSession.duration_minutes,
    coaches_comments: comments,
    drills: typeof drills === 'string' ? drills : JSON.stringify(drills)
  });

  cancelCommentsEditMode();
  showToast('Comments updated successfully!');
}

async function addDrillToSession() {
  if (!activeFeedbackSession) return;

  const drillSelect = document.getElementById('editor-drill-select');
  const durationSlider = document.getElementById('editor-drill-duration');
  
  let name = drillSelect.value;
  let category = 'Other';
  
  if (name === 'custom') {
    const customInput = document.getElementById('editor-custom-drill');
    name = customInput.value.trim();
    if (!name) {
      alert('Please enter a custom drill name.');
      return;
    }
  } else {
    const selectedOption = drillSelect.options[drillSelect.selectedIndex];
    name = selectedOption.textContent;
    const optgroup = selectedOption.parentNode;
    if (optgroup && optgroup.tagName === 'OPTGROUP') {
      category = optgroup.label;
    }
  }

  const duration = parseInt(durationSlider.value, 10);
  if (isNaN(duration) || duration <= 0) {
    alert('Please select a valid duration.');
    return;
  }

  // Find feedback and current drills
  let fb = feedbackList.find(
    f => (f.player_id || 'player-001') === activePlayerId && f.session_date === activeFeedbackSession.date && Number(f.session_duration) === activeFeedbackSession.duration_minutes
  );

  let drills = [];
  if (fb && fb.drills) {
    try {
      drills = typeof fb.drills === 'string' ? JSON.parse(fb.drills) : fb.drills;
    } catch (e) {
      console.error(e);
    }
  }

  // Merge or add drill
  const existing = drills.find(
    d => d.name.toLowerCase() === name.toLowerCase() &&
         (d.category || '').toLowerCase() === category.toLowerCase()
  );
  if (existing) {
    existing.duration = Number(existing.duration) + duration;
  } else {
    drills.push({ name, duration, category });
  }

  // Save changes
  const comments = fb ? fb.coaches_comments || '' : '';
  await saveFeedbackObject({
    session_date: activeFeedbackSession.date,
    session_duration: activeFeedbackSession.duration_minutes,
    coaches_comments: comments,
    drills: JSON.stringify(drills)
  });

  // Reset custom text input and form inputs
  document.getElementById('editor-custom-drill').value = '';
  showToast('Drill added successfully!');
}

async function saveSessionDrills(session, drills) {
  let fb = feedbackList.find(
    f => (f.player_id || 'player-001') === activePlayerId && f.session_date === session.date && Number(f.session_duration) === session.duration_minutes
  );

  const comments = fb ? fb.coaches_comments || '' : '';

  await saveFeedbackObject({
    session_date: session.date,
    session_duration: session.duration_minutes,
    coaches_comments: comments,
    drills: JSON.stringify(drills)
  });
  showToast('Drills list updated!');
}

async function saveFeedbackObject(feedbackObj) {
  showLoader();
  try {
    const apiUrl = localStorage.getItem('rubber_tracker_api_url');
    feedbackObj.player_id = activePlayerId || 'player-001';

    if (apiUrl) {
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
        },
        body: JSON.stringify({
          action: 'save_feedback',
          ...feedbackObj
        })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const responseJson = await res.json();
      if (responseJson.error) {
        throw new Error(responseJson.message);
      }
    }

    // Update locally
    let localFeedback = [];
    try {
      const stored = localStorage.getItem('rubber_tracker_feedback');
      if (stored) localFeedback = JSON.parse(stored);
    } catch (e) {}

    const existingIdx = localFeedback.findIndex(
      f => (f.player_id || 'player-001') === (feedbackObj.player_id || 'player-001') &&
           f.session_date === feedbackObj.session_date && 
           Number(f.session_duration) === Number(feedbackObj.session_duration)
    );
    if (existingIdx !== -1) {
      localFeedback[existingIdx] = feedbackObj;
    } else {
      localFeedback.push(feedbackObj);
    }
    localStorage.setItem('rubber_tracker_feedback', JSON.stringify(localFeedback));

    // Also update the cached appData directly to keep the cache synchronized
    try {
      const storedData = localStorage.getItem('rubber_tracker_cached_data');
      if (storedData) {
        const cached = JSON.parse(storedData);
        if (cached.feedback) {
          const idx = cached.feedback.findIndex(
            f => (f.player_id || 'player-001') === (feedbackObj.player_id || 'player-001') &&
                 f.session_date === feedbackObj.session_date && 
                 Number(f.session_duration) === Number(feedbackObj.session_duration)
          );
          if (idx !== -1) {
            cached.feedback[idx] = feedbackObj;
          } else {
            cached.feedback.push(feedbackObj);
          }
          localStorage.setItem('rubber_tracker_cached_data', JSON.stringify(cached));
        }
      }
    } catch (e) {
      console.error('Failed to update cached appData feedback', e);
    }

    // Reload (will load from local cache)
    await loadData();
    
    // Re-select session
    const matchedSession = currentCoachingSessions.find(
      s => s.date === feedbackObj.session_date && s.duration_minutes === feedbackObj.session_duration
    );
    if (matchedSession) {
      selectCoachingSession(matchedSession);
    }

  } catch (err) {
    showError(`Failed to save feedback: ${err.message}`);
  } finally {
    hideLoader();
  }
}

function showEmptyFeedbackDetail() {
  document.getElementById('feedback-detail-date').textContent = 'No Session Selected';
  document.getElementById('feedback-detail-duration').textContent = 'Please choose a session to view comments and training details.';
  
  const drillsSec = document.getElementById('coaching-drills-section');
  const divider = document.getElementById('coaching-divider');
  const commentsSec = document.getElementById('coaching-comments-section');
  if (drillsSec) drillsSec.style.display = 'none';
  if (divider) divider.style.display = 'none';
  if (commentsSec) commentsSec.style.display = 'none';
}

function getDrillTypeClass(name) {
  const norm = (name || '').toLowerCase();
  
  // Categorized overrides first
  if (norm.includes('multi') || norm.includes('multiball')) {
    return 'drill-badge--multiball';
  }
  if (norm.includes('sr') || norm.includes('serve receive')) {
    if (norm.includes('attack')) return 'drill-badge--serve-attack';
    if (norm.includes('flick')) return 'drill-badge--receive';
    return 'drill-badge--receive';
  }
  if (norm.includes('single')) {
    if (norm.includes('warmup')) return 'drill-badge--warmup';
    if (norm.includes('forehand 1-1') || norm.includes('fh 1-1')) return 'drill-badge--fh-loop';
    if (norm.includes('1 forehand 1 backhand') || norm.includes('1 fh 1 bh')) return 'drill-badge--footwork';
    if (norm.includes('falkenberg')) return 'drill-badge--footwork';
  }

  // General/Legacy fallbacks
  if (norm.includes('warmup') || norm.includes('drive')) return 'drill-badge--warmup';
  if (norm.includes('forehand loop') || norm.includes('fh loop') || norm.includes('forehand')) return 'drill-badge--fh-loop';
  if (norm.includes('backhand loop') || norm.includes('bh loop') || norm.includes('backhand drive')) return 'drill-badge--bh-loop';
  if (norm.includes('falkenberg')) return 'drill-badge--footwork';
  if (norm.includes('3-point') || norm.includes('three-point') || norm.includes('footwork')) return 'drill-badge--footwork';
  if (norm.includes('block') || norm.includes('defend') || norm.includes('control')) return 'drill-badge--block';
  if (norm.includes('serve') || norm.includes('3rd ball') || norm.includes('third ball')) return 'drill-badge--serve-attack';
  if (norm.includes('receive') || norm.includes('flick') || norm.includes('return')) return 'drill-badge--receive';
  if (norm.includes('match') || norm.includes('game') || norm.includes('play')) return 'drill-badge--match';
  return '';
}

function getDrillSegmentColorClass(name) {
  const norm = (name || '').toLowerCase();
  
  // Categorized overrides first
  if (norm.includes('multi') || norm.includes('multiball')) {
    return 'drill-seg--multiball';
  }
  if (norm.includes('sr') || norm.includes('serve receive')) {
    if (norm.includes('attack')) return 'drill-seg--serve-attack';
    if (norm.includes('flick')) return 'drill-seg--receive';
    return 'drill-seg--receive';
  }
  if (norm.includes('single')) {
    if (norm.includes('warmup')) return 'drill-seg--warmup';
    if (norm.includes('forehand 1-1') || norm.includes('fh 1-1')) return 'drill-seg--fh-loop';
    if (norm.includes('1 forehand 1 backhand') || norm.includes('1 fh 1 bh')) return 'drill-seg--footwork';
    if (norm.includes('falkenberg')) return 'drill-seg--footwork';
  }

  // General/Legacy fallbacks
  if (norm.includes('warmup') || norm.includes('drive')) return 'drill-seg--warmup';
  if (norm.includes('forehand loop') || norm.includes('fh loop') || norm.includes('forehand')) return 'drill-seg--fh-loop';
  if (norm.includes('backhand loop') || norm.includes('bh loop') || norm.includes('backhand drive')) return 'drill-seg--bh-loop';
  if (norm.includes('falkenberg')) return 'drill-seg--footwork';
  if (norm.includes('3-point') || norm.includes('three-point') || norm.includes('footwork')) return 'drill-seg--footwork';
  if (norm.includes('block') || norm.includes('defend') || norm.includes('control')) return 'drill-seg--block';
  if (norm.includes('serve') || norm.includes('3rd ball') || norm.includes('third ball')) return 'drill-seg--serve-attack';
  if (norm.includes('receive') || norm.includes('flick') || norm.includes('return')) return 'drill-seg--receive';
  if (norm.includes('match') || norm.includes('game') || norm.includes('play')) return 'drill-seg--match';
  return 'drill-seg--other';
}

function escapeHtml(unsafe) {
  return (unsafe || '')
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(msg) {
  const toast = document.createElement('div');
  toast.className = 'glass-card toast-success';
  toast.textContent = msg;
  toast.style.position = 'fixed';
  toast.style.bottom = '20px';
  toast.style.right = '20px';
  toast.style.padding = '12px 24px';
  toast.style.border = '1px solid #22c55e';
  toast.style.backgroundColor = 'rgba(15, 22, 18, 0.95)';
  toast.style.color = '#86efac';
  toast.style.borderRadius = '8px';
  toast.style.zIndex = '9999';
  toast.style.fontWeight = '600';
  toast.style.fontSize = '0.9rem';
  toast.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.4)';
  
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.5s ease';
    setTimeout(() => toast.remove(), 500);
  }, 3000);
}
