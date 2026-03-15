// Global variables
let terminal = null;
let terminalSocket = null;
let fitAddon = null;
let refreshInterval = null;
let refreshCountdown = 10;

const state = {
    readOnly: true,
    graphsRange: '10m',
    charts: {},
    metrics: {
        cpu: [],
        memory: [],
        disk: [],
        credits: []
    },
    cachedIP: null,
    logLines: 100
};

async function parseJsonResponse(response) {
    const text = await response.text();
    if (!text || !text.trim()) {
        return { success: response.ok, error: response.ok ? null : `HTTP ${response.status}` };
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        return {
            success: false,
            error: `Invalid JSON response (HTTP ${response.status})`,
            raw: text
        };
    }
}


function loadMetricsCache() {
    try {
        const raw = localStorage.getItem('xpm_metrics');
        if (!raw) {
            console.log('No metrics cache found, starting fresh');
        } else {
            const parsed = JSON.parse(raw);
            const cutoffMetrics = Date.now() - (24 * 60 * 60 * 1000);
            const cutoffCredits = Date.now() - (40 * 24 * 60 * 60 * 1000);
            
            ['cpu','memory','disk'].forEach(k => {
                const arr = Array.isArray(parsed[k]) ? parsed[k].filter(p => p.t >= cutoffMetrics) : [];
                state.metrics[k] = arr;
            });
            
            // Credits: 40 day retention
            const creditsArr = Array.isArray(parsed['credits']) ? parsed['credits'].filter(p => p.t >= cutoffCredits) : [];
            state.metrics['credits'] = creditsArr;
            
            console.log('Loaded metrics cache:', {
                cpu: state.metrics.cpu.length,
                mem: state.metrics.memory.length,
                disk: state.metrics.disk.length,
                credits: state.metrics.credits.length
            });
        }
        
        // Load cached IP
        const cachedIP = localStorage.getItem('xpm_ip');
        if (cachedIP) {
            state.cachedIP = cachedIP;
            console.log('Loaded cached IP:', cachedIP);
        }
    } catch (e) {
        console.warn('cache load failed', e);
    }
}

function saveMetricsCache() {
    try {
        localStorage.setItem('xpm_metrics', JSON.stringify(state.metrics));
    } catch (e) {
        console.warn('metrics cache save failed', e);
    }
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    initializeTabs();
    initializeAutoRefresh();
    initReadOnlyToggle();
    loadMetricsCache();
    loadDashboard()
    loadCurrentPubkey();;
    
    // Setup log service selector
    const logService = document.getElementById('log-service');
    if (logService) {
        logService.addEventListener('change', togglePubkeyButton);
        togglePubkeyButton();
    }
});

// ============================================================================
// TAB MANAGEMENT
// ============================================================================

function initializeTabs() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    
    tabButtons.forEach(button => {
        button.addEventListener('click', function() {
            const tabName = this.getAttribute('data-tab');
            switchTab(tabName);
        });
    });
}

function switchTab(tabName) {
    // Update buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');
    
    // Update content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(`${tabName}-tab`).classList.add('active');
    
    // Load data for specific tabs
    switch(tabName) {
        case 'dashboard':
            loadDashboard();
            break;
        case 'services':
            loadServices();
            // Ensure buttons respect read-only after load
            setTimeout(() => {
                document.querySelectorAll('[data-protected="true"]').forEach(btn => {
                    btn.disabled = state.readOnly;
                });
            }, 100);
            break;
        case 'network':
            // Don't auto-load, wait for user to click
            break;
        case 'graphs':
            renderCharts();
            break;
        case 'terminal':
            // Don't block demo users from terminal (they get demo-user shell)
            // Only block if read-only AND not demo (admins/standard with read-only on)
            if (window.userRole !== 'demo' && guardDangerous()) {
                return;
            }
            if (!terminal) {
                initializeTerminal();
            } else {
                // Re-fit terminal when switching to tab
                setTimeout(() => {
                    if (fitAddon) {
                        fitAddon.fit();
                    }
                }, 100);
            }
            break;
    }
}

// ============================================================================
// AUTO-REFRESH
// ============================================================================

function initializeAutoRefresh() {
    refreshInterval = setInterval(() => {
        refreshCountdown--;
        document.getElementById('refresh-countdown').textContent = refreshCountdown;
        
        if (refreshCountdown <= 0) {
            refreshCountdown = 10;
            
            // Always collect metrics in background
            collectMetricsInBackground();
            
            // Only refresh UI if on dashboard tab
            const activTab = document.querySelector('.tab-content.active');
            if (activTab && activTab.id === 'dashboard-tab') {
                console.log('[Auto-refresh] Refreshing dashboard...');
                loadDashboard();
            }
        }
    }, 1000);
}

async function collectMetricsInBackground() {
    try {
        const [dashResponse, creditsResponse] = await Promise.all([
            fetch('/api/dashboard'),
            fetch('/api/devnet-eligibility')
        ]);
        const dashData = await dashResponse.json();
        const creditsData = await creditsResponse.json();
        
        if (dashData.success) {
            const creditsVal = creditsData.success ? creditsData.localCredits : null;
            recordMetrics(dashData.system, creditsVal);
        }
    } catch (error) {
        console.warn('[Background] Metrics collection failed:', error);
    }
}


