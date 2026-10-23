// -----------------------------------------------------------------------------
// Integration configuration: defaults, normalization, validation, warnings.
//
// The user fills the form Gladys generates from the manifest `config_schema`;
// the SDK hands us raw values (strings, numbers, booleans, or nothing for a
// field never saved). Everything else reads the output of `normalizeConfig()`,
// so the defaults live here and stay aligned with the manifest
// (test/manifest.test.js checks it).
// -----------------------------------------------------------------------------

import { X509Certificate } from 'node:crypto';

export const MODES = Object.freeze({ REMOTE: 'remote', MANAGED: 'managed' });
export const DETECTORS = Object.freeze(['auto', 'coral', 'openvino', 'cpu']);
export const GPU_VENDORS = Object.freeze(['intel', 'amd', 'none']);

export const DEFAULT_CONFIG = Object.freeze({
  // `remote`: an existing Frigate (the upstream behavior, unchanged);
  // `managed`: Frigate run by Gladys as the `frigate` sub-container.
  mode: MODES.REMOTE,
  frigate_url: '',
  username: '',
  password: '',
  mqtt_host: '',
  mqtt_port: 1883,
  mqtt_username: '',
  mqtt_password: '',
  mqtt_tls: false,
  mqtt_topic_prefix: 'frigate',
  min_score: 70,
  trigger_cooldown: 30,
  zone_sensors: false,
  // Live view (go2rtc RTSP restream of Frigate). A blank host means the host
  // of the Frigate URL, or 127.0.0.1 in managed mode (src/gladys/live.js).
  live_rtsp_host: '',
  live_rtsp_port: 8554,
  // Managed mode only.
  detector: 'auto',
  gpu_vendor: 'intel',
  record_continuous_days: 2,
  record_alerts_days: 7,
  record_detections_days: 7,
  snapshots_retain_days: 14,
  // Expert TLS settings, both optional. Without them, a certificate signed by
  // a public authority is verified normally and a self-signed one (Frigate's
  // default on port 8971) is trusted on first use, then pinned.
  tls_fingerprint: '',
  tls_ca: '',
});

const PEM_BLOCK = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

function text(value) {
  return value == null ? '' : String(value).trim();
}

function choice(value, choices, fallback) {
  const chosen = text(value);
  return choices.includes(chosen) ? chosen : fallback;
}

function integer(value, fallback, min, max) {
  const n = Math.round(Number(value));
  // Number('') and Number('  ') are 0: a blank field keeps the default.
  return Number.isFinite(n) && text(value) !== '' ? Math.min(max, Math.max(min, n)) : fallback;
}

/**
 * Rebuild well-formed PEM certificates from a paste. The Gladys form has no
 * multi-line field, so a certificate pasted there arrives on a single line:
 * the base64 body is re-wrapped at 64 characters.
 * @param {string} raw
 * @returns {string} zero, one or several PEM blocks separated by newlines
 */
export function normalizePem(raw) {
  const blocks = [];
  for (const [, body] of String(raw ?? '').matchAll(PEM_BLOCK)) {
    const base64 = body.replace(/\s+/g, '');
    if (base64) {
      const lines = base64.match(/.{1,64}/g).join('\n');
      blocks.push(`-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----`);
    }
  }
  return blocks.join('\n');
}

/**
 * Normalize a SHA-256 certificate fingerprint to Node's `fingerprint256`
 * format ("AB:CD:…", 32 uppercase pairs). Returns '' when it is not one.
 * @param {string} raw
 */
export function normalizeFingerprint(raw) {
  const hex = String(raw ?? '')
    .replace(/^.*=/s, '') // "SHA256 Fingerprint=AB:CD…" (openssl output)
    .replace(/^\s*sha-?256\s*:?/i, '') // "sha256:AB:CD…"
    .replace(/[^0-9a-f]/gi, '')
    .toUpperCase();
  return hex.length === 64 ? hex.match(/.{2}/g).join(':') : '';
}

const MAX_DAYS = 3650;
const RETENTION_FIELDS = [
  'record_continuous_days',
  'record_alerts_days',
  'record_detections_days',
  'snapshots_retain_days',
];

