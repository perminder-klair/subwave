// System-resource readout for the admin Stats page.
//
// Answers "how much CPU/memory is SUB/WAVE using on this box?" by talking to the
// Docker Engine API — no `docker` CLI in the image, just Node's http. The
// controller never holds the raw Docker socket: the compose files run a
// `docker-socket-proxy` sidecar that owns /var/run/docker.sock and exposes a
// read-only, GET-only slice of the API over TCP (CONTAINERS only; all POST/
// mutating calls refused). The controller reaches it via DOCKER_HOST
// (tcp://docker-socket-proxy:2375). A direct unix-socket path is still supported
// for ad-hoc use (DOCKER_HOST=unix:///path or DOCKER_SOCKET), but the shipped
// composes never mount the socket into the controller.
//
// When neither transport is reachable (dev on a Mac without the proxy, a BYO
// operator who dropped it), summary() returns just the host figures with an
// empty container list — the UI degrades to "container stats unavailable"
// rather than erroring.
//
// Container selection: we resolve the controller's own Compose project label and
// return every running container in that project (caddy, broadcast, controller,
// web, the proxy, and the tts-heavy sidecar when enabled). Falls back to the
// sub-wave-* container-name convention if the project label isn't present.

import http from 'node:http';
import os from 'node:os';
import { existsSync } from 'node:fs';

// Resolve the Docker API transport from DOCKER_HOST (Docker's own convention),
// falling back to a local unix socket. tcp:// → talk to the socket-proxy; unix://
// or unset → a socketPath (only used for ad-hoc direct runs).
const DOCKER_HOST = process.env.DOCKER_HOST || '';
const DOCKER_SOCK = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

interface DockerTransport {
  socketPath?: string;
  host?: string;
  port?: number;
}

function transport(): DockerTransport {
  const tcp = /^tcp:\/\/([^:/]+):(\d+)/.exec(DOCKER_HOST);
  if (tcp) return { host: tcp[1], port: Number(tcp[2]) };
  const unix = /^unix:\/\/(.+)/.exec(DOCKER_HOST);
  if (unix) return { socketPath: unix[1] };
  return { socketPath: DOCKER_SOCK };
}

// --- Docker API types (only the fields we read) ---------------------------

interface DockerContainer {
  Id: string;
  Names?: string[];
  Labels?: Record<string, string>;
}

interface DockerCpuUsage {
  total_usage?: number;
  percpu_usage?: number[];
}

