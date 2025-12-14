const axios = require("axios");

/**
 * pRPC API Client
 * 
 * SECURITY CONSIDERATIONS:
 * - Only connects to localhost (127.0.0.1)
 * - Validates RPC method names
 * - Timeout on all requests (5s)
 * - Error handling for malformed responses
 */

const PRPC_URL = "http://127.0.0.1:6000/rpc";
const REQUEST_TIMEOUT = 5000; // 5 seconds

// Whitelist of known safe RPC methods
const KNOWN_METHODS = [
  "get-version",
  "get-stats",
  "get-pods",
  "get-pods-with-stats",
  "get-pubkey",
  "get-balance"
];

class PRPCClient {
  /**
   * Make a generic RPC call
   */
  static async call(method, params = {}) {
    try {
      const response = await axios.post(
        PRPC_URL,
        {
          jsonrpc: "2.0",
          method: method,
          params: params,
          id: Date.now()
        },
        {
          headers: {
            "Content-Type": "application/json"
          },
          timeout: REQUEST_TIMEOUT
        }
      );
      
      return {
        success: true,
        method: method,
        result: response.data.result,
        raw: response.data
      };
    } catch (error) {
      return {
        success: false,
        method: method,
        error: error.message,
        details: error.response?.data || null
      };
    }
  }

  /**
   * Get pod version
   */
  static async getVersion() {
    return await this.call("get-version");
  }

  /**
   * Get pod statistics
   */
  static async getStats() {
    return await this.call("get-stats");
  }

  /**
   * Get connected pods
   */
  static async getPods() {
    return await this.call("get-pods");
  }

  /**
   * Get pods with statistics
   */
  static async getPodsWithStats() {
    return await this.call("get-pods-with-stats");
  }

  /**
   * Check if pRPC API is accessible
   */
  static async healthCheck() {
    try {
      const result = await this.getVersion();
      return {
        accessible: result.success,
        method: "get-version",
        result: result
      };
    } catch (error) {
      return {
        accessible: false,
        error: error.message
      };
    }
  }

  /**
   * Get all available info
   */
  static async getAllInfo() {
    const [version, stats, pods] = await Promise.all([
      this.getVersion(),
      this.getStats(),
      this.getPods()
    ]);
    
    return {
      version,
      stats,
      pods,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Validate if a method name looks safe
   * SECURITY: Prevents potential RPC injection
   */
  static isValidMethod(method) {
    // Only allow alphanumeric and dashes
    return /^[a-z0-9-]+$/i.test(method);
  }

  /**
   * Execute custom RPC method (with validation)
   */
  static async customCall(method, params = {}) {
    if (!this.isValidMethod(method)) {
      return {
        success: false,
        error: "Invalid method name format. Only alphanumeric and dashes allowed."
      };
    }
    
    return await this.call(method, params);
  }
}

module.exports = PRPCClient;
