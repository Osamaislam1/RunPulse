// =============================================
//  RunPulse — Themes, Voice, Weather, Map, Race,
//  Training, Social Share
// =============================================

// ---- Theme ----
function applyTheme(theme) {
    const mode = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', mode);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = mode === 'light' ? '#f4f6fb' : '#0a0e1a';
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) { }
    const btn = document.getElementById('themeToggle');
    if (btn) {
        btn.innerHTML = mode === 'light'
            ? '<i class="fa-solid fa-moon"></i>'
            : '<i class="fa-solid fa-sun"></i>';
        btn.title = mode === 'light' ? 'Dark' : 'Light';
    }
}

function initTheme() {
    let theme = 'dark';
    try {
        const saved = localStorage.getItem(THEME_KEY);
        if (saved === 'light' || saved === 'dark') theme = saved;
    } catch (e) { }
    applyTheme(theme);
    const btn = document.getElementById('themeToggle');
    if (btn) {
        btn.addEventListener('click', () => {
            const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
            applyTheme(next);
        });
    }
}

// ---- Voice feedback ----
let voiceEnabled = false;

function initVoice() {
    try { voiceEnabled = localStorage.getItem(VOICE_KEY) === '1'; } catch (e) { }
    const btn = document.getElementById('voiceToggle');
    if (!btn) return;
    btn.classList.toggle('active', voiceEnabled);
    btn.title = voiceEnabled ? t('voiceOn') : t('voiceOff');
    btn.addEventListener('click', () => {
        voiceEnabled = !voiceEnabled;
        try { localStorage.setItem(VOICE_KEY, voiceEnabled ? '1' : '0'); } catch (e) { }
        btn.classList.toggle('active', voiceEnabled);
        btn.title = voiceEnabled ? t('voiceOn') : t('voiceOff');
        showToast(voiceEnabled ? t('voiceOn') : t('voiceOff'));
        if (voiceEnabled) speak(t('voiceOn'));
    });
}

function speak(text) {
    if (!voiceEnabled || !('speechSynthesis' in window)) return;
    try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = currentLang === 'es' ? 'es-ES' : currentLang === 'nl' ? 'nl-NL' : 'en-GB';
        u.rate = 1.05;
        window.speechSynthesis.speak(u);
    } catch (e) { }
}

function announceSegment() {
    if (!voiceEnabled || !segments.length) return;
    const n = segments.length;
    const last = segments[n - 1];
    const dist = totalDistance >= 1000
        ? `${(totalDistance / 1000).toFixed(2)} km`
        : `${Math.round(totalDistance)} m`;
    speak(t('voiceAnnounce', { n, dist, pace: last.paceStr }));
}

// Hook segment completion after core handler finishes
const _origOnSegmentComplete = onSegmentComplete;
onSegmentComplete = function (completedCount) {
    const before = segments.length;
    _origOnSegmentComplete(completedCount);
    if (segments.length > before) {
        announceSegment();
        advanceWorkoutOnSegment();
    }
};

// ---- Weather (Open-Meteo) ----
let weatherFetchedFor = null;

async function fetchWeather(lat, lon) {
    const el = document.getElementById('weatherBadge');
    if (!el) return;
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (weatherFetchedFor === key) return;
    weatherFetchedFor = key;
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('weather http');
        const data = await res.json();
        const cur = data.current;
        if (!cur) throw new Error('no current');
        const label = weatherCodeLabel(cur.weather_code);
        el.classList.remove('hidden');
        el.innerHTML = `<i class="fa-solid fa-cloud-sun"></i> ${Math.round(cur.temperature_2m)}° · ${label}`;
    } catch (e) {
        el.classList.remove('hidden');
        el.textContent = t('weatherUnavailable');
    }
}

function weatherCodeLabel(code) {
    if (code === 0) return 'Clear';
    if (code <= 3) return 'Cloudy';
    if (code <= 67) return 'Rain';
    if (code <= 77) return 'Snow';
    if (code <= 82) return 'Showers';
    if (code <= 99) return 'Storm';
    return '—';
}

