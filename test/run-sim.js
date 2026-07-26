// =============================================================================
//  RunPulse — headless run simulator / regression checks
// =============================================================================
//  Usage:  node test/run-sim.js
//
//  Loads the real script.js against a minimal DOM stub and a fake clock, then
//  drives the run state machine with a synthetic GPS track. This exists because
//  the timing and filtering maths are otherwise only verifiable by going outside
//  and running, which makes regressions in them very easy to ship.
//
//  Every check here corresponds to a numbered finding in REVIEW.md.
// =============================================================================
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || path.join(__dirname, '..');

// ---- fake clock (all app time reads go through Date.now) ----
let NOW = 1700000000000;
const realNow = Date.now;
Date.now = () => NOW;
const advance = ms => { NOW += ms; };

// ---- DOM stub: just enough surface for script.js to run headless ----
function makeEl(id) {
    const classes = new Set();
    return {
        id, textContent: '', innerHTML: '', className: '', disabled: false,
        style: {}, dataset: {}, firstChild: null, offsetLeft: 0, offsetWidth: 0,
        classList: {
            add: (...c) => c.forEach(x => classes.add(x)),
            remove: (...c) => c.forEach(x => classes.delete(x)),
            toggle: (c, on) => {
                if (on === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
                else if (on) { classes.add(c); } else { classes.delete(c); }
            },
            contains: c => classes.has(c),
        },
        addEventListener() { }, appendChild() { }, insertBefore() { },
        querySelector: () => makeEl('sub'),
        getContext: () => ({
            clearRect() { }, beginPath() { }, arc() { }, fill() { },
            createLinearGradient: () => ({ addColorStop() { } }),
        }),
    };
}

const els = new Map();
const byId = id => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
};

const document = {
    getElementById: byId,
    querySelector: sel => byId('q:' + sel),
    querySelectorAll: () => [],
    createElement: () => makeEl('created'),
    addEventListener() { },
    visibilityState: 'visible',
};

const store = new Map();
const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
};

// watchPosition's success callback is captured so the harness can push fixes in.
let posCb = null;
const navigator = {
    geolocation: {
        watchPosition: ok => { posCb = ok; return 1; },
        clearWatch: () => { posCb = null; },
        getCurrentPosition: ok => ok({ coords: {} }),
    },
};

// Deterministic: no rAF particle loop, no live intervals. The harness ticks manually.
const noopTimer = () => 1;
const noop = () => { };

const src = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
const wrapped = new Function(
    'document', 'window', 'navigator', 'localStorage', 'requestAnimationFrame',
    'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'alert', 'console',
    src + `
  ;return {
    prepareRun, startRun, pauseRun, resumeRun, stopRun,
    onPosition, updateTimers, currentElapsedS,
    state: () => ({
      isRunning, isPaused, gpsReady, totalDistance, segments,
      elapsedPauseMs, segmentStartTime, startTime, elevationGain,
      paceBufferLen: paceBuffer.length,
    }),
    setSegmentSize: v => { segmentSize = v; },
    HISTORY_KEY,
  };`
);

const app = wrapped(
    document, { innerWidth: 400, innerHeight: 800, addEventListener() { } },
    navigator, localStorage, noopTimer,
    noopTimer, noop, noopTimer, noop,
    noop, { log() { }, warn() { }, error() { } }
);

// ---- synthetic track helpers ----
const M_PER_DEG = 6371000 * Math.PI / 180;   // metres per degree of latitude
const LAT0 = 51.5;
const LON = -0.12;

function fix(metresFromStart, accuracy = 5, opts = {}) {
    return {
        coords: {
            latitude: LAT0 + metresFromStart / M_PER_DEG,
            longitude: LON,
            accuracy,
            altitude: opts.altitude ?? null,
            altitudeAccuracy: opts.altitudeAccuracy ?? null,
        },
        timestamp: NOW,
    };
}

function push(metres, accuracy, opts) {
    if (!posCb) throw new Error('no GPS watch active');
    posCb(fix(metres, accuracy, opts));
}

// Straight-line running at a fixed pace. Returns metres reached.
function runFor(seconds, paceSecPerKm, startMetres, stepS = 3) {
    const mps = 1000 / paceSecPerKm;
    let m = startMetres;
    for (let t = 0; t < seconds; t += stepS) {
        advance(stepS * 1000);
        m += mps * stepS;
        push(m);
    }
    return m;
}

