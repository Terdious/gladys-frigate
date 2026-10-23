// -----------------------------------------------------------------------------
// In-memory ring buffer of the last real-time messages (MQTT or Frigate
// WebSocket), for the "Show the last real-time messages" button: what Frigate
// actually sends, without a broker client at hand.
//
//   - 200 messages at most, the oldest dropped first;
//   - payloads stored as text, cut at 2000 characters; a binary payload (a
//     JPEG snapshot, anything that is not UTF-8 text) is replaced by
//     `[binary, N bytes]`;
//   - defensive redaction: Frigate puts no secret in its topics, but a topic
//     naming a password or a token is never stored, and a payload value
//     whose key names one is masked (as are the credentials of a URL).
//
// Port of `recordMqttMessage` of the Gladys frigate-pr8 branch. Memory only:
// nothing is written to /data, the buffer starts empty at every start.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

export const DEBUG_BUFFER_SIZE = 200;
export const DEBUG_PAYLOAD_MAX_LENGTH = 2000;

const SECRET_WORD = /password|passwd|token|secret|api[_-]?key/i;
// `"password": "x"`, `token=x`, `'secret': 'x'`: the key stays, the value goes.
// Bounded repetitions: a long run of letters (base64) must not backtrack
// quadratically on every message.
const SECRET_VALUE =
  /((["']?)[\w.-]{0,40}(?:password|passwd|token|secret|api[_-]?key)[\w.-]{0,40}\2\s*[:=]\s*)("(?:[^"\\]|\\.){0,512}"|'[^']{0,512}'|[^\s,;&}\]]{1,512})/gi;
// rtsp://user:pass@host -> rtsp://***@host
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]{0,20}:\/\/)[^/\s@"']{1,256}@/gi;
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Mask what looks like a credential in a text (best effort, see the header). */
export function redactSecrets(text) {
  return String(text)
    .replace(URL_CREDENTIALS, '$1***@')
    .replace(SECRET_VALUE, (_, key, _quote, value) =>
      value.startsWith('"') ? `${key}"***"` : `${key}***`,
    );
}

/** A JPEG, a PNG, or bytes that are not UTF-8 text (or carry control characters). */
function isBinary(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return true;
  }
  let text;
  try {
    text = utf8.decode(buffer);
  } catch {
    return true;
  }
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000e-\u001f]/.test(text);
}

/**
 * A payload as the text stored in the buffer.
 * @param {string | Buffer | Uint8Array | number | boolean | object | null | undefined} payload
 *   MQTT gives a Buffer, the WebSocket a JSON value
 * @param {number} [maxLength]
 */
export function payloadText(payload, maxLength = DEBUG_PAYLOAD_MAX_LENGTH) {
  let text;
  if (payload instanceof Uint8Array) {
    const buffer = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    if (isBinary(buffer)) {
      return `[binary, ${buffer.length} bytes]`;
    }
    text = buffer.toString('utf8');
  } else if (typeof payload === 'string') {
    text = payload;
  } else if (payload === undefined) {
    text = '';
  } else {
    try {
      text = JSON.stringify(payload) ?? String(payload);
    } catch {
      text = String(payload);
    }
  }
  const length = text.length;
  // Cut before masking (a 256 KB camera_activity costs nothing more), with a
  // margin so that a secret across the cut is still recognised.
  text = redactSecrets(text.slice(0, maxLength + 600));
  return length > maxLength || text.length > maxLength
    ? `${text.slice(0, maxLength)}… [truncated, ${length} characters]`
    : text;
}

/**
 * @param {object} [options]
 * @param {number} [options.size]
 * @param {number} [options.maxPayloadLength]
 * @param {() => Date} [options.now]
 */
export function createDebugBuffer({
  size = DEBUG_BUFFER_SIZE,
  maxPayloadLength = DEBUG_PAYLOAD_MAX_LENGTH,
  now = () => new Date(),
} = {}) {
  let entries = []; // newest first
  let received = 0;
  let lastAt = null;

  return {
    /**
     * Record one message; a topic naming a credential is dropped.
     * @param {string} topic without the MQTT prefix
     * @param {unknown} payload
     */
    record(topic, payload) {
      const at = now();
      received += 1;
      lastAt = at;
      if (typeof topic !== 'string' || SECRET_WORD.test(topic)) {
        return;
      }
      entries.unshift({
        topic,
        payload: payloadText(payload, maxPayloadLength),
        received_at: at.toISOString(),
      });
      if (entries.length > size) {
        entries.length = size;
      }
    },

    /** The stored messages, newest first (`limit` of them). */
    entries(limit = size) {
      return entries.slice(0, limit);
    },

    /** Messages received since the start (stored or not). */
    get received() {
      return received;
    },

    /** When the last message arrived (Date), null before the first one. */
    get lastAt() {
      return lastAt;
    },

    clear() {
      entries = [];
    },
  };
}
