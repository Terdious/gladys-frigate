// -----------------------------------------------------------------------------
// Pure formatters of the "Diagnostics report" and "Show the last real-time
// messages" buttons.
//
// Gladys shows an action result as plain text with its line breaks kept
// (`white-space: pre-wrap`), in a scrolling box: the report is made of short
// titled sections of `•` bullets, both languages built side by side. What
// goes in is already free of secrets (the adapter, src/gladys/diagnostics.js,
// never hands a password, a token or a cookie over); host names and
// addresses are fine.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

/** The report stays readable in the Gladys result box. */
export const MAX_REPORT_LINES = 60;
export const MAX_LISTED_CAMERAS = 10;
/** Messages shown by "Show the last real-time messages". */
export const DEBUG_SHOWN = 50;
/** Characters per language of the debug answer (50 × 2000 would be 100 KB). */
export const MAX_DEBUG_TEXT_LENGTH = 20_000;
/** Frigate's watchdog restarts a detector stuck this long. */
const STUCK_DETECTION_S = 10;

const BULLET = '  • ';

/** { en, fr } in one call. */
export const text = (en, fr = en) => ({ en, fr });

const fixed = (value, digits = 1) =>
  Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '?';

/** "3 s", "4 min", "2 h", "5 d" (same in both languages). */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/** "3 s ago" / "il y a 3 s". */
export function formatAgo(ms) {
  const duration = formatDuration(ms);
  return text(`${duration} ago`, `il y a ${duration}`);
}

/** "HH:MM:SS" in UTC (the container has no time zone of its own). */
export function formatClock(date) {
  return new Date(date).toISOString().slice(11, 19);
}

