// -----------------------------------------------------------------------------
// Constants of the managed mode: Frigate run by Gladys as the `frigate`
// sub-container declared in the manifest (`containers`).
//
// test/manifest.test.js ties these values to the manifest: the image, the
// container name and the port names must change on both sides together.
//
// No Gladys dependency (layering rule).
// -----------------------------------------------------------------------------

/**
 * The Frigate image of the sub-container. One place for the version: bump it
 * here and in the manifest `containers[0].docker_image` together (pinned by
 * a test). 0.18.0 is the latest stable release the team verified.
 */
export const FRIGATE_IMAGE = 'ghcr.io/blakeblackshear/frigate:0.18.0';

/** Manifest `containers[].name`: the DNS alias on the private network too. */
export const CONTAINER_NAME = 'frigate';

/**
 * Frigate's internal port, reached over the private network of the
 * integration (never published on the LAN): no TLS, no login. The UI port
 * 8971 (authenticated, published) is for the user.
 */
export const INTERNAL_URL = `http://${CONTAINER_NAME}:5000`;

/**
 * Resources of the sub-container: the manifest `memory_mb`, `cpu` and
 * `shm_mb` of the `frigate` entry (pinned by a test). They are the maximums
 * the Gladys core accepts today, whatever the machine (core issue #14):
 * ./advice.js compares what the cameras need with them.
 */
export const CONTAINER_LIMITS = Object.freeze({ memoryMb: 4096, cpu: 2, shmMb: 512 });

/** Manifest port names, referenced by `{{port:<name>}}` in the section texts. */
export const UI_PORT_NAME = 'frigate_ui';
export const RTSP_PORT_NAME = 'frigate_rtsp';

/** The account Frigate 0.16+ creates on its first start (random password). */
export const ADMIN_USER = 'admin';

/**
 * The broker password reaches Frigate through the environment of
 * `startContainer` and Frigate's `{FRIGATE_*}` substitution: it never sits in
 * config.yml, which the Frigate UI shows in its configuration editor.
 */
export const MQTT_PASSWORD_ENV = 'FRIGATE_MQTT_PASSWORD';

/** Where the volumes of the sub-container appear in the main container's /data. */
export const CONFIG_DIR = `containers/${CONTAINER_NAME}/config`;
export const MEDIA_DIR = `containers/${CONTAINER_NAME}/media/frigate`;
export const CONFIG_FILE = 'config.yml';

/** The broker authority written next to config.yml, seen by Frigate under /config. */
export const MQTT_CA_FILE = 'gladys-mqtt-ca.pem';
export const MQTT_CA_PATH_IN_FRIGATE = `/config/${MQTT_CA_FILE}`;
/**
 * The system authorities of the Frigate image (Debian): Frigate only enables
 * MQTT over TLS when `tls_ca_certs` is set, so a broker certificate signed by
 * a public authority needs this bundle.
 */
export const SYSTEM_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';

/** Retention defaults (days); mirror the manifest defaults (pinned by a test). */
export const RETENTION_DEFAULTS = Object.freeze({
  continuous: 2,
  alerts: 7,
  detections: 7,
  snapshots: 14,
});

/** The detector sections Gladys generates. Frigate embeds the EdgeTPU model. */
export const DETECTOR_PRESETS = Object.freeze({
  edgetpu_usb: { coral: { type: 'edgetpu', device: 'usb' } },
  edgetpu_pci: { coral: { type: 'edgetpu', device: 'pci' } },
  // Validated on an Intel N5105: inference 94.6 ms (CPU) -> 15.8 ms (GPU).
  openvino: { ov: { type: 'openvino', device: 'GPU' } },
  cpu: { cpu0: { type: 'cpu' } },
});

/** The OpenVINO model shipped in the Frigate image (removed when leaving OpenVINO). */
export const OPENVINO_MODEL = Object.freeze({
  width: 300,
  height: 300,
  input_tensor: 'nhwc',
  input_pixel_format: 'bgr',
  path: '/openvino-model/ssdlite_mobilenet_v2.xml',
  labelmap_path: '/openvino-model/coco_91cl_bkgr.txt',
});

/**
 * The go2rtc embedded in Frigate restreams every managed camera on its RTSP
 * port: Frigate's ffmpeg reads it there, so the camera gets one connection
 * per stream whatever reads it (detection, recording, live view).
 */
export const RESTREAM_BASE = 'rtsp://127.0.0.1:8554';

/** Suffix of the go2rtc stream of the secondary (detection) source of a camera. */
export const SUB_STREAM_SUFFIX = '_sub';

/**
 * Input arguments validated for the tapo:// producer: its non-monotonic
 * timestamps make ffmpeg run away without wallclock re-timestamping.
 */
export const TAPO_INPUT_ARGS =
  '-avoid_negative_ts make_zero -fflags +genpts+discardcorrupt -rtsp_transport tcp -use_wallclock_as_timestamps 1';

/**
 * The tapo:// substream does not expose its size fast enough for Frigate's
 * probe: the known 640x360 is set explicitly.
 */
export const TAPO_DETECT_SIZE = Object.freeze({ width: 640, height: 360 });

/** Detection frames per second of a managed camera (Frigate recommends 5). */
export const DEFAULT_DETECT_FPS = 5;
export const MAX_DETECT_FPS = 15;

/** VAAPI video decoding (Intel and AMD render nodes), independent of the detector. */
export const VAAPI_FFMPEG = Object.freeze({ hwaccel_args: 'preset-vaapi' });
