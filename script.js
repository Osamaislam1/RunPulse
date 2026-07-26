// =============================================
//  RunPulse — Live GPS Tracker — Main Script
// =============================================

// ---- State ----
let isRunning = false;
let isPaused = false;
let watchId = null;
let timerInterval = null;
let wakeLock = null;

let startTime = 0;
let segmentStartTime = 0;
let elapsedPauseMs = 0;
let pauseStartTime = 0;

let totalDistance = 0;
let previousPosition = null;
let segments = [];
let segmentSize = 250;

let chartInstance = null;
let lastElevation = null;
let elevationGain = 0;

let lastAccuracy = null;      // Most recent reported accuracy, for the GPS lock screen
let startPending = false;     // True between tapping Start and the run actually beginning

// ---- GPS Filtering ----
const MAX_ACCURACY = 50;      // Reject positions worse than 50m accuracy
const GPS_WARMUP_ACC = 20;    // Wait until GPS accuracy is this good before tracking
const MIN_DELTA = 2.0;        // Minimum metres movement before adding distance
const MAX_SPEED_MPS = 10;     // Reject GPS jumps implying speed > 36 km/h
const MAX_ALT_ACCURACY = 15;  // Ignore altitude from fixes less certain than this
const MIN_ELEVATION_DELTA = 3;// Altitude change that counts as real climb, not noise
const GPS_STALE_MS = 5000;    // No fresh fix for this long => blank the live readouts
const GPS_LOCK_HINT_MS = 15000; // Offer "start anyway" after waiting this long for a lock
const PACE_WINDOW_MS = 30000; // Rolling window backing the live pace figure
const PACE_MAX_DT = 10;       // Discard pace samples spanning a longer gap than this (s)
// Floor on how long the "Acquiring GPS" gate stays up. Without this, a fast lock (warm
// receiver, cached fix) can resolve inside one poll tick and the gate flashes by unreadably.
const MIN_GPS_VISIBLE_MS = 700;
const OVERLAY_FADE_MS = 200;   // Must match the .countdown-overlay transition duration in CSS

// Shared watchPosition options — every caller must use the same settings.
const GEO_OPTS = { enableHighAccuracy: true, timeout: 12000, maximumAge: 1000 };

// =====================
// Countdown Overlay show/hide (fade, not an instant display:none<->flex pop)
// =====================
function showOverlay() {
    const overlay = document.getElementById('countdownOverlay');
    overlay.classList.remove('hidden');
    // Force layout so the browser commits display:flex before opacity animates — adding
    // 'visible' in the same tick as removing 'hidden' would skip the transition entirely.
    void overlay.offsetWidth;
    overlay.classList.add('visible');
}

function hideOverlay() {
    const overlay = document.getElementById('countdownOverlay');
    overlay.classList.remove('visible');
    setTimeout(() => overlay.classList.add('hidden'), OVERLAY_FADE_MS);
}

// ---- Kalman Filter State ----
// Independently filters latitude and longitude using a 1D Kalman filter.
// This is the same principle used in professional GPS trackers (Strava, Garmin).
let kfLat = null;  // { value, variance }
let kfLon = null;  // { value, variance }
let gpsReady = false; // True once GPS has acquired good initial accuracy

// Process noise: how much we expect position to change per second (in degrees²)
// Lower = smoother but laggier. ~0.5m/s → ~4.5e-9 degrees²/s
const KF_PROCESS_NOISE = 5e-9;

function kalmanUpdate(kf, measurement, accuracy) {
    // Measurement noise: scale accuracy (metres) to degrees² (~8e-11)
    const measurementVariance = (accuracy * accuracy) * 1e-10;

    if (!kf) {
        // Initialize filter with first measurement
        return { value: measurement, variance: measurementVariance };
    }

    // Prediction step: add process noise (account for movement since last update)
    const predictedVariance = kf.variance + KF_PROCESS_NOISE;

    // Update step: blend prediction with measurement, weighted by their uncertainties
    const gain = predictedVariance / (predictedVariance + measurementVariance); // Kalman Gain
    const updatedValue = kf.value + gain * (measurement - kf.value);
    const updatedVariance = (1 - gain) * predictedVariance;

    return { value: updatedValue, variance: updatedVariance };
}

const SEGMENT_SIZE_KEY = 'lrt_seg_size';
const HISTORY_KEY = 'lrt_history';