// Read-only toggle
function initReadOnlyToggle() {
    const toggle = document.getElementById('readonly-toggle');
    const pill = document.getElementById('readonly-status');
    if (!toggle || !pill) return;

    // Demo users: lock toggle in read-only mode
    if (window.userRole === 'demo') {
        toggle.checked = true;
        toggle.disabled = true;
        toggle.title = 'Demo mode - contact admin for full access';
        pill.textContent = 'Demo Mode';
        pill.classList.remove('unprotected');
        pill.classList.add('protected');
        state.readOnly = true;
        
        // Disable all protected buttons
        document.querySelectorAll('[data-protected="true"]').forEach(btn => {
            btn.disabled = true;
        });
        
        return; // Skip normal toggle behavior
    }
    
    // Standard users: can use advanced features but can't manage users
    if (window.userRole === 'standard') {
        // Toggle works normally for standard users
    }

    const apply = () => {
        state.readOnly = toggle.checked;
        pill.textContent = state.readOnly ? 'Protected' : 'Unprotected';
        pill.classList.toggle('protected', state.readOnly);
        pill.classList.toggle('unprotected', !state.readOnly);
        document.querySelectorAll('[data-protected="true"]').forEach(btn => {
            btn.disabled = state.readOnly;
        });
    };

    toggle.addEventListener('change', () => {
        apply();
    });

    apply();
}

function guardDangerous() {
    // Demo users always blocked
    if (window.userRole === 'demo') {
        alert('Demo mode - this action is restricted. Contact admin for full access.');
        return true;
    }
    
    // Standard users can use advanced features (not blocked by this)
    
    if (state.readOnly) {
        alert('Read-Only mode is on. Toggle off to run commands.');
        return true;
    }
    return false;
}


async function logout() {
    if (!confirm('Are you sure you want to logout?')) {
        return;
    }
    
    try {
        await fetch('/api/logout', { method: 'POST' });
        window.location.href = '/login.html';
    } catch (error) {
        console.error('Logout failed:', error);
        window.location.href = '/login.html';
    }
}

// ============================================================================
// DASHBOARD
// ============================================================================


// Load component versions
async function loadVersions() {
    try {
        const response = await fetch("/api/component-versions");
        const data = await response.json();
        
        if (data.success && data.versions) {
            const versions = data.versions;
            const versionEl = document.getElementById("version-xandminer");
            const versionEl2 = document.getElementById("version-xandminerd");
            const versionEl3 = document.getElementById("version-pod");
            
            if (versionEl) versionEl.textContent = versions.xandminer || "Unknown";
            if (versionEl2) versionEl2.textContent = versions.xandminerd || "Unknown";
            if (versionEl3) versionEl3.textContent = versions.pod || "Unknown";
        } else {
            // Set to "Unknown" if failed
            ["version-xandminer", "version-xandminerd", "version-pod"].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.textContent = "Unknown";
            });
        }
    } catch (error) {
        console.error("Error loading versions:", error);
        ["version-xandminer", "version-xandminerd", "version-pod"].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = "Error";
        });
    }
}


async function loadDashboard() {
    try {
        const response = await fetch('/api/dashboard');
        const data = await response.json();
        
        if (data.success) {
            updateSystemStats(data.system);
            updateServiceStatus(data.services);
            updateNetworkStatus(data.network);
            updateHealthScore(data);
            await loadVersions();
            
            // Load credits but don't block metrics recording if it fails
            let creditsVal = null;
            try {
                const credits = await loadDashboardCredits();
                creditsVal = credits.localCredits;
            } catch (err) {
                console.warn('Credits load failed, recording metrics without credits');
            }
            
            recordMetrics(data.system, creditsVal);
        }
    } catch (error) {
        console.error('Error loading dashboard:', error);
    }
}

function updateSystemStats(system) {
    if (system.cpu) {
        document.getElementById('cpu-usage').textContent = `${system.cpu.usage.toFixed(1)}%`;
    }
    
    if (system.memory) {
        document.getElementById('memory-usage').textContent = `${system.memory.percentage.toFixed(1)}%`;
    }
    
    if (system.disk) {
        document.getElementById('disk-usage').textContent = `${system.disk.percentage}%`;
    }
    
    if (system.uptime) {
        document.getElementById('uptime').textContent = formatUptime(system.uptime.uptime);
    }

    if (system.xandeumPages) {
        const el = document.getElementById('xandeum-pages');
        if (el) {
            const size = system.xandeumPages.sizeGB !== undefined ? `${system.xandeumPages.sizeGB} GB` : `${system.xandeumPages.sizeMB} MB`;
            el.textContent = `Xandeum-Pages: ${size}`;
        }
    }
}

