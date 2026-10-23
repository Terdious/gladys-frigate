// Shared fakes of the managed-mode session tests: Gladys' side of the
// sub-container (GET /container and the start/stop/restart routes), a
// Frigate client answering only when `frigate.up` is true, the real-time
// feed, and a session wired to a temporary data folder.

import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig } from '../../src/config.js';
import { UnreachableError } from '../../src/frigate/errors.js';
import { createManagedFrigate } from '../../src/gladys/managed.js';
import { createFrigateSession } from '../../src/gladys/frigateSession.js';
import { FRIGATE_CONFIG } from './fakeFrigate.js';

export const MANAGED = { mode: 'managed' };

/** Gladys' side of the sub-container, as GET /container and the start/stop routes. */
export function fakeGladys(initial = {}) {
  const calls = [];
  const statuses = [];
  let starts = 0;
  const frigate = {
    name: 'frigate',
    status: 'stopped',
    desired: 'stopped',
    started_at: null,
    ports: [
      { container_port: 8971, name: 'frigate_ui', host_port: null },
      { container_port: 8554, name: 'frigate_rtsp', host_port: null },
    ],
    devices: [
      { class: 'coral-usb', granted: false, available: false },
      { class: 'coral-pcie', granted: false, available: false },
      { class: 'gpu', granted: false, available: false },
    ],
    ...initial,
  };
  const run = () => {
    starts += 1;
    frigate.status = 'running';
    frigate.desired = 'running';
    frigate.started_at = `2026-01-01T00:00:0${starts}.000Z`;
    frigate.ports[0].host_port ??= 42115;
    frigate.ports[1].host_port ??= 42116;
  };
  return {
    frigate,
    calls,
    statuses,
    async setConnectionStatus(connected, message) {
      statuses.push({ connected, message });
    },
    async getContainers() {
      calls.push(['getContainers']);
      return [structuredClone(frigate)];
    },
    async startContainer(name, options) {
      calls.push(['start', name, options]);
      run();
      return { success: true };
    },
    async stopContainer(name) {
      calls.push(['stop', name]);
      Object.assign(frigate, { status: 'stopped', desired: 'stopped', started_at: null });
      return { success: true };
    },
    async restartContainer(name) {
      calls.push(['restart', name]);
      run();
      return { success: true };
    },
  };
}

/** A Frigate client answering only when `frigate.up` is true. */
function fakeClients(frigate, configOf) {
  const created = [];
  const factory = (options) => {
    const client = {
      options,
      authMode: 'none',
      tlsDecision: null,
      async getVersion() {
        if (!frigate.up) throw new UnreachableError('ECONNREFUSED');
        return '0.18.0';
      },
      async getConfig() {
        return configOf();
      },
      async getStats() {
        return {
          service: { storage: { '/media/frigate/recordings': { total: 10240, used: 1024 } } },
        };
      },
      async close() {},
    };
    created.push(client);
    return client;
  };
  factory.created = created;
  return factory;
}

function feedFactory() {
  const feed = new EventEmitter();
  feed.mode = 'websocket';
  feed.endpoint = 'ws://frigate:5000/ws';
  feed.status = { state: 'connected', error: null };
  feed.close = async () => {};
  return feed;
}

export async function setup(
  t,
  {
    container,
    now,
    managedMaxPolls = 60,
    adminStatus = () => 200,
    frigateConfig = FRIGATE_CONFIG,
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'gladys-frigate-managed-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const gladys = fakeGladys(container);
  const frigate = { up: false, config: null };
  const adminCalls = [];
  const logs = [];
  const logger = {
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
  };
  const managed = createManagedFrigate({
    gladys,
    logger,
    dataDir,
    passwordFactory: () => 'Generated-Admin-Pw-24chars',
    adminOptions: {
      wait: async () => {},
      fetchImpl: async (url, init) => {
        adminCalls.push({ url: String(url), body: JSON.parse(init.body) });
        return { ok: adminStatus() < 300, status: adminStatus(), body: null };
      },
    },
  });
  const containers = [];
  // `frigate.config` replaces what Frigate answers on /api/config (a test may change it).
  const clientFactory = fakeClients(frigate, () => frigate.config ?? frigateConfig);
  const session = createFrigateSession({
    gladys,
    trustStore: { async reset() {} },
    logger,
    clientFactory,
    feedFactory,
    managed,
    managedPollMs: 5,
    managedMaxPolls,
    retryDelayMs: 60_000,
    onContainer: (entry) => containers.push(entry),
    ...(now ? { now } : {}),
  });
  t.after(() => session.close());
  const apply = (raw = MANAGED) => session.apply(normalizeConfig(raw), raw);
  const last = () => gladys.statuses.at(-1);
  const configPath = join(dataDir, 'containers', 'frigate', 'config', 'config.yml');
  return {
    session,
    managed,
    gladys,
    frigate,
    adminCalls,
    logs,
    apply,
    last,
    dataDir,
    configPath,
    containers,
    clientFactory,
  };
}