// Fetch weather once GPS locks during prepare / first good fix while running
const _origOnPosition = onPosition;
onPosition = function (pos) {
    _origOnPosition(pos);
    if (gpsReady && pos && pos.coords) {
        fetchWeather(pos.coords.latitude, pos.coords.longitude);
    }
    updateRaceUI();
};

// ---- Live Map (Leaflet) ----
let liveMap = null;
let livePolyline = null;
let liveMarker = null;
let histMap = null;
let histPolyline = null;

function initLiveMap() {
    const el = document.getElementById('liveMap');
    if (!el || typeof L === 'undefined') return;
    if (liveMap) return;
    liveMap = L.map(el, { zoomControl: false, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
    }).addTo(liveMap);
    liveMap.setView([20, 0], 2);
    setTimeout(() => liveMap.invalidateSize(), 200);
}

function refreshLiveMap() {
    if (!liveMap || typeof L === 'undefined') return;
    if (!trackPoints.length) return;
    const latlngs = trackPoints.map(p => [p.lat, p.lon]);
    if (!livePolyline) {
        livePolyline = L.polyline(latlngs, { color: '#ff6b35', weight: 4 }).addTo(liveMap);
    } else {
        livePolyline.setLatLngs(latlngs);
    }
    const last = latlngs[latlngs.length - 1];
    if (!liveMarker) {
        liveMarker = L.circleMarker(last, {
            radius: 7, color: '#ff6b35', fillColor: '#ff9a2e', fillOpacity: 1, weight: 2,
        }).addTo(liveMap);
    } else {
        liveMarker.setLatLng(last);
    }
    liveMap.fitBounds(livePolyline.getBounds(), { padding: [24, 24], maxZoom: 16 });
}

onTrackUpdated = function () {
    refreshLiveMap();
};

function showHistoryMap(track) {
    const wrap = document.getElementById('histMapWrap');
    const el = document.getElementById('histMap');
    if (!wrap || !el || typeof L === 'undefined') return;
    if (!track || !track.length) {
        wrap.classList.add('hidden');
        return;
    }
    wrap.classList.remove('hidden');
    if (histMap) {
        histMap.remove();
        histMap = null;
        histPolyline = null;
    }
    // Defer so modal layout is visible
    setTimeout(() => {
        histMap = L.map(el, { zoomControl: true });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; OpenStreetMap',
        }).addTo(histMap);
        const latlngs = track.map(p => [p.lat, p.lon]);
        histPolyline = L.polyline(latlngs, { color: '#ff6b35', weight: 4 }).addTo(histMap);
        L.circleMarker(latlngs[0], { radius: 6, color: '#00e676', fillOpacity: 1 }).addTo(histMap);
        L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color: '#ff5252', fillOpacity: 1 }).addTo(histMap);
        histMap.fitBounds(histPolyline.getBounds(), { padding: [20, 20] });
        setTimeout(() => histMap && histMap.invalidateSize(), 100);
    }, 50);
}

// ---- Race Mode ----
let raceEnabled = false;
let raceTargetM = 5000;
let raceTargetS = 25 * 60;

function initRaceMode() {
    try {
        const raw = localStorage.getItem(RACE_KEY);
        if (raw) {
            const o = JSON.parse(raw);
            raceEnabled = !!o.enabled;
            raceTargetM = o.targetM || 5000;
            raceTargetS = o.targetS || 1500;
        }
    } catch (e) { }
    const toggle = document.getElementById('raceToggle');
    const panel = document.getElementById('racePanel');
    const distSel = document.getElementById('raceDist');
    const timeInput = document.getElementById('raceTime');
    if (toggle) {
        toggle.checked = raceEnabled;
        toggle.addEventListener('change', () => {
            raceEnabled = toggle.checked;
            if (panel) panel.classList.toggle('hidden', !raceEnabled);
            persistRace();
            updateRaceUI();
        });
    }
    if (panel) panel.classList.toggle('hidden', !raceEnabled);
    if (distSel) {
        distSel.value = String(raceTargetM);
        distSel.addEventListener('change', () => {
            raceTargetM = parseInt(distSel.value, 10) || 5000;
            persistRace();
            updateRaceUI();
        });
    }
    if (timeInput) {
        timeInput.value = formatTimeLong(raceTargetS);
        timeInput.addEventListener('change', () => {
            raceTargetS = parseClockToSeconds(timeInput.value) || raceTargetS;
            timeInput.value = formatTimeLong(raceTargetS);
            persistRace();
            updateRaceUI();
        });
    }
}