// ---- assertions ----
let failures = 0;
function check(name, actual, expected, tol) {
    const ok = tol === undefined ? actual === expected : Math.abs(actual - expected) <= tol;
    const shown = typeof actual === 'number' ? actual.toFixed(2) : actual;
    const want = tol !== undefined ? `${expected}±${tol}` : expected;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${shown} expected ${want}`);
    if (!ok) failures++;
}
function section(t) { console.log(`\n--- ${t} ---`); }

// =============================================================================
section('0.1  distance is not banked before the gun');
app.prepareRun();
push(0, 30);                                        // too poor -> stays in warm-up
check('gpsReady after poor fix', app.state().gpsReady, false);
push(0, 6);                                         // good fix -> locked
check('gpsReady after good fix', app.state().gpsReady, true);
advance(10000); push(40);                           // user drifts during the GPS wait
advance(10000); push(80);
check('distance before startRun', app.state().totalDistance, 0, 0.001);

// =============================================================================
section('0.2 / 0.3  pause excluded from run time and segment time');
app.setSegmentSize(250);
app.startRun();
check('isRunning', app.state().isRunning, true);

let m = runFor(300, 300, 80);                       // 300s at 5:00/km => 1000m
check('segments completed', app.state().segments.length >= 3, true);

const elapsedBeforePause = app.currentElapsedS();
app.pauseRun();
advance(60000);                                     // 60s paused
check('clock frozen while paused', app.currentElapsedS(), elapsedBeforePause, 0.01);

app.resumeRun();
check('elapsedPauseMs after resume', app.state().elapsedPauseMs, 60000, 1);

const segCountAtResume = app.state().segments.length;
const need = 250 - (app.state().totalDistance % 250);
m = runFor(Math.ceil(need / (1000 / 300)) + 6, 300, m);
const newSegs = app.state().segments.slice(segCountAtResume);
if (!newSegs.length) { console.log('FAIL  no segment completed after resume'); failures++; }
else check('segment time after resume (s)', newSegs[0].timeS, 75, 25);  // bug => ~138

// =============================================================================
section('0.2  finishing while paused does not bank the pause');
const elapsedBeforeFinalPause = app.currentElapsedS();
app.pauseRun();
advance(120000);                                    // 2 min paused, then Finish
app.stopRun();

const history = JSON.parse(localStorage.getItem(app.HISTORY_KEY) || '[]');
check('run saved', history.length, 1);
if (history.length) {
    check('saved totalTimeS (s)', history[0].totalTimeS, elapsedBeforeFinalPause, 2);
}

// =============================================================================
section('0.6  a stationary gap does not poison live pace');
app.prepareRun();
push(0, 6);
app.startRun();
let m2 = runFor(120, 300, 0);
const bufAfterSteady = app.state().paceBufferLen;
check('pace samples collected', bufAfterSteady > 0, true);
advance(90000);                                     // stand still, then one step
m2 += 3; push(m2);
check('oversized-dt sample discarded', app.state().paceBufferLen <= bufAfterSteady, true);

// =============================================================================
section('0.4  elevation ignores noisy / unqualified altitude');
app.prepareRun();
push(0, 6, { altitude: 100, altitudeAccuracy: 4 });
app.startRun();
let m3 = 0;
for (const alt of [101, 99, 101.5, 98.5, 100]) {    // jitter below the noise floor
    advance(3000); m3 += 10; push(m3, 6, { altitude: alt, altitudeAccuracy: 4 });
}
check('gain from jitter', app.state().elevationGain, 0, 0.001);
advance(3000); m3 += 10; push(m3, 6, { altitude: 120, altitudeAccuracy: 4 });
check('gain from real climb', app.state().elevationGain, 20, 0.5);
advance(3000); m3 += 10; push(m3, 6, { altitude: 400, altitudeAccuracy: null });
check('gain ignored when altitudeAccuracy missing', app.state().elevationGain, 20, 0.5);
advance(3000); m3 += 10; push(m3, 90, { altitude: 900, altitudeAccuracy: 1 });
check('gain ignored on fix rejected for accuracy', app.state().elevationGain, 20, 0.5);

// =============================================================================
section('1.1  run starts and tracks with Chart.js absent');
check('Chart global absent in harness', typeof global.Chart, 'undefined');
app.prepareRun();
push(0, 6);
app.startRun();
check('isRunning despite no Chart', app.state().isRunning, true);
runFor(60, 300, 0);
check('distance accrued despite no Chart', app.state().totalDistance > 100, true);
app.stopRun();

// =============================================================================
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
Date.now = realNow;
process.exit(failures === 0 ? 0 : 1);
