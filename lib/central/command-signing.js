const crypto = require('crypto');

const COMMAND_SIGNATURE_VERSION = 'v1';
const COMMAND_MAX_AGE_MS = 5 * 60 * 1000;
const COMMAND_NONCE_TTL_MS = 10 * 60 * 1000;

function stableStringify(value) {
  if (value === null || value === undefined) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function deriveCommandSigningSecret(apiKey) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('API key is required to derive command signing secret');
  }

  return crypto
    .createHash('sha256')
    .update(`pod-man-command-signing:${COMMAND_SIGNATURE_VERSION}:${apiKey}`)
    .digest('hex');
}

function buildSigningPayload(fields) {
  return stableStringify(fields);
}

function signPayload(secret, fields) {
  return crypto
    .createHmac('sha256', secret)
    .update(buildSigningPayload(fields))
    .digest('hex');
}

function verifySignedPayload(secret, fields, signature) {
  if (!signature || typeof signature !== 'string') {
    return false;
  }

  const expected = signPayload(secret, fields);
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

module.exports = {
  COMMAND_MAX_AGE_MS,
  COMMAND_NONCE_TTL_MS,
  COMMAND_SIGNATURE_VERSION,
  deriveCommandSigningSecret,
  signPayload,
  stableStringify,
  verifySignedPayload
};