/**
 * Merge the raw user configuration with the defaults.
 * @param {Record<string, unknown>} [raw] configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    mode: choice(raw.mode, Object.values(MODES), DEFAULT_CONFIG.mode),
    frigate_url: text(raw.frigate_url).replace(/\/+$/, ''),
    username: text(raw.username),
    password: raw.password == null ? '' : String(raw.password),
    mqtt_host: text(raw.mqtt_host),
    mqtt_port: integer(raw.mqtt_port, DEFAULT_CONFIG.mqtt_port, 1, 65535),
    mqtt_username: text(raw.mqtt_username),
    mqtt_password: raw.mqtt_password == null ? '' : String(raw.mqtt_password),
    mqtt_tls: raw.mqtt_tls === true,
    mqtt_topic_prefix:
      text(raw.mqtt_topic_prefix).replace(/^\/+|\/+$/g, '') || DEFAULT_CONFIG.mqtt_topic_prefix,
    min_score: integer(raw.min_score, DEFAULT_CONFIG.min_score, 0, 100),
    trigger_cooldown: integer(raw.trigger_cooldown, DEFAULT_CONFIG.trigger_cooldown, 0, 3600),
    zone_sensors: raw.zone_sensors === true,
    live_rtsp_host: text(raw.live_rtsp_host),
    live_rtsp_port: integer(raw.live_rtsp_port, DEFAULT_CONFIG.live_rtsp_port, 1, 65535),
    detector: choice(raw.detector, DETECTORS, DEFAULT_CONFIG.detector),
    gpu_vendor: choice(raw.gpu_vendor, GPU_VENDORS, DEFAULT_CONFIG.gpu_vendor),
    ...Object.fromEntries(
      RETENTION_FIELDS.map((key) => [key, integer(raw[key], DEFAULT_CONFIG[key], 0, MAX_DAYS)]),
    ),
    tls_fingerprint: normalizeFingerprint(raw.tls_fingerprint),
    tls_ca: normalizePem(raw.tls_ca),
  };
}

/** True when Frigate is the sub-container run by Gladys. */
export function isManaged(config) {
  return config?.mode === MODES.MANAGED;
}

/**
 * The retention days the user saved in Gladys, null for a field never saved
 * (or emptied): config.yml then keeps the days set in the Frigate UI.
 * @param {Record<string, unknown>} [raw]
 * @returns {{ continuous: number | null, alerts: number | null,
 *   detections: number | null, snapshots: number | null }}
 */
export function explicitRetention(raw = {}) {
  const read = (key) => (text(raw[key]) === '' ? null : integer(raw[key], null, 0, MAX_DAYS));
  return {
    continuous: read('record_continuous_days'),
    alerts: read('record_alerts_days'),
    detections: read('record_detections_days'),
    snapshots: read('snapshots_retain_days'),
  };
}

/** True when real-time data comes from MQTT (otherwise: Frigate WebSocket). */
export function usesMqtt(config) {
  return Boolean(config.mqtt_host);
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * A host name or an IP address alone ("mqtt://broker" or "broker:1883" would
 * only fail later, at connection time). A single colon followed by digits is
 * a port; IPv6 addresses have several.
 * @param {string} host
 */
function isBareHost(host) {
  return !/[\s/]/.test(host) && !/^[^:]+:\d+$/.test(host);
}

/**
 * Check that the configuration is usable.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {Record<string, unknown>} [raw] the raw values, to report a field the
 *   user filled but that could not be parsed (certificate, fingerprint)
 * @returns {{ en: string, fr: string } | null} a user-facing error, or null
 */
export function validateConfig(config, raw = {}) {
  // Managed: the integration reaches its own Frigate on the private network,
  // without URL nor account to enter.
  const error = isManaged(config) ? null : validateRemote(config);
  if (error) {
    return error;
  }
  return validateCommon(config, raw);
}

/** The Frigate URL and account of the remote mode. */
function validateRemote(config) {
  if (!config.frigate_url) {
    return {
      en: 'Enter the URL of your Frigate server.',
      fr: "Renseignez l'URL de votre serveur Frigate.",
    };
  }
  const url = parseUrl(config.frigate_url);
  if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return {
      en: 'The Frigate URL must look like https://192.168.1.10:8971.',
      fr: "L'URL de Frigate doit ressembler à https://192.168.1.10:8971.",
    };
  }
  if (url.username || url.password || url.search || url.hash) {
    return {
      en: 'The Frigate URL must not contain credentials, a query string or a fragment.',
      fr: "L'URL de Frigate ne doit contenir ni identifiants, ni paramètres, ni fragment.",
    };
  }
  if (Boolean(config.username) !== Boolean(config.password)) {
    return {
      en: 'Fill in both the Frigate username and password, or leave both empty.',
      fr: "Renseignez l'utilisateur et le mot de passe Frigate, ou laissez les deux vides.",
    };
  }
  return null;
}

