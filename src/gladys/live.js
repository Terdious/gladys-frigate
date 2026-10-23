// -----------------------------------------------------------------------------
// Live view: the RTSP URL Gladys streams from.
//
// The dashboard Camera widget starts a live stream for any camera device
// through the core `rtsp-camera` service, which only reads the device param
// `CAMERA_URL` (an RTSP URL) and runs ffmpeg to an encrypted HLS stream,
// served locally and through Gladys Plus. Publishing that param on our camera
// devices therefore gives live view without any core change. The URL points
// at the go2rtc restream embedded in Frigate (`rtsp://<host>:8554/<camera>`),
// so the cameras keep a single connection each (Frigate's).
//
// The URL is resolved on the integration side because only it knows where
// Frigate runs: the host of the Frigate URL in remote mode, the host port
// Gladys published for the sub-container in managed mode. The params of an
// already-created device are upserted by Gladys on every republication of the
// discovery, so a changed host or port reaches existing devices.
// -----------------------------------------------------------------------------

export const LIVE_PARAM = 'CAMERA_URL';
// go2rtc's RTSP port, published by Frigate's default docker setup.
export const DEFAULT_LIVE_RTSP_PORT = 8554;
// Gladys runs on the host network and the sub-container port is published on
// the host: the loopback reaches it without depending on the LAN address.
export const MANAGED_LIVE_RTSP_HOST = '127.0.0.1';

/** An IPv6 literal must be bracketed in a URL; host names and IPv4 pass as is. */
function urlHost(host) {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * RTSP URL of the go2rtc restream of a Frigate camera. No credentials: the
 * go2rtc restream has none by default, and a password must never sit in a
 * device param (Gladys shows params and sends them to the browser).
 * @param {{ host: string, port: number }} target
 * @param {string} cameraName Frigate camera name (also the go2rtc stream name)
 * @returns {string}
 */
export function liveRtspUrl({ host, port }, cameraName) {
  return `rtsp://${urlHost(host)}:${port}/${encodeURIComponent(cameraName)}`;
}

function frigateHostname(frigateUrl) {
  try {
    // `hostname` keeps the brackets of an IPv6 literal ("[fe80::1]").
    return new URL(frigateUrl).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Where the live RTSP restream is reached from the Gladys machine.
 * @param {ReturnType<import('../config.js').normalizeConfig> & { mode?: string }} config
 *   an absent `mode` is the remote mode (configurations saved before the
 *   managed mode existed)
 * @param {{ managedHostPort?: number | null }} [options] managed mode only: the
 *   host port Gladys assigned to the `frigate_rtsp` port of the sub-container
 * @returns {{ host: string, port: number } | null} null when it cannot be
 *   known yet (no param is published then)
 */
export function resolveLiveRtsp(config, { managedHostPort } = {}) {
  const explicitHost = config?.live_rtsp_host || '';
  if (config?.mode === 'managed') {
    const port = Number(managedHostPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }
    return { host: explicitHost || MANAGED_LIVE_RTSP_HOST, port };
  }
  const host = explicitHost || frigateHostname(config?.frigate_url);
  if (!host) {
    return null;
  }
  return { host, port: config?.live_rtsp_port || DEFAULT_LIVE_RTSP_PORT };
}
