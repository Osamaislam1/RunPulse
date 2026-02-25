# 🏃‍♂️ RunPulse — Live GPS Tracker

<div align="center">

**A premium real-time GPS running tracker with live pace, segments, calorie tracking, and detailed analytics.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/HTML)
[![CSS3](https://img.shields.io/badge/CSS3-1572B6?logo=css3&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/CSS)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)

[Features](#-features) • [Demo](#-demo) • [Installation](#-installation) • [Usage](#-usage) • [Technology](#-technology) • [Contributing](#-contributing)

</div>

---

## ✨ Features

### 🎯 Core Tracking
- **Live GPS Tracking** with Kalman filtering for accurate position estimation
- **Real-time Pace Calculation** with rolling buffer smoothing
- **Customizable Segments** (125m, 250m, 500m, 1km)
- **Automatic Segment Detection** with haptic feedback and audio cues
- **Elevation Gain Tracking** for hill runs

### 📊 Advanced Analytics
- **Live Pace Chart** with Chart.js visualization
- **Segment Performance Zones** (fast, average, slow)
- **Split Group Tables** showing 4-segment groupings
- **Best/Worst Segment Highlighting**
- **5km Time Estimation** based on current pace

### 💪 Performance Features
- **GPS Quality Filtering** (rejects inaccurate readings)
- **Speed Spike Rejection** (filters impossible GPS jumps)
- **Anti-drift Protection** (ignores GPS noise on stationary)
- **Smart GPS Warm-up** (waits for good initial fix)
- **Wake Lock Support** (keeps screen on during runs)

### 📈 Statistics & History
- **Lifetime Statistics Dashboard**
  - Total distance and runs
  - Best average pace
  - Total time and calories
  - Longest run
- **Detailed Run History** with sortable entries
- **Run Detail Modal** with segment breakdowns
- **Data Export/Import** (JSON format)

### 🎨 User Experience
- **Animated Particle Background**
- **Glass-morphism UI Design**
- **Countdown Timer** before run start
- **Pause/Resume Functionality**
- **Toast Notifications**
- **Responsive Mobile-First Design**
- **PWA-Ready** (installable on mobile)

---

## 🚀 Demo

### Screenshots

**Live Run Interface**
- Real-time distance, pace, and time tracking
- GPS accuracy indicator
- Segment completion log

**Statistics Dashboard**
- Lifetime performance metrics
- Visual stat cards with icons

**Run History**
- Chronological run list
- Detailed segment analysis per run

---

## 📦 Installation

### Prerequisites
- Modern web browser with GPS support (Chrome, Firefox, Safari, Edge)
- HTTPS connection (required for geolocation API)
- Location permissions enabled

### Quick Start

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/runpulse-gps-tracker.git
   cd runpulse-gps-tracker
   ```

2. **Serve the files**
   
   Using Python:
   ```bash
   python -m http.server 8000
   ```
   
   Using Node.js:
   ```bash
   npx http-server -p 8000
   ```
   
   Using PHP:
   ```bash
   php -S localhost:8000
   ```

3. **Open in browser**
   ```
   https://localhost:8000
   ```
   
   ⚠️ **Note:** HTTPS is required for GPS access. Use a local SSL certificate or deploy to a hosting service.

### Deployment Options

**Netlify/Vercel (Recommended)**
- Simply drag and drop the project folder
- Automatic HTTPS provisioning
- Zero configuration needed

**GitHub Pages**
```bash
git checkout -b gh-pages
git push origin gh-pages
```
Then enable GitHub Pages in repository settings.

---

## 🎮 Usage

### Starting a Run

1. **Select Segment Size** (125m, 250m, 500m, or 1km)
2. Click **"Start Run"** button
3. Wait for **GPS lock** (green indicator with good accuracy)
4. The **countdown** (3-2-1-GO!) will begin
5. Start running! 🏃‍♂️

### During the Run

- **Distance** updates in real-time
- **Current Pace** shows your live pace per kilometer
- **Segment Timer** counts time since last segment
- **Segments automatically complete** with vibration + beep
- **GPS Accuracy** badge shows signal quality

### Controls

- **Pause** — Stops tracking, timer, and GPS (resume later)
- **Resume** — Continues from where you paused
- **Finish** — Saves the run to history

### Viewing Statistics

Navigate to the **Stats** tab to see:
- Total distance across all runs
- Total number of runs
- Best average pace achieved
- Total running time
- Estimated calories burned
- Your longest single run

### Managing History

**View Past Runs**
- Tap any run card to see detailed segment breakdown
- Color-coded segments (green=fast, blue=average, orange=slow)

**Export Data**
- Click "Export Data" to download JSON backup
- Save for records or migration

**Import Data**
- Click "Import Data" and select a JSON file
- Merges with existing data (no duplicates)

**Clear History**
- Click "Clear" button (⚠️ permanent deletion)

---

## 🔧 Technology

### Core Technologies
- **HTML5** — Semantic structure with PWA meta tags
- **CSS3** — Glass-morphism design with animations
- **Vanilla JavaScript** — No frameworks, pure ES6+

### APIs & Libraries
- **Geolocation API** — High-accuracy GPS tracking
- **Chart.js** — Pace visualization
- **Web Audio API** — Segment completion beep
- **Vibration API** — Haptic feedback
- **Screen Wake Lock API** — Keep display active
- **localStorage** — Persistent data storage
- **Font Awesome 6.5** — Icon system
- **Google Fonts** — Inter + JetBrains Mono

### Key Algorithms

**Kalman Filter**
```javascript
// 1D Kalman filter for GPS smoothing
// Reduces GPS jitter while preserving responsiveness
kalmanUpdate(kf, measurement, accuracy)
```

**Haversine Formula**
```javascript
// Accurate distance calculation on Earth's surface
haversine(lat1, lon1, lat2, lon2)
```

**GPS Quality Control**
- Accuracy threshold filtering (≤50m)
- Warm-up phase (wait for ≤20m accuracy)
- Speed spike rejection (>36 km/h = invalid)
- Minimum delta threshold (≥2m movement)

---

## 📂 Project Structure

```
runpulse-gps-tracker/
├── index.html          # Main HTML structure
├── styles.css          # Complete styling (glass-morphism UI)
├── script.js           # Core application logic
├── README.md           # This file
└── assets/             # (optional) Screenshots, icons
```

### File Breakdown

**index.html** (356 lines)
- App header with wake lock indicator
- Navigation tabs (Live Run, Stats, History)
- Segment selector & big stat cards
- GPS status indicator
- Control buttons
- Segment log & split table
- Chart.js canvas
- History modal

**script.js** (700+ lines)
- State management
- GPS tracking with Kalman filtering
- Segment completion logic
- Real-time UI updates
- Chart rendering
- localStorage persistence
- Export/import functionality

**styles.css** (not included but referenced)
- Glass-morphism design system
- Responsive breakpoints
- Animated particles
- Custom scrollbars
- Toast notifications

---

## ⚙️ Configuration

### Adjust GPS Filtering Constants

In `script.js`, modify these values:

```javascript
// GPS accuracy threshold (reject worse than this)
const MAX_ACCURACY = 50;        // default: 50 meters

// GPS warm-up accuracy target
const GPS_WARMUP_ACC = 20;      // default: 20 meters

// Minimum movement before adding distance
const MIN_DELTA = 2.0;          // default: 2 meters

// Maximum realistic speed (reject GPS jumps)
const MAX_SPEED_MPS = 10;       // default: 10 m/s (36 km/h)
```

### Customize Kalman Filter

```javascript
// Process noise (expected position change per second)
const KF_PROCESS_NOISE = 5e-9;  // default: 5e-9 degrees²/s
```
- **Lower** = smoother but laggier tracking
- **Higher** = more responsive but noisier

### Calorie Calculation

```javascript
// Rough estimate: ~60-65 cal/km for 70kg runner
Math.round(totalDistance / 1000 * 62)
```

Adjust the multiplier (62) based on body weight:
- 60kg: ~55 cal/km
- 70kg: ~62 cal/km
- 80kg: ~70 cal/km

---

## 🐛 Troubleshooting

### GPS Not Working
- ✅ Ensure HTTPS connection (geolocation requires secure context)
- ✅ Grant location permissions in browser
- ✅ Check device GPS is enabled
- ✅ Move to open area (away from tall buildings)

### Inaccurate Distance
- ✅ Wait for GPS accuracy ≤15m before starting
- ✅ Keep phone in a stable position (armband/waistband)
- ✅ Avoid running in dense urban areas (GPS multipath)

### Screen Turns Off
- ✅ Wake Lock not supported in your browser
- ✅ Manually adjust screen timeout in device settings
- ✅ Use Chrome/Edge (best Wake Lock support)

### Data Not Saving
- ✅ Check localStorage is enabled (incognito mode disables it)
- ✅ Clear browser cache if storage is full
- ✅ Export data regularly as backup

---

## 🤝 Contributing

Contributions are welcome! Here's how you can help:

### Reporting Bugs
Open an issue with:
- Device & browser details
- Steps to reproduce
- Expected vs actual behavior
- Screenshots if applicable

### Feature Requests
Open an issue describing:
- The feature you'd like
- Why it would be useful
- Possible implementation ideas

### Pull Requests
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines
- Maintain vanilla JavaScript (no build tools)
- Keep mobile-first responsive design
- Comment complex algorithms
- Test on multiple devices/browsers
- Follow existing code style

---

## 📋 Roadmap

- [ ] **Map View** — Show running route on map
- [ ] **Heart Rate Integration** — Bluetooth HR monitor support
- [ ] **Training Plans** — Interval/tempo/long run workouts
- [ ] **Social Sharing** — Export run images for social media
- [ ] **Voice Feedback** — Audio pace/distance announcements
- [ ] **Dark/Light Themes** — User preference toggle
- [ ] **Multi-Language Support** — i18n implementation
- [ ] **Strava Integration** — Direct upload to Strava
- [ ] **Weather Overlay** — Show temperature/conditions
- [ ] **Race Mode** — Virtual pacing for target times

---

## 📄 License

This project is licensed under the **MIT License** — see below for details:

```
MIT License

Copyright (c) 2024 RunPulse

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 🙏 Acknowledgments

- **Chart.js** — Beautiful pace visualizations
- **Font Awesome** — Comprehensive icon set
- **Google Fonts** — Inter & JetBrains Mono typography
- **Kalman Filter Algorithm** — GPS smoothing technique used by Strava/Garmin
- **Haversine Formula** — Accurate Earth-surface distance calculation

---

## 📞 Support

- **Issues:** [GitHub Issues](https://github.com/Osamaislam1/runpulse-gps-tracker/issues)
- **Email:** osama.islam29@gmail.com 

---

<div align="center">

**Built with ❤️ for runners by runners**

⭐ Star this repo if you find it helpful!

[⬆ Back to Top](#-runpulse--live-gps-tracker)

</div>