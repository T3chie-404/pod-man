function showLoginMessage(text, isError = false) {
    const messageDiv = document.getElementById('login-message');
    messageDiv.textContent = text;
    messageDiv.className = isError ? 'error' : 'success';
    messageDiv.style.display = 'block';
}

function showMgmtMessage(text, isError = false) {
    const messageDiv = document.getElementById('mgmt-message');
    messageDiv.textContent = text;
    messageDiv.className = isError ? 'error' : 'success';
    messageDiv.style.display = 'block';
    setTimeout(() => {
        messageDiv.style.display = 'none';
    }, 3000);
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    
    try {
        const response = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        
        const data = await response.json();
        
        if (data.success) {
            // Check if admin - show user management
            if (data.role === 'admin') {
                document.querySelector('.login-container').style.display = 'none';
                document.getElementById('user-management').style.display = 'block';
                loadUsers();
            } else {
                // Standard or Demo user - redirect to dashboard
                window.location.href = '/index.html';
            }
        } else {
            showLoginMessage(data.error || 'Login failed', true);
        }
    } catch (error) {
        showLoginMessage('Error: ' + error.message, true);
    }
});

async function loadUsers() {
    try {
        const response = await fetch('/api/users/list');
        const data = await response.json();
        
        if (data.success) {
            const container = document.getElementById('user-list');
            container.innerHTML = '';
            
            data.users.forEach(user => {
                const userDiv = document.createElement('div');
                userDiv.className = 'user-row';
                userDiv.innerHTML = `
                    <div>
                        <strong>${user.username}</strong>
                        <span class="role-badge role-${user.role}">${user.role.toUpperCase()}</span>
                    </div>
                    <button class="btn btn-danger btn-small" onclick="deleteUser('${user.username}')">Delete</button>
                `;
                container.appendChild(userDiv);
            });
        }
    } catch (error) {
        console.error('Failed to load users:', error);
    }
}

async function addUser() {
    const username = document.getElementById('new-username').value.trim();
    const password = document.getElementById('new-password').value;
    const role = document.querySelector('input[name="new-role"]:checked').value;
    
    if (!username || !password) {
        showMgmtMessage('Username and password required', true);
        return;
    }
    
    try {
        const response = await fetch('/api/users/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, role })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showMgmtMessage('User added successfully', false);
            document.getElementById('new-username').value = '';
            document.getElementById('new-password').value = '';
            loadUsers();
        } else {
            showMgmtMessage(data.error || 'Failed to add user', true);
        }
    } catch (error) {
        showMgmtMessage('Error: ' + error.message, true);
    }
}

async function deleteUser(username) {
    if (!confirm(`Delete user: ${username}?`)) {
        return;
    }
    
    try {
        const response = await fetch('/api/users/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showMgmtMessage('User deleted', false);
            loadUsers();
        } else {
            showMgmtMessage(data.error || 'Failed to delete user', true);
        }
    } catch (error) {
        showMgmtMessage('Error: ' + error.message, true);
    }
}

