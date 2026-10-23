// -----------------------------------------------------------------------------
// Typed errors of the Frigate client.
//
// The Gladys adapter turns them into user-facing messages (src/gladys/
// messages.js); the client itself only states facts. No message ever carries
// a password, a token, a cookie or a request body.
// -----------------------------------------------------------------------------

export class FrigateError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The TLS peer was not trusted: the request was never sent. */
export class CertificateError extends FrigateError {
  /**
   * @param {string} reason a TRUST_REASONS value (src/frigate/tlsTrust.js)
   * @param {string} endpoint "host:port"
   * @param {string} fingerprint SHA-256 of the certificate that was refused
   */
  constructor(reason, endpoint, fingerprint) {
    super(`Untrusted certificate for ${endpoint} (${reason})`);
    this.reason = reason;
    this.endpoint = endpoint;
    this.fingerprint = fingerprint;
  }
}

/**
 * Frigate refused the credentials, or asked for some while none are
 * configured. `code`: 'invalid_credentials' | 'credentials_required' |
 * 'rate_limited' | 'forbidden'.
 */
export class AuthError extends FrigateError {
  constructor(code) {
    super(`Frigate authentication failed (${code})`);
    this.code = code;
  }
}

/** Frigate answered with an unexpected HTTP status. */
export class HttpStatusError extends FrigateError {
  constructor(status, path) {
    super(`Frigate answered HTTP ${status} on ${path}`);
    this.status = status;
    this.path = path;
  }
}

/** No answer: DNS, refused or reset connection, timeout. */
export class UnreachableError extends FrigateError {
  /** @param {string} code a Node error code (ECONNREFUSED…) or 'TIMEOUT' */
  constructor(code, options) {
    super(`Frigate is unreachable (${code})`, options);
    this.code = code;
  }
}

/** Frigate older than the oldest supported version (0.16). */
export class UnsupportedVersionError extends FrigateError {
  constructor(version) {
    super(`Frigate ${version} is not supported (0.16 or later required)`);
    this.version = version;
  }
}

/** The MQTT broker refused the connection (CONNACK return code). */
export class MqttRefusedError extends FrigateError {
  /** @param {'invalid_credentials' | 'not_authorized' | 'refused'} code */
  constructor(code) {
    super(`The MQTT broker refused the connection (${code})`);
    this.code = code;
  }
}

/**
 * The managed-mode Frigate configuration file cannot be generated.
 * `code`: 'invalid_yaml' (the file does not parse) | 'not_a_map' (its root
 * is not a mapping) | 'write_failed' (the folder is not writable).
 */
export class ManagedConfigError extends FrigateError {
  constructor(code, options) {
    super(`The Frigate configuration file cannot be generated (${code})`, options);
    this.code = code;
  }
}

/**
 * Frigate refused, or never answered, the admin password bootstrap of the
 * managed mode. `status` is the last HTTP status (null: no answer).
 */
export class AdminBootstrapError extends FrigateError {
  constructor(status, options) {
    super(
      `The Frigate admin password could not be set (${status == null ? 'no answer' : `HTTP ${status}`})`,
      options,
    );
    this.status = status;
  }
}

/**
 * A managed camera cannot be turned into a go2rtc source. `code`:
 * 'unknown_model' | 'missing_host' | 'missing_password' |
 * 'missing_custom_source'. Never carries a credential.
 */
export class CameraSourceError extends FrigateError {
  constructor(code, camera) {
    super(`Camera ${camera ?? '?'}: no go2rtc source (${code})`);
    this.code = code;
    this.camera = camera ?? null;
  }
}

/** /data/managed/cameras.json is not readable JSON: never overwritten blindly. */
export class CamerasStoreError extends FrigateError {
  constructor(options) {
    super('The managed cameras file (managed/cameras.json) is not valid JSON', options);
  }
}

/**
 * A D-Link HTTP control (pan/tilt, night mode) cannot be sent: no control
 * account (user and password) is known for the camera. Never sent at all.
 */
export class DlinkCredentialsError extends FrigateError {
  constructor() {
    super('The D-Link control credentials are missing');
  }
}

/** The D-Link camera answered a control with an unexpected HTTP status (401: not admin). */
export class DlinkHttpError extends FrigateError {
  constructor(status) {
    super(`The D-Link camera answered HTTP ${status}`);
    this.status = status;
  }
}

/** The D-Link camera did not answer a control (DNS, refused connection, timeout). */
export class DlinkUnreachableError extends FrigateError {
  /** @param {string} code a Node error code (ECONNREFUSED…) or 'TIMEOUT' */
  constructor(code, options) {
    super(`The D-Link camera is unreachable (${code})`, options);
    this.code = code;
  }
}