/** "2026-10-23 14:02 UTC". */
export function formatDateTime(date) {
  const iso = new Date(date).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * One text out of titled sections, both languages, capped at `maxLines`.
 * @param {Array<{ en: string, fr: string }>} header lines before the sections
 * @param {Array<{ title: { en: string, fr: string }, lines: Array<{ en: string, fr: string } | null> }>} sections
 * @param {{ maxLines?: number }} [options]
 */
export function composeReport(header, sections, { maxLines = MAX_REPORT_LINES } = {}) {
  const rows = [...header.filter(Boolean)];
  for (const section of sections) {
    const lines = section.lines.filter(Boolean);
    if (lines.length === 0) continue;
    rows.push(
      text(''),
      section.title,
      ...lines.map((line) => text(BULLET + line.en, BULLET + line.fr)),
    );
  }
  let kept = rows;
  if (rows.length > maxLines) {
    kept = [...rows.slice(0, maxLines - 1), text('… (report shortened)', '… (rapport raccourci)')];
  }
  return {
    en: kept.map((row) => row.en).join('\n'),
    fr: kept.map((row) => row.fr).join('\n'),
  };
}

const STATUS_TEXT = {
  online: text('online', 'en ligne'),
  offline: text('offline', 'hors ligne'),
  disabled: text('disabled', 'désactivé'),
};

/**
 * One line per camera: fps from /api/stats, `status/<role>` from the feed.
 * @param {Array<{ name: string, friendlyName: string, enabled: boolean }>} cameras
 * @param {object | null} stats /api/stats
 * @param {Map<string, Record<string, string>>} statuses camera -> role -> state
 * @returns {Array<{ en: string, fr: string }>}
 */
export function cameraLines(cameras, stats, statuses = new Map()) {
  const lines = cameras.slice(0, MAX_LISTED_CAMERAS).map((camera) => {
    const name =
      camera.friendlyName && camera.friendlyName !== camera.name
        ? `${camera.name} (${camera.friendlyName})`
        : camera.name;
    if (camera.enabled === false) {
      return text(`${name}: disabled in Frigate`, `${name} : désactivée dans Frigate`);
    }
    const entry = stats?.cameras?.[camera.name];
    const fps = entry
      ? text(
          `camera ${fixed(entry.camera_fps)} fps, detection ${fixed(entry.detection_fps)} fps, skipped ${fixed(entry.skipped_fps)} fps`,
          `caméra ${fixed(entry.camera_fps)} i/s, détection ${fixed(entry.detection_fps)} i/s, sautées ${fixed(entry.skipped_fps)} i/s`,
        )
      : text('no statistics', 'aucune statistique');
    const roles = Object.entries(statuses.get(camera.name) ?? {});
    const status = roles.length
      ? text(
          roles.map(([role, state]) => `${role} ${STATUS_TEXT[state]?.en ?? state}`).join(', '),
          roles.map(([role, state]) => `${role} ${STATUS_TEXT[state]?.fr ?? state}`).join(', '),
        )
      : null;
    return text(
      `${name}: ${fps.en}${status ? `; ${status.en}` : ''}`,
      `${name} : ${fps.fr}${status ? ` ; ${status.fr}` : ''}`,
    );
  });
  if (cameras.length > MAX_LISTED_CAMERAS) {
    const more = cameras.length - MAX_LISTED_CAMERAS;
    lines.push(text(`… and ${more} more`, `… et ${more} de plus`));
  }
  return lines;
}

/**
 * One line per detector of /api/stats: type (from /api/config), inference
 * speed, and whether a detection is running for too long.
 * @param {object | null} stats
 * @param {Record<string, { type?: string }> | null} detectorsConfig /api/config `detectors`
 * @param {number} nowMs
 */
export function detectorLines(stats, detectorsConfig, nowMs) {
  const detectors = Object.entries(stats?.detectors ?? {});
  return detectors.map(([name, entry]) => {
    const type = detectorsConfig?.[name]?.type;
    const label = type ? `${name} (${type})` : name;
    const start = Number(entry?.detection_start);
    let state = text('idle', 'au repos');
    if (Number.isFinite(start) && start > 0) {
      const runningS = nowMs / 1000 - start;
      state =
        runningS >= STUCK_DETECTION_S
          ? text(
              `detection running for ${Math.round(runningS)} s (stuck?)`,
              `détection en cours depuis ${Math.round(runningS)} s (bloquée ?)`,
            )
          : text('detecting', 'détection en cours');
    }
    return text(
      `${label}: inference ${fixed(entry?.inference_speed)} ms, ${state.en}`,
      `${label} : inférence ${fixed(entry?.inference_speed)} ms, ${state.fr}`,
    );
  });
}

const STORAGE_PATHS = [
  { path: '/media/frigate/recordings', name: text('Recordings', 'Enregistrements'), gb: true },
  { path: '/tmp/cache', name: text('Cache (/tmp/cache)'), gb: false },
  { path: '/dev/shm', name: text('Shared memory (/dev/shm)', 'Mémoire partagée (/dev/shm)') },
];

/** Recordings, cache and shared memory of /api/stats `service.storage` (MB). */
export function storageLines(stats) {
  const storage = stats?.service?.storage ?? {};
  const lines = [];
  for (const { path, name, gb } of STORAGE_PATHS) {
    const entry = storage[path];
    if (!entry || !Number.isFinite(entry.used) || !Number.isFinite(entry.total)) continue;
    const unit = gb ? text('GB', 'Go') : text('MB', 'Mo');
    const size = (mb) => (gb ? (mb / 1024).toFixed(1) : String(Math.round(mb)));
    lines.push(
      text(
        `${name.en}: ${size(entry.used)} ${unit.en} used of ${size(entry.total)} ${unit.en}`,
        `${name.fr} : ${size(entry.used)} ${unit.fr} utilisés sur ${size(entry.total)} ${unit.fr}`,
      ),
    );
  }
  return lines;
}

const HARDWARE_NAMES = {
  'coral-usb': 'Coral USB',
  'coral-pcie': 'Coral PCIe',
  gpu: 'GPU',
};

/** "Coral USB: usable · GPU: detected, not granted". */
export function hardwareLine(devices = []) {
  if (!devices.length) return null;
  const parts = devices.map((device) => {
    const name = HARDWARE_NAMES[device.class] ?? device.class;
    let state;
    if (device.granted && device.available) state = text('granted, detected', 'autorisé, détecté');
    else if (device.granted) state = text('granted, not detected', 'autorisé, non détecté');
    else if (device.available) state = text('detected, not granted', 'détecté, non autorisé');
    else state = text('absent');
    return text(`${name}: ${state.en}`, `${name} : ${state.fr}`);
  });
  return text(
    `Hardware: ${parts.map((p) => p.en).join(' · ')}`,
    `Matériel : ${parts.map((p) => p.fr).join(' · ')}`,
  );
}

/** "Host ports: frigate_ui 42115, frigate_rtsp 42116". */
export function portsLine(ports = []) {
  if (!ports.length) return null;
  const list = (none) =>
    ports.map((port) => `${port.name ?? port.container_port} ${port.host_port ?? none}`).join(', ');
  return text(`Host ports: ${list('not assigned')}`, `Ports hôte : ${list('non attribué')}`);
}

/** "Container frigate: running (wanted: running), started … (2 h ago)". */
export function containerLine(entry, nowMs) {
  if (!entry) {
    return text(
      'Container frigate: Gladys reports none (Gladys too old, or the integration not updated)',
      "Conteneur frigate : Gladys n'en indique aucun (Gladys trop ancien, ou intégration pas à jour)",
    );
  }
  const started = entry.started_at ? new Date(entry.started_at) : null;
  const since =
    started && !Number.isNaN(started.getTime())
      ? {
          en: `, started ${formatDateTime(started)} (${formatAgo(nowMs - started.getTime()).en})`,
          fr: `, démarré le ${formatDateTime(started)} (${formatAgo(nowMs - started.getTime()).fr})`,
        }
      : { en: '', fr: '' };
  return text(
    `Container ${entry.name}: ${entry.status} (wanted: ${entry.desired ?? 'unknown'})${since.en}`,
    `Conteneur ${entry.name} : ${entry.status} (souhaité : ${entry.desired ?? 'inconnu'})${since.fr}`,
  );
}

/**
 * The answer of "Show the last real-time messages": `HH:MM:SS topic payload`,
 * newest first, at most `limit` messages and MAX_DEBUG_TEXT_LENGTH characters.
 * @param {Array<{ topic: string, payload: string, received_at: string }>} entries newest first
 * @param {object} options
 * @param {number} options.received messages received since the start
 * @param {{ en: string, fr: string }} options.source "MQTT broker x:1883"…
 * @param {number} [options.limit]
 * @param {number} [options.maxLength]
 */
export function formatDebugMessages(
  entries,
  { received, source, limit = DEBUG_SHOWN, maxLength = MAX_DEBUG_TEXT_LENGTH },
) {
  if (entries.length === 0) {
    return text(
      `No real-time message received yet (${source.en}). Frigate publishes on changes: move in front of a camera, then press the button again.`,
      `Aucun message temps réel reçu pour l'instant (${source.fr}). Frigate publie à chaque changement : passez devant une caméra, puis cliquez de nouveau.`,
    );
  }
  const shown = entries.slice(0, limit);
  const lines = [];
  let length = 0;
  for (const entry of shown) {
    // One message per line: a payload with line breaks would read as several.
    const line = `${formatClock(entry.received_at)} ${entry.topic} ${entry.payload.replace(/\s*[\r\n]+\s*/g, ' ')}`;
    if (length + line.length + 1 > maxLength && lines.length > 0) break;
    lines.push(line);
    length += line.length + 1;
  }
  const omitted = shown.length - lines.length;
  const head = text(
    `Last ${lines.length} of ${received} real-time messages since the start (${source.en}), newest first, times in UTC. Payloads are cut at 2000 characters; images show as [binary, N bytes]; nothing secret is kept.`,
    `${lines.length} derniers des ${received} messages temps réel reçus depuis le démarrage (${source.fr}), du plus récent au plus ancien, heures UTC. Contenus coupés à 2000 caractères ; images affichées [binary, N bytes] ; rien de secret n'est conservé.`,
  );
  const tail =
    omitted > 0
      ? text(
          `… ${omitted} older messages left out (answer size).`,
          `… ${omitted} messages plus anciens omis (taille de la réponse).`,
        )
      : null;
  const body = lines.join('\n');
  return {
    en: [head.en, '', body, tail?.en].filter((part) => part !== undefined).join('\n'),
    fr: [head.fr, '', body, tail?.fr].filter((part) => part !== undefined).join('\n'),
  };
}