function formatUptime(uptimeStr) {
    if (!uptimeStr) return '--';
    const parts = { day: 0, hour: 0, minute: 0 };
    const regex = /(\d+)\s+(day|days|hour|hours|minute|minutes)/g;
    let match;
    while ((match = regex.exec(uptimeStr)) !== null) {
        const val = parseInt(match[1]);
        const unit = match[2];
        if (unit.startsWith('day')) parts.day = val;
        else if (unit.startsWith('hour')) parts.hour = val;
        else if (unit.startsWith('minute')) parts.minute = val;
    }
    const out = [];
    if (parts.day) out.push(`${parts.day}d`);
    if (parts.hour || parts.day) out.push(`${parts.hour}h`);
    out.push(`${parts.minute}m`);
    return out.join(' ');
}

function updateServiceStatus(services) {
    const container = document.getElementById('service-status');
    container.innerHTML = '';
    
    for (const [name, status] of Object.entries(services.services)) {
        const card = document.createElement('div');
        card.className = 'service-card';
        card.innerHTML = `
            <div class="service-info">
                <h4>${name}</h4>
                <span class="service-status ${status.running ? 'running' : 'stopped'}">
                    ${status.running ? '● Running' : '○ Stopped'}
                </span>
            </div>
        `;
        container.appendChild(card);
    }
}

function updateNetworkStatus(network) {
    const container = document.getElementById('network-status');
    
    if (network.details && network.details.public && network.details.public.ip) {
        const ip = network.details.public.ip;
        const udpPorts = network.details.public.udp || [];
        const tcpPorts = network.details.public.tcp || [];
        
        container.innerHTML = `
            <p><strong>External IP:</strong> ${ip}</p>
            <p><strong>Public Access:</strong> ${network.publicAccessConfigured ? '✅ Configured' : '❌ Not configured'}</p>
        `;
    } else {
        container.innerHTML = '<p>Network information unavailable</p>';
    }
}

async function updateHealthScore(data) {
    try {
        const response = await fetch('/api/health');
        const health = await response.json();
        
        if (health.success) {
            // Check if pod service is running
            const podRunning = data?.services?.services?.pod?.running;
            
            const statusBadge = document.getElementById('health-status');
            
            if (podRunning === false) {
                document.getElementById('health-score').textContent = '0';
                statusBadge.textContent = 'DISCONNECTED';
                statusBadge.className = 'status-badge critical';
            } else {
                document.getElementById('health-score').textContent = health.score;
                statusBadge.textContent = health.status;
                statusBadge.className = `status-badge ${health.status}`;
            }
        }
    } catch (error) {
        console.error('Error loading health:', error);
    }
}

// Credits & charts
async function loadDashboardCredits() {    try {
        const response = await fetch('/api/devnet-eligibility');        const data = await response.json();        if (!data.success) throw new Error(data.error || 'Failed to load credits');

        const earnedEl = document.getElementById('credits-earned');
        const maxEl = document.getElementById('credits-max');
        if (earnedEl) earnedEl.textContent = data.localCredits !== null && data.localCredits !== undefined ? data.localCredits.toFixed(0) : '--';
        if (maxEl) maxEl.textContent = data.maxCredits !== null && data.maxCredits !== undefined ? data.maxCredits.toFixed(0) : '--';

        renderEligibilityOutput(data);
        return { localCredits: data.localCredits, maxCredits: data.maxCredits };
    } catch (error) {        console.error('Error loading credits:', error);
        const earnedEl = document.getElementById('credits-earned');
        const maxEl = document.getElementById('credits-max');
        if (earnedEl) earnedEl.textContent = '--';
        if (maxEl) maxEl.textContent = '--';
        const out = document.getElementById('eligibility-output');
        if (out) out.textContent = 'Unable to load credits right now.';
        return { localCredits: null, maxCredits: null };
    }
}


async function forcePubkeyScan() {
    if (guardDangerous()) return;
    const out = document.getElementById('eligibility-output');
    if (out) out.textContent = 'Restarting pod to rescan pubkey...';
    try {
        const resp = await fetch('/api/find-pubkey', { method: 'POST' });
        const data = await resp.json();
        if (data.success && data.pubkey) {
            if (out) out.textContent = `Pubkey found: ${data.pubkey}. Refreshing credits...`;
            await loadDashboardCredits();
        } else {
            if (out) out.textContent = 'Pubkey not found in recent logs.';
        }
    } catch (err) {
        if (out) out.textContent = 'Error scanning pubkey: ' + err.message;
    }
}

