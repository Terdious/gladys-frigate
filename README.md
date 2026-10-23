# Frigate integration for Gladys Assistant

> **Fork** of [LM1LC3N7/gladys-frigate](https://github.com/LM1LC3N7/gladys-frigate)
> adding a **managed mode**: Frigate installed and driven by Gladys as a
> sub-container, cameras added from Gladys (model catalog), hardware
> acceleration, live view, PTZ and diagnostics. The connector to an existing
> Frigate (remote mode) is unchanged. Plan and status: [`ROADMAP.md`](./ROADMAP.md)
> and [issue #1](https://github.com/Terdious/gladys-frigate/issues/1).

External integration that brings [Frigate NVR](https://frigate.video) cameras
into [Gladys Assistant](https://gladysassistant.com). Goal: more reliable and
safer than the Home Assistant integration, built on the official Gladys
integration SDK.

> **Status: v1 feature-complete**, to be validated on real installations
> before a stable release. See the [CHANGELOG](./CHANGELOG.md).

| Compatibility    | Versions                                             |
| ---------------- | ---------------------------------------------------- |
| Gladys Assistant | 5.1 or later (`>=5.1.0`)                             |
| Frigate          | 0.16, 0.17, 0.18 (version and features read via API) |
| Node.js          | 20.18.1 or later (the image ships Node 24)           |

User documentation: [`docs/en.md`](./docs/en.md) / [`docs/fr.md`](./docs/fr.md)
(re-hosted by the Gladys store, linked from the Configuration screen).

Roadmap of the fork: [`ROADMAP.md`](./ROADMAP.md). Upstream decisions and
handoff notes (historical): [`TODO.md`](./TODO.md).

## v1 scope

- **One device per Frigate camera**, discovering only what the Frigate
  configuration enables: image (every minute and on alerts under 60 KB, on
  demand under 150 KB), camera enabled, detect / recordings / snapshots / audio switches
  (confirmed by Frigate), motion, one presence sensor and one counter per
  tracked object, a total counter, the review status, optional zone
  sensors, a transport badge per camera.
- **Scene triggers** (keys final, never renamed): `review_alert`,
  `object_detected`, `object_entered_zone`. **Scene action**:
  `attach_event_snapshot`.
- **PTZ** of the cameras Frigate drives over ONVIF: a `move` command (only
  the movements the camera supports, stopped automatically after 1.5 s) and
  a `preset` command (its ONVIF presets), shown by the dashboard widgets.
- **D-Link HTTP controls** (0.6.0, issue #9, managed mode): a DCS-5020L
  added from Gladys gets pan/tilt single steps (5°, no zoom) and a
  "Night mode (IR)" switch, sent to the camera itself with its admin
  account (control credentials).
- **Real-time feed** from the Frigate MQTT broker, or from the Frigate
  WebSocket when no broker is configured.
- **Security**: authenticated port 8971 with a dedicated (viewer) account,
  certificates verified by a CA or, when self-signed, trusted on first use and
  pinned (with a "Trust the new certificate" button); expert pinned
  fingerprint or custom CA; no secret
  in logs or URLs.
- **Live view** (0.6.0, issue #7): the ⏵ button of the dashboard Camera
  widget, locally and through Gladys Plus. Each camera device carries a
  `CAMERA_URL` param pointing at the Frigate go2rtc restream
  (`rtsp://<host>:8554/<camera>`), which the core `rtsp-camera` service turns
  into encrypted HLS: no core change, no video through this container.

- **Managed mode** (0.4.0, issues #3, #4, #5): Frigate 0.18 run by Gladys as
  the `frigate` sub-container of the manifest (`start: manual`), driven by the
  Start / Stop / Restart buttons. The integration generates `config.yml`
  (MQTT, detector from the granted hardware — Coral, Intel GPU/OpenVINO, CPU —,
  VAAPI decoding, recording retention) and keeps everything set in the
  Frigate UI; it sets Frigate's admin password ("Show the Frigate
  credentials") and talks to Frigate on its internal port 5000.
- **Camera management from Gladys** (0.5.0, issue #6, managed mode): one
  **Cameras** button (operation add / edit / remove / list) and a model
  catalog — TP-Link Tapo wired and battery/solar (`tapo://`, SHA256
  variant), Reolink RTSP and Home Hub, D-Link DCS-5020L (MJPEG),
  DCS-8302LH and DCS-8635LH, generic RTSP, ONVIF, custom go2rtc source.
  Cameras are stored in `/data/managed/cameras.json` (0600) and written to
  `config.yml` (go2rtc streams, restreamed inputs with record / detect
  roles, objects, detection fps, ONVIF endpoint); zones and masks drawn in
  the Frigate UI are kept, cameras added there are never touched.
- **Diagnostics** (0.7.0, issues #10, #11): a **Diagnostics** button with
  two reports — the overview (versions, feed, cameras, detectors, storage,
  pinned certificates, the managed container and its resource advice — shm
  and RAM per camera against the sandbox limits) and the last real-time
  messages (ring buffer of 200, payloads cut at 2000 characters) — and
  **Propose a camera to the catalog** (a pre-filled GitHub issue link the
  user opens). No secret in any answer.

Out of scope for now: faces and plates, classification, widgets, profiles,
multiple Frigate instances (see
[`ROADMAP.md`](./ROADMAP.md)).

## Architecture

```
index.js          wiring only
src/config.js     configuration defaults, normalization, validation, warnings
src/frigate/      Frigate client — NO Gladys dependency (enforced by ESLint)
  tlsTrust.js       trust-on-first-use policy + pin store (/data/tls-trust.json)
  tlsConnector.js   TLS sockets applying that policy before any byte is sent (HTTP, MQTT)
  httpClient.js     undici client: auth (probe, login, Bearer, renewal), timeouts, retries
  capabilities.js   /api/version + /api/config -> normalized cameras & features
                    (+ /api/<camera>/ptz/info for the ONVIF cameras)
  ptz.js            Gladys movement values -> Frigate PTZ payloads, supported moves
  dlink.js          D-Link HTTP controls: pan/tilt steps, night mode (basic auth, 5 s timeout)
  mqttStream.js     MQTT transport (TLS trust before the CONNECT), shared by the two below
  mqttProbe.js      one-shot broker check ("Test the connection")
  mqttClient.js     real-time feed from the broker: reconnection, resubscription
  wsClient.js       real-time feed from the Frigate WebSocket when there is no broker;
                    one-shot camera_activity read (MQTT keeps no object count)
  topics.js         MQTT / WebSocket messages -> typed messages
  eventEngine.js    events + reviews -> deduplicated transitions (score, cooldown)
  errors.js         typed errors, never carrying a secret
  debugBuffer.js    ring buffer of the last 200 feed messages (cut, binary, redacted)
  diagnostics.js    en/fr formatters of the diagnostics report and the debug answer
  proposal.js       pre-filled GitHub issue link of "Propose a camera to the catalog"
  managed/          managed mode, still without any Gladys dependency
    constants.js      Frigate image (one version), container and port names, presets
    detector.js       granted hardware (+ GPU vendor) -> detector, VAAPI, notes
    configFile.js     idempotent config.yml generation (Gladys-owned sections only)
    adminAccount.js   admin password bootstrap (PUT /api/users/admin/password)
    stateFile.js      /data/managed/state.json (0600): admin password, last start
    catalog.js        camera model catalog (presets, bilingual notes), COCO labels
    cameraSources.js  managed camera -> go2rtc sources + Frigate camera section
    camerasStore.js   /data/managed/cameras.json (0600): cameras added from Gladys
    advice.js         shm / RAM advice per camera against the container limits
src/gladys/       thin adapter to the Gladys SDK
  frigateSession.js connection lifecycle, real-time feed, status, the buttons,
                    resync when Frigate is back, MQTT flapping report; managed mode:
                    sub-container state in the status, start polling, crash loop
  managed.js        managed mode adapter: getContainers / start / stop / restart,
                    hardware grants, credentials, en/fr texts
  cameraActions.js  the "Cameras" button (add / edit / remove / list), en/fr answers
  discovery.js      Frigate cameras -> Gladys devices (Discover tab)
  live.js           live view: go2rtc restream URL (CAMERA_URL param), both modes
  images.js         camera images (resized by Frigate): 60 KB stored, 150 KB live
  deviceSync.js     states, commands (confirmed by Frigate), PTZ (1.5 s watchdog), D-Link controls, polls, badges
  cameraStates.js   typed messages -> feature states
  statePublisher.js dedupe, batches, rate limit of the states sent to Gladys
  transports.js     per-camera badge (unreachable / degraded), debounced
  sceneEvents.js    transitions -> scene triggers; attach_event_snapshot action
  diagnostics.js    the diagnostics (overview, last messages) and catalog buttons (read-only)
  messages.js       user-facing texts (en/fr) for errors, certificates, accounts
  keys.js           frozen manifest keys (scene triggers / actions)
  status.js         connection status message (errors and security warnings)
```

Runtime dependencies: `@gladysassistant/integration-sdk`, `mqtt`, `undici` (custom CA and certificate pinning for `fetch`
and the WebSocket fallback) and `yaml` (managed mode: Frigate's `config.yml` edited as a document, comments and
user sections kept).

## Development

```bash
npm install
npm run format:check   # Prettier
npm run lint           # ESLint (includes the layering rule)
npm test               # node --test, including an end-to-end run of index.js
npm audit --omit=dev   # the runtime dependencies shipped in the image
npm run validate:manifest   # store admission rules (image must be published)
```

`test/index.e2e.test.js` runs the real `index.js` in a child process against
a fake Gladys (host API and WebSocket, `test/helpers/fakeGladys.js`), a fake
Frigate and an MQTT broker stub: it catches a handler that is not registered
or a hook that is not connected, which unit tests cannot see.

Run against a Gladys instance in developer mode:

```bash
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="frigate" \
FRIGATE_DATA_DIR="./.data" \
LOG_LEVEL=debug npm start
```

`FRIGATE_DATA_DIR` (default `/data`, the container volume) is where the
pinned certificates are saved, and, in managed mode, the Frigate
configuration (`containers/frigate/config/config.yml`) and
`managed/state.json`. `FRIGATE_MANAGED_URL` (default `http://frigate:5000`,
the sub-container on the private network) points the managed mode at another
Frigate, for development and `test/index.managed.e2e.test.js`.

`test/fixtures/tls/` holds test-only certificates (a test CA and a
`localhost` certificate); they are never used outside the test suite.

## Publishing

1. Make the repository public and add the GitHub topic
   `gladys-assistant-integration`.
2. Run **Actions → Release** (patch / minor / major): it runs the CI checks,
   bumps the version in `package.json` and the manifest, turns the
   CHANGELOG's "Unreleased" section into the version, tags `vX.Y.Z` and
   pushes the multi-arch image (`linux/amd64`, `linux/arm64`) to `ghcr.io`.
3. Make the `ghcr.io` package public (first release only).

## License

[Apache-2.0](./LICENSE). Test fixtures derived from
[frigate-hass-integration](https://github.com/blakeblackshear/frigate-hass-integration)
(MIT), if any, are credited in `NOTICE`.
