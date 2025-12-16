// Load current configuration
async function loadConfig() {
    try {
        const response = await fetch('/api/central/status');
        const data = await response.json();
        
        if (data.success) {
            const status = data.status;
            
            // Update form fields
            document.getElementById('enabled-toggle').checked = status.enabled;
            document.getElementById('auto-connect').checked = status.autoConnect || false;
            
            // Don't show API key for security (it's encrypted)
            // User must enter it to update
            
            // Update status display
            updateStatusDisplay(status);
        }
    } catch (error) {
        showMessage('Error loading configuration: ' + error.message, 'error');
    }
}


// Auto-refresh connection status every 10 seconds
let statusRefreshInterval = null;

function startStatusAutoRefresh() {
    // Clear existing interval if any
    if (statusRefreshInterval) {
        clearInterval(statusRefreshInterval);
    }
    
    // Refresh immediately
    loadConfig();
    
    // Then refresh every 10 seconds
    statusRefreshInterval = setInterval(() => {
        loadConfig();
    }, 10000); // 10 seconds
}

function stopStatusAutoRefresh() {
    if (statusRefreshInterval) {
        clearInterval(statusRefreshInterval);
        statusRefreshInterval = null;
    }
}

// Start auto-refresh when page loads
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startStatusAutoRefresh);
} else {
    startStatusAutoRefresh();
}

// Stop when page unloads
window.addEventListener("beforeunload", stopStatusAutoRefresh);


function updateStatusDisplay(status) {
    const statusDiv = document.getElementById('connection-status');
    
    if (!status.enabled) {
        statusDiv.innerHTML = '<span class="status-badge" style="background: #6b7280;">Disabled</span>';
        return;
    }
    
    if (status.connected) {
        statusDiv.innerHTML = `
            <span class="status-badge" style="background: #10b981;">Connected</span>
            <p style="margin-top: 10px;">
                Server: ${status.centralUrl || 'Not configured'}<br>
                Last Heartbeat: ${status.lastHeartbeat ? new Date(status.lastHeartbeat).toLocaleString() : 'Never'}
            </p>
        `;
    } else if (status.reconnectAttempts > 0) {
        statusDiv.innerHTML = `
            <span class="status-badge" style="background: #f59e0b;">Reconnecting...</span>
            <p style="margin-top: 10px;">
                Attempt: ${status.reconnectAttempts}<br>
                Server: ${status.centralUrl || 'Not configured'}
            </p>
        `;
    } else {
        statusDiv.innerHTML = '<span class="status-badge" style="background: #ef4444;">Disconnected</span>';
    }
}

async function saveConfiguration() {
    const enabled = document.getElementById('enabled-toggle').checked;
    const centralUrl = document.getElementById('central-url').value.trim();
    const apiKey = document.getElementById('api-key').value.trim();
    const autoConnect = document.getElementById('auto-connect').checked;
    
    if (enabled && (!centralUrl || !apiKey)) {
        showMessage('Please provide both Central Server URL and API Key', 'error');
        return;
    }
    
    try {
        const response = await fetch('/api/central/configure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled, centralUrl, apiKey, autoConnect })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showMessage('Configuration saved successfully', 'success');
            updateStatusDisplay(data.status);
            
            // Clear API key field for security
            document.getElementById('api-key').value = '';
        } else {
            showMessage('Error: ' + data.error, 'error');
        }
    } catch (error) {
        showMessage('Error saving configuration: ' + error.message, 'error');
    }
}

async function testConnection() {
    showMessage('Testing connection...', 'info');
    
    try {
        const response = await fetch('/api/central/connect', {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.success) {
            showMessage('Connection test successful!', 'success');
            updateStatusDisplay(data.status);
            
            // Refresh status after a moment
            setTimeout(loadConfig, 2000);
        } else {
            showMessage('Connection failed: ' + data.error, 'error');
        }
    } catch (error) {
        showMessage('Connection test failed: ' + error.message, 'error');
    }
}

async function disconnect() {
    if (!confirm('Disconnect from central management server?')) {
        return;
    }
    
    try {
        const response = await fetch('/api/central/disconnect', {
            method: 'POST'
        });
        
        const data = await response.json();
        
        if (data.success) {
            showMessage('Disconnected from central server', 'success');
            updateStatusDisplay(data.status);
        } else {
            showMessage('Error: ' + data.error, 'error');
        }
    } catch (error) {
        showMessage('Error disconnecting: ' + error.message, 'error');
    }
}

function showMessage(text, type) {
    const messageDiv = document.getElementById('message');
    messageDiv.textContent = text;
    messageDiv.className = type === 'error' ? 'error' : type === 'success' ? 'success' : 'info';
    messageDiv.style.display = 'block';
    
    if (type === 'success' || type === 'info') {
        setTimeout(() => {
            messageDiv.style.display = 'none';
        }, 5000);
    }
}

// Load config on page load
document.addEventListener('DOMContentLoaded', loadConfig);

// Refresh status every 10 seconds
setInterval(loadConfig, 10000);