async function checkEligibility() {
    const modal = document.getElementById('eligibility-modal');
    const details = document.getElementById('eligibility-details');
    if (!modal || !details) return;
    
    modal.classList.remove('hidden');
    details.innerHTML = '<p>Loading eligibility data...</p>';
    
    try {
        const response = await fetch('/api/devnet-eligibility');
        const data = await response.json();
        
        if (!data.success) {
            details.innerHTML = '<p style="color: var(--danger-color);">Failed to load eligibility data.</p>';
            return;
        }
        
        const html = `
            <h4>Formula: 95th Percentile × 80% Threshold</h4>
            <div class="eligibility-row">
                <span class="eligibility-label">Your Pubkey:</span>
                <span class="eligibility-value">${data.pubkey || 'Not found'}</span>
            </div>
            <div class="eligibility-row">
                <span class="eligibility-label">Your Credits:</span>
                <span class="eligibility-value ${data.localCredits ? 'success' : ''}">${data.localCredits !== null ? data.localCredits : '--'}</span>
            </div>
            <div class="eligibility-row">
                <span class="eligibility-label">Top Earner:</span>
                <span class="eligibility-value">${data.maxCredits !== null ? data.maxCredits : '--'}</span>
            </div>
            <div class="eligibility-row">
                <span class="eligibility-label">95th Percentile:</span>
                <span class="eligibility-value">${data.percentile95 !== null ? data.percentile95 : '--'}</span>
            </div>
            <div class="eligibility-row">
                <span class="eligibility-label">Threshold (80% of P95):</span>
                <span class="eligibility-value">${data.threshold !== null ? data.threshold : '--'}</span>
            </div>
            <div class="eligibility-row">
                <span class="eligibility-label">Eligible for DevNet:</span>
                <span class="eligibility-value">Unknown (criteria TBD)</span>
            </div>
            <div class="eligibility-row">
                <span class="eligibility-label">Total Pods:</span>
                <span class="eligibility-value">${data.totalPods || '--'}</span>
            </div>
        `;
        
        details.innerHTML = html;
    } catch (error) {
        details.innerHTML = `<p style="color: var(--danger-color);">Error: ${error.message}</p>`;
    }
}

function toggleEligibilityModal(forceHide = false) {
    const modal = document.getElementById('eligibility-modal');
    if (!modal) return;
    if (forceHide) {
        modal.classList.add('hidden');
        return;
    }
    modal.classList.toggle('hidden');
}

function renderEligibilityOutput(data) {
    const out = document.getElementById('eligibility-output');
    if (!out) return;
    if (!data.success) {
        out.textContent = 'Unable to load eligibility.';
        return;
    }
    const parts = [];
    if (data.pubkey) parts.push(`Pubkey: ${data.pubkey}`);
    if (data.localCredits !== null && data.localCredits !== undefined) parts.push(`My credits: ${data.localCredits}`);
    if (data.threshold !== null && data.threshold !== undefined) parts.push(`Threshold (80% of P95): ${data.threshold}`);
    if (data.maxCredits !== null && data.maxCredits !== undefined) parts.push(`Top earner: ${data.maxCredits}`);
    if (data.percentile95 !== null && data.percentile95 !== undefined) parts.push(`P95 earner: ${data.percentile95}`);
    parts.push(`DevNet Status: Unknown (criteria TBD)`);
    out.textContent = parts.join(' | ');
}

function recordMetrics(system, creditsVal) {
    const now = Date.now();
    pushMetric(state.metrics.cpu, now, system?.cpu?.usage);
    pushMetric(state.metrics.memory, now, system?.memory?.percentage);
    pushMetric(state.metrics.disk, now, system?.disk?.percentage);
    pushMetric(state.metrics.credits, now, creditsVal);
    saveMetricsCache();
    console.log('Recorded metrics:', {
        cpu: state.metrics.cpu.length,
        mem: state.metrics.memory.length,
        disk: state.metrics.disk.length,
        credits: state.metrics.credits.length
    });
}

function pushMetric(arr, ts, value) {
    if (typeof value !== 'number' || Number.isNaN(value)) return;
    arr.push({ t: ts, v: value });
    if (arr.length > 1000) arr.shift();
}

function setGraphRange(range) {
    state.graphsRange = range;
    updateGraphRangeButtons();
    renderCharts();
}

function updateGraphRangeButtons() {
    document.querySelectorAll('.graph-controls .btn').forEach(btn => {
        const active = btn.getAttribute('data-range') === state.graphsRange;
        btn.classList.toggle('btn-primary', active);
        btn.classList.toggle('btn-secondary', !active);
    });
}

function getRangeMs() {
    switch (state.graphsRange) {
        case '10m': return 10 * 60 * 1000;
        case '6h': return 6 * 60 * 60 * 1000;
        case '24h': return 24 * 60 * 60 * 1000;
        default: return 10 * 60 * 1000;
    }
}

function filterByRange(arr) {
    const cutoff = Date.now() - getRangeMs();
    return arr.filter(p => p.t >= cutoff);
}

