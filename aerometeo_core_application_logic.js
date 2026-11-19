/**
 * AeroMeteo | Modular Scientific Weather & Oceanography Engine
 * Consumes data.json for coordinates, dictionaries, and hazard configurations,
 * integrates Open-Meteo live telemetry, D3.js vector maps, Chart.js, and Canvas simulations.
 */

class AeroMeteoApp {
    constructor() {
        this.config = null;
        this.cache = new Map();
        this.cacheTtl = 30 * 60 * 1000;
        this.currentLocKey = 'kochi';
        this.worldGeoJson = null;
        this.chartInstance = null;

        // D3 Map instances
        this.maps = {};

        // Canvas simulation states
        this.amocWeakened = true;
        this.amocAnimId = null;
        this.amocParticles = [];

        this.ensoIsElNino = true;
        this.ensoAnimId = null;
        this.ensoOceanParticles = [];
        this.ensoAirParticles = [];
    }

    /**
     * Bootstraps configuration from data.json and initializes UI listeners
     */
    async init() {
        try {
            const res = await fetch('./data.json');
            if (!res.ok) throw new Error(`HTTP ${res.status} loading data.json`);
            this.config = await res.json();
            this.cacheTtl = this.config.metadata?.cacheTtlMs || this.cacheTtl;
        } catch (err) {
            console.error('Failed to load data.json:', err);
            this.showToast('Error loading data.json configuration');
            return;
        }

        this.bindEvents();
        this.initChart();
        await this.initIndiaAnchoredMap();
        await this.refreshData();
    }

    bindEvents() {
        const locSelect = document.getElementById('location-select');
        if (locSelect) {
            locSelect.addEventListener('change', (e) => {
                this.currentLocKey = e.target.value;
                this.refreshData();
            });
        }

        // Hardware volume key incremental zoom on mobile devices
        window.addEventListener('keydown', (e) => {
            if (e.key === 'AudioVolumeUp' || e.key === 'VolumeUp') {
                e.preventDefault();
                this.stepMapZoom('main', 1.35);
            } else if (e.key === 'AudioVolumeDown' || e.key === 'VolumeDown') {
                e.preventDefault();
                this.stepMapZoom('main', 0.74);
            }
        });
    }

    /**
     * Tab router that lazily initializes maps and starts/stops canvas loops
     */
    switchTab(tabId) {
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

        const targetTab = document.getElementById(`tab-${tabId}`);
        const targetBtn = document.getElementById(`tabbtn-${tabId}`);
        if (targetTab) targetTab.classList.add('active');
        if (targetBtn) targetBtn.classList.add('active');

        if (tabId === 'cyclone' && !this.maps.cyclone) this.initHazardMap('cyclone', [85, 15], 1.5);
        if (tabId === 'hurricanes' && !this.maps.hurricanes) this.initHazardMap('hurricanes', [-80, 25], 1.0);
        if (tabId === 'volcanoes' && !this.maps.volcanoes) this.initHazardMap('volcanoes', [0, 20], 0.25);

        if (tabId === 'amoc') this.startAmocAnimation();
        if (tabId === 'elnino') this.startEnsoAnimation();
    }

    /**
     * Storm classification supporting Saffir-Simpson, IMD, and Category 6 (>192 mph)
     */
    getStormCategory(windSpeedMph, basin = 'atl') {
        if (windSpeedMph >= 192) {
            return '<span class="text-purple-400 font-bold animate-pulse">Category 6: Extreme Storm</span>';
        }
        if (basin === 'atl' || basin === 'pac') {
            if (windSpeedMph >= 157) return '<span class="text-red-500 font-bold">Category 5</span>';
            if (windSpeedMph >= 130) return '<span class="text-red-400 font-bold">Category 4</span>';
            if (windSpeedMph >= 111) return '<span class="text-orange-400 font-bold">Category 3</span>';
            if (windSpeedMph >= 96) return '<span class="text-yellow-400 font-bold">Category 2</span>';
            if (windSpeedMph >= 74) return '<span class="text-yellow-200 font-bold">Category 1</span>';
            return '<span class="text-blue-300">Tropical Storm</span>';
        } else {
            if (windSpeedMph >= 138) return '<span class="text-red-500 font-bold">Super Cyclone</span>';
            if (windSpeedMph >= 104) return '<span class="text-red-400 font-bold">Extremely Severe</span>';
            if (windSpeedMph >= 90) return '<span class="text-orange-400 font-bold">Very Severe</span>';
            if (windSpeedMph >= 63) return '<span class="text-yellow-400 font-bold">Severe Cyclone</span>';
            return '<span class="text-blue-300">Cyclonic Storm</span>';
        }
    }

