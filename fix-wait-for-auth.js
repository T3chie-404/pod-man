const fs = require('fs');
let content = fs.readFileSync('lib/central/central-connector.js', 'utf8');

// Don't send registration on 'open', wait for server acknowledgment
const oldOpen = `    this.ws.on('open', () => {
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

const newOpen = `    this.ws.on('open', () => {
      console.log('[Central] Connected to central server');
      console.log('[Central] Waiting for authentication confirmation...');
      this.connected = true;
      this.reconnectAttempts = 0;
      
      // Start heartbeat
      this.startHeartbeat();
      
      // Registration will be sent when we receive 'authenticated' message
    });`;

content = content.replace(oldOpen, newOpen);

// Handle the 'authenticated' message
const oldHandle = `  async handleMessage(message) {
    const { type, id, command, params, signature } = message;

    switch (type) {
      case 'ping':`;

const newHandle = `  async handleMessage(message) {
    const { type, id, command, params, signature } = message;

    switch (type) {
      case 'authenticated':
        console.log('[Central] Authentication confirmed, sending registration...');
        this.sendRegistration();
        console.log('[Central] Registration sent');
        break;
        
      case 'ping':`;

content = content.replace(oldHandle, newHandle);

fs.writeFileSync('lib/central/central-connector.js', content);
console.log('✓ Fixed registration handshake');