function ensureCharts() {
    if (!window.Chart) return;
    if (!state.charts.cpu) {
        const common = {
            type: 'line',
            options: {
                animation: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { autoSkip: true, maxTicksLimit: 2 } },
                    y: { beginAtZero: true }
                }
            }
        };
        state.charts.cpu = new Chart(document.getElementById('chart-cpu'), {
            ...common,
            options: { ...common.options, scales: { x: common.options.scales.x, y: { beginAtZero: true, max: 100 } } },
            data: { labels: [], datasets: [{ label: 'CPU %', data: [], borderColor: '#6366f1', tension: 0.3 }] }
        });
        state.charts.memory = new Chart(document.getElementById('chart-memory'), {
            ...common,
            options: { ...common.options, scales: { x: common.options.scales.x, y: { beginAtZero: true, max: 100 } } },
            data: { labels: [], datasets: [{ label: 'Memory %', data: [], borderColor: '#22c55e', tension: 0.3 }] }
        });
        state.charts.disk = new Chart(document.getElementById('chart-disk'), {
            ...common,
            options: { ...common.options, scales: { x: common.options.scales.x, y: { beginAtZero: true, max: 100 } } },
            data: { labels: [], datasets: [{ label: 'Disk %', data: [], borderColor: '#f59e0b', tension: 0.3 }] }
        });
        state.charts.credits = new Chart(document.getElementById('chart-credits'), {
            type: 'line',
            options: {
                animation: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { ticks: { autoSkip: true, maxTicksLimit: 2 } },
                    y: { beginAtZero: true, max: 90000 }
                }
            },
            data: { labels: [], datasets: [{ label: 'Credits', data: [], borderColor: '#06b6d4', tension: 0.3 }] }
        });
    }
}

function renderCharts() {
    ensureCharts();
    const charts = state.charts;
    if (!charts.cpu) return;
    updateGraphRangeButtons();
    
    // Credits uses 40-day window, others use selected range
    const cutoffCredits = Date.now() - (40 * 24 * 60 * 60 * 1000);
    const creditsData = state.metrics.credits.filter(p => p.t >= cutoffCredits);
    
    const datasets = [
        { chart: charts.cpu, data: filterByRange(state.metrics.cpu) },
        { chart: charts.memory, data: filterByRange(state.metrics.memory) },
        { chart: charts.disk, data: filterByRange(state.metrics.disk) },
        { chart: charts.credits, data: creditsData },
    ];
    datasets.forEach(({ chart, data }, idx) => {
        // Credits chart: show days of history
        if (idx === 3 && data.length > 0) {
            const oldestTs = data[0].t;
            const ageMs = Date.now() - oldestTs;
            const ageDays = (ageMs / (24 * 60 * 60 * 1000)).toFixed(1);
            chart.data.labels = data.map((_, i) => {
                if (i === 0) return `-${ageDays}d`;
                if (i === data.length - 1) return "now";
                return "";
            });
        } else {
            // Other charts: use range selector
            chart.data.labels = data.map((_, i) => {
                if (data.length === 1) return state.graphsRange === "10m" ? "-10m" : "now";
                if (i === 0) return "-" + state.graphsRange;
                if (i === data.length - 1) return "now";
                return "";
            });
        }
        chart.data.datasets[0].data = data.map(d => d.v);
        chart.update('none');
    });
}

// Health formula popup
function toggleHealthFormula(forceHide = false) {
    const modal = document.getElementById('health-formula-modal');
    if (!modal) return;
    if (forceHide) {
        modal.classList.add('hidden');
        return;
    }
    modal.classList.toggle('hidden');
}


function updateAPIFormat(method, params = {}) {
    const el = document.getElementById('api-format');
    if (!el) return;
    const payload = {
        "jsonrpc": "2.0",
        "method": method,
        "id": 1
    };
    if (Object.keys(params).length > 0) {
        payload.params = params;
    }
    
    const ip = state.cachedIP || 'YOUR_PUBLIC_IP';
    const curlCmd = `curl -X POST http://${ip}:6000/rpc \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(payload, null, 2)}' | jq`;
    el.textContent = curlCmd;
    
    // Refresh IP in background if not cached
    if (!state.cachedIP) {
        fetch('/api/network')
            .then(res => res.json())
            .then(data => {
                state.cachedIP = data.diagnostics?.public?.ip;
                localStorage.setItem('xpm_ip', state.cachedIP);
                if (state.cachedIP && state.cachedIP !== ip) {
                    updateAPIFormat(method, params);
                }
            })
            .catch(() => {});
    }
}

// ============================================================================
// SERVICES
// ============================================================================

async function loadServices() {
    try {
        const response = await fetch('/api/services');
        const data = await response.json();
        
        if (data.success) {
            displayServices(data.services);
        }
    } catch (error) {
        console.error('Error loading services:', error);
    }
}

async function refreshServicesWithSettle() {
    await loadServices();
    setTimeout(() => {
        loadServices().catch((error) => console.warn('Delayed services refresh failed:', error));
    }, 1500);
}

