const fs = require('fs');
let content = fs.readFileSync('lib/central/central-connector.js', 'utf8');

// Find the send method
const oldSend = `  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }`;

const newSend = `  send(message) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      console.log('[Central] Sending message:', message.type);
      this.ws.send(JSON.stringify(message));
    } else {
      console.log('[Central] Cannot send, WebSocket not open. State:', this.ws ? this.ws.readyState : 'no ws');
    }
  }`;

content = content.replace(oldSend, newSend);

fs.writeFileSync('lib/central/central-connector.js', content);
console.log('✓ Added send logging');