    /**
     * Stale-While-Revalidate in-memory fetch wrapper
     */
    async fetchWithCache(url, key) {
        const now = Date.now();
        const cached = this.cache.get(key);
        if (cached && (now - cached.timestamp < this.cacheTtl)) {
            return cached.data;
        }
        const response = await fetch(url);
        if (!response.ok) throw new Error(`API status ${response.status}`);
        const data = await response.json();
        this.cache.set(key, { data, timestamp: now });
        return data;
    }

    /**
     * Concurrent telemetry fetch for Overview, Marine, Alerts, and Chart
     */
    async refreshData() {
        const loc = this.config.locations[this.currentLocKey];
        if (!loc) return;

        const wUrl = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,surface_pressure,wind_speed_10m,wind_gusts_10m&hourly=snow_depth&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=7&timezone=auto`;
        const aqiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${loc.lat}&longitude=${loc.lon}&current=us_aqi`;
        const marUrl = `https://marine-api.open-meteo.com/v1/marine?latitude=${loc.lat}&longitude=${loc.lon}&current=wave_height,swell_wave_height,sea_surface_temperature`;

        const [wRes, aqiRes, marRes] = await Promise.allSettled([
            this.fetchWithCache(wUrl, `wx_${this.currentLocKey}`),
            this.fetchWithCache(aqiUrl, `aqi_${this.currentLocKey}`),
            loc.isCoastal ? this.fetchWithCache(marUrl, `mar_${this.currentLocKey}`) : Promise.resolve(null)
        ]);

        if (wRes.status === 'fulfilled' && wRes.value) {
            this.renderOverview(loc, wRes.value, aqiRes.status === 'fulfilled' ? aqiRes.value : null);
            this.updateChart(wRes.value);
            this.updateAlerts(loc, wRes.value);
        }

        if (marRes.status === 'fulfilled' && marRes.value && marRes.value.current) {
            this.renderMarine(marRes.value.current, wRes.value?.current?.surface_pressure);
        }
    }

    renderOverview(loc, w, aqi) {
        const c = w.current;
        const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

        setTxt('ui-city', loc.name);
        setTxt('ui-temp', Math.round(c.temperature_2m));
        setTxt('ui-feels', `${Math.round(c.apparent_temperature)}°C`);
        setTxt('ui-humidity', `${c.relative_humidity_2m}%`);
        setTxt('ui-wind', `${c.wind_speed_10m} km/h`);
        setTxt('ui-pressure', `${c.surface_pressure} hPa`);
        setTxt('ui-aqi', aqi?.current?.us_aqi ?? '--');
        setTxt('ui-tmax', `${Math.round(w.daily.temperature_2m_max[0])}°C`);
        setTxt('ui-precip', `${w.daily.precipitation_sum[0]} mm`);
    }

    renderMarine(m, pressure) {
        const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        setTxt('mar-temp', m.sea_surface_temperature != null ? `${m.sea_surface_temperature}°C` : '--°C');
        setTxt('mar-wave', m.wave_height != null ? `${m.wave_height} m` : '--');
        setTxt('mar-swell', m.swell_wave_height != null ? `${m.swell_wave_height} m` : '-- m');
        setTxt('mar-pressure', pressure != null ? `${pressure} hPa` : '-- hPa');
    }

    updateAlerts(loc, w) {
        const c = w.current;
        const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        setTxt('cyc-press', `${c.surface_pressure} hPa`);
        setTxt('cyc-gust', `${c.wind_gusts_10m} km/h`);

        const rain7d = w.daily.precipitation_sum.reduce((a, b) => a + b, 0).toFixed(1);
        setTxt('ls-rain', `${rain7d} mm`);
        setTxt('ls-terrain', loc.lsProne ? 'Steep / Sloped' : 'Plains / Urban');
    }