function persistRace() {
    try {
        localStorage.setItem(RACE_KEY, JSON.stringify({
            enabled: raceEnabled, targetM: raceTargetM, targetS: raceTargetS,
        }));
    } catch (e) { }
}

function parseClockToSeconds(str) {
    const parts = String(str).trim().split(':').map(Number);
    if (parts.some(n => !isFinite(n))) return null;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 1) return parts[0];
    return null;
}

function updateRaceUI() {
    const raceCell = document.getElementById('dispRace');
    const etaCell = document.getElementById('dispETA');
    const label = document.getElementById('raceLabel');
    if (!raceCell || !etaCell) return;

    if (!raceEnabled) {
        raceCell.classList.add('hidden');
        etaCell.classList.remove('hidden');
        if (label) label.textContent = t('est5km');
        return;
    }

    raceCell.classList.remove('hidden');
    etaCell.classList.add('hidden');
    if (label) label.textContent = t('aheadBehind');

    if (!isRunning || isPaused || totalDistance < 50) {
        const goalPace = raceTargetS / (raceTargetM / 1000);
        raceCell.textContent = formatPace(goalPace);
        if (label) label.textContent = t('pace');
        return;
    }
    const elapsed = currentElapsedS();
    const expectedDist = (elapsed / raceTargetS) * raceTargetM;
    const deltaM = totalDistance - expectedDist;
    const goalPaceSecPerM = raceTargetS / raceTargetM;
    const deltaS = Math.round(deltaM * goalPaceSecPerM);
    if (Math.abs(deltaS) < 3) {
        raceCell.textContent = t('raceOnPace');
    } else if (deltaS > 0) {
        raceCell.textContent = t('raceAhead', { s: formatTime(Math.abs(deltaS)) });
    } else {
        raceCell.textContent = t('raceBehind', { s: formatTime(Math.abs(deltaS)) });
    }
}

// ---- Training plans ----
const WORKOUTS = {
    none: { nameKey: 'noWorkout', steps: [] },
    intervals: {
        nameKey: 'intervals',
        steps: [
            { type: 'run', distM: 400, label: '400m' },
            { type: 'rest', timeS: 90, label: 'Rest 90s' },
            { type: 'run', distM: 400, label: '400m' },
            { type: 'rest', timeS: 90, label: 'Rest 90s' },
            { type: 'run', distM: 400, label: '400m' },
            { type: 'rest', timeS: 90, label: 'Rest 90s' },
            { type: 'run', distM: 400, label: '400m' },
            { type: 'rest', timeS: 90, label: 'Rest 90s' },
            { type: 'run', distM: 400, label: '400m' },
        ],
    },
    tempo: {
        nameKey: 'tempo',
        steps: [{ type: 'time', timeS: 20 * 60, label: 'Tempo 20:00' }],
    },
    long: {
        nameKey: 'longRun',
        steps: [{ type: 'run', distM: 10000, label: '10 km' }],
    },
};

let activeWorkoutKey = 'none';
let workoutStepIdx = 0;
let workoutStepStartDist = 0;
let workoutStepStartTime = 0;
let workoutRestUntil = 0;

function initTraining() {
    const sel = document.getElementById('workoutSelect');
    if (!sel) return;
    sel.addEventListener('change', () => {
        activeWorkoutKey = sel.value || 'none';
        resetWorkoutProgress();
        updateWorkoutUI();
    });
    updateWorkoutUI();
}

function resetWorkoutProgress() {
    workoutStepIdx = 0;
    workoutStepStartDist = 0;
    workoutStepStartTime = 0;
    workoutRestUntil = 0;
}