// =====================
// Particles Background
// =====================
(function initParticles() {
    const canvas = document.getElementById('particleCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let particles = [];
    const COUNT = 30;

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    for (let i = 0; i < COUNT; i++) {
        particles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            r: Math.random() * 1.5 + 0.5,
            dx: (Math.random() - 0.5) * 0.3,
            dy: (Math.random() - 0.5) * 0.3,
            alpha: Math.random() * 0.3 + 0.05
        });
    }

    function draw() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => {
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, 107, 53, ${p.alpha})`;
            ctx.fill();
            p.x += p.dx;
            p.y += p.dy;
            if (p.x < 0 || p.x > canvas.width) p.dx *= -1;
            if (p.y < 0 || p.y > canvas.height) p.dy *= -1;
        });
        requestAnimationFrame(draw);
    }
    draw();
})();

// =====================
// Toast Notification
// =====================
// Timers live in module scope so a second toast cancels the first one's dismissal
// instead of being cut short by it.
let toastHideTimer = null;
let toastCleanupTimer = null;

function showToast(msg, duration = 2500) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMsg');
    clearTimeout(toastHideTimer);
    clearTimeout(toastCleanupTimer);
    toastMsg.textContent = msg;
    toast.classList.remove('hidden');
    requestAnimationFrame(() => toast.classList.add('show'));
    toastHideTimer = setTimeout(() => {
        toast.classList.remove('show');
        toastCleanupTimer = setTimeout(() => toast.classList.add('hidden'), 350);
    }, duration);
}

// =====================
// Wake Lock
// =====================
async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    if (wakeLock) return;   // already held — re-requesting would leak the old sentinel
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        setWakeStatus(true);
        // Clear the handle on release (the browser drops the lock when the page is
        // hidden), so the visibilitychange handler can re-acquire it on return.
        wakeLock.addEventListener('release', () => {
            wakeLock = null;
            setWakeStatus(false);
        });
    } catch (e) {
        console.warn('Wake lock denied:', e.message);
    }
}

function releaseWakeLock() {
    if (wakeLock) { wakeLock.release(); wakeLock = null; }
    setWakeStatus(false);
}

function setWakeStatus(active) {
    document.getElementById('wakeDot').classList.toggle('active', active);
    document.getElementById('wakeText').textContent = active ? 'ON' : 'OFF';
    document.getElementById('wakeIndicator').classList.toggle('active', active);
}

document.addEventListener('visibilitychange', async () => {
    if (isRunning && !isPaused && document.visibilityState === 'visible') {
        await acquireWakeLock();
    }
});

// =====================
// Location Permission
// =====================
// Android/Chrome's "Only this time" grant expires each session, causing the
// native permission dialog to reappear on every run. Surfacing an explicit
// check + request step (instead of only prompting implicitly inside
// startRun's watchPosition call) lets the user grant it deliberately, and
// "denied" can only be undone by the user in browser/site settings — JS
// cannot force a re-prompt, so that state gets inline guidance instead.
let lastPermState = 'unknown';

function setPermStatus(state) {
    lastPermState = state;
    const dot = document.getElementById('permDot');
    const text = document.getElementById('permText');
    const btn = document.getElementById('permBtn');
    const help = document.getElementById('permHelp');

    btn.classList.add('hidden');
    help.classList.add('hidden');

    if (state === 'granted') {
        dot.className = 'perm-dot good';
        text.textContent = 'Location access granted';
    } else if (state === 'denied') {
        dot.className = 'perm-dot bad';
        text.textContent = 'Location blocked';
        help.classList.remove('hidden');
    } else {
        dot.className = 'perm-dot weak';
        text.textContent = 'Location permission needed';
        btn.classList.remove('hidden');
    }
}

async function checkGeoPermission() {
    if (!navigator.geolocation) {
        setPermStatus('denied');
        return;
    }
    if (!navigator.permissions || !navigator.permissions.query) {
        // Safari/iOS: no Permissions API for geolocation — assume prompt state
        setPermStatus('prompt');
        return;
    }
    try {
        const status = await navigator.permissions.query({ name: 'geolocation' });
        setPermStatus(status.state);
        status.onchange = () => setPermStatus(status.state);
    } catch (e) {
        setPermStatus('prompt');
    }
}

function requestGeoPermission() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) { resolve(false); return; }
        navigator.geolocation.getCurrentPosition(
            () => { checkGeoPermission(); resolve(true); },
            () => { checkGeoPermission(); resolve(false); },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
        );
    });
}

document.getElementById('permBtn').addEventListener('click', requestGeoPermission);
checkGeoPermission();

// =====================
// Nav Tabs with Indicator
// =====================
const navTabs = document.querySelectorAll('.nav-tab');
const navIndicator = document.getElementById('navIndicator');

function updateNavIndicator() {
    const activeTab = document.querySelector('.nav-tab.active');
    if (activeTab && navIndicator) {
        navIndicator.style.left = activeTab.offsetLeft + 'px';
        navIndicator.style.width = activeTab.offsetWidth + 'px';
    }
}

navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        navTabs.forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const page = document.getElementById(`page-${tab.dataset.page}`);
        if (page) page.classList.add('active');
        updateNavIndicator();
        if (tab.dataset.page === 'history') renderHistory();
        if (tab.dataset.page === 'stats') renderStats();
    });
});

window.addEventListener('load', updateNavIndicator);
window.addEventListener('resize', updateNavIndicator);

// =====================
// Segment Size
// =====================
const savedSeg = localStorage.getItem(SEGMENT_SIZE_KEY);
if (savedSeg) segmentSize = parseInt(savedSeg);

document.querySelectorAll('.seg-pill').forEach(pill => {
    if (parseInt(pill.dataset.size) === segmentSize) pill.classList.add('active');
    else pill.classList.remove('active');

    pill.addEventListener('click', () => {
        if (isRunning) return;
        document.querySelectorAll('.seg-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        segmentSize = parseInt(pill.dataset.size);
        localStorage.setItem(SEGMENT_SIZE_KEY, segmentSize);
        updateSplitTableHeader();
    });
});

function updateSplitTableHeader() {
    document.getElementById('splitTableLabel').textContent =
        `${segmentSize * 4}m Group Table (4 × ${segmentSize}m)`;
}
updateSplitTableHeader();

// =====================
// Countdown
// =====================
function runCountdown() {
    return new Promise(resolve => {
        const body = document.getElementById('countdownBody');
        const num = document.getElementById('countdownNum');
        showOverlay();   // no-op if waitForGpsLock already left it open
        body.classList.remove('hidden');
        let count = 3;
        num.textContent = count;

        const interval = setInterval(() => {
            count--;
            if (count > 0) {
                num.textContent = count;
            } else if (count === 0) {
                num.textContent = 'GO!';
                num.style.fontSize = '5rem';
            } else {
                clearInterval(interval);
                num.style.fontSize = '';
                body.classList.add('hidden');
                hideOverlay();
                resolve();
            }
        }, 800);
    });
}

// =====================
// GPS Lock Gate
// =====================
// The receiver needs 10-30s to reach a usable fix. Previously the countdown ran first
// and watchPosition started cold afterwards, so the warm-up happened while the user was
// already running and the opening 20-60m were never counted. Now the watch is started
// first and the countdown waits behind this gate.
function waitForGpsLock() {
    return new Promise(resolve => {
        const wait = document.getElementById('gpsWait');
        const body = document.getElementById('countdownBody');
        const accEl = document.getElementById('gpsWaitAcc');
        const anyway = document.getElementById('gpsStartAnyway');
        const cancel = document.getElementById('gpsCancel');

        showOverlay();
        body.classList.add('hidden');
        wait.classList.remove('hidden');
        anyway.classList.add('hidden');

        let settled = false;
        let minTimeTimer = null;
        function finish(locked) {
            if (settled) return;
            settled = true;
            clearInterval(poll);
            clearTimeout(minTimeTimer);
            anyway.onclick = null;
            cancel.onclick = null;
            wait.classList.add('hidden');
            if (!locked) hideOverlay();
            resolve(locked);
        }

        const startedAt = Date.now();
        // A lock detected automatically (the common case) waits out a minimum display time
        // so a fast lock doesn't flash by before the user can read it. A lock accepted via
        // the user's own "Start anyway" click below bypasses this and finishes immediately
        // — that's already a deliberate action, not something to delay further.
        function finishLocked() {
            const remaining = MIN_GPS_VISIBLE_MS - (Date.now() - startedAt);
            if (remaining > 0) minTimeTimer = setTimeout(() => finish(true), remaining);
            else finish(true);
        }

        const poll = setInterval(() => {
            if (gpsReady) { clearInterval(poll); finishLocked(); return; }
            accEl.textContent = lastAccuracy != null
                ? `±${lastAccuracy.toFixed(0)}m — need ±${GPS_WARMUP_ACC}m`
                : 'Waiting for first fix…';
            // Never trap the user behind a lock that may never come (indoors, poor sky view).
            if (Date.now() - startedAt > GPS_LOCK_HINT_MS) anyway.classList.remove('hidden');
        }, 500);

        anyway.onclick = () => {
            // Accept a worse fix deliberately: tracking starts now, accuracy be damned.
            gpsReady = true;
            finish(true);
        };
        cancel.onclick = () => finish(false);

        if (gpsReady) finishLocked();
    });
}

// =====================
// GPS Watch (single owner of watchId)
// =====================
function startGpsWatch() {
    if (watchId !== null) return;
    watchId = navigator.geolocation.watchPosition(onPosition, onGPSError, GEO_OPTS);
}

function stopGpsWatch() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
}

// Elapsed run seconds, excluding all paused time — including a pause that is still open.
// Single source of truth: stopRun, saveRun, updateTimers and the 5k projection all use it.
function currentElapsedS() {
    if (!startTime) return 0;
    const pausedMs = elapsedPauseMs + (isPaused && pauseStartTime ? Date.now() - pauseStartTime : 0);
    return (Date.now() - startTime - pausedMs) / 1000;
}

// =====================
// Start / Pause / Stop
// =====================
document.getElementById('btnStart').addEventListener('click', async () => {
    // Must happen synchronously inside the gesture, before any await, or iOS will not
    // let the audio context resume and segment beeps stay silent all run.
    unlockAudio();

    if (isPaused) {
        resumeRun();
        return;
    }
    if (startPending) return;

    if (lastPermState === 'denied') {
        document.getElementById('permHelp').classList.remove('hidden');
        showToast('Location is blocked — enable it in browser settings.');
        return;
    }
    if (lastPermState !== 'granted') {
        const granted = await requestGeoPermission();
        if (!granted) {
            showToast('Location permission is required to start a run.');
            return;
        }
    }

    startPending = true;
    try {
        if (!navigator.geolocation) { alert('Geolocation not supported.'); return; }
        prepareRun();
        const locked = await waitForGpsLock();
        if (!locked) {
            abortPreparedRun();
            return;
        }
        await runCountdown();
        startRun();
    } finally {
        startPending = false;
    }
});

document.getElementById('btnPause').addEventListener('click', pauseRun);
document.getElementById('btnStop').addEventListener('click', stopRun);

// Phase 1 of starting: clear tracking state and get the receiver warming up. The run
// clock does NOT start here — startRun() does that once GPS is locked and the countdown
// has finished. onPosition refuses to accumulate distance while isRunning is false.
function prepareRun() {
    isRunning = false;
    isPaused = false;
    totalDistance = 0;
    previousPosition = null;
    segments = [];
    elapsedPauseMs = 0;
    pauseStartTime = 0;
    elevationGain = 0;
    lastElevation = null;
    kfLat = null;
    kfLon = null;
    gpsReady = false;
    lastAccuracy = null;
    startTime = 0;
    paceBuffer = [];

    resetDisplay();
    startGpsWatch();
    // Waiting for a lock can take 30s of standing still — don't let the screen sleep.
    acquireWakeLock();
}

function abortPreparedRun() {
    stopGpsWatch();
    releaseWakeLock();
    setGPSStatus('stopped', 'GPS: stopped');
    showToast('Start cancelled.');
}

// Phase 2: GPS is locked and the countdown has run — start the clock.
function startRun() {
    isRunning = true;
    isPaused = false;
    startTime = Date.now();
    segmentStartTime = startTime;

    const btnStart = document.getElementById('btnStart');
    const btnPause = document.getElementById('btnPause');
    const btnStop = document.getElementById('btnStop');

    btnStart.classList.add('running');
    btnStart.disabled = true;
    btnStart.classList.add('hidden');
    btnPause.classList.remove('hidden');
    btnStop.disabled = false;
    document.querySelectorAll('.seg-pill').forEach(p => p.style.pointerEvents = 'none');

    timerInterval = setInterval(updateTimers, 500);
    startGpsWatch();   // no-op if prepareRun's watch is still live
    acquireWakeLock();

    // Last, and non-fatal: Chart.js is CDN-loaded and may be missing offline. Nothing
    // below this line is required for the run to be tracked.
    initChart();

    showToast('Run started! 🏃');
}

function pauseRun() {
    isPaused = true;
    pauseStartTime = Date.now();
    clearInterval(timerInterval);

    const btnStart = document.getElementById('btnStart');
    const btnPause = document.getElementById('btnPause');
    btnStart.classList.remove('hidden');
    btnStart.disabled = false;
    btnStart.innerHTML = '<i class="fa-solid fa-play"></i> Resume';
    btnStart.classList.remove('running');
    btnPause.classList.add('hidden');

    // The watch stays live. onPosition early-returns while paused, so no distance is
    // accumulated, and keeping the receiver warm avoids paying the 10-30s warm-up cost
    // again on resume — which used to silently drop the first stretch after every pause.
    showToast('Run paused ⏸️');
}

function resumeRun() {
    const pausedFor = Date.now() - pauseStartTime;
    isPaused = false;
    elapsedPauseMs += pausedFor;
    // Charge the pause to the pause ledger, not to the segment in progress.
    segmentStartTime += pausedFor;
    pauseStartTime = 0;

    const btnStart = document.getElementById('btnStart');
    const btnPause = document.getElementById('btnPause');
    btnStart.classList.add('hidden');
    btnStart.disabled = true;
    btnStart.classList.add('running');
    btnPause.classList.remove('hidden');

    timerInterval = setInterval(updateTimers, 500);

    // Re-anchor position: the filter estimate is stale if the user moved while paused,
    // and previousPosition must not bridge the gap as travelled distance. gpsReady stays
    // true — the receiver never stopped, so there is nothing to warm up.
    previousPosition = null;
    kfLat = null;
    kfLon = null;

    showToast('Run resumed! ▶️');
}

function stopRun() {
    // Settle an open pause into both ledgers before measuring anything. Finishing while
    // paused used to charge the entire final pause to run time (and to the in-progress
    // segment), inflating the saved total time and average pace permanently.
    if (isRunning && isPaused && pauseStartTime) {
        const pausedFor = Date.now() - pauseStartTime;
        elapsedPauseMs += pausedFor;
        segmentStartTime += pausedFor;
        pauseStartTime = 0;
    }

    // Capture run data BEFORE resetting state
    const hadDistance = totalDistance > 0;
    const runDurationS = isRunning ? currentElapsedS() : 0;

    isRunning = false;
    isPaused = false;
    stopGpsWatch();
    clearInterval(timerInterval);
    releaseWakeLock();

    const btnStart = document.getElementById('btnStart');
    const btnPause = document.getElementById('btnPause');
    const btnStop = document.getElementById('btnStop');

    btnStart.classList.remove('running', 'hidden');
    btnStart.innerHTML = '<i class="fa-solid fa-play"></i> Start Run';
    btnStart.disabled = false;
    btnPause.classList.add('hidden');
    btnStop.disabled = true;
    document.querySelectorAll('.seg-pill').forEach(p => p.style.pointerEvents = '');
    setGPSStatus('stopped', 'GPS: stopped');

    // When stopped, show accurate average pace (total time / total distance).
    // Old logic: PACE stayed at last "live pace" from updateLivePace (rolling buffer);
    // that value was frozen when GPS stopped, so it could be way off (e.g. 6:27 vs true 5:09 for 5 km in 25:44).
    if (hadDistance && totalDistance > 0 && runDurationS > 0) {
        const avgPaceSecKm = (runDurationS / totalDistance) * 1000;
        document.getElementById('dispPace').textContent = formatPace(avgPaceSecKm);
    }

    // Save if any distance was tracked (even partial segments count)
    if (hadDistance && runDurationS > 5) {
        // Flush final segment if distance passed the threshold but no GPS update recorded it
        const completedSegs = Math.floor(totalDistance / segmentSize);
        if (completedSegs > segments.length) {
            const now = Date.now();
            const segTimeS = (now - segmentStartTime) / 1000;
            const distLabel = (segments.length + 1) * segmentSize;
            const paceSecKm = segTimeS > 0 ? (segTimeS / segmentSize) * 1000 : 0;
            const paceStr = formatPace(paceSecKm);
            segments.push({ distLabel, timeS: segTimeS, paceSecKm, paceStr });
            renderSegmentLog();
            updateSegCount();
            updateSplitTable();
            updateChart();
        }
        saveRun(runDurationS);
        showToast('Run saved! ✅');
    } else if (segments.length === 0 && totalDistance === 0) {
        showToast('No GPS data recorded.');
    }
}

// =====================
// GPS Position Handler
// =====================
function onPosition(pos) {
    if (isPaused) return;
    const { latitude, longitude, accuracy, altitude, altitudeAccuracy } = pos.coords;
    lastAccuracy = accuracy;

    // Hard reject: too inaccurate to be of any use
    if (accuracy > MAX_ACCURACY) {
        setGPSStatus('bad', `GPS: ±${accuracy.toFixed(1)}m — skipped`);
        return;
    }

    // Elevation tracking — deliberately below the accuracy gate, since a fix too poor to
    // trust for position is also too poor to trust for altitude. Raw GPS altitude drifts
    // by +/-10-30m, so only changes clearing MIN_ELEVATION_DELTA from the last committed
    // reading count; otherwise a flat run accumulates hundreds of metres of fake climb.
    if (altitude != null && altitudeAccuracy != null && altitudeAccuracy <= MAX_ALT_ACCURACY) {
        if (lastElevation === null) {
            lastElevation = altitude;
        } else if (Math.abs(altitude - lastElevation) >= MIN_ELEVATION_DELTA) {
            if (altitude > lastElevation) elevationGain += altitude - lastElevation;
            lastElevation = altitude;
        }
        document.getElementById('dispElevation').textContent = `${Math.round(elevationGain)}m`;
    }

    // GPS quality status
    if (accuracy <= 8) setGPSStatus('good', `GPS: ±${accuracy.toFixed(1)}m — excellent`);
    else if (accuracy <= 15) setGPSStatus('good', `GPS: ±${accuracy.toFixed(1)}m — good`);
    else setGPSStatus('weak', `GPS: ±${accuracy.toFixed(1)}m — fair`);

    const accBadge = document.getElementById('gpsAccBadge');
    if (accBadge) accBadge.textContent = `±${accuracy.toFixed(0)}m`;

    // --- Kalman Filter: update estimated position ---
    kfLat = kalmanUpdate(kfLat, latitude, accuracy);
    kfLon = kalmanUpdate(kfLon, longitude, accuracy);

    const filteredLat = kfLat.value;
    const filteredLon = kfLon.value;

    // GPS Warm-up: wait for a good initial fix before committing positions
    if (!gpsReady) {
        if (accuracy <= GPS_WARMUP_ACC) {
            gpsReady = true;
            previousPosition = pos;
            previousPosition.filteredLat = filteredLat;
            previousPosition.filteredLon = filteredLon;
            setGPSStatus('good', `GPS: ±${accuracy.toFixed(1)}m — locked!`);
        } else {
            setGPSStatus('weak', `GPS: ±${accuracy.toFixed(1)}m — acquiring...`);
        }
        return;
    }

    if (!previousPosition) {
        previousPosition = pos;
        previousPosition.filteredLat = filteredLat;
        previousPosition.filteredLon = filteredLon;
        return;
    }

    const prevLat = previousPosition.filteredLat;
    const prevLon = previousPosition.filteredLon;

    const delta = haversine(prevLat, prevLon, filteredLat, filteredLon);
    const dt = (pos.timestamp - previousPosition.timestamp) / 1000;

    // Speed spike rejection: discard impossible GPS jumps, rollback Kalman state
    if (dt > 0 && delta / dt > MAX_SPEED_MPS) {
        kfLat = { value: prevLat, variance: kfLat.variance };
        kfLon = { value: prevLon, variance: kfLon.variance };
        return;
    }

    // Locked but not started yet (GPS gate / countdown): keep the filter and the reference
    // position current so the first metres after "GO!" are measured from where the user
    // actually is, but do not bank distance against a clock that has not started.
    if (!isRunning) {
        pos.filteredLat = filteredLat;
        pos.filteredLon = filteredLon;
        previousPosition = pos;
        return;
    }

    // Anti-drift: ignore tiny movements that are just GPS noise
    if (delta < MIN_DELTA) {
        // Do not update previousPosition, preserving distance accumulation for slow walkers
        return;
    }

    totalDistance += delta;
    pos.filteredLat = filteredLat;
    pos.filteredLon = filteredLon;
    previousPosition = pos;

    // Update distance display
    const distEl = document.getElementById('dispDist');
    distEl.textContent = totalDistance >= 1000
        ? (totalDistance / 1000).toFixed(2)
        : Math.round(totalDistance).toFixed(0);
    document.querySelector('#distCard .bs-unit').textContent =
        totalDistance >= 1000 ? 'kilometres' : 'metres';

    // Calories (rough: ~60 cal/km for 70kg runner)
    document.getElementById('dispCalories').textContent = Math.round(totalDistance / 1000 * 62);

    // Speed km/h
    if (dt > 0) {
        const speedKmH = (delta / dt) * 3.6;
        document.getElementById('dispSpeed').textContent = speedKmH.toFixed(1);
    }

    const completedSegs = Math.floor(totalDistance / segmentSize);
    if (completedSegs > segments.length) {
        onSegmentComplete(completedSegs);
    }

    updateLivePace(delta, dt);
}

function onGPSError(err) {
    setGPSStatus('bad', `GPS error: ${err.message}`);
}

// =====================
// Segment Completion
// =====================
function onSegmentComplete(completedCount) {
    while (segments.length < completedCount) {
        const now = Date.now();
        const segTimeS = (now - segmentStartTime) / 1000;
        const distLabel = (segments.length + 1) * segmentSize;
        const paceSecKm = segTimeS > 0 ? (segTimeS / segmentSize) * 1000 : 0;
        const paceStr = formatPace(paceSecKm);

        segments.push({ distLabel, timeS: segTimeS, paceSecKm, paceStr });
        segmentStartTime = now;

        try { navigator.vibrate && navigator.vibrate([100, 50, 100]); } catch (e) { }
        playBeep();

        renderSegmentLog();
        updateSegCount();
        updateSplitTable();
        updateChart();
        document.getElementById('dispSegTimer').textContent = '00:00';
    }
}

// =====================
// Timer
// =====================
function updateTimers() {
    if (!isRunning || isPaused) return;
    const elapsed = currentElapsedS();
    document.getElementById('dispTimer').textContent = formatTimeLong(elapsed);

    const segElapsed = (Date.now() - segmentStartTime) / 1000;
    document.getElementById('dispSegTimer').textContent = formatTime(segElapsed);

    // No fresh GPS for a while (stationary at a light): every rate-derived readout is
    // stale, so blank them rather than displaying a frozen number as if it were live.
    const gpsStale = previousPosition && (Date.now() - previousPosition.timestamp > GPS_STALE_MS);
    if (gpsStale) {
        document.getElementById('dispPace').textContent = '–:––';
        document.getElementById('dispSpeed').textContent = '0.0';
        document.getElementById('dispETA').textContent = '––:––';
    } else if (totalDistance > 100 && elapsed > 0) {
        // Whole-run projection, so it belongs on the clock tick rather than inside the
        // live-pace path where it only updated when a pace sample happened to qualify.
        document.getElementById('dispETA').textContent = formatTimeLong((elapsed / totalDistance) * 5000);
    }
}

// =====================
// Live Pace (rolling time window; only used while running)
// When run is stopped, stopRun() sets PACE to average pace (total time / total distance).
// =====================
let paceBuffer = [];
function updateLivePace(delta, dt) {
    // A large dt means the runner was standing still and MIN_DELTA held previousPosition
    // back, so this sample spans a stationary gap and says nothing about current pace.
    // The old count-based buffer let one such sample skew the display for minutes.
    if (dt > 0 && dt <= PACE_MAX_DT) {
        paceBuffer.push({ delta, dt, t: Date.now() });
    }

    const cutoff = Date.now() - PACE_WINDOW_MS;
    paceBuffer = paceBuffer.filter(s => s.t >= cutoff);

    const totalD = paceBuffer.reduce((a, b) => a + b.delta, 0);
    const totalT = paceBuffer.reduce((a, b) => a + b.dt, 0);
    if (totalD > 5 && totalT > 0) {
        const secKm = 1000 / (totalD / totalT);
        document.getElementById('dispPace').textContent = formatPace(secKm);
    }
}

// =====================
// Segment Log Render
// =====================
function renderSegmentLog() {
    const container = document.getElementById('logContainer');
    container.innerHTML = '';

    if (segments.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="fa-solid fa-satellite-dish"></i><p>Segment times will appear here.</p></div>';
        return;
    }

    const avgPace = segments.reduce((a, b) => a + b.paceSecKm, 0) / segments.length;
    const bestPace = Math.min(...segments.map(s => s.paceSecKm));
    const worstPace = Math.max(...segments.map(s => s.paceSecKm));

    // Update best badge
    const bestBadge = document.getElementById('bestBadge');
    const bestPaceVal = document.getElementById('bestPaceVal');
    if (bestBadge && bestPaceVal) {
        bestBadge.classList.remove('hidden');
        bestPaceVal.textContent = formatPace(bestPace) + '/km';
    }

    // Render newest first
    for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        let zone = 'avg';
        if (seg.paceSecKm < avgPace * 0.97) zone = 'fast';
        else if (seg.paceSecKm > avgPace * 1.03) zone = 'slow';

        let extraClass = '';
        if (seg.paceSecKm === bestPace && segments.length > 2) extraClass = ' best-seg';
        else if (seg.paceSecKm === worstPace && segments.length > 2) extraClass = ' worst-seg';

        const item = document.createElement('div');
        item.className = 'log-item' + extraClass;
        item.innerHTML = `
            <span class="li-dist">${seg.distLabel}m</span>
            <span></span>
            <span class="li-time">${formatTime(seg.timeS)}</span>
            <span class="li-pace">${seg.paceStr}<br>/km</span>
            <span class="li-zone"><span class="z-dot ${zone}"></span></span>
        `;
        container.appendChild(item);
    }
}

function updateSegCount() {
    const el = document.getElementById('segCountBadge');
    if (el) el.textContent = `${segments.length} completed`;
}

// =====================
// Split Table
// =====================
function updateSplitTable() {
    const tbody = document.getElementById('splitBody');
    tbody.innerHTML = '';
    const avgPace = segments.reduce((a, b) => a + b.paceSecKm, 0) / segments.length;

    for (let i = 0; i < segments.length; i += 4) {
        const group = segments.slice(i, i + 4);
        const tr = document.createElement('tr');
        const fromDist = i * segmentSize;
        let cells = `<td>${fromDist}m</td>`;
        let groupTotal = 0;
        for (let j = 0; j < 4; j++) {
            if (j < group.length) {
                const s = group[j];
                groupTotal += s.timeS;
                let cls = '';
                if (s.paceSecKm < avgPace * 0.97) cls = 'col-fast';
                else if (s.paceSecKm > avgPace * 1.03) cls = 'col-slow';
                else cls = 'col-avg';
                cells += `<td class="${cls}">${formatTime(s.timeS)}</td>`;
            } else {
                cells += `<td style="color:var(--text3)">–</td>`;
            }
        }
        cells += `<td style="font-weight:700">${formatTime(groupTotal)}</td>`;
        tr.innerHTML = cells;
        tbody.insertBefore(tr, tbody.firstChild);
    }
}

// =====================
// Chart
// =====================
// Chart.js loads from a CDN, so offline it is simply absent. A run must never fail to
// start because the chart could not be built — the chart is the least important thing
// on this screen.
function setChartAvailable(available) {
    const canvas = document.getElementById('runChart');
    const fallback = document.getElementById('chartFallback');
    if (canvas) canvas.classList.toggle('hidden', !available);
    if (fallback) fallback.classList.toggle('hidden', available);
}

function initChart() {
    const canvas = document.getElementById('runChart');
    if (!canvas) return;

    if (typeof Chart === 'undefined') {
        console.warn('Chart.js unavailable — continuing without the pace chart.');
        chartInstance = null;
        setChartAvailable(false);
        return;
    }

    try {
        if (chartInstance) chartInstance.destroy();
        chartInstance = buildChart(canvas);
        setChartAvailable(true);
    } catch (e) {
        console.warn('Chart init failed — continuing without the pace chart:', e);
        chartInstance = null;
        setChartAvailable(false);
    }
}

function buildChart(canvas) {
    return new Chart(canvas, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: `Pace per ${segmentSize}m`,
                data: [],
                borderColor: '#ff6b35',
                backgroundColor: (ctx) => {
                    const chart = ctx.chart;
                    const { ctx: c, chartArea } = chart;
                    if (!chartArea) return 'rgba(255,107,53,0.1)';
                    const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                    gradient.addColorStop(0, 'rgba(255, 107, 53, 0.25)');
                    gradient.addColorStop(1, 'rgba(255, 107, 53, 0.02)');
                    return gradient;
                },
                borderWidth: 2.5,
                tension: 0.4,
                fill: true,
                pointRadius: 4,
                pointBackgroundColor: '#ff9a2e',
                pointBorderColor: '#ff6b35',
                pointBorderWidth: 1.5,
                pointHoverRadius: 7,
                pointHoverBackgroundColor: '#fff',
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 400, easing: 'easeOutQuart' },
            scales: {
                y: {
                    grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
                    ticks: { color: '#4a5775', font: { size: 10, family: 'JetBrains Mono' }, callback: v => v.toFixed(0) + 's' },
                },
                x: {
                    grid: { color: 'rgba(255,255,255,0.04)', drawBorder: false },
                    ticks: { color: '#4a5775', font: { size: 9, family: 'JetBrains Mono' }, maxRotation: 45, maxTicksLimit: 12, autoSkip: true },
                },
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(10,14,26,0.95)',
                    titleColor: '#eef2ff',
                    bodyColor: '#8592ad',
                    borderColor: 'rgba(255,107,53,0.3)',
                    borderWidth: 1,
                    cornerRadius: 10,
                    padding: 10,
                    callbacks: {
                        label: ctx => `Time: ${formatTime(ctx.raw)} | Pace: ${formatPace(ctx.raw / segmentSize * 1000)}`,
                    },
                },
            },
        },
    });
}

function updateChart() {
    if (!chartInstance) return;
    chartInstance.data.labels = segments.map(s => `${s.distLabel}m`);
    chartInstance.data.datasets[0].data = segments.map(s => s.timeS);
    chartInstance.update('none');
}

// =====================
// Beep
// =====================
// One context for the whole session. Creating one per beep leaked them until the
// browser's cap (~6 on Safari) was hit and beeps went silent mid-run.
let audioCtx = null;

function getAudioContext() {
    if (audioCtx) return audioCtx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch (e) { return null; }
    return audioCtx;
}

// Must be called from inside a real user-gesture handler: iOS starts audio contexts
// suspended and only honours resume() during a gesture. Segment beeps fire from a GPS
// callback, which is not a gesture, so without this they never sounded on iOS at all.
function unlockAudio() {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => { });
}

function playBeep() {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
        if (ctx.state === 'suspended') ctx.resume().catch(() => { });
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.35, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
    } catch (e) { }
}

// =====================
// GPS Status
// =====================
function setGPSStatus(quality, text) {
    const dot = document.getElementById('gpsDot');
    dot.className = `gps-dot ${quality}`;
    document.getElementById('gpsText').textContent = text;
}

// =====================
// Display Reset
// =====================
function resetDisplay() {
    document.getElementById('dispDist').textContent = '0';
    // onPosition flips this to "kilometres" past 1km; without resetting it the next run
    // opens reading "0 kilometres".
    document.querySelector('#distCard .bs-unit').textContent = 'metres';
    document.getElementById('dispTimer').textContent = '00:00';
    document.getElementById('dispSegTimer').textContent = '00:00';
    document.getElementById('dispPace').textContent = '–:––';
    document.getElementById('dispETA').textContent = '––:––';
    document.getElementById('dispCalories').textContent = '0';
    document.getElementById('dispSpeed').textContent = '0.0';
    document.getElementById('dispElevation').textContent = '–';
    document.getElementById('logContainer').innerHTML =
        '<div class="empty-state"><i class="fa-solid fa-satellite-dish"></i><p>Segment times will appear here.</p></div>';
    document.getElementById('splitBody').innerHTML = '';
    const segCount = document.getElementById('segCountBadge');
    if (segCount) segCount.textContent = '0 completed';
    const bestBadge = document.getElementById('bestBadge');
    if (bestBadge) bestBadge.classList.add('hidden');
    paceBuffer = [];
}

// =====================
// Save Run
// =====================
// totalTimeS is passed in by the caller so there is one definition of "how long did this
// run take" — stopRun and the auto-save path both source it from currentElapsedS().
function saveRun(totalTimeS) {
    const run = {
        id: Date.now(),
        date: new Date().toISOString(),
        distanceM: Math.round(totalDistance * 10) / 10, // round to 1 decimal
        totalTimeS: Math.round(totalTimeS),
        segmentSize,
        elevationGain: Math.round(elevationGain),
        calories: Math.round(totalDistance / 1000 * 62),
        segments: segments.map(s => ({
            distLabel: s.distLabel,
            timeS: Math.round(s.timeS * 10) / 10,
            paceStr: s.paceStr,
            paceSecKm: Math.round(s.paceSecKm * 10) / 10,
        })),
    };
    try {
        const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        history.unshift(run);
        if (history.length > 100) history.pop();
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
        console.log('Run saved:', run);
    } catch (e) {
        console.error('Failed to save run:', e);
        alert('Could not save run — localStorage may be full or disabled.');
    }
}

// Auto-save run data if page is closed/refreshed during a run
window.addEventListener('beforeunload', () => {
    if (isRunning && totalDistance > 0) {
        saveRun(currentElapsedS());
    }
});

// =====================
// Stats Page
// =====================
function renderStats() {
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    const runs = history.filter(r => r.distanceM > 50);

    const totalDist = runs.reduce((a, r) => a + r.distanceM, 0);
    const totalTime = runs.reduce((a, r) => a + r.totalTimeS, 0);
    const totalCal = runs.reduce((a, r) => a + (r.calories || Math.round(r.distanceM / 1000 * 62)), 0);
    const longest = runs.length ? Math.max(...runs.map(r => r.distanceM)) : 0;

    let bestAvgPace = 0;
    runs.forEach(r => {
        if (r.segments.length > 0) {
            const avg = r.segments.reduce((a, s) => a + s.paceSecKm, 0) / r.segments.length;
            if (bestAvgPace === 0 || avg < bestAvgPace) bestAvgPace = avg;
        }
    });

    document.getElementById('statTotalDist').textContent = (totalDist / 1000).toFixed(1) + ' km';
    document.getElementById('statTotalRuns').textContent = runs.length;
    document.getElementById('statBestPace').textContent = bestAvgPace > 0 ? formatPace(bestAvgPace) + '/km' : '–:––';

    const hours = Math.floor(totalTime / 3600);
    const mins = Math.floor((totalTime % 3600) / 60);
    document.getElementById('statTotalTime').textContent = `${hours}h ${mins}m`;
    document.getElementById('statTotalCal').textContent = totalCal.toLocaleString();
    document.getElementById('statLongestRun').textContent = (longest / 1000).toFixed(2) + ' km';
}

// =====================
// History Page
// =====================
function renderHistory() {
    const list = document.getElementById('historyList');
    const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    const runs = history.filter(r => r.distanceM > 50);
    const summary = document.getElementById('histSummary');

    if (summary) {
        summary.textContent = runs.length > 0
            ? `${runs.length} run${runs.length > 1 ? 's' : ''} recorded`
            : 'Your recent runs';
    }

    if (!runs.length) {
        list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-person-running"></i><p>No runs saved yet. Complete a run to see it here.</p></div>';
        return;
    }

    list.innerHTML = '';
    runs.forEach(run => {
        const card = document.createElement('div');
        card.className = 'hist-card';
        const dist = run.distanceM >= 1000
            ? `${(run.distanceM / 1000).toFixed(2)} km`
            : `${Math.round(run.distanceM)} m`;
        const date = new Date(run.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const avgPaceSecKm = run.segments.length
            ? run.segments.reduce((a, b) => a + b.paceSecKm, 0) / run.segments.length : 0;

        card.innerHTML = `
            <div class="hist-top">
                <span class="hist-dist">${dist}</span>
                <span class="hist-date">${date}</span>
            </div>
            <div class="hist-meta">
                <span><i class="fa-solid fa-clock"></i> ${formatTimeLong(run.totalTimeS)}</span>
                <span><i class="fa-solid fa-gauge-high"></i> ${avgPaceSecKm > 0 ? formatPace(avgPaceSecKm) + '/km' : '–'}</span>
                <span><i class="fa-solid fa-layer-group"></i> ${run.segments.length}×${run.segmentSize}m</span>
            </div>
        `;
        card.addEventListener('click', () => showRunDetail(run));
        list.appendChild(card);
    });
}

function showRunDetail(run) {
    const modal = document.getElementById('histModal');
    modal.classList.remove('hidden');
    const title = document.getElementById('hModalTitle');
    const body = document.getElementById('hModalBody');
    const date = new Date(run.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const dist = run.distanceM >= 1000 ? `${(run.distanceM / 1000).toFixed(2)} km` : `${Math.round(run.distanceM)} m`;

    title.textContent = `${dist} — ${date}`;

    const avgPace = run.segments.length
        ? run.segments.reduce((a, b) => a + b.paceSecKm, 0) / run.segments.length : 0;

    let rows = run.segments.map((s) => {
        let cls = '';
        if (avgPace > 0) {
            if (s.paceSecKm < avgPace * 0.97) cls = 'col-fast';
            else if (s.paceSecKm > avgPace * 1.03) cls = 'col-slow';
            else cls = 'col-avg';
        }
        return `<tr>
            <td>${s.distLabel}m</td>
            <td>${formatTime(s.timeS)}</td>
            <td class="${cls}">${s.paceStr} /km</td>
        </tr>`;
    }).join('');

    body.innerHTML = `
        <div class="modal-badges">
            <span class="modal-badge orange">${dist}</span>
            <span class="modal-badge blue">${formatTimeLong(run.totalTimeS)}</span>
            <span class="modal-badge green">${avgPace > 0 ? formatPace(avgPace) + '/km avg' : '–'}</span>
        </div>
        <table class="split-table">
            <thead><tr><th>Segment</th><th>Time</th><th>Pace</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

document.getElementById('closeModal').addEventListener('click', () => {
    document.getElementById('histModal').classList.add('hidden');
});

document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    if (confirm('Clear all run history? This cannot be undone.')) {
        localStorage.removeItem(HISTORY_KEY);
        renderHistory();
        showToast('History cleared');
    }
});

// =====================
// Export / Import
// =====================
document.getElementById('exportBtn').addEventListener('click', () => {
    const data = localStorage.getItem(HISTORY_KEY) || '[]';
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `runpulse_export_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Data exported! 📁');
});

document.getElementById('importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            if (Array.isArray(data)) {
                const existing = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
                const merged = [...data, ...existing];
                const unique = merged.filter((r, i, arr) => arr.findIndex(x => x.id === r.id) === i);
                unique.sort((a, b) => new Date(b.date) - new Date(a.date));
                if (unique.length > 100) unique.length = 100;
                localStorage.setItem(HISTORY_KEY, JSON.stringify(unique));
                showToast(`Imported ${data.length} runs! ✅`);
                renderHistory();
                renderStats();
            }
        } catch (err) {
            alert('Invalid JSON file.');
        }
    };
    reader.readAsText(file);
    e.target.value = '';
});

// =====================
// UTILS
// =====================
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTimeLong(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.round(seconds % 60);
    if (h > 0)
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatPace(secPerKm) {
    if (!secPerKm || secPerKm <= 0 || !isFinite(secPerKm)) return '–:––';
    const m = Math.floor(secPerKm / 60);
    const s = Math.round(secPerKm % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}