async function getServiceStatus(name) {
    const response = await fetch(`/api/services/${name}`);
    const data = await parseJsonResponse(response);
    if (!response.ok || !data.success || !data.service) {
        throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data.service;
}

function displayServices(services) {
    const container = document.getElementById('services-list');
    container.innerHTML = '';
    
    for (const [name, status] of Object.entries(services)) {
        const isSelfService = name === 'pod-manager';
        const stopDisabled = state.readOnly || isSelfService;
        const restartDisabled = state.readOnly || isSelfService;
        const stopTitle = isSelfService
            ? 'Stop pod-manager from the server shell: sudo systemctl stop pod-manager'
            : '';
        const restartTitle = isSelfService
            ? 'Restart pod-manager from the server shell: sudo systemctl restart pod-manager'
            : '';
        const item = document.createElement('div');
        item.className = 'service-item';
        item.innerHTML = `
            <div class="service-header">
                <div>
                    <h3>${name}</h3>
                    <span class="service-status ${status.running ? 'running' : 'stopped'}">
                        ${status.running ? '● Running' : '○ Stopped'}
                    </span>
                </div>
                <div class="service-actions">
                    <button class="btn btn-primary" data-protected="true" onclick="controlService('${name}', 'start')">Start</button>
                    <button class="btn btn-danger" data-protected="true" onclick="controlService('${name}', 'stop')" ${stopDisabled ? 'disabled' : ''} title="${stopTitle}">Stop</button>
                    <button class="btn btn-secondary" data-protected="true" onclick="controlService('${name}', 'restart')" ${restartDisabled ? 'disabled' : ''} title="${restartTitle}">Restart</button>
                </div>
            </div>
            ${isSelfService ? '<p style="color: var(--warning-color); font-size: 12px; margin-top: 8px;">`pod-manager` restart/stop must be done from the server shell so this UI does not disconnect itself.</p>' : ''}
            <pre style="color: var(--text-secondary); font-size: 12px; margin-top: 10px; max-height: 300px; overflow-y: auto;">${status.output.substring(0, 2000)}</pre>
        `;
        const buttons = item.querySelectorAll('button');
        buttons.forEach(btn => {
            if (!btn.disabled) {
                btn.disabled = state.readOnly;
            }
        });
        container.appendChild(item);
    }
    
    // Also update Restart All button state
    const restartAllBtn = document.querySelector('[onclick="restartAllServices()"]');
    if (restartAllBtn) {
        restartAllBtn.disabled = state.readOnly;
    }
    
    console.log('Services loaded, read-only:', state.readOnly);
}

async function controlService(name, action) {
    // Check read-only mode first with popup
    if (state.readOnly) {
        alert('Read-Only mode is enabled. Turn off the toggle to use service controls.');
        return;
    }
    
    if (guardDangerous()) return;
    
    if (name === 'pod-manager' && (action === 'stop' || action === 'restart')) {
        if (!confirm(`WARNING: ${action} on pod-manager will disconnect this interface. Continue?`)) {
            return;
        }
    } else {
        if (!confirm(`Are you sure you want to ${action} ${name}?`)) {
            return;
        }
    }
    
    try {
        const response = await fetch(`/api/services/${name}/${action}`, {
            method: 'POST'
        });
        const data = await parseJsonResponse(response);

        if (response.ok && data.success) {
            alert(`${name} ${action} successful`);
            await refreshServicesWithSettle();
        } else {
            const desiredRunning = action === 'start' || action === 'restart';
            try {
                const status = await getServiceStatus(name);
                if (status.running === desiredRunning) {
                    alert(`${name} ${action} successful`);
                    await refreshServicesWithSettle();
                    return;
                }
            } catch (statusError) {
                console.warn('Post-action status check failed:', statusError);
            }

            alert(`Error: ${data.error || `HTTP ${response.status}` || 'Request failed'}`);
        }
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

async function restartAllServices() {
    // Check read-only mode first with popup
    if (state.readOnly) {
        alert('Read-Only mode is enabled. Turn off the toggle to restart services.');
        return;
    }
    
    if (guardDangerous()) return;
    if (!confirm('Are you sure you want to restart ALL services?')) {
        return;
    }
    
    try {
        const response = await fetch('/api/services/restart-all', {
            method: 'POST'
        });
        const data = await parseJsonResponse(response);

        if (data.success) {
            alert('All services restarted');
            await loadServices();
        } else {
            alert(`Error: ${data.error || 'Request failed'}`);
        }
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

function refreshServices() {
    loadServices();
}


function togglePubkeyButton() {
    const service = document.getElementById('log-service').value;
    const btn = document.getElementById('find-pubkey-btn');
    if (btn) {
        btn.style.display = service === 'pod' ? 'inline-block' : 'none';
    }
}

// ============================================================================
// LOGS
// ============================================================================


function setLogLines(lines) {
    state.logLines = lines;
    document.querySelectorAll('.log-line-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.getAttribute('data-lines')) === lines);
    });
}

async function loadLogs() {
    const service = document.getElementById('log-service').value;
    const filter = document.getElementById('log-filter').value;
    const container = document.getElementById('logs-output');
    
    container.innerHTML = '<p>Loading logs...</p>';
    
    try {
        let url = `/api/logs/${service}?lines=${state.logLines}`;
        if (filter) {
            url += `&filter=${encodeURIComponent(filter)}`;
        }
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        const data = await response.json();
        
        console.log('Logs response:', { success: data.success, count: data.lines?.length, service });
        
        if (data.success && data.lines.length > 0) {
            container.innerHTML = data.lines.join('\n');
        } else if (data.success) {
            container.innerHTML = '<p>No logs found (empty response)</p>';
        } else {
            container.innerHTML = `<p style="color: var(--danger-color);">Error: ${data.error}</p>`;
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            container.innerHTML = '<p style="color: var(--danger-color);">Request timeout (>15s). Try fewer lines.</p>';
        } else {
            container.innerHTML = `<p style="color: var(--danger-color);">Error: ${error.message}</p>`;
        }
    }
}

// Manual pubkey management
async function saveManualPubkey() {
    const input = document.getElementById("manual-pubkey-input");
    const status = document.getElementById("pubkey-status");
    if (!input || !status) return;
    
    const pubkey = input.value.trim();
    if (!pubkey) {
        status.textContent = "Please enter a pubkey";
        status.style.color = "var(--danger-color)";
        return;
    }
    
    // Validate format (base58, 32-44 chars)
    const pubkeyRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    if (!pubkeyRegex.test(pubkey)) {
        status.textContent = "Invalid pubkey format (must be base58, 32-44 characters)";
        status.style.color = "var(--danger-color)";
        return;
    }
    
    status.textContent = "Saving...";
    status.style.color = "var(--text-secondary)";
    
    try {
        const resp = await fetch("/api/save-pubkey", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pubkey })
        });
        
        const data = await resp.json();
        if (data.success) {
            const shortPubkey = pubkey.substring(0, 8) + "..." + pubkey.substring(pubkey.length - 8);
            status.textContent = "✓ Pubkey saved: " + shortPubkey;
            status.style.color = "var(--success-color)";
            input.value = "";
            // Refresh credits
            await loadDashboardCredits();
        } else {
            status.textContent = "Error: " + (data.error || "Failed to save");
            status.style.color = "var(--danger-color)";
        }
    } catch (err) {
        status.textContent = "Error: " + err.message;
        status.style.color = "var(--danger-color)";
    }
}

// Load and display current pubkey on page load
async function loadCurrentPubkey() {
    const status = document.getElementById("pubkey-status");
    if (!status) return;
    
    try {
        const resp = await fetch("/api/pod-pubkey");
        const data = await resp.json();
        if (data.success && data.pubkey) {
            const shortPubkey = data.pubkey.substring(0, 8) + "..." + data.pubkey.substring(data.pubkey.length - 8);
            status.textContent = "Current pubkey: " + shortPubkey + " (" + (data.source || "unknown source") + ")";
            status.style.color = "var(--text-secondary)";
        } else {
            status.textContent = "No pubkey found. Use Find Pubkey or paste manually.";
            status.style.color = "var(--text-secondary)";
        }
    } catch (err) {
        // Silently fail - pubkey status is optional
    }
}


async function findPubkey() {
    if (guardDangerous()) return;
    const out = document.getElementById("eligibility-output");
    if (out) out.textContent = "Restarting pod to rescan pubkey...";
    try {
        const resp = await fetch("/api/find-pubkey", { method: "POST" });
        const data = await resp.json();
        if (data.success && data.pubkey) {
            if (out) out.textContent = "Pubkey found: " + data.pubkey + ". Refreshing credits...";
            // Refresh pubkey status display
            await loadCurrentPubkey();
            await loadDashboardCredits();
        } else {
            if (out) out.textContent = "Pubkey not found in recent logs.";
        }
    } catch (err) {
        if (out) out.textContent = "Error scanning pubkey: " + err.message;
    }
}


// ============================================================================
// pRPC API
// ============================================================================

async function callAPI(method) {
    const container = document.getElementById('api-output');
    updateAPIFormat(method, {});
    container.innerHTML = '<p>Calling API...</p>';
    
    try {
        const response = await fetch(`/api/prpc/${method}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ params: {} })
        });
        const data = await parseJsonResponse(response);

        if (response.ok && data.success) {
            container.innerHTML = `<pre>${JSON.stringify(data.result || data.raw || data, null, 2)}</pre>`;
        } else {
            const errorText = data.error || data.raw || `HTTP ${response.status}`;
            container.innerHTML = `<p style="color: var(--danger-color);">Error: ${errorText}</p>`;
        }
    } catch (error) {
        container.innerHTML = `<p style="color: var(--danger-color);">Error: ${error.message}</p>`;
    }
}

async function callCustomAPI() {
    const method = document.getElementById('custom-method').value.trim();
    
    if (!method) {
        alert('Please enter a method name');
        return;
    }
    updateAPIFormat(method, {});
    await callAPI(method);
}

// ============================================================================
// NETWORK
// ============================================================================

async function runNetworkDiagnostics() {
    const container = document.getElementById('network-output');
    container.innerHTML = '<p>Running network diagnostics...</p>';
    
    try {
        const response = await fetch('/api/network');
        const data = await response.json();
        
        if (data.success) {
            displayNetworkDiagnostics(data.diagnostics);
        } else {
            container.innerHTML = `<p style="color: var(--danger-color);">Error: ${data.error}</p>`;
        }
    } catch (error) {
        container.innerHTML = `<p style="color: var(--danger-color);">Error: ${error.message}</p>`;
    }
}

function displayNetworkDiagnostics(diagnostics) {
    const container = document.getElementById('network-output');
    
    let html = '<p style="color: var(--text-secondary); margin-bottom: 15px; font-size: 13px;"><strong>Note:</strong> Ports listening on server. Firewall rules and port forwarding (if behind router) still required for external access.</p>';
    
    // Localhost section - sort by port number
    html += '<div class="network-section"><h4>Localhost Services</h4>';
    const localPorts = Object.entries(diagnostics.localhost).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
    localPorts.forEach(([port, status]) => {
        const icon = status.listening ? '✅' : '❌';
        const scope = status.isPublic ? ' (0.0.0.0 - PUBLIC + LOCALHOST)' : ' (127.0.0.1)';
        html += `<div class="port-status"><span class="icon">${icon}</span> TCP ${port}${status.listening ? scope : ''} ${status.listening ? 'LISTENING' : 'NOT LISTENING'}</div>`;
    });
    html += '</div>';
    
    // Public section
    if (diagnostics.public.ip) {
        html += `<div class="network-section"><h4>Public Access (${diagnostics.public.ip})</h4>`;
        
        // Sort UDP ports
        const udpSorted = diagnostics.public.udp.sort((a, b) => a.port - b.port);
        udpSorted.forEach(port => {
            const icon = port.accessible ? '✅' : '❌';
            html += `<div class="port-status"><span class="icon">${icon}</span> UDP ${port.port} ${port.accessible ? 'PUBLIC' : 'NOT PUBLIC'}</div>`;
        });
        
        // Divider between UDP and TCP
        if (udpSorted.length > 0 && diagnostics.public.tcp.length > 0) {
            html += '<hr style="margin: 12px 0; border: 0; border-top: 1px solid var(--border-color);">';
        }
        
        // Sort TCP ports
        const tcpSorted = diagnostics.public.tcp.sort((a, b) => a.port - b.port);
        tcpSorted.forEach(port => {
            const icon = port.accessible ? '✅' : '❌';
            html += `<div class="port-status"><span class="icon">${icon}</span> TCP ${port.port} ${port.accessible ? 'PUBLIC' : 'NOT PUBLIC'}</div>`;
        });
        
        html += '</div>';
    } else {
        html += '<div class="network-section"><p style="color: var(--warning-color);">Could not determine external IP</p></div>';
    }
    
    container.innerHTML = html;
}



// ============================================================================
// TERMINAL
// ============================================================================

function initializeTerminal() {
    terminal = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        theme: {
            background: '#0f172a',
            foreground: '#e2e8f0',
            cursor: '#6366f1'
        }
    });
    
    fitAddon = new FitAddon.FitAddon();
    terminal.loadAddon(fitAddon);
    
    terminal.open(document.getElementById('terminal-container'));
    fitAddon.fit();
    
    connectTerminalWebSocket();
    
    // Handle window resize
    window.addEventListener('resize', () => {
        if (fitAddon) {
            fitAddon.fit();
        }
    });
}

function connectTerminalWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/terminal`;
    
    terminalSocket = new WebSocket(wsUrl);
    
    terminalSocket.onopen = () => {
        terminal.write('\x1b[32mConnected to terminal\x1b[0m\r\n');
        
        // Send user role to backend
        terminalSocket.send(JSON.stringify({
            type: 'auth',
            role: window.userRole || 'admin'
        }));
        
        // IMPORTANT: Remove old listeners before attaching new ones (prevents duplicate chars)
        if (window.terminalDataHandler) {
            terminal.onData(() => {});
        }
        if (window.terminalResizeHandler) {
            terminal.onResize(() => {});
        }
        
        // Send data from terminal to WebSocket
        window.terminalDataHandler = terminal.onData(data => {
            if (terminalSocket.readyState === WebSocket.OPEN) {
                terminalSocket.send(JSON.stringify({
                    type: 'input',
                    data: data
                }));
            }
        });
        
        // Handle terminal resize
        window.terminalResizeHandler = terminal.onResize(({ cols, rows }) => {
            if (terminalSocket.readyState === WebSocket.OPEN) {
                terminalSocket.send(JSON.stringify({
                    type: 'resize',
                    cols: cols,
                    rows: rows
                }));
            }
        });
    };
    
    terminalSocket.onmessage = (event) => {
        terminal.write(event.data);
    };
    
    terminalSocket.onerror = (error) => {
        terminal.write('\r\n\x1b[31mWebSocket error occurred\x1b[0m\r\n');
    };
    
    terminalSocket.onclose = () => {
        terminal.write('\r\n\x1b[31mDisconnected from terminal\x1b[0m\r\n');
    };
}

function reconnectTerminal() {
    if (terminalSocket) {
        terminalSocket.close();
    }
    
    if (terminal) {
        terminal.clear();
    }
    
    setTimeout(() => {
        connectTerminalWebSocket();
    }, 500);
}
