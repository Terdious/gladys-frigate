// -----------------------------------------------------------------------------
// The three troubleshooting buttons:
//
//   - "Diagnostics report": one text with everything a support thread asks
//     for — versions, mode, Frigate, the real-time feed, the cameras (fps of
//     /api/stats, `status/<role>` of the feed), the detectors, the storage,
//     the pinned certificates, the warnings and, in managed mode, the
//     sub-container, the detector decision, the retention and the resource
//     advice. Read-only: it reads Frigate's /api/stats and /api/config and
//     the state of the sub-container, never reconnects nor writes anything.
//   - "Show the last real-time messages": the debug ring buffer fed by every
//     message of the feed (src/frigate/debugBuffer.js).
//   - "Propose a camera to the catalog": a pre-filled GitHub issue link the
//     user opens themselves (src/frigate/proposal.js).
//
// Never a password, a token or a cookie in the answers (host names and
// addresses are fine): only the presence of a secret is told (yes / no), and
// certificates by their public fingerprint.
//
// Thin adapter: the formatting lives in src/frigate/diagnostics.js.
// -----------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { configWarnings, isManaged, usesMqtt } from '../config.js';
import { createDebugBuffer } from '../frigate/debugBuffer.js';
import {
  DEBUG_SHOWN,
  cameraLines,
  composeReport,
  containerLine,
  detectorLines,
  formatAgo,
  formatDateTime,
  formatDebugMessages,
  formatDuration,
  hardwareLine,
  portsLine,
  storageLines,
  text,
} from '../frigate/diagnostics.js';
import { describeAdvice, resourceAdvice } from '../frigate/managed/advice.js';
import { buildProposal } from '../frigate/proposal.js';
import { endpointKey } from '../frigate/tlsTrust.js';
import { describeDetector, describeRetention } from './managed.js';
import { describeAuth, describeError, describeTls, shortFingerprint } from './messages.js';

const PACKAGE_URL = new URL('../../package.json', import.meta.url);