/** The TLS and MQTT settings, shared by both modes. */
function validateCommon(config, raw) {
  if (text(raw.tls_fingerprint) && !config.tls_fingerprint) {
    return {
      en: 'The certificate fingerprint must be a SHA-256 (64 hexadecimal characters).',
      fr: "L'empreinte du certificat doit être un SHA-256 (64 caractères hexadécimaux).",
    };
  }
  if (text(raw.tls_ca)) {
    let valid = Boolean(config.tls_ca);
    try {
      for (const [block] of config.tls_ca.matchAll(PEM_BLOCK)) new X509Certificate(block);
    } catch {
      valid = false;
    }
    if (!valid) {
      return {
        en: 'The certificate authority is not a valid PEM certificate.',
        fr: "L'autorité de certification n'est pas un certificat PEM valide.",
      };
    }
  }
  if (config.tls_fingerprint && config.tls_ca) {
    return {
      en: 'Fill in either the certificate fingerprint or the certificate authority, not both.',
      fr: "Renseignez soit l'empreinte du certificat, soit l'autorité de certification, pas les deux.",
    };
  }
  if (usesMqtt(config) && !isBareHost(config.mqtt_host)) {
    return {
      en: 'The MQTT broker host must be a host name or an IP address only, without mqtt://, port or path.',
      fr: "L'hôte du broker MQTT doit être un nom d'hôte ou une adresse IP seuls, sans mqtt://, port ni chemin.",
    };
  }
  // Same rule for the live view host, which ends up in rtsp://<host>:<port>/<camera>,
  // plus no credentials ("user:pw@host") and no port after a bracketed IPv6.
  const liveHost = config.live_rtsp_host;
  if (liveHost && (!isBareHost(liveHost) || /@|\]:\d+$/.test(liveHost))) {
    return {
      en: 'The live view RTSP host must be a host name or an IP address only, without rtsp://, port or path.',
      fr: "L'hôte RTSP de la vidéo en direct doit être un nom d'hôte ou une adresse IP seuls, sans rtsp://, port ni chemin.",
    };
  }
  if (usesMqtt(config) && /[+#\s]/.test(config.mqtt_topic_prefix)) {
    return {
      en: 'The MQTT topic prefix must not contain spaces or the wildcards + and #.',
      fr: 'Le préfixe des topics MQTT ne doit contenir ni espace, ni les jokers + et #.',
    };
  }
  return null;
}

/**
 * Non-blocking security warnings, shown in the connection status message.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @returns {Array<{ en: string, fr: string }>}
 */
export function configWarnings(config) {
  const warnings = [];
  // Managed: port 5000 is only reachable on the private network of the
  // integration, so it carries no warning.
  const url = isManaged(config) ? null : parseUrl(config.frigate_url);
  if (url?.protocol === 'http:' && !config.username) {
    warnings.push({
      en: 'Unauthenticated Frigate port (5000): anyone on the network has admin access. Prefer port 8971.',
      fr: "Port Frigate non authentifié (5000) : n'importe qui sur le réseau a un accès admin. Préférez le port 8971.",
    });
  } else if (url?.protocol === 'http:') {
    warnings.push({
      en: 'The Frigate password travels unencrypted over HTTP. Prefer https:// on port 8971.',
      fr: 'Le mot de passe Frigate circule en clair en HTTP. Préférez https:// sur le port 8971.',
    });
  }
  if (usesMqtt(config) && config.mqtt_password && !config.mqtt_tls) {
    warnings.push({
      en: 'The MQTT password travels unencrypted: enable TLS on the broker if it is not on a trusted network.',
      fr: "Le mot de passe MQTT circule en clair : activez TLS sur le broker s'il n'est pas sur un réseau de confiance.",
    });
  }
  // Frigate (paho-mqtt) verifies the broker certificate against authorities
  // only: no trust on first use, no pinned fingerprint.
  if (isManaged(config) && usesMqtt(config) && config.mqtt_tls && !config.tls_ca) {
    warnings.push({
      en: 'MQTT over TLS: Frigate only trusts a broker certificate signed by a public authority or by the authority of the expert settings (a self-signed broker needs it there).',
      fr: "MQTT sur TLS : Frigate n'approuve qu'un certificat de broker signé par une autorité publique ou par l'autorité des réglages experts (un broker auto-signé doit l'y avoir).",
    });
  }
  return warnings;
}