function beginWorkoutTracking() {
    resetWorkoutProgress();
    workoutStepStartDist = totalDistance;
    workoutStepStartTime = Date.now();
    const steps = (WORKOUTS[activeWorkoutKey] || WORKOUTS.none).steps;
    if (steps[0] && steps[0].type === 'rest') {
        workoutRestUntil = Date.now() + steps[0].timeS * 1000;
    }
    updateWorkoutUI();
}

function advanceWorkoutOnSegment() {
    // Distance-based steps also advance via timer poll; segment hook is a cue only.
    updateWorkoutUI();
}

function tickWorkout() {
    const plan = WORKOUTS[activeWorkoutKey];
    if (!plan || !plan.steps.length || !isRunning || isPaused) {
        updateWorkoutUI();
        return;
    }
    const step = plan.steps[workoutStepIdx];
    if (!step) {
        updateWorkoutUI();
        return;
    }
    if (step.type === 'rest') {
        if (Date.now() >= workoutRestUntil) nextWorkoutStep();
    } else if (step.type === 'run') {
        const done = totalDistance - workoutStepStartDist;
        if (done >= step.distM) nextWorkoutStep();
    } else if (step.type === 'time') {
        const elapsed = (Date.now() - workoutStepStartTime) / 1000;
        if (elapsed >= step.timeS) nextWorkoutStep();
    }
    updateWorkoutUI();
}

function nextWorkoutStep() {
    workoutStepIdx++;
    const plan = WORKOUTS[activeWorkoutKey];
    workoutStepStartDist = totalDistance;
    workoutStepStartTime = Date.now();
    const step = plan && plan.steps[workoutStepIdx];
    if (step && step.type === 'rest') {
        workoutRestUntil = Date.now() + step.timeS * 1000;
        speak(step.label);
        showToast(step.label);
    } else if (step) {
        speak(step.label);
        showToast(step.label);
    } else {
        showToast('Workout complete');
        speak('Workout complete');
    }
}

function updateWorkoutUI() {
    const el = document.getElementById('workoutStatus');
    if (!el) return;
    const plan = WORKOUTS[activeWorkoutKey] || WORKOUTS.none;
    if (!plan.steps.length) {
        el.textContent = t('noWorkout');
        return;
    }
    if (workoutStepIdx >= plan.steps.length) {
        el.textContent = '✓ Complete';
        return;
    }
    const step = plan.steps[workoutStepIdx];
    let detail = step.label;
    if (isRunning && !isPaused) {
        if (step.type === 'run') {
            const left = Math.max(0, step.distM - (totalDistance - workoutStepStartDist));
            detail += ` · ${Math.round(left)}m left`;
        } else if (step.type === 'rest') {
            const left = Math.max(0, Math.ceil((workoutRestUntil - Date.now()) / 1000));
            detail += ` · ${left}s`;
        } else if (step.type === 'time') {
            const left = Math.max(0, step.timeS - (Date.now() - workoutStepStartTime) / 1000);
            detail += ` · ${formatTime(left)}`;
        }
    }
    el.textContent = `${workoutStepIdx + 1}/${plan.steps.length}: ${detail}`;
}

const _origStartRun = startRun;
startRun = function () {
    _origStartRun();
    beginWorkoutTracking();
    initLiveMap();
    refreshLiveMap();
};

const _origUpdateTimers = updateTimers;
updateTimers = function () {
    _origUpdateTimers();
    updateRaceUI();
    tickWorkout();
};

