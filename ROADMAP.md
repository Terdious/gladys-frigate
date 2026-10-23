# Roadmap — Frigate for Gladys, "the best of both worlds"

This repository is a fork of
[LM1LC3N7/gladys-frigate](https://github.com/LM1LC3N7/gladys-frigate), the
external integration that connects Gladys Assistant to an **existing** Frigate
instance (sensors, confirmed switches, scene triggers, TLS and MQTT security).
The fork adds what had been built inside the Gladys core on the
`frigate-pr1` … `frigate-pr10` branches of
[Terdious/Gladys](https://github.com/Terdious/Gladys/tree/frigate-pr10-remote-instance):
Frigate **installed and driven by Gladys** (turnkey), cameras added from
Gladys with a model catalog, hardware acceleration, live view, PTZ and
diagnostics.

Tracking: [issue #1](https://github.com/Terdious/gladys-frigate/issues/1)
(epic) and the
[milestones](https://github.com/Terdious/gladys-frigate/milestones).

## Principles

- **Keep the base.** The upstream architecture stays: HTTP/MQTT/WebSocket
  clients, trust-on-first-use TLS, event engine, states, scenes. Scene keys and
  the existing external ids never change.
- **Two complementary modes** in one integration: `remote` (an existing
  Frigate, today's behavior, unchanged) and `managed` (Frigate as a
  sub-container declared in the manifest, started on demand by a button).
  Remote stays essential for Raspberry Pi and NAS owners; managed is for a
  machine fit for the job.
- **go2rtc** is the one embedded in the Frigate image (restream
  `rtsp://frigate:8554/<camera>`, one connection per camera). A standalone
  go2rtc sub-container is a later lead (#16).
- **No YAML for the user.** The Frigate configuration is generated; what the
  user sets in the Frigate UI (zones, masks, filters) is preserved.
- **Core dependencies are isolated** in the "Core track" milestone and
  proposed to GladysAssistant/Gladys as separate PRs. The integration works,
  with documented limits, without them.

## Milestones

| Version    | Milestone                                                                                    | Issues                                                                               |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 0.4.0      | Managed mode: Frigate sub-container, config generation, hardware, retention                  | #2 bootstrap, #3 sub-container + config, #4 detector, #5 retention                   |
| 0.5.0      | Camera management from Gladys: catalog (Tapo, Reolink, D-Link), add/remove, advanced sources | #6                                                                                   |
| 0.6.0      | Live view through the core HLS streaming (local and Gladys Plus), both modes                 | #7                                                                                   |
| 0.7.0      | PTZ, presets, night mode                                                                     | #8 ONVIF via Frigate, #9 D-Link HTTP                                                 |
| 0.8.0      | Diagnostics, MQTT debug, resource advice, catalog proposals                                  | #10, #11                                                                             |
| Core track | PRs for GladysAssistant/Gladys                                                               | #12 pids/tmpfs/4 ports, #13 on-demand pull, #14 host resources, #15 image per object |
| Later      | Unscheduled leads                                                                            | #16 standalone go2rtc, #17 Tapo battery cameras                                      |

## Known limits of the core sandbox (to confirm on a real machine)

`server/lib/external-integration/externalIntegration.buildSubContainerDescriptor.js`
on Gladys master: `PidsLimit: 100` (threads included), `/tmp` tmpfs 64 MB
`noexec`, `CapDrop ALL` + `no-new-privileges`, 3 published ports per
sub-container, every image pulled at install time even with `start: manual`,
caps of 4 GB / 2 CPU / 512 MB shm. The managed mode is designed to work inside
those bounds when possible (a disk volume on `/tmp/cache`, two published
ports: UI 8971 and RTSP 8554) and to **say clearly** in the connection status
what blocks otherwise. Core PRs #12 and #13 lift the limits.

## Process

PRs target `main` of this fork and are merged once `npm run format:check`,
`npm run lint` and `npm test` pass; releases go through **Actions → Release**
(the owner enables workflows on the fork; the ghcr.io package is made public
after the first release). Upstream proposal (LM1LC3N7) only once the managed
mode is validated on a real installation.