interface DockerStat {
  cpu_stats?: { cpu_usage?: DockerCpuUsage; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: DockerCpuUsage; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
}

// --- response shape -------------------------------------------------------

export interface ContainerUsage {
  name: string;       // friendly container name, leading slash stripped
  service: string;    // compose service (or name minus the sub-wave- prefix)
  cpuPct: number;     // 0..(100 × cores)
  memUsed: number;    // bytes (page cache excluded, matching `docker stats`)
  memLimit: number;   // bytes (host memory when no per-container limit is set)
  memPct: number;     // memUsed / memLimit, 0..100
}

export interface HostUsage {
  cpus: number;                          // logical cores
  loadavg: [number, number, number];     // 1 / 5 / 15-minute load (0s on non-Linux)
  memTotal: number;                      // bytes
  memUsed: number;                       // bytes (total − free)
  uptime: number;                        // host uptime, seconds
}

export interface SystemSummary {
  t: string;
  dockerAvailable: boolean;
  dockerError?: string;
  host: HostUsage;
  containers: ContainerUsage[];
}

// --- helpers --------------------------------------------------------------

export function dockerAvailable(): boolean {
  const t = transport();
  if (t.host) return true; // TCP proxy — reachability is confirmed at request time
  try {
    return existsSync(t.socketPath!);
  } catch {
    return false;
  }
}

const round = (n: number): number => Math.round(n * 10) / 10;

// One-shot JSON GET over the Docker socket.
function dockerGetJson<T>(path: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { ...transport(), path, method: 'GET', timeout: timeoutMs },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c as Buffer));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(`docker ${path} → HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(e as Error);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`docker ${path} timed out`)));
    req.end();
  });
}

// Read the container stats stream and resolve with the SECOND frame. Docker's
// stats stream emits the first frame with an empty precpu_stats (CPU% would be
// the cumulative-since-start average); the second frame, ~1s later, carries the
// previous frame as precpu_stats, giving an accurate 1-second CPU window — the
// same two-sample maths `docker stats` does. We then abort the stream.
function dockerStats(id: string, timeoutMs = 6000): Promise<DockerStat> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    const req = http.request(
      { ...transport(), path: `/containers/${id}/stats?stream=true`, method: 'GET', timeout: timeoutMs },
      res => {
        let buf = '';
        const frames: DockerStat[] = [];
        res.on('data', chunk => {
          buf += (chunk as Buffer).toString('utf8');
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              frames.push(JSON.parse(line) as DockerStat);
            } catch {
              /* partial line — keep buffering */
            }
            if (frames.length >= 2) {
              req.destroy();
              done(() => resolve(frames[1]));
              return;
            }
          }
        });
        res.on('end', () => {
          if (frames.length) done(() => resolve(frames[frames.length - 1]));
          else done(() => reject(new Error('no stats frames')));
        });
      },
    );
    // destroy() above fires an 'error' (aborted) we want to swallow once settled.
    req.on('error', err => done(() => reject(err)));
    req.on('timeout', () => req.destroy(new Error('stats timed out')));
    req.end();
  });
}

// CPU% across all cores, matching `docker stats`: cpuDelta / systemDelta × cores.
function cpuPct(s: DockerStat): number {
  const cpu = s.cpu_stats;
  const pre = s.precpu_stats;
  const cpuDelta = (cpu?.cpu_usage?.total_usage || 0) - (pre?.cpu_usage?.total_usage || 0);
  const sysDelta = (cpu?.system_cpu_usage || 0) - (pre?.system_cpu_usage || 0);
  const cores = cpu?.online_cpus || cpu?.cpu_usage?.percpu_usage?.length || os.cpus().length || 1;
  if (cpuDelta > 0 && sysDelta > 0) return (cpuDelta / sysDelta) * cores * 100;
  return 0;
}

// Used memory excluding reclaimable page cache, matching `docker stats`:
// cgroup v2 subtracts inactive_file, v1 subtracts cache.
function memUsed(s: DockerStat): number {
  const m = s.memory_stats;
  if (!m?.usage) return 0;
  const cache = m.stats?.inactive_file ?? m.stats?.cache ?? 0;
  return Math.max(0, m.usage - cache);
}

function hostUsage(): HostUsage {
  const total = os.totalmem();
  const free = os.freemem();
  const [l1, l5, l15] = os.loadavg();
  return {
    cpus: os.cpus().length || 1,
    loadavg: [l1, l5, l15],
    memTotal: total,
    memUsed: Math.max(0, total - free),
    uptime: os.uptime(),
  };
}

// Running containers belonging to the controller's own Compose project (falling
// back to the sub-wave-* naming convention).
async function subwaveContainers(): Promise<DockerContainer[]> {
  const all = await dockerGetJson<DockerContainer[]>('/containers/json');
  const selfHost = os.hostname(); // short container id unless `hostname:` is set
  const self = all.find(
    c => (c.Id || '').startsWith(selfHost) || (c.Names || []).includes('/sub-wave-controller'),
  );
  const project = self?.Labels?.['com.docker.compose.project'];
  return all.filter(c =>
    project
      ? c.Labels?.['com.docker.compose.project'] === project
      : (c.Names || []).some(n => n.startsWith('/sub-wave-')),
  );
}

// --- public ---------------------------------------------------------------

export async function summary(): Promise<SystemSummary> {
  const host = hostUsage();
  const base = { t: new Date().toISOString(), host, containers: [] as ContainerUsage[] };

  if (!dockerAvailable()) {
    return { ...base, dockerAvailable: false, dockerError: 'docker socket-proxy not reachable' };
  }

  try {
    const list = await subwaveContainers();
    const usage = await Promise.all(
      list.map(async (c): Promise<ContainerUsage | null> => {
        try {
          const s = await dockerStats(c.Id);
          const name = (c.Names?.[0] || c.Id).replace(/^\//, '');
          const service = c.Labels?.['com.docker.compose.service'] || name.replace(/^sub-wave-/, '');
          const used = memUsed(s);
          const limit = s.memory_stats?.limit || 0;
          return {
            name,
            service,
            cpuPct: round(cpuPct(s)),
            memUsed: used,
            memLimit: limit,
            memPct: limit ? round((used / limit) * 100) : 0,
          };
        } catch {
          return null; // one container failing shouldn't sink the whole readout
        }
      }),
    );
    const containers = usage
      .filter((c): c is ContainerUsage => c !== null)
      .sort((a, b) => b.cpuPct - a.cpuPct || b.memUsed - a.memUsed);
    return { ...base, dockerAvailable: true, containers };
  } catch (err) {
    return { ...base, dockerAvailable: false, dockerError: (err as Error).message };
  }
}