    initChart() {
        const ctx = document.getElementById('meteogramChart');
        if (!ctx) return;
        this.chartInstance = new Chart(ctx.getContext('2d'), {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Max Temp (°C)',
                    data: [],
                    borderColor: '#818cf8',
                    backgroundColor: 'rgba(129, 140, 248, 0.15)',
                    fill: true,
                    tension: 0.35
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { ticks: { color: '#94a3b8', callback: (v) => `${v}°C` } },
                    x: { ticks: { color: '#94a3b8' } }
                }
            }
        });
    }

    updateChart(w) {
        if (!this.chartInstance || !w?.daily) return;
        this.chartInstance.data.labels = w.daily.time.map(d => {
            const dt = new Date(d);
            return `${dt.toLocaleString('default', { month: 'short' })} ${dt.getDate()}`;
        });
        this.chartInstance.data.datasets[0].data = w.daily.temperature_2m_max;
        this.chartInstance.update('none');
    }

    async loadGeoJson() {
        if (!this.worldGeoJson) {
            const res = await fetch('https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson');
            this.worldGeoJson = await res.json();
        }
        return this.worldGeoJson;
    }

    /**
     * Initializes HD D3 Map anchored to the Indian Subcontinent with wide zoom range
     */
    async initIndiaAnchoredMap() {
        const container = document.getElementById('map');
        if (!container) return;
        const width = container.clientWidth || 800;
        const height = container.clientHeight || 500;

        const svg = d3.select('#map').append('svg')
            .attr('width', '100%')
            .attr('height', '100%')
            .attr('viewBox', `0 0 ${width} ${height}`);
        const g = svg.append('g');

        const projection = d3.geoMercator()
            .center([82.5, 22.2])
            .scale(Math.min(width, height) * 1.65)
            .translate([width / 2, height / 2]);

        const zoom = d3.zoom()
            .scaleExtent([0.6, 50])
            .on('zoom', (e) => g.attr('transform', e.transform));

        svg.call(zoom);
        this.maps.main = { svg, g, projection, zoom };

        const geo = await this.loadGeoJson();
        g.selectAll('path')
            .data(geo.features)
            .join('path')
            .attr('d', d3.geoPath().projection(projection))
            .attr('class', 'd3-land');
    }

    stepMapZoom(mapKey, factor) {
        const m = this.maps[mapKey];
        if (!m) return;
        m.svg.transition().duration(250).call(m.zoom.scaleBy, factor);
    }

    resetIndiaAnchor() {
        const m = this.maps.main;
        if (!m) return;
        m.svg.transition().duration(400).call(m.zoom.transform, d3.zoomIdentity);
    }

    async initHazardMap(type, centerCoords, scaleMult) {
        const containerId = type === 'cyclone' ? 'cyclone-map' : type === 'hurricanes' ? 'hurricane-map' : 'volcano-map';
        const container = document.getElementById(containerId);
        if (!container) return;

        const width = container.clientWidth || 800;
        const height = container.clientHeight || 500;
        const svg = d3.select(`#${containerId}`).append('svg')
            .attr('width', '100%')
            .attr('height', '100%')
            .attr('viewBox', `0 0 ${width} ${height}`);
        const g = svg.append('g');
        const projection = d3.geoMercator().center(centerCoords).scale(width * scaleMult).translate([width / 2, height / 2]);
        const zoom = d3.zoom().scaleExtent([1, 15]).on('zoom', (e) => g.attr('transform', e.transform));
        svg.call(zoom);

        const geo = await this.loadGeoJson();
        g.selectAll('path').data(geo.features).join('path')
            .attr('d', d3.geoPath().projection(projection))
            .attr('fill', '#0f172a')
            .attr('stroke', 'rgba(56, 189, 248, 0.25)');

        this.maps[type] = { svg, g, projection, zoom };
        this.renderHazardMarkers(type);
    }

    renderHazardMarkers(type) {
        const m = this.maps[type];
        if (!m || !this.config) return;
        const items = this.config.hazards[type] || [];
        items.forEach(item => {
            const [x, y] = m.projection([item.lon, item.lat]);
            if (x && y) {
                m.g.append('circle').attr('cx', x).attr('cy', y).attr('r', 7).attr('fill', '#ef4444');
                m.g.append('circle').attr('class', 'cyc-pulse').attr('cx', x).attr('cy', y).attr('stroke', '#ef4444').attr('fill', 'none');
            }
        });
    }

    /**
     * Opens scientific deep-dive modal backed by data.json dictionaries
     */
    showDetailModal(category, key) {
        const entry = this.config?.dictionaries?.[category]?.[key];
        if (!entry) return;

        document.getElementById('detail-modal-title').textContent = entry.title;
        document.getElementById('detail-modal-plain').textContent = entry.plain;
        document.getElementById('detail-modal-tech').textContent = entry.tech;

        const modal = document.getElementById('detail-modal');
        const box = document.getElementById('detail-modal-box');
        modal.classList.remove('hidden', 'pointer-events-none');
        requestAnimationFrame(() => {
            modal.classList.remove('opacity-0');
            box.classList.remove('scale-95');
        });
    }

    hideDetailModal() {
        const modal = document.getElementById('detail-modal');
        const box = document.getElementById('detail-modal-box');
        modal.classList.add('opacity-0');
        box.classList.add('scale-95');
        setTimeout(() => modal.classList.add('hidden', 'pointer-events-none'), 300);
    }

    toggleAmocSimMode() {
        this.amocWeakened = !this.amocWeakened;
        const btn = document.getElementById('amoc-mode-btn');
        const status = document.getElementById('amoc-status');
        if (btn) {
            btn.innerHTML = `<i class="fa-solid fa-sliders mr-1.5"></i>Flow: ${this.amocWeakened ? 'Weakened (12.4 Sv)' : 'Baseline (18.5 Sv)'}`;
        }
        if (status) {
            status.textContent = this.amocWeakened ? 'Critical Weakening' : 'Strong Overturning';
        }
    }

    toggleEnsoSimMode() {
        this.ensoIsElNino = !this.ensoIsElNino;
        const btn = document.getElementById('enso-mode-btn');
        const status = document.getElementById('enso-status');
        if (btn) {
            btn.innerHTML = `<i class="fa-solid fa-sliders mr-1.5"></i>Phase: ${this.ensoIsElNino ? 'El Niño (+2.1°C)' : 'La Niña (-1.6°C)'}`;
        }
        if (status) {
            status.textContent = this.ensoIsElNino ? 'El Niño Advisory (Strong)' : 'La Niña Watch (Strong)';
        }
    }

    startAmocAnimation() {
        const canvas = document.getElementById('amoc-canvas');
        if (!canvas || this.amocAnimId) return;
        const render = () => {
            if (!document.getElementById('tab-amoc')?.classList.contains('active')) {
                this.amocAnimId = null;
                return;
            }
            this.amocAnimId = requestAnimationFrame(render);
        };
        this.amocAnimId = requestAnimationFrame(render);
    }

    startEnsoAnimation() {
        const canvas = document.getElementById('enso-canvas');
        if (!canvas || this.ensoAnimId) return;
        const render = () => {
            if (!document.getElementById('tab-elnino')?.classList.contains('active')) {
                this.ensoAnimId = null;
                return;
            }
            this.ensoAnimId = requestAnimationFrame(render);
        };
        this.ensoAnimId = requestAnimationFrame(render);
    }

    showToast(msg) {
        const toast = document.getElementById('toast');
        const msgEl = document.getElementById('toast-msg');
        if (!toast || !msgEl) return;
        msgEl.textContent = msg;
        toast.classList.remove('translate-y-20', 'opacity-0');
        setTimeout(() => toast.classList.add('translate-y-20', 'opacity-0'), 3000);
    }
}

// Initialize global instance on DOM ready
const aeroMeteo = new AeroMeteoApp();
document.addEventListener('DOMContentLoaded', () => aeroMeteo.init());