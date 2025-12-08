let additionalUsers = [];
let userIdCounter = 0;

function addUserForm() {
    const userId = userIdCounter++;
    const container = document.getElementById('additional-users');
    
    const userDiv = document.createElement('div');
    userDiv.className = 'user-item';
    userDiv.id = `user-${userId}`;
    userDiv.innerHTML = `
        <div style="flex: 1;">
            <div style="display: flex; gap: 10px; margin-bottom: 8px;">
                <input type="text" placeholder="Username" id="username-${userId}" style="flex: 1;">
                <input type="password" placeholder="Password" id="password-${userId}" style="flex: 1;">
            </div>
            <div class="role-toggle">
                <label>
                    <input type="radio" name="role-${userId}" value="admin" checked>
                    Admin
                </label>
                <label>
                    <input type="radio" name="role-${userId}" value="standard">
                    Standard
                </label>
                <label>
                    <input type="radio" name="role-${userId}" value="demo">
                    Demo
                </label>
            </div>
        </div>
        <button type="button" class="btn btn-danger btn-small" onclick="removeUser(${userId})">Remove</button>
    `;
    
    container.appendChild(userDiv);
    additionalUsers.push(userId);
}

function removeUser(userId) {
    const userDiv = document.getElementById(`user-${userId}`);
    if (userDiv) {
        userDiv.remove();
    }
    additionalUsers = additionalUsers.filter(id => id !== userId);
}

function showMessage(text, isError = false) {
    const messageDiv = document.getElementById('message');
    messageDiv.textContent = text;
    messageDiv.className = isError ? 'error' : 'success';
    messageDiv.style.display = 'block';
}

document.getElementById('setup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const adminUsername = document.getElementById('admin-username').value.trim();
    const adminPassword = document.getElementById('admin-password').value;
    const adminPasswordConfirm = document.getElementById('admin-password-confirm').value;
    
    // Validate admin account
    if (!adminUsername || !adminPassword) {
        showMessage('Admin username and password are required', true);
        return;
    }
    
    if (adminPassword !== adminPasswordConfirm) {
        showMessage('Admin passwords do not match', true);
        return;
    }
    
    if (adminPassword.length < 6) {
        showMessage('Password must be at least 6 characters', true);
        return;
    }
    
    // Build users array
    const users = [{
        username: adminUsername,
        password: adminPassword,
        role: 'admin'
    }];
    
    // Add additional users
    for (const userId of additionalUsers) {
        const username = document.getElementById(`username-${userId}`).value.trim();
        const password = document.getElementById(`password-${userId}`).value;
        const role = document.querySelector(`input[name="role-${userId}"]:checked`).value;
        
        if (username && password) {
            users.push({ username, password, role });
        }
    }
    
    // Check for duplicate usernames
    const usernames = users.map(u => u.username);
    if (new Set(usernames).size !== usernames.length) {
        showMessage('Duplicate usernames not allowed', true);
        return;
    }
    
    // Submit to backend
    try {
        const response = await fetch('/api/setup/initialize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ users })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showMessage('Setup complete! Redirecting to login...', false);
            setTimeout(() => {
                window.location.href = '/login.html';
            }, 1500);
        } else {
            showMessage(data.error || 'Setup failed', true);
        }
    } catch (error) {
        showMessage('Error: ' + error.message, true);
    }
});

