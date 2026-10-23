# Frigate

Bring the cameras of your [Frigate NVR](https://frigate.video) into Gladys
Assistant: snapshots, motion, detected objects, review alerts, camera
switches, and scene triggers to react when a person, a car or an animal shows
up.

## Requirements

- **Gladys Assistant 5.1 or later.**
- **Frigate 0.16, 0.17 or 0.18.** The integration reads the Frigate version
  and configuration and only exposes what your Frigate actually enables.
- Recommended: the MQTT broker Frigate publishes to. Without a broker, the
  integration falls back to the Frigate WebSocket.
- No Frigate yet? Gladys can install and run it for you on a machine fit
  for it: see "Frigate installed by Gladys (managed mode)".

## Quick start

1. In Frigate, create a dedicated account: **Settings → Users → Add user**,
   role `viewer` (enough when an MQTT broker is used, see below).
2. In Gladys, install **Frigate** from the integration store, then open its
   **Configuration** tab: Frigate URL `https://<frigate-ip>:8971`, the
   account, and the MQTT broker Frigate publishes to. Save.
3. The status at the top says "Connected to Frigate …, Real-time feed: MQTT
   broker connected". **Test the connection** gives the details.
4. In the **Discover** tab, press **Add to Gladys** on your cameras.
5. Create scenes with the **Frigate** triggers (see Scenes).

## Frigate installed by Gladys (managed mode)

No Frigate yet? Choose **Frigate installed by Gladys (managed)** in the
**Deployment** section: Gladys runs Frigate 0.18 in a container of its own,
next to the integration, and writes its configuration for you. Otherwise
keep **Existing Frigate instance (remote)**, the behavior described in the
rest of this page.

### Prerequisites

- A machine fit for video analysis: a recent x86 mini PC (Intel N100 or
  better), ideally with a Google Coral or an Intel GPU. Frigate gets up to
  4 GB of RAM and 2 CPUs. On a **Raspberry Pi or a NAS**, prefer an existing
  Frigate on a separate machine (remote mode).
- Disk space for the recordings: they live in the Gladys data folder (an SD
  card wears out quickly under continuous recording — prefer an SSD).
- The Frigate image (more than 1 GB) is downloaded when the integration is
  installed, even if you never start it.

### Hardware acceleration

When installing the integration, Gladys lists the hardware the Frigate
container may use — **Coral USB**, **Coral PCIe**, **GPU** (`/dev/dri`) —
with what it detected. Grant what you have; you can change it later in the
**Hardware** block of the integration (supervision controls): Gladys then
recreates the Frigate container, and the integration regenerates the
configuration and restarts Frigate.

- **Object detector** (managed section): **Automatic** picks a Coral (USB,
  then PCIe), then an Intel GPU (OpenVINO), else the CPU. An explicit choice
  whose hardware is not granted or not detected falls back to the automatic
  choice, and the status says so.
- **GPU vendor**: the integration cannot read it from its container. Intel:
  OpenVINO detection and VAAPI video decoding (`ffmpeg.hwaccel_args:
preset-vaapi`); AMD: VAAPI decoding only, detection on CPU; None: the GPU
  is not used. NVIDIA GPUs are not supported in managed mode.
- CPU detection only works, slowly and CPU hungry: the status warns about
  it.

#### Which GPU do I have?

The GPU that matters is the one of the **machine running Gladys** (Docker
only shares `/dev/dri` on Linux; Gladys on Docker Desktop for Windows or
macOS has no GPU to grant: choose **None**).

- **Linux, command line** (SSH on the Gladys machine):
  `lspci | grep -i -E "vga|display"` names the chip ("Intel … UHD Graphics",
  "AMD … Radeon", "NVIDIA …"). `ls /dev/dri` must list a `renderD128` (else
  no GPU can be granted); `cat /sys/class/drm/renderD128/device/vendor` gives
  the vendor id: `0x8086` Intel, `0x1002` AMD, `0x10de` NVIDIA.
- **Linux, desktop**: Settings → About (GNOME, "Graphics") or System Settings
  → About this System (KDE), or the `hardinfo` / `inxi -G` tools.
- **Windows** (to know the hardware before installing Linux on it): Task
  Manager → Performance → GPU, or `dxdiag` → Display tab.
- **macOS**: Apple menu → About This Mac → Graphics (Apple Silicon and AMD
  GPUs of Macs are not usable by Frigate in a container anyway).

Intel 6th generation (Skylake) or later with an iGPU is the sweet spot for
the managed mode: OpenVINO detection and VAAPI decoding, no Coral needed for a
few cameras. An **NVIDIA** GPU is not usable in the managed mode (the core
exposes `/dev/dri` only, not the NVIDIA runtime): choose **None**, or a Coral.

### Start, stop, restart

1. Choose the managed mode and save: the first save starts Frigate by
   itself. The integration writes the Frigate configuration, then asks
   Gladys to start the container. The status follows: "starting…", then
   "Connected to Frigate 0.18.0 (installed by Gladys)". The first start can
   take a few minutes (on a Gladys that downloads the Frigate image at that
   moment, longer).
2. **Start Frigate**, **Stop Frigate** and **Restart Frigate** drive it
   afterwards: a Frigate you stopped stays stopped until you press Start,
   whatever you save.
3. Press **Show the Frigate credentials**: the address of the Frigate UI,
   `https://<address of Gladys>:<port>` (the port Gladys assigned, also the
   "Frigate UI" link of the supervision block and of the managed section),
   and the `admin` account the integration created. The certificate is
   self-signed: accept it in your browser. The answer is only shown to you.
4. Add your cameras with the **Cameras** button (see "Adding cameras"
   below), or in the Frigate UI; then **Add to Gladys** in the Discover tab,
   as in remote mode.

**Stop Frigate** stops the container (Gladys will not restart it);
**Restart Frigate** regenerates the configuration and restarts it. Saving the
configuration of the integration applies the managed settings at once: a
running Frigate restarts only when its configuration actually changes.

### Adding cameras (managed mode)

The **Cameras** button manages the cameras of a Frigate installed by Gladys,
without writing any YAML. Pick its **operation**, fill in the fields it
uses (the others are ignored), and run it:

- **Add a camera**: a name, a model from the catalog below (generic RTSP
  when empty), the IP address and the account of the camera. Optional: the
  objects to detect (`person` when empty, comma-separated Frigate labels:
  `person, car, dog, cat, horse, bird, bicycle, motorcycle, bus, truck`…)
  and the detection frames per second (5 when empty, 1 to 15).
- **Edit a camera**: pick it in the **Camera** list (or type its Frigate name
  when it is not created in Gladys yet). A blank field keeps its value;
  objects and frames per second replace the stored ones when filled in.
- **Remove a camera**: takes it out of Frigate. Its recordings already made
  stay in the Frigate media folder; the Gladys device stays too (delete it
  from its page if you no longer need it).
- **List the cameras** (the default operation): the cameras added from
  Gladys (model, address, objects, frames per second — never a password)
  and the ones added in the Frigate UI.

After each change, the integration writes the Frigate configuration and
restarts Frigate when it runs (about 30 seconds; the connection status
follows). Then open the **Discover** tab, press **Scan**, and **Add to
Gladys**. The answer of the button gives the note of the model (what to do
on the camera side) and these next steps.

The **Frigate name** of a camera is derived from its name once and for all
("Front door" → `front_door`): it identifies the Gladys device forever.
Editing the name later only changes the name shown by Frigate.

| Brand        | Models                                                                        | What to enter                                                                                     | Note                                                                                                                                                                            |
| ------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TP-Link Tapo | wired: C100, C110, C120, C200, C210, C225, C310, C320WS, C325WB, C500, C520WS | IP, the **camera account** of the Tapo app (camera settings → Advanced settings → Camera account) | Not your TP-Link cloud account. Streams `stream1` / `stream2`, ONVIF (PTZ) on port 2020.                                                                                        |
| TP-Link Tapo | battery/solar: C400, C420, C425, C460, C610, C645D, C660, D230                | IP, the password of your **TP-Link cloud** account (no user)                                      | No RTSP: go2rtc's `tapo://`, light 640×360 stream. "401 Unauthorized" in the Frigate logs: edit the camera with the authentication variant **SHA256**.                          |
| Reolink      | RLC, E1, Duo (RTSP)                                                           | IP, the camera account                                                                            | Paths `h264Preview_01_main` / `h264Preview_01_sub`, ONVIF on port 8000. Enable RTSP / ONVIF in the Reolink app if they are off.                                                 |
| Reolink      | Argus and other battery cameras (Home Hub)                                    | IP **of the Home Hub**, its account                                                               | Channel 1 by default (`Preview_01_main` / `Preview_01_sub`): for the 2nd camera of the hub, set the paths `Preview_02_main` / `Preview_02_sub`.                                 |
| D-Link       | DCS-5020L                                                                     | IP, a user account of the camera                                                                  | No RTSP: MJPEG stream (`video.cgi`, port 80) re-encoded to H264. Pan/tilt and the night mode (IR) switch need the **admin** account as control account (see "D-Link controls"). |
| D-Link       | DCS-8302LH, DCS-8635LH (mydlink)                                              | IP, user `admin`, password = the **PIN code** of the camera                                       | Enable **Local Access** in the mydlink app, then unplug the camera a few seconds. Full PIN refused: try its last 6 digits. DCS-8635LH: one 1080p stream.                        |
| Any          | RTSP camera (generic)                                                         | IP, account, the **path** of the main stream (and of a light one)                                 | For instance `stream1`, `live/ch0`, `cam/realmonitor?channel=1&subtype=0`.                                                                                                      |
| Any          | ONVIF camera                                                                  | IP, account, ONVIF port                                                                           | go2rtc asks the camera for its stream; the first profile is used (sometimes H265: prefer RTSP then).                                                                            |
| Any          | Custom go2rtc source                                                          | the source, as go2rtc reads it (`rtsp://`, `ffmpeg:`, `tapo://`, `homekit://`…)                   | Typed as is: URL-encode the special characters of a password (`@` → `%40`).                                                                                                     |

**Advanced fields** (optional; empty = the setting of the model): main and
secondary stream paths, stream port (RTSP, or HTTP for MJPEG), ONVIF port and
control account (PTZ and D-Link controls, the camera account by default), Tapo authentication
variant, custom source and custom secondary source. Type `-` in a text field
to empty it — for instance `-` as the secondary path opens a single
connection to the camera.

- **Two streams**: Frigate records the main stream and detects on the
  secondary one; both go through the go2rtc of Frigate, so the camera gets
  one connection per stream whatever reads it (detection, recording, live
  view).
- **2-3 simultaneous connections**: Tapo and D-Link mydlink cameras accept
  few connections. When the vendor app or its cloud use the camera
  continuously, keep a single stream (`-` as the secondary path).
- **Battery cameras** (Tapo battery/solar, Reolink Argus): they **must be
  mains-powered** (or on a sufficient solar panel). Frigate reads their
  stream continuously and would drain the battery in hours. In your scenes,
  a condition on the battery level (> 50 %) avoids relying on a camera about
  to go dark.
- **Zones, masks, filters**: draw them in the Frigate UI; they are kept.
  Gladys only owns, for the cameras it added, the go2rtc streams, the ffmpeg
  inputs, the detection frames per second (and the Tapo detection size), the
  tracked objects, the name shown and the ONVIF endpoint. The cameras you add
  in the Frigate UI are never touched.
- The camera passwords are stored in `managed/cameras.json` (readable by the
  integration only) and written in `config.yml` (go2rtc streams, ONVIF
  section), which the Frigate UI shows to its admins in its configuration
  editor. They are never logged nor shown in the answers of the buttons.

### Configuration and data

The integration only writes the parts of `config.yml` it owns; everything
you set in the Frigate UI (cameras, zones, masks, go2rtc streams, users) is
kept:

- `mqtt`: disabled, or the broker of the **Real-time feed** section — Frigate
  then publishes to that broker **with the same account** as the
  integration: its ACL then needs `topic readwrite frigate/#`. The
  broker password goes to Frigate through its container environment, never
  in `config.yml`. MQTT over TLS: Frigate only accepts a broker certificate
  signed by a public authority, or by the authority pasted in the expert
  settings (a self-signed broker needs it there; a pinned fingerprint does
  not apply to Frigate). Without a broker, the integration uses the Frigate
  WebSocket.
- `detectors` (and the OpenVINO `model` section it needs), and
  `ffmpeg.hwaccel_args` when VAAPI applies and you wrote no `ffmpeg` section.
  In automatic mode, a `detectors` section you wrote yourself is kept.
- The retention of the recordings: **continuous** (2 days by default),
  **alerts** (7), **detections** (7) and **snapshots** (14); 0 = none. A value
  saved in Gladys wins; empty a field to keep the value set in the Frigate
  UI.
- The cameras added from Gladys (see "Adding cameras"): their go2rtc
  streams and the parts of their section listed there.

Where the data lives, in the data folder of the integration
(`/data/containers/frigate/…` seen from the integration):

| Folder          | Content                                          |
| --------------- | ------------------------------------------------ |
| `config`        | `config.yml`, Frigate's database (users, events) |
| `media/frigate` | recordings, clips and snapshots                  |
| `tmp/cache`     | recording segments being written                 |

`/tmp/cache` is a disk folder, not memory: the Gladys sandbox mounts a 64 MB
`/tmp` in RAM, too small for Frigate's cache. The integration keeps the admin
password in its own `managed/state.json` (readable by it only). Uninstalling
the integration deletes all of it, recordings included.

### When Frigate does not stay up

The Gladys sandbox applies the same limits to Frigate as to any integration
container: at most **100 processes and threads**, a 64 MB `/tmp`, **no Linux
capabilities**, three published ports. Frigate (ffmpeg per camera, go2rtc,
nginx, Python workers) may not start or may stop under these limits. The
status then says "Frigate does not stay up" (the container keeps
restarting) or "has not answered for 5 min". What to do:

- **Restart Frigate** once, and look at the logs of the integration.
- Fewer cameras, or a Coral instead of CPU detection, use fewer processes.
- Gladys counts the crashes: after five, it stops the whole integration.
- If it persists, use an existing Frigate on a machine of its own (remote
  mode): the limits are being lifted in Gladys (sandbox settings for
  sub-containers).

## Frigate connection

| Field               | What to enter                                                                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frigate URL         | `https://<frigate-ip>:8971` (authenticated port, recommended). Port `5000` works but has **no authentication at all**: a warning is shown in the connection status.    |
| Username / password | A **dedicated Frigate account**. The `viewer` role (or a custom role limited to your cameras) is enough: camera commands go through MQTT, not through the Frigate API. |

### Certificate: trusted on first connection

Frigate's port 8971 serves a self-signed certificate by default. You do not
have to do anything:

- a certificate **signed by an authority** (Let's Encrypt, your company CA
  installed in the system…) is verified normally, and renewals keep working,
  as long as the Frigate URL uses a name the certificate covers (reached by
  its IP address instead, it is handled like a self-signed one, and each
  renewal asks you to trust it again);
- a **self-signed** certificate is **trusted on the first connection**, then
  **pinned**: if it changes later (Frigate reinstalled, certificate
  regenerated… or someone impersonating Frigate), the connection is refused
  and the status explains why.

When you know the certificate changed for a legitimate reason, press
**Trust the new certificate** in the Configuration tab: the next connection
trusts and pins the new certificate. The same applies to the MQTT broker when
TLS is enabled.

The first connection is the only moment the certificate is not checked: run
it on your local network, not through an untrusted network.

### Expert settings (optional)

At the bottom of the Configuration tab, fill in **one** of these fields to
replace the trust on first use:

- **Pinned certificate SHA-256 fingerprint**: only this exact certificate is
  accepted. To read it, from the Frigate host itself or a trusted machine:

  ```bash
  openssl s_client -connect <frigate-ip>:8971 </dev/null 2>/dev/null \
    | openssl x509 -noout -fingerprint -sha256
  ```

- **Certificate authority (PEM)**: your own authority; the certificate must be
  signed by it and match the host name.

## Real-time feed (MQTT)

Enter the broker host, port, credentials and the Frigate topic prefix
(`frigate` by default). Give the integration its own broker account with this
ACL (Mosquitto syntax):

```
user gladys-frigate
topic read frigate/#
topic write frigate/+/+/set
topic write frigate/+/ptz
```

The last line is only needed for PTZ cameras (see below).

Leave the broker host empty to use the Frigate WebSocket instead. Camera
commands (the switches) then need an **admin** Frigate account: since Frigate
0.17, the WebSocket refuses them from other roles (PTZ commands excepted).

The connection status shows the state of the feed ("Real-time feed: MQTT
broker connected", or why not). A network failure is retried on its own; a
refused certificate or account stops the feed until you fix it and press
**Test the connection** (or save the configuration). When Frigate announces
it is offline (restart), the status says so, and its configuration is read
again when it comes back (at most once a minute).

MQTT keeps no object count: when the feed connects, and when Frigate comes
back online, the integration reads the current objects of every camera once
over the Frigate WebSocket, so a presence never stays stuck on a count lost
in between. The Frigate account must be allowed to open its WebSocket (any
role is).

A Frigate that drops its broker connection again and again (three times in
five minutes) loses its messages: detections, counts and motion reach Gladys
late or never. The status and the logs then say "Frigate keeps dropping its
MQTT connection". The usual cause is another MQTT client using the same
client id as Frigate (`mqtt.client_id`, `frigate` by default): a second
Frigate instance, an old container still running, or another tool. Give each
one its own `client_id`. Frigate's own logs show `MQTT disconnected`.

Each incident is also written to the integration logs (**View logs**):
`front: person detected, 87 %`, `front: person entered porch, 87 %`,
`front: review alert, person, car in porch`.

## Cameras in Gladys

Open the **Discover** tab of the integration: every Frigate camera is
listed (press **Scan** to read Frigate again). Press **Add to Gladys** on the
ones you want. Each camera device carries what its Frigate configuration
enables:

| Feature                                 | What it does                                                                                                               |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Image                                   | Refreshed every minute (under 60 KB, see below), taken fresh up to 150 KB when Gladys asks (live view, chat, scenes).      |
| Camera enabled                          | Turns the camera on or off **in Frigate** (no detection, no recording while off); Gladys then shows no image of it either. |
| Object detection, Snapshots             | Frigate's switches.                                                                                                        |
| Recordings, Audio detection             | Only when enabled in the Frigate configuration file: Frigate refuses to turn them on otherwise.                            |
| Motion                                  | Motion seen by Frigate.                                                                                                    |
| One sensor per tracked object (Person…) | Present / absent, and its count. Plus the total of objects.                                                                |
| Review status                           | none, detection or alert.                                                                                                  |
| Zone sensors                            | With the "Zone occupancy sensors" option: one presence sensor per zone and object.                                         |
| Movement, Preset                        | Cameras with an ONVIF section in Frigate: pan, tilt, zoom and presets (see "PTZ cameras").                                 |
| Night mode (IR)                         | D-Link DCS-5020L added from Gladys: infrared forced (on) or automatic (off) (see "D-Link controls").                       |

A switch is only shown as changed once Frigate confirms it. Without an MQTT
broker, the Frigate WebSocket only accepts commands from an **admin** account
(Frigate 0.17 and later): with another role, the command fails with that
explanation.

Frigate resizes the images (no image library in the container). The image
stored on the device stays under 60 KB: the Gladys device screen saves a
device by sending it back whole, image included, and refuses more than
100 KB, so renaming a camera or moving it to another room failed with a
larger image.

The badge of each camera says when it is not nominal: unreachable when
Frigate does not answer, has announced it is offline for 30 seconds, or the
camera stream has been lost for 30 seconds; degraded when its recording
stream is interrupted, the real-time feed is down, or Frigate keeps dropping
its broker connection (the states may then be outdated).

A camera added with an older version of the integration shows **Update** in
the Discover tab: press it to add the new features.

## PTZ cameras

Frigate drives the pan, tilt, zoom and presets of a camera that has an
`onvif` section in its configuration (the camera's ONVIF port and account,
not the RTSP ones):

```yaml
cameras:
  garden:
    onvif:
      host: 192.168.1.20
      port: 2020 # Tapo; Reolink 8000; many others 80
      user: admin
      password: your-camera-password
```

The integration asks Frigate what such a camera supports
(`/api/<camera>/ptz/info`) and its device gets two more features:

| Feature  | What it does                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Movement | Pan left / right, tilt up / down, zoom in / out: only the movements the camera can make continuously (Frigate's `pt`, `zoom`). |
| Preset   | Moves the camera to one of its ONVIF presets, listed by name in the order Frigate gives them.                                  |

Use them from the **Devices in room** widget of the dashboard (a row of
arrows, zoom and stop buttons, and a preset list), from the pad of the
**Camera** widget on its live view, and from scenes: "Set a device value"
with the preset number (1 for the first preset of the list) points the
camera at the door when you leave.

**Safety stop.** Frigate moves a camera until it is told to stop. Every
movement is stopped automatically after **1.5 seconds** unless another order
comes first, so a release lost by the browser, or a scene sending a lone
movement, never leaves the camera turning against its end stop. Holding a
button longer stops the camera after 1.5 s: press again to go further. A
preset recalled while the camera moves stops the movement first.

Commands go through the real-time feed, and Frigate sends nothing back for
them: a command is answered once sent. With an MQTT broker, its ACL must let
the integration write `frigate/+/ptz` (see above). Without a broker, the
Frigate WebSocket accepts PTZ commands from **any** Frigate role (unlike the
switches, which need an admin account from Frigate 0.17).

Presets are created and renamed in the camera's app (or in Frigate). Press
**Refresh the cameras** afterwards: the preset list of the camera devices
already added is updated by itself (the dashboard shows it on its next
load). A camera added before this version shows **Update** in the Discover
tab: press it to add the PTZ features. Frigate failing to answer for one
camera (ONVIF not ready yet after a restart) only leaves that camera without
its controls in the Discover tab until the next read; with a Gladys version
that does not know the PTZ features yet, the cameras are listed without
them (a warning in the logs says so).

### D-Link controls

The D-Link DCS-5020L has no ONVIF: it is moved and switched to night vision
through its own HTTP commands, which the integration sends **to the camera
itself** (not through Frigate). **Managed mode only**: the integration needs
the camera address and its admin account, which it only knows for a camera
added with the **Cameras** button. In remote mode, Gladys does not know where
the camera is: no D-Link control.

- **Movement**: pan left / right, tilt up / down. Each press is a **single
  step of 5°** that ends by itself: hold-to-move does not exist, press again
  to go further; the stop button sends nothing. No zoom (the camera has no
  zoom motor) and no preset.
- **Night mode (IR)**, a switch: on = infrared forced, off = automatic
  (the camera chooses day or night). The camera sends nothing back: the
  switch shows the last value Gladys set, not a change made in the D-Link
  app.
- **Admin account**: these commands need the camera **admin** account
  (a user account streams but is refused). Enter it as **Control user** and
  **Control password** (Advanced fields of the Cameras button): without it,
  the stream account is used. A command without any control account fails
  with "control credentials (admin account) missing: edit the camera"; a
  refused account says so too. Credentials are never logged.

A DCS-5020L added before this version shows **Update** in the Discover tab:
press it to add the controls.

## Scenes

Three triggers, fired **once per incident** (never once per frame), above
the minimum confidence and outside the cooldown (see Options). False
positives and objects standing still never fire.

| Trigger                       | Fires when                                                                                    | Filters                        |
| ----------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------ |
| Frigate: new review           | Frigate opens a review item (alert or detection); once more when a detection becomes an alert | camera, severity, object, zone |
| Frigate: object detected      | Frigate starts tracking an object (person, car…)                                              | camera, object, zone           |
| Frigate: object enters a zone | A tracked object enters a zone defined in Frigate                                             | camera, zone, object           |

Object and zone are the names used in Frigate, in lowercase (`person`,
`car`, `dog`, `cat`, `bicycle`… for objects, those of `objects.track`;
`porch`… for zones); an empty field accepts any value. The objects a camera
tracks are also its presence sensors (Person, Car…). "Object detected" only
fires on an object confirmed by Frigate's detection, above the minimum
confidence: plain motion never fires it (motion is the camera's "Motion"
sensor).
A review is filtered on its **main** object (the first of the camera's
tracked objects, in the order of the Frigate configuration) and its first
zone; all of them are in the `objects` and `zones` variables. Variables
available in the following actions: `camera`, `camera_name`, `label`,
`sub_label` (face or plate recognized by Frigate), `zone`, `zones`, `score`
(%), `severity`, `objects`, `event_id`, `review_id`.

On an alert, the integration pushes a fresh image of the camera **before**
firing the trigger: the core action "Send a camera image" placed right
after it sends the alert.

**Action "Frigate: attach the event snapshot"**: publishes the snapshot
Frigate kept for an event (with or without its bounding box) as the image of
the camera (the event's camera by default). Use `{{triggerEvent.data.event_id}}`
as the event id, then "Send a camera image". For one minute, the snapshot is
also what Gladys gets when it asks for a live image of that camera ("Send a
camera image", the dashboard live view). When Frigate keeps no snapshot for
the camera, or keeps one too large for Gladys, its thumbnail is used. Once
the event is over, Frigate serves the snapshot it saved: the bounding box
then follows its own `snapshots.bounding_box` setting.

Example — a photo on your phone when someone comes to the door:

1. Trigger **Frigate: new review**, camera _Front door_, severity _Alert_,
   object `person`.
2. Action **Frigate: attach the event snapshot**, event id
   `{{triggerEvent.data.event_id}}`.
3. Action **Send a camera image** of _Front door_ to yourself.

## Options

- **Minimum confidence** (default 70 %): object triggers only fire above it
  (reviews carry no score: Frigate's own thresholds apply).
- **Trigger cooldown** (default 30 s): at most one trigger per camera and
  object type (and zone, for zone triggers; per camera and severity for
  reviews) and period, so an incident never floods your scenes. False positives and
  objects that stay still (a parked car) never trigger.
- **Zone occupancy sensors** (off by default): one presence sensor per zone
  and tracked object.

## Live video

The ⏵ button of the dashboard **Camera** widget plays the live video of a
Frigate camera, at home and remotely through Gladys Plus. Gladys reads the
go2rtc restream embedded in Frigate (`rtsp://<host>:8554/<camera_name>`) and
turns it into an encrypted HLS stream, exactly as for its own RTSP cameras;
the widget's **latency** setting applies. Nothing to add by hand: each camera
device carries the address of its restream, updated automatically when you
change the options below (no need to recreate the device).

Prerequisites (remote mode, an existing Frigate):

- The go2rtc RTSP restream of Frigate is enabled (Frigate's default) and each
  camera has a go2rtc stream named after the Frigate camera (the `go2rtc:` →
  `streams:` section of the Frigate configuration).
- Port **8554** of the Frigate machine is published (Frigate's default docker
  ports) and reachable from the Gladys machine (firewall, VLAN).
- The restream has no password (go2rtc's default): a restream protected by a
  username and password is not supported.

Options (section **Options** of the configuration):

- **Live view: RTSP host** (blank by default): the host of the Frigate URL is
  used. Fill it in when the restream is reached at another address (Frigate
  behind a reverse proxy, a different network interface). Host name or IP
  address only, without `rtsp://` nor port.
- **Live view: RTSP port** (8554 by default): the published go2rtc port, if
  you mapped it elsewhere.

In managed mode (Frigate installed by Gladys), the port assigned by Gladys is
used automatically and the host defaults to `127.0.0.1`.

Limits: every viewer of the widget starts its own ffmpeg conversion on the
Gladys machine (one RTSP connection to go2rtc per live view, not per camera),
and the video goes through HLS, a few seconds behind real time: the WebRTC
and MSE streams of go2rtc are not used. The image rotation of the Gladys RTSP
cameras (`CAMERA_ROTATION`) is not available. A disabled camera (the "Camera
enabled" feature off) does not play live, as in Frigate.

## Configuration buttons

- **Test the connection**: Frigate's version and cameras, how its
  certificate is trusted, the account used, and a connection to the MQTT
  broker (or a reminder that the Frigate WebSocket is used without one).
- **Refresh the cameras**: reads the Frigate configuration again (for
  instance after adding a camera) and updates the list of the Discover
  tab.
- **Trust the new certificate**: forgets the pinned certificates of Frigate
  and of the broker, reconnects, and shows the fingerprint now pinned.
  Compare it with the one of your Frigate (command above) when in doubt.
- **Start Frigate**, **Stop Frigate**, **Restart Frigate**, **Show the
  Frigate credentials**, **Cameras** (add, edit, remove, list): managed
  mode only (see "Frigate installed by Gladys"); in remote mode they answer
  that they do not apply (add the cameras in the UI of your Frigate). In managed
  mode, **Test the connection** also shows the state of the Frigate
  container, the detector, the retention and the space used by the
  recordings.

When Frigate cannot be reached, the integration tries again every minute. A
refused certificate or refused credentials wait for you instead: retrying
would only lock the account out (Frigate limits failed logins).

## Security

- The integration only talks to Frigate and to the broker, on your network;
  it runs in an isolated container (read-only, no privileges, its only
  writable folder holds the pinned certificates).
- A dedicated Frigate account with the `viewer` role (or a role limited to
  some cameras) cannot change Frigate's configuration. With MQTT, the broker
  account above can only read Frigate's topics and send the camera commands.
- Certificates: verified by an authority, or pinned on first use (see
  above); the Frigate token and the broker password are only sent once the
  certificate is trusted.
- Passwords, tokens and cookies never appear in the logs or the status.
- Port 5000 and MQTT without TLS work, with a warning in the status: use them
  only on a network you trust.
- Managed mode: the integration reaches Frigate on its internal port 5000
  over the private network of the integration only (never published on your
  network); you reach the Frigate UI on its authenticated port, with the
  `admin` account the integration created. Only the UI and the go2rtc RTSP
  restream are published, on ports Gladys chooses.

## Troubleshooting

The connection status at the top of the Configuration tab says what is wrong;
**Test the connection** checks everything again. The integration logs
(supervision controls, **View logs**) never contain passwords or tokens.

| Symptom                                             | What to check                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Frigate does not stay up" (managed mode)           | The Gladys sandbox limits (100 processes, 64 MB `/tmp`, no capabilities): see "When Frigate does not stay up". Remote mode works around them.     |
| "not started yet" (managed mode)                    | Save the configuration (the first save starts Frigate) or press **Start Frigate**.                                                                |
| The managed status says "no Frigate sub-container"  | Update Gladys and the integration (sub-containers need Gladys 5.1 or later), or choose the remote mode.                                           |
| "The certificate of … changed"                      | Frigate reinstalled or certificate regenerated: press **Trust the new certificate**. Otherwise, someone may be impersonating Frigate.             |
| "Frigate refused the username or the password"      | The account of the Configuration tab. After several failures Frigate blocks logins for a while: the integration does not retry by itself.         |
| The Discover tab is empty                           | The status: Frigate must be reachable. Then **Scan**.                                                                                             |
| No image on the dashboard                           | The camera is on in Frigate and in Gladys; wait one minute after adding it.                                                                       |
| A switch fails ("did not confirm", "admin account") | Without a broker, Frigate 0.17+ only accepts commands from an admin account; with a broker, its ACL must allow `frigate/+/+/set`.                 |
| A PTZ camera does not move                          | With a broker, its ACL must allow `frigate/+/ptz`; otherwise Frigate's logs (ONVIF). No PTZ feature: **Refresh the cameras**.                     |
| A D-Link camera refuses pan/tilt or night mode      | Edit the camera with its **admin** account as control user and password (managed mode only, see "D-Link controls").                               |
| "Real-time feed stopped"                            | The broker refused the account or the certificate: fix it, then **Test the connection**.                                                          |
| Camera badge "unreachable"                          | Frigate is down or restarting, or the camera stream has been lost for 30 s (check the camera in Frigate).                                         |
| A scene does not fire                               | The minimum confidence and the cooldown (Options); the object and zone names are Frigate's (`person`, not `Person`); the logs show each incident. |
| A camera added before an update misses features     | The Discover tab shows **Update** on it.                                                                                                          |
| "Frigate keeps dropping its MQTT connection"        | Another MQTT client uses Frigate's `mqtt.client_id` (`frigate` by default): give each its own. Meanwhile states and scenes miss events.           |
| Renaming a camera or changing its room fails        | Fixed in 0.3.2: wait one minute after the update, so that the smaller image replaces the stored one, then save again.                             |

### Diagnostics buttons

Two buttons of the Configuration tab help when asking for help (forum,
GitHub issue). **Diagnostics** has a **Report** choice:

- **Diagnostics**, report **Overview** (the default): one text with the integration and Frigate
  versions, the mode, whether Frigate answers, the real-time feed (MQTT
  broker or Frigate WebSocket, its state, the age of the last message,
  whether Frigate keeps dropping its broker connection), each camera (camera,
  detection and skipped frames per second, the `status/<role>` Frigate 0.17+
  publishes), the detectors (type, inference speed, a detection stuck), the
  storage (recordings, cache, shared memory), the pinned certificates
  (fingerprints only) and the warnings. In managed mode it adds the Frigate
  container (state, wanted state, start time, host ports, hardware granted
  and detected), the detector chosen, the retention, where the generated
  `config.yml` is, whether the admin password is set (yes or no, never the
  password) and the resource advice below.
- **Diagnostics**, report **Last real-time messages (MQTT / WebSocket)**:
  the last 50 messages Frigate sent
  (out of the last 200 kept in memory since the integration started),
  newest first, as `HH:MM:SS topic payload` in UTC. Payloads are cut at 2000
  characters and images show as `[binary, N bytes]`. Handy to check that
  Frigate publishes, and what: a camera that never appears, an object name.
- **Propose a camera to the catalog**: type the brand, the model, the
  stream type and notes (stream paths, settings that work), and the button
  answers a link to a pre-filled GitHub issue on this repository. Open it in
  your browser, review it and submit it with your GitHub account: the
  integration sends nothing itself. The text carries the versions but no
  address nor password; what looks like one in the notes is masked, check it
  anyway.

**Sharing safely**: the report and the messages never contain a password, a
token, a cookie or the broker password. They do contain host names and IP
addresses (Frigate, broker): mask them before posting publicly if you wish.

**Resource advice (managed mode)**: Frigate keeps its decoded frames in
shared memory. The integration advises 256 MB of it for one camera plus
64 MB per extra camera, and about 1 GB of memory plus 256 MB per camera
(512 MB more when detection runs on the CPU): a rule of thumb, not a
measurement. Gladys gives the Frigate container fixed limits whatever the
machine (512 MB of shared memory, 4 GB of memory, 2 CPU), so beyond 5
cameras the advice says so; prefer the remote mode then, until the Gladys
core allows limits relative to the machine (see `ROADMAP.md`, issues #12
and #14). **Test the connection** shows the same advice in one line.

**Frigate's own logs** (managed mode) are not in the integration logs: open
the supervision block of the integration in Gladys, which shows the logs of
the Frigate sub-container.
