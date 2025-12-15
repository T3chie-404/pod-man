const fs = require('fs');
let content = fs.readFileSync('lib/central/central-connector.js', 'utf8');

// Find the open handler
const oldOpen = `this.ws.on('open', () => {
      console.log('[Central] WebSocket opened, sending registration...');
      console.log('[Central] Connected to central server');
      this.connected = true;
      this.reconnectAttempts = 0;
      
      // Start heartbeat
      this.startHeartbeat();
      
      // Send initial registration
      console.log('[Central] Registration message sent');
      this.sendRegistration();
    });`;

const newOpen = `this.ws.on('open', () => {
      console.log('[Central] WebSocket opened, sending registration...');
      console.log('[Central] Connected to central server');
      this.connected = true;
      this.reconnectAttempts = 0;
      
      // Start heartbeat
      this.startHeartbeat();
      
      // Send initial registration (with small delay to ensure server is ready)
      setTimeout(() => {
        console.log('[Central] Registration message sent');
        this.sendRegistration();
      }, 100);
    });`;

content = content.replace(oldOpen, newOpen);

fs.writeFileSync('lib/central/central-connector.js', content);
console.log('✓ Fixed registration timing');