/** The integration version, from package.json (read once). */
async function readPackageVersion() {
  try {
    return JSON.parse(await readFile(PACKAGE_URL, 'utf8')).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const FEED_STATES = {
  connecting: text('connecting', 'connexion en cours'),
  connected: text('connected', 'connecté'),
  disconnected: text('interrupted, retrying', 'interrompu, nouvel essai en cours'),
  failed: text(
    'stopped (fix the cause, then "Test the connection")',
    'arrêté (corrigez la cause, puis « Tester la connexion »)',
  ),
};

const yesNo = (value) => (value ? text('yes', 'oui') : text('no', 'non'));

/** "https://192.168.1.10:8971" without any user info of the URL. */
function frigateOrigin(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/** Trust store key of the Frigate endpoint (https only), else null. */
function frigateEndpoint(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? endpointKey(parsed.hostname, parsed.port || 443) : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {() => ReturnType<import('./frigateSession.js').createFrigateSession>} options.getSession
 * @param {ReturnType<import('./managed.js').createManagedFrigate> | null} [options.managed]
 * @param {import('../frigate/tlsTrust.js').TrustStore} options.trustStore loaded
 * @param {() => number} [options.now]
 * @param {() => Promise<string>} [options.packageVersion]
 * @param {ReturnType<typeof createDebugBuffer>} [options.buffer]
 */
export function createDiagnostics({
  getSession,
  managed = null,
  trustStore,
  now = Date.now,
  packageVersion = readPackageVersion,
  buffer = createDebugBuffer({ now: () => new Date(now()) }),
}) {
  // camera -> { role: state } from `<camera>/status/<role>` (0.17+).
  const statuses = new Map();
  let version = null;

  async function integrationVersion() {
    version ??= await packageVersion();
    return version;
  }

  /** "MQTT broker host:port" / "Frigate WebSocket" / "no feed". */
  function feedSource(feed) {
    if (!feed) return text('no real-time feed yet', 'pas encore de flux temps réel');
    return feed.mode === 'mqtt'
      ? text(`MQTT broker ${feed.endpoint}`, `broker MQTT ${feed.endpoint}`)
      : text('Frigate WebSocket', 'WebSocket de Frigate');
  }

  function feedLines(session) {
    const { feed } = session;
    if (!feed) {
      return [
        text(
          'Not started: it starts once Frigate has been read',
          'Pas démarré : il démarre une fois Frigate lu',
        ),
      ];
    }
    const source = feedSource(feed);
    const { state, error } = feed.status;
    const shown = FEED_STATES[state] ?? text(String(state));
    const capital = (value) => `${value[0].toUpperCase()}${value.slice(1)}`;
    const lines = [
      text(`${capital(source.en)}: ${shown.en}`, `${capital(source.fr)} : ${shown.fr}`),
    ];
    if (error) {
      lines.push(
        describeError(error, {
          en: feed.mode === 'mqtt' ? `MQTT broker ${feed.endpoint}` : 'Frigate',
          fr: feed.mode === 'mqtt' ? `Broker MQTT ${feed.endpoint}` : 'Frigate',
        }),
      );
    }
    const last = buffer.lastAt;
    lines.push(
      last
        ? text(
            `Last message ${formatAgo(now() - last.getTime()).en} (${buffer.received} since the start)`,
            `Dernier message ${formatAgo(now() - last.getTime()).fr} (${buffer.received} depuis le démarrage)`,
          )
        : text('No message received yet', "Aucun message reçu pour l'instant"),
    );
    const online = session.frigateOnline;
    const announced =
      online == null
        ? text('unknown', 'inconnu')
        : online
          ? text('online', 'en ligne')
          : text('offline', 'hors ligne');
    const flapping = yesNo(session.flapping);
    lines.push(
      text(
        `Frigate announces: ${announced.en}; drops its broker connection again and again: ${flapping.en}`,
        `Frigate s'annonce : ${announced.fr} ; perd sans cesse sa connexion au broker : ${flapping.fr}`,
      ),
    );
    return lines;
  }

  function tlsLines(config, client) {
    const managedMode = isManaged(config);
    const lines = [];
    const pins = new Map(trustStore.list().map((pin) => [pin.endpoint, pin]));
    const pinLine = (what, key) => {
      const pin = key ? pins.get(key) : null;
      pins.delete(key);
      if (!pin) return null;
      const since = pin.pinned_at ? formatDateTime(pin.pinned_at) : '?';
      return text(
        `${what.en} ${key}: pinned SHA-256 ${shortFingerprint(pin.fingerprint)} (since ${since})`,
        `${what.fr} ${key} : SHA-256 épinglé ${shortFingerprint(pin.fingerprint)} (depuis ${since})`,
      );
    };
    if (managedMode) {
      lines.push(
        text(
          'Frigate: internal port over the private network of the integration, no TLS needed',
          "Frigate : port interne sur le réseau privé de l'intégration, sans TLS",
        ),
      );
    } else {
      const decision = client?.tlsDecision ?? null;
      if (client) {
        const tls = describeTls(decision);
        lines.push(text(`Frigate certificate: ${tls.en}`, `Certificat de Frigate : ${tls.fr}`));
      }
      lines.push(pinLine(text('Frigate'), frigateEndpoint(config.frigate_url)));
    }
    if (usesMqtt(config)) {
      lines.push(
        config.mqtt_tls
          ? (pinLine(text('Broker'), safeKey(config.mqtt_host, config.mqtt_port)) ??
              text('Broker: TLS, no pinned certificate', 'Broker : TLS, aucun certificat épinglé'))
          : text('Broker: no TLS', 'Broker : sans TLS'),
      );
    }
    if (pins.size > 0) {
      lines.push(
        text(
          `${pins.size} other pinned endpoint(s) (an older address)`,
          `${pins.size} autre(s) point(s) épinglé(s) (une ancienne adresse)`,
        ),
      );
    }
    const expert = config.tls_fingerprint
      ? text(
          `set (${shortFingerprint(config.tls_fingerprint)})`,
          `définie (${shortFingerprint(config.tls_fingerprint)})`,
        )
      : text('none', 'aucune');
    const ca = yesNo(Boolean(config.tls_ca));
    lines.push(
      text(
        `Expert fingerprint: ${expert.en}; custom authority: ${ca.en}`,
        `Empreinte experte : ${expert.fr} ; autorité personnalisée : ${ca.fr}`,
      ),
    );
    return lines;
  }

  function safeKey(host, port) {
    try {
      return endpointKey(host, port);
    } catch {
      return null;
    }
  }

  async function managedLines(config, raw, capabilities) {
    if (!managed) return [];
    const lines = [];
    let entry = null;
    try {
      entry = await managed.container();
      lines.push(
        containerLine(entry, now()),
        portsLine(entry?.ports),
        hardwareLine(entry?.devices),
      );
    } catch (err) {
      lines.push(
        text(
          `Container frigate: state unreadable (${err.message})`,
          `Conteneur frigate : état illisible (${err.message})`,
        ),
      );
    }
    const inspected = await managed.inspect(config, raw, entry).catch(() => null);
    if (inspected) {
      lines.push(...describeDetector(inspected.decision, inspected));
      lines.push(describeRetention(inspected.retention));
    }
    lines.push(
      text(
        `Generated configuration: ${managed.configPath} (/config/config.yml in Frigate)`,
        `Configuration générée : ${managed.configPath} (/config/config.yml dans Frigate)`,
      ),
    );
    const adminSet = yesNo(await managed.adminPasswordSet().catch(() => false));
    lines.push(
      text(
        `Admin password set by Gladys: ${adminSet.en}`,
        `Mot de passe admin défini par Gladys : ${adminSet.fr}`,
      ),
    );
    const cameras = capabilities?.cameras.length ?? inspected?.cameras ?? 0;
    lines.push(...describeAdvice(resourceAdvice({ cameras, detector: inspected?.decision?.kind })));
    return lines;
  }

  return {
    /** The raw tap of the feed (frigateSession `onRawMessage`). */
    recordRaw(topic, payload) {
      buffer.record(topic, payload);
    },

    /** Every typed message (frigateSession `onMessage`): the camera roles. */
    noteMessage(message) {
      if (message?.type !== 'cameraStatus') return;
      const roles = statuses.get(message.camera) ?? {};
      roles[message.role] = message.state;
      statuses.set(message.camera, roles);
    },

    /** "Diagnostics report". */
    async report() {
      const session = getSession();
      const config = session.config;
      const header = [
        text(
          `Frigate integration diagnostics, ${formatDateTime(now())}`,
          `Diagnostic de l'intégration Frigate, ${formatDateTime(now())}`,
        ),
      ];
      const integration = await integrationVersion();
      if (!config) {
        header.push(
          text(
            `Integration ${integration}: not configured yet.`,
            `Intégration ${integration} : pas encore configurée.`,
          ),
        );
        return composeReport(header, []);
      }
      const managedMode = isManaged(config);
      header.push(
        managedMode
          ? text(
              `Integration ${integration}, mode: managed (Frigate installed by Gladys)`,
              `Intégration ${integration}, mode : géré (Frigate installé par Gladys)`,
            )
          : text(
              `Integration ${integration}, mode: remote (existing Frigate)`,
              `Intégration ${integration}, mode : distant (Frigate existant)`,
            ),
      );
      const { capabilities, client } = session;
      const [stats, frigateConfig] = client
        ? await Promise.all([
            client.getStats().catch(() => null),
            client.getConfig().catch(() => null),
          ])
        : [null, null];

      const where = managedMode ? 'http://frigate:5000' : frigateOrigin(config.frigate_url);
      const frigate = [];
      if (capabilities) {
        frigate.push(
          text(
            `Version ${capabilities.version.raw}, reachable at ${where}`,
            `Version ${capabilities.version.raw}, joignable à ${where}`,
          ),
        );
        const uptime = Number(stats?.service?.uptime);
        if (Number.isFinite(uptime)) {
          const duration = formatDuration(uptime * 1000);
          frigate.push(text(`Up for ${duration}`, `Démarré depuis ${duration}`));
        }
        if (!managedMode && client) {
          const auth = describeAuth(client.authMode, config.username);
          frigate.push(text(`Account: ${auth.en}`, `Compte : ${auth.fr}`));
        }
      } else {
        frigate.push(
          text(
            `Not reachable at ${where ?? 'the configured address'} (the connection status says why)`,
            `Injoignable à ${where ?? "l'adresse configurée"} (le statut de connexion dit pourquoi)`,
          ),
        );
      }

      const cameras = capabilities?.cameras ?? [];
      const warnings = [...configWarnings(config)];
      if (trustStore.saveError) {
        warnings.push(
          text(
            'The pinned certificates cannot be saved in /data (memory only)',
            'Les certificats épinglés ne peuvent pas être enregistrés dans /data (mémoire seule)',
          ),
        );
      }
      return composeReport(header, [
        { title: text('Frigate'), lines: frigate },
        { title: text('Real-time feed', 'Flux temps réel'), lines: feedLines(session) },
        {
          title: text(`Cameras (${cameras.length})`, `Caméras (${cameras.length})`),
          lines: capabilities
            ? cameras.length
              ? cameraLines(cameras, stats, statuses)
              : [text('None in Frigate', 'Aucune dans Frigate')]
            : [],
        },
        {
          title: text('Detectors', 'Détecteurs'),
          lines: detectorLines(stats, frigateConfig?.detectors ?? null, now()),
        },
        { title: text('Storage', 'Stockage'), lines: storageLines(stats) },
        { title: text('Certificates (TLS)', 'Certificats (TLS)'), lines: tlsLines(config, client) },
        {
          title: text('Managed mode', 'Mode géré'),
          lines: managedMode
            ? await managedLines(config, session.rawConfig ?? {}, capabilities)
            : [],
        },
        {
          title: text('Warnings', 'Avertissements'),
          lines: warnings.length ? warnings : [text('None', 'Aucun')],
        },
        {
          title: text('About this report', 'À propos de ce rapport'),
          lines: [
            text(
              'No password, token or key in it; host names and addresses are: mask them before sharing if needed',
              "Aucun mot de passe, jeton ni clé ; les noms d'hôte et adresses y figurent : masquez-les avant de partager si besoin",
            ),
            managedMode
              ? text(
                  "Frigate's own logs: the supervision block of the integration in Gladys",
                  "Logs de Frigate : le bloc de supervision de l'intégration dans Gladys",
                )
              : null,
          ],
        },
      ]);
    },

    /** "Show the last real-time messages". */
    mqttDebug() {
      return formatDebugMessages(buffer.entries(DEBUG_SHOWN), {
        received: buffer.received,
        source: feedSource(getSession().feed),
      });
    },

    /**
     * "Propose a camera to the catalog": the GitHub link to open.
     * @param {{ brand?: string, model?: string, source_type?: string, notes?: string }} fields
     */
    async proposeCamera(fields = {}) {
      const brand = String(fields.brand ?? '').trim();
      const model = String(fields.model ?? '').trim();
      if (!brand || !model) {
        return text(
          'Fill in the brand and the model of the camera.',
          'Renseignez la marque et le modèle de la caméra.',
        );
      }
      const session = getSession();
      const proposal = buildProposal({
        brand,
        model,
        sourceType: fields.source_type,
        notes: fields.notes ?? '',
        frigateVersion: session.capabilities?.version.raw ?? '',
        integrationVersion: await integrationVersion(),
        mode: isManaged(session.config) ? 'managed' : 'remote',
      });
      const shortened = proposal.shortened
        ? text(
            ' Your notes were shortened to fit in the link.',
            ' Vos notes ont été raccourcies pour tenir dans le lien.',
          )
        : text('');
      return text(
        `Open this link in your browser to propose "${brand} ${model}" on GitHub (a GitHub account is needed). Review the text there before submitting: the integration sends nothing itself, and addresses or passwords found in the notes were masked.${shortened.en}\n\n${proposal.url}`,
        `Ouvrez ce lien dans votre navigateur pour proposer « ${brand} ${model} » sur GitHub (un compte GitHub est nécessaire). Relisez le texte avant d'envoyer : l'intégration n'envoie rien elle-même, et les adresses ou mots de passe trouvés dans les notes ont été masqués.${shortened.fr}\n\n${proposal.url}`,
      );
    },

    /** The debug buffer (tests). */
    buffer,
  };
}
