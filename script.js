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

// ---- GPS Filtering ----
const MAX_ACCURACY = 50;      // Reject positions worse than 50m accuracy
const GPS_WARMUP_ACC = 20;    // Wait until GPS accuracy is this good before tracking
const MIN_DELTA = 2.0;        // Minimum metres movement before adding distance
const MAX_SPEED_MPS = 10;     // Reject GPS jumps implying speed > 36 km/h

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
function showToast(msg, duration = 2500) {
    const toast = document.getElementById('toast');
    const toastMsg = document.getElementById('toastMsg');
    toastMsg.textContent = msg;
    toast.classList.remove('hidden');
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.classList.add('hidden'), 350);
    }, duration);
}

// =====================
// Wake Lock
// =====================
async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        setWakeStatus(true);
        wakeLock.addEventListener('release', () => setWakeStatus(false));
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
        const overlay = document.getElementById('countdownOverlay');
        const num = document.getElementById('countdownNum');
        overlay.classList.remove('hidden');
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
                overlay.classList.add('hidden');
                resolve();
            }
        }, 800);
    });
}

// =====================
// Start / Pause / Stop
// =====================
document.getElementById('btnStart').addEventListener('click', async () => {
    if (isPaused) {
        resumeRun();
        return;
    }
    await runCountdown();
    startRun();
});

document.getElementById('btnPause').addEventListener('click', pauseRun);
document.getElementById('btnStop').addEventListener('click', stopRun);

function startRun() {
    if (!navigator.geolocation) { alert('Geolocation not supported.'); return; }

    isRunning = true;
    isPaused = false;
    totalDistance = 0;
    previousPosition = null;
    segments = [];
    elapsedPauseMs = 0;
    elevationGain = 0;
    lastElevation = null;
    kfLat = null;
    kfLon = null;
    gpsReady = false;
    startTime = Date.now();
    segmentStartTime = Date.now();

    resetDisplay();
    initChart();
    acquireWakeLock();

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

    watchId = navigator.geolocation.watchPosition(
        onPosition,
        onGPSError,
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 1000 }
    );

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

    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    showToast('Run paused ⏸️');
}

function resumeRun() {
    isPaused = false;
    elapsedPauseMs += Date.now() - pauseStartTime;

    const btnStart = document.getElementById('btnStart');
    const btnPause = document.getElementById('btnPause');
    btnStart.classList.add('hidden');
    btnStart.disabled = true;
    btnStart.classList.add('running');
    btnPause.classList.remove('hidden');

    timerInterval = setInterval(updateTimers, 500);
    previousPosition = null;
    kfLat = null;
    kfLon = null;
    gpsReady = false;

    watchId = navigator.geolocation.watchPosition(
        onPosition,
        onGPSError,
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 1000 }
    );

    showToast('Run resumed! ▶️');
}

function stopRun() {
    // Capture run data BEFORE resetting state
    const hadDistance = totalDistance > 0;
    const runDurationS = isRunning ? (Date.now() - startTime - elapsedPauseMs) / 1000 : 0;

    isRunning = false;
    isPaused = false;
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
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
        saveRun();
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
    const { latitude, longitude, accuracy, altitude } = pos.coords;

    // Elevation tracking
    if (altitude != null) {
        if (lastElevation !== null && altitude > lastElevation) {
            elevationGain += altitude - lastElevation;
        }
        lastElevation = altitude;
        document.getElementById('dispElevation').textContent = `${Math.round(elevationGain)}m`;
    }

    // Hard reject: too inaccurate to be of any use
    if (accuracy > MAX_ACCURACY) {
        setGPSStatus('bad', `GPS: ±${accuracy.toFixed(1)}m — skipped`);
        return;
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
    const elapsed = (Date.now() - startTime - elapsedPauseMs) / 1000;
    document.getElementById('dispTimer').textContent = formatTimeLong(elapsed);

    const segElapsed = (Date.now() - segmentStartTime) / 1000;
    document.getElementById('dispSegTimer').textContent = formatTime(segElapsed);

    // Freeze pace to --:-- if no new GPS point in 5 seconds (stationary at light)
    if (previousPosition && (Date.now() - previousPosition.timestamp > 5000)) {
        document.getElementById('dispPace').textContent = '–:––';
    }
}

// =====================
// Live Pace (rolling buffer; only used while running)
// When run is stopped, stopRun() sets PACE to average pace (total time / total distance).
// =====================
let paceBuffer = [];
function updateLivePace(delta, dt) {
    paceBuffer.push({ delta, dt });
    if (paceBuffer.length > 12) paceBuffer.shift();
    const totalD = paceBuffer.reduce((a, b) => a + b.delta, 0);
    const totalT = paceBuffer.reduce((a, b) => a + b.dt, 0);
    if (totalD > 5 && totalT > 0) {
        const speed = totalD / totalT;
        const secKm = 1000 / speed;
        document.getElementById('dispPace').textContent = formatPace(secKm);

        const totalElapsed = (Date.now() - startTime - elapsedPauseMs) / 1000;
        if (totalDistance > 100) {
            const secPer5k = (totalElapsed / totalDistance) * 5000;
            document.getElementById('dispETA').textContent = formatTimeLong(secPer5k);
        }
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
function initChart() {
    const canvas = document.getElementById('runChart');
    if (chartInstance) chartInstance.destroy();
    chartInstance = new Chart(canvas, {
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
function playBeep() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
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
    document.getElementById('dispDist').textContent = '0.00';
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
function saveRun() {
    // Use captured elapsed time if still running (e.g. auto-save on close)
    const totalTimeS = (Date.now() - startTime - elapsedPauseMs) / 1000;
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
        saveRun();
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
