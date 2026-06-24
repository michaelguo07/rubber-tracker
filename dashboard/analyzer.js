/**
 * Rubber Sheet Usage Analyzer
 *
 * Pure analysis engine — takes structured session + rubber sheet data
 * and returns key stats, chart data, anomalies, and a human-readable summary.
 */

/**
 * Analyze rubber sheet usage.
 *
 * @param {Object} data - { rubber_sheets: [...], sessions: [...] }
 * @param {string} [rubberSheetId] - ID of the sheet to analyze.
 * @param {number} [defaultLifespanHours] - Default rubber life in hours.
 * @returns {Object} Analysis result
 */
export function analyzeRubberUsage(data, rubberSheetId, defaultLifespanHours = 60) {
  const { rubber_sheets, sessions, feedback = [] } = data;

  // --- Resolve target sheet ---------------------------------------------------
  let sheet;
  if (rubber_sheets && rubber_sheets.length > 0) {
    if (rubberSheetId) {
      sheet = rubber_sheets.find((s) => s.id === rubberSheetId);
    }
    if (!sheet) {
      sheet = rubber_sheets.find((s) => s.replaced_date === null);
    }
    if (!sheet) {
      sheet = rubber_sheets[rubber_sheets.length - 1];
    }
  }

  if (!sheet) {
    const sortedTT = (sessions || [])
      .filter((s) => s.activity_type === "table_tennis")
      .sort((a, b) => a.date.localeCompare(b.date));
    const firstDate = sortedTT.length > 0 ? sortedTT[0].date : _today();
    sheet = {
      id: "virtual-sheet",
      name: "No Rubber Sheet Logged",
      installed_date: firstDate,
      replaced_date: null,
      isVirtual: true,
    };
  }

  const installDate = sheet.installed_date;
  const endDate = sheet.replaced_date || _today();

  // --- Filter sessions --------------------------------------------------------
  const filtered = sessions
    .filter(
      (s) =>
        s.activity_type === "table_tennis" &&
        s.date >= installDate &&
        s.date <= endDate
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // --- Key stats --------------------------------------------------------------
  const totalMinutes = filtered.reduce((sum, s) => sum + s.duration_minutes, 0);
  const totalPlayTime = {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  };

  const sessionsLogged = filtered.length;

  const avgSessionMinutes =
    sessionsLogged > 0 ? Math.round(totalMinutes / sessionsLogged) : 0;

  const dateRange = {
    first: filtered.length > 0 ? filtered[0].date : installDate,
    last: filtered.length > 0 ? filtered[filtered.length - 1].date : installDate,
  };

  const daysSinceInstall = _daysBetween(installDate, _today());

  const weeksActive = daysSinceInstall / 7 || 1;
  const sessionsPerWeek = parseFloat((sessionsLogged / weeksActive).toFixed(2));

  const keyStats = {
    totalPlayTime,
    sessionsLogged,
    avgSessionMinutes,
    dateRange,
    daysSinceInstall,
    sessionsPerWeek,
  };

  // --- Weekly stats (rolling last 7 days from the latest session date) ---------
  let weeklyMinutes = 0;
  let weeklyCalories = 0;
  let weeklySteps = 0;
  let weeklySessionsCount = 0;
  let weeklyStartDate = "";
  let weeklyEndDate = "";

  if (filtered.length > 0) {
    weeklyEndDate = filtered[filtered.length - 1].date;
    const latestDate = new Date(weeklyEndDate + "T00:00:00");
    const dayOfWeek = latestDate.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const lastSunday = new Date(latestDate.getTime() - dayOfWeek * 86_400_000);
    weeklyStartDate = lastSunday.toISOString().slice(0, 10);

    const weeklySessions = filtered.filter(
      (s) => s.date >= weeklyStartDate && s.date <= weeklyEndDate
    );

    weeklyMinutes = weeklySessions.reduce((sum, s) => sum + (s.duration_minutes || 0), 0);
    weeklyCalories = weeklySessions.reduce((sum, s) => sum + (Number(s.calories) || 0), 0);
    weeklySteps = weeklySessions.reduce((sum, s) => sum + (Number(s.steps) || 0), 0);
    weeklySessionsCount = weeklySessions.length;
  }

  const weeklyStats = {
    playTime: {
      hours: Math.floor(weeklyMinutes / 60),
      minutes: weeklyMinutes % 60,
      totalMinutes: weeklyMinutes
    },
    calories: weeklyCalories,
    steps: weeklySteps,
    sessionsCount: weeklySessionsCount,
    startDate: weeklyStartDate,
    endDate: weeklyEndDate
  };

  // --- Chart data -------------------------------------------------------------
  let cumulativeMinutes = 0;
  const cumulative_chart = filtered.map((s) => {
    cumulativeMinutes += s.duration_minutes;
    return {
      date: s.date,
      cumulative_hours: parseFloat((cumulativeMinutes / 60).toFixed(2)),
    };
  });

  const session_chart = filtered.map((s) => ({
    date: s.date,
    duration_minutes: s.duration_minutes,
  }));

  const chartData = { cumulative_chart, session_chart };

  // --- Prior sheet comparison -------------------------------------------------
  let priorSheet = null;
  if (rubber_sheets && rubber_sheets.length > 0 && !sheet.isVirtual) {
    const sheetIndex = rubber_sheets.findIndex((s) => s.id === sheet.id);
    if (sheetIndex > 0) {
      const prior = rubber_sheets[sheetIndex - 1];
      const priorEnd = prior.replaced_date || _today();
      const priorSessions = sessions.filter(
        (s) =>
          s.activity_type === "table_tennis" &&
          s.date >= prior.installed_date &&
          s.date <= priorEnd
      );
      const priorMinutes = priorSessions.reduce(
        (sum, s) => sum + s.duration_minutes,
        0
      );
      priorSheet = {
        name: prior.name,
        totalHours: parseFloat((priorMinutes / 60).toFixed(2)),
      };
    }
  }

  // --- Anomalies --------------------------------------------------------------
  const anomalies = [];

  filtered.forEach((s) => {
    if (s.duration_minutes > 180) {
      anomalies.push({
        type: "suspicious duration",
        description: `Session lasted ${s.duration_minutes} minutes (over 3 hours)`,
        date: s.date,
      });
    } else if (s.duration_minutes < 5) {
      anomalies.push({
        type: "suspicious duration",
        description: `Session lasted only ${s.duration_minutes} minutes`,
        date: s.date,
      });
    }
  });

  for (let i = 1; i < filtered.length; i++) {
    const gap = _daysBetween(filtered[i - 1].date, filtered[i].date);
    if (gap > 30) {
      anomalies.push({
        type: "long gap",
        description: `${gap}-day gap between sessions (${filtered[i - 1].date} → ${filtered[i].date})`,
        date: filtered[i].date,
      });
    }
  }

  // --- Summary ----------------------------------------------------------------
  const totalHoursDecimal = (totalMinutes / 60).toFixed(1);
  let summary = "";
  if (sheet.isVirtual) {
    summary = `No equipment (rubber sheets) has been logged in the database yet. `;
    summary += `Across all ${sessionsLogged} logged session${sessionsLogged !== 1 ? "s" : ""}, you have accumulated ${totalHoursDecimal} hours of play time with an average session length of ${avgSessionMinutes} minutes. `;
    summary += `Play frequency averages ${sessionsPerWeek} sessions per week. `;
  } else {
    const sheetStatus =
      sheet.replaced_date === null ? "currently in use" : "retired";

    summary = `The ${sheet.name} rubber sheet has been ${sheetStatus === "currently in use" ? "installed for" : "used for"} ${daysSinceInstall} days${sheetStatus === "currently in use" ? " and is still active" : ` before being replaced on ${sheet.replaced_date}`}. `;
    summary += `Over ${sessionsLogged} logged session${sessionsLogged !== 1 ? "s" : ""}, the sheet has accumulated ${totalHoursDecimal} hours of play time with an average session length of ${avgSessionMinutes} minutes. `;
    summary += `Play frequency averages ${sessionsPerWeek} sessions per week. `;

    if (priorSheet) {
      const diff = parseFloat(totalHoursDecimal) - priorSheet.totalHours;
      if (diff > 0) {
        summary += `Compared to the previous sheet (${priorSheet.name}, ${priorSheet.totalHours} hours), this sheet has already logged ${diff.toFixed(1)} more hours of use.`;
      } else if (diff < 0) {
        summary += `The previous sheet (${priorSheet.name}) accumulated ${priorSheet.totalHours} hours — ${Math.abs(diff).toFixed(1)} hours more than the current sheet so far.`;
      } else {
        summary += `This sheet has matched the previous ${priorSheet.name} at ${priorSheet.totalHours} hours.`;
      }
    }
  }

  // --- Blade tracking ---------------------------------------------------------
  const blades = data.blades || [];
  let bladeStats = null;
  if (blades.length > 0) {
    let activeBlade = blades.find((b) => b.replaced_date === null);
    if (!activeBlade) {
      activeBlade = blades[blades.length - 1];
    }
    
    const bladeInstallDate = activeBlade.installed_date;
    const bladeEndDate = activeBlade.replaced_date || _today();
    
    const bladeSessions = sessions.filter(
      (s) =>
        s.activity_type === "table_tennis" &&
        s.date >= bladeInstallDate &&
        s.date <= bladeEndDate
    );
    
    const bladeMinutes = bladeSessions.reduce((sum, s) => sum + s.duration_minutes, 0);
    const bladeDays = _daysBetween(bladeInstallDate, _today());
    
    bladeStats = {
      name: activeBlade.name,
      totalPlayTime: {
        hours: Math.floor(bladeMinutes / 60),
        minutes: bladeMinutes % 60,
      },
      daysInUse: bladeDays,
      installedDate: bladeInstallDate,
      replacedDate: activeBlade.replaced_date
    };
  }

  // --- Drill stats aggregation ------------------------------------------------
  const drillDurations = {};
  let totalDrillMinutes = 0;

  filtered.forEach(session => {
    // Find matching feedback
    const fb = (feedback || []).find(
      f => f.session_date === session.date && Number(f.session_duration) === session.duration_minutes
    );

    if (fb && fb.drills) {
      try {
        let drillsList = [];
        if (typeof fb.drills === 'string') {
          drillsList = JSON.parse(fb.drills);
        } else if (Array.isArray(fb.drills)) {
          drillsList = fb.drills;
        }

        drillsList.forEach(d => {
          const name = d.name || d.drill || 'Other';
          const dur = Number(d.duration) || 0;
          if (dur > 0) {
            drillDurations[name] = (drillDurations[name] || 0) + dur;
            totalDrillMinutes += dur;
          }
        });
      } catch (e) {
        console.error('Failed to parse drills for session', session.date, e);
      }
    }
  });

  const drillStats = Object.keys(drillDurations).map(name => ({
    name,
    duration: drillDurations[name],
    percentage: totalDrillMinutes > 0 ? Math.round((drillDurations[name] / totalDrillMinutes) * 100) : 0
  })).sort((a, b) => b.duration - a.duration);

  // --- Personalized Rubber Health Estimation ---------------------------------
  let rubberHealth = null;
  if (!sheet.isVirtual) {
    const isFH = sheet.name.includes('(FH)') || sheet.name.toLowerCase().includes('fh');
    const isBH = sheet.name.includes('(BH)') || sheet.name.toLowerCase().includes('bh');
    
    const sameSideSheets = (rubber_sheets || []).filter(s => {
      const nextFH = s.name.includes('(FH)') || s.name.toLowerCase().includes('fh');
      const nextBH = s.name.includes('(BH)') || s.name.toLowerCase().includes('bh');
      return (isFH && nextFH) || (isBH && nextBH);
    });
    
    const sortedSheets = [...sameSideSheets].sort((a, b) => a.installed_date.localeCompare(b.installed_date));
    const historicalLifespans = [];
    
    sortedSheets.forEach((s, idx) => {
      let resolvedReplacedDate = s.replaced_date;
      let isHistorical = false;
      
      if (resolvedReplacedDate && resolvedReplacedDate !== 'replaced' && resolvedReplacedDate !== '') {
        isHistorical = true;
      } else if (idx < sortedSheets.length - 1) {
        resolvedReplacedDate = sortedSheets[idx + 1].installed_date;
        isHistorical = true;
      }
      
      if (isHistorical && resolvedReplacedDate) {
        const historicalSessions = sessions.filter(session => 
          session.activity_type === 'table_tennis' &&
          session.date >= s.installed_date &&
          session.date <= resolvedReplacedDate
        );
        const historicalMinutes = historicalSessions.reduce((sum, session) => sum + session.duration_minutes, 0);
        const historicalHours = historicalMinutes / 60;
        if (historicalHours > 0) {
          historicalLifespans.push(historicalHours);
        }
      }
    });
    
    const avgLifespanHours = historicalLifespans.length > 0
      ? historicalLifespans.reduce((sum, h) => sum + h, 0) / historicalLifespans.length
      : defaultLifespanHours;
      
    const currentPlayHours = totalMinutes / 60;
    
    const isLatest = sortedSheets.length > 0 && sortedSheets[sortedSheets.length - 1].id === sheet.id;
    const isActiveSheet = isLatest && (!sheet.replaced_date || sheet.replaced_date === 'replaced' || sheet.replaced_date === '');
    
    let healthPercent = 0;
    let remainingHours = 0;
    let weeklyPlayHours = 4.0;
    let daysRemaining = 0;
    let estReplaceDateStr = null;
    
    if (isActiveSheet) {
      healthPercent = Math.max(0, Math.min(100, Math.round((1 - currentPlayHours / avgLifespanHours) * 100)));
      remainingHours = Math.max(0, avgLifespanHours - currentPlayHours);
      
      const ttSessions = sessions.filter(s => s.activity_type === 'table_tennis');
      if (ttSessions.length > 0) {
        const sortedSessions = [...ttSessions].sort((a, b) => a.date.localeCompare(b.date));
        const firstSessDate = new Date(sortedSessions[0].date + 'T00:00:00');
        const lastSessDate = new Date(sortedSessions[sortedSessions.length - 1].date + 'T00:00:00');
        const diffTime = Math.abs(lastSessDate - firstSessDate);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) || 1;
        const totalTTMinutes = ttSessions.reduce((sum, s) => sum + s.duration_minutes, 0);
        const totalTTHours = totalTTMinutes / 60;
        const weeks = diffDays / 7;
        if (weeks > 0.5) {
          weeklyPlayHours = totalTTHours / weeks;
        }
      }
      
      if (weeklyPlayHours < 0.5) weeklyPlayHours = 0.5;
      daysRemaining = (remainingHours / weeklyPlayHours) * 7;
      
      const estReplaceDate = new Date(_today() + 'T00:00:00');
      estReplaceDate.setDate(estReplaceDate.getDate() + Math.round(daysRemaining));
      estReplaceDateStr = estReplaceDate.toISOString().slice(0, 10);
    }
    
    rubberHealth = {
      isFH,
      isActiveSheet,
      currentPlayHours: parseFloat(currentPlayHours.toFixed(1)),
      avgLifespanHours: parseFloat(avgLifespanHours.toFixed(1)),
      healthPercent,
      remainingHours: parseFloat(remainingHours.toFixed(1)),
      weeklyPlayHours: parseFloat(weeklyPlayHours.toFixed(1)),
      daysRemaining: Math.round(daysRemaining),
      estReplaceDate: estReplaceDateStr,
      historicalLifespansCount: historicalLifespans.length
    };
  }

  return { keyStats, weeklyStats, chartData, priorSheet, anomalies, summary, bladeStats, drillStats, rubberHealth, filteredSessions: filtered };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _today() {
  return new Date().toISOString().slice(0, 10);
}

function _daysBetween(dateStrA, dateStrB) {
  const a = new Date(dateStrA + "T00:00:00");
  const b = new Date(dateStrB + "T00:00:00");
  return Math.round(Math.abs(b - a) / 86_400_000);
}