// ---- Social share image ----
function buildShareCard(run) {
    const canvas = document.createElement('canvas');
    canvas.width = 1080;
    canvas.height = 1350;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 1080, 1350);
    g.addColorStop(0, '#0a0e1a');
    g.addColorStop(1, '#1c2340');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1080, 1350);

    ctx.fillStyle = '#ff6b35';
    ctx.font = 'bold 48px Inter, sans-serif';
    ctx.fillText('RunPulse', 64, 100);

    const dist = run.distanceM >= 1000
        ? `${(run.distanceM / 1000).toFixed(2)} km`
        : `${Math.round(run.distanceM)} m`;
    ctx.fillStyle = '#eef2ff';
    ctx.font = 'bold 120px Inter, sans-serif';
    ctx.fillText(dist, 64, 280);

    ctx.fillStyle = '#8592ad';
    ctx.font = '36px JetBrains Mono, monospace';
    const avgPace = run.segments && run.segments.length
        ? run.segments.reduce((a, s) => a + s.paceSecKm, 0) / run.segments.length : 0;
    ctx.fillText(`Time  ${formatTimeLong(run.totalTimeS)}`, 64, 380);
    ctx.fillText(`Pace  ${avgPace > 0 ? formatPace(avgPace) + ' /km' : '—'}`, 64, 440);
    ctx.fillText(`Cal   ${run.calories || 0}`, 64, 500);

    // Mini route
    if (run.track && run.track.length > 1) {
        drawTrackOnCanvas(ctx, run.track, 64, 580, 952, 620);
    }

    ctx.fillStyle = '#4a5775';
    ctx.font = '28px Inter, sans-serif';
    const date = new Date(run.date).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
    });
    ctx.fillText(date, 64, 1280);
    return canvas;
}

function drawTrackOnCanvas(ctx, track, x, y, w, h) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    track.forEach(p => {
        minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
        minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    });
    const pad = 0.0001;
    minLat -= pad; maxLat += pad; minLon -= pad; maxLon += pad;
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    roundRect(ctx, x, y, w, h, 24);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = '#ff6b35';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    track.forEach((p, i) => {
        const px = x + 20 + ((p.lon - minLon) / (maxLon - minLon || 1)) * (w - 40);
        const py = y + h - 20 - ((p.lat - minLat) / (maxLat - minLat || 1)) * (h - 40);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

async function shareRun(run) {
    const canvas = buildShareCard(run);
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    if (!blob) return;
    const file = new File([blob], `runpulse_${run.id}.png`, { type: 'image/png' });
    try {
        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
            await navigator.share({ files: [file], title: 'RunPulse', text: 'My run' });
            showToast(t('shareReady'));
            return;
        }
    } catch (e) {
        if (e && e.name === 'AbortError') return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
    showToast(t('shareReady'));
}

// ---- Enhance history modal ----
const _origShowRunDetail = showRunDetail;
showRunDetail = function (run) {
    _origShowRunDetail(run);
    const body = document.getElementById('hModalBody');
    if (!body) return;
    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    actions.innerHTML = `
        <div id="histMapWrap" class="hist-map-wrap hidden"><div id="histMap" class="hist-map"></div></div>
        <div class="data-actions" style="margin-top:1rem;">
            <button type="button" class="btn-secondary" id="shareRunBtn"><i class="fa-solid fa-share-nodes"></i> <span data-i18n="shareRun">${t('shareRun')}</span></button>
        </div>`;
    body.appendChild(actions);
    document.getElementById('shareRunBtn').addEventListener('click', () => shareRun(run));
    showHistoryMap(run.track);
};

// ---- Toast / start messages via i18n (light touch) ----
const _origShowToast = showToast;
showToast = function (msg, duration) {
    const map = {
        'Run started! 🏃': () => t('runStarted'),
        'Run paused ⏸️': () => t('runPaused'),
        'Run resumed! ▶️': () => t('runResumed'),
        'Run saved! ✅': () => t('runSaved'),
        'No GPS data recorded.': () => t('noGps'),
        'Start cancelled.': () => t('startCancelled'),
        'History cleared': () => t('historyCleared'),
        'Data exported! 📁': () => t('dataExported'),
    };
    const mapped = map[msg] ? map[msg]() : msg;
    _origShowToast(mapped, duration);
};

// ---- Boot ----
function initFeatures() {
    initTheme();
    initVoice();
    initRaceMode();
    initTraining();
    initI18n();
    initLiveMap();

    const langSel = document.getElementById('langSelect');
    if (langSel) {
        langSel.addEventListener('change', () => setLanguage(langSel.value));
    }

    // Resize map when switching to Live Run tab
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            if (tab.dataset.page === 'run' && liveMap) {
                setTimeout(() => liveMap.invalidateSize(), 200);
            }
        });
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFeatures);
} else {
    initFeatures();
}
