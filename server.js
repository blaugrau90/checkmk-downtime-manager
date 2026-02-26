const express = require('express');
const path = require('path');
const { version } = require('./package.json');
if (process.env.CHECKMK_IGNORE_SSL === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory operation log (last 100 entries)
const recentOps = [];
function logOp(entry) {
  recentOps.unshift({ ...entry, timestamp: new Date().toISOString() });
  if (recentOps.length > 100) recentOps.pop();
}

const {
  CHECKMK_URL,
  CHECKMK_SITE,
  CHECKMK_USERNAME,
  CHECKMK_PASSWORD,
  PORT = 3000,
} = process.env;

if (!CHECKMK_URL || !CHECKMK_SITE || !CHECKMK_USERNAME || !CHECKMK_PASSWORD) {
  console.error('Missing required environment variables: CHECKMK_URL, CHECKMK_SITE, CHECKMK_USERNAME, CHECKMK_PASSWORD');
  process.exit(1);
}

const CHECKMK_AUTH = `Bearer ${CHECKMK_USERNAME} ${CHECKMK_PASSWORD}`;
const BASE_API = `${CHECKMK_URL.replace(/\/$/, '')}/${CHECKMK_SITE}/check_mk/api/1.0`;

async function checkmkFetch(endpoint, options = {}) {
  const url = `${BASE_API}${endpoint}`;
  const isWrite = options.method && options.method !== 'GET';
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: CHECKMK_AUTH,
      Accept: 'application/json',
      ...(isWrite ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw { status: res.status, body: text };
  }
  return text ? JSON.parse(text) : null;
}

// Helper: walk up the folder path to find the nearest inherited parents
// folderParents: { '/path/to/folder': ['parent1', ...] }
function getInheritedParents(hostFolder, folderParents) {
  // Normalize: '' (root) → '/'
  const folder = hostFolder || '/';
  // Check the host's own folder first, then each ancestor
  const parts = folder.split('/').filter(Boolean); // ['vmware','vmware','esxi_server']
  for (let len = parts.length; len >= 0; len--) {
    const path = len === 0 ? '/' : '/' + parts.slice(0, len).join('/');
    if (folderParents[path]?.length > 0) return folderParents[path];
  }
  return [];
}

// Helper: fetch all descendants of a host via parent-child relationships
async function getDescendants(site, rootHostName, recursive) {
  // 1. Fetch all folder configs to build folder → parents map (handles folder inheritance)
  const foldersData = await checkmkFetch(
    '/domain-types/folder_config/collections/all?recursive=true&show_hosts=false'
  );
  const folderParents = {};
  for (const f of foldersData?.value ?? []) {
    const parents = f.extensions?.attributes?.parents ?? [];
    if (parents.length > 0) {
      // Convert Checkmk folder ID (~vmware~esxi) to path (/vmware/esxi)
      const path = '/' + f.id.replace(/^~/, '').replace(/~/g, '/');
      folderParents[path.replace(/^\/\//, '/')] = parents; // normalise root '//'→'/'
    }
  }

  // 2. Fetch all hosts for the site
  const data = await checkmkFetch(
    `/domain-types/host_config/collections/all?site=${encodeURIComponent(site)}`
  );
  const allHosts = data?.value ?? [];

  // 3. Build parent → children map (skip offline hosts)
  // Direct attributes.parents takes precedence; fall back to folder-inherited parents
  const childrenOf = {};
  for (const h of allHosts) {
    if (h.extensions?.is_offline) continue;
    const direct = h.extensions?.attributes?.parents ?? [];
    const parents = direct.length > 0
      ? direct
      : getInheritedParents(h.extensions?.folder ?? '', folderParents);
    for (const p of parents) {
      if (!childrenOf[p]) childrenOf[p] = [];
      childrenOf[p].push(h.id);
    }
  }

  // 4. BFS: direct children only, or full tree if recursive
  const result = [];
  const queue = [rootHostName];
  const visited = new Set([rootHostName]);
  while (queue.length) {
    const current = queue.shift();
    for (const child of (childrenOf[current] ?? [])) {
      if (!visited.has(child)) {
        visited.add(child);
        result.push(child);
        if (recursive) queue.push(child);
      }
    }
  }
  return result;
}

// GET /api/sites — List all site connections
app.get('/api/sites', async (req, res) => {
  try {
    const data = await checkmkFetch('/domain-types/site_connection/collections/all');
    const sites = (data?.value ?? []).map((s) => ({
      id: s.id ?? s.extensions?.site_id ?? s.title,
      name: s.title ?? s.id,
    }));
    // Always include the configured local site
    const localSite = { id: CHECKMK_SITE, name: CHECKMK_SITE };
    const hasLocal = sites.some((s) => s.id === CHECKMK_SITE);
    const result = hasLocal ? sites : [localSite, ...sites];
    res.json(result);
  } catch (err) {
    // Fallback: return only the configured site (single-site setup)
    res.json([{ id: CHECKMK_SITE, name: CHECKMK_SITE }]);
  }
});

// GET /api/hosts?site=SITENAME — List all hosts for a site
app.get('/api/hosts', async (req, res) => {
  const { site } = req.query;
  if (!site) return res.status(400).json({ error: 'site parameter required' });
  try {
    const url = `/domain-types/host_config/collections/all?site=${encodeURIComponent(site)}`;
    const data = await checkmkFetch(url);
    const hosts = (data?.value ?? [])
      .filter((h) => !h.extensions?.is_offline)
      .map((h) => ({
        name: h.id,
        displayName: h.extensions?.alias || h.id,
      }));
    hosts.sort((a, b) => a.name.localeCompare(b.name));
    res.json(hosts);
  } catch (err) {
    console.error('Error fetching hosts:', err);
    res.status(err.status ?? 500).json({ error: 'Failed to fetch hosts' });
  }
});

// GET /api/services?host=HOSTNAME — List all services for a host
app.get('/api/services', async (req, res) => {
  const { host } = req.query;
  if (!host) return res.status(400).json({ error: 'host parameter required' });
  try {
    const data = await checkmkFetch(
      `/domain-types/service/collections/all?host_name=${encodeURIComponent(host)}`
    );
    const services = (data?.value ?? []).map((s) => ({
      name: s.extensions?.description ?? s.id,
      displayName: s.extensions?.display_name ?? s.extensions?.description ?? s.id,
    }));
    services.sort((a, b) => a.name.localeCompare(b.name));
    res.json(services);
  } catch (err) {
    console.error('Error fetching services:', err);
    res.status(err.status ?? 500).json({ error: 'Failed to fetch services' });
  }
});

// POST /api/downtime — Set a host or service downtime
app.post('/api/downtime', async (req, res) => {
  const { host, type, services, startTime, endTime, comment, includeChildren = 'none', site } = req.body;

  if (!host || !type || !startTime || !endTime) {
    return res.status(400).json({ error: 'host, type, startTime, endTime are required' });
  }
  if (type === 'service' && (!services || services.length === 0)) {
    return res.status(400).json({ error: 'services array required for service downtime' });
  }

  const endpoint = type === 'host'
    ? '/domain-types/downtime/collections/host'
    : '/domain-types/downtime/collections/service';

  const makePayload = (hostName) => type === 'host'
    ? {
        downtime_type: 'host',
        host_name: hostName,
        start_time: startTime,
        end_time: endTime,
        comment: comment || 'Downtime set via Downtime Manager',
      }
    : {
        downtime_type: 'service',
        host_name: hostName,
        service_descriptions: services,
        start_time: startTime,
        end_time: endTime,
        comment: comment || 'Downtime set via Downtime Manager',
      };

  try {
    if (type === 'host' && includeChildren !== 'none') {
      const recursive = includeChildren === 'recursive';
      const effectiveSite = site || CHECKMK_SITE;
      const childHosts = await getDescendants(effectiveSite, host, recursive);
      const allHosts = [host, ...childHosts];
      // allSettled: continue even if individual requests fail (e.g. duplicate downtime)
      const results = await Promise.allSettled(allHosts.map(h =>
        checkmkFetch(endpoint, { method: 'POST', body: JSON.stringify(makePayload(h)) })
      ));
      const succeeded = [];
      const failed = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          succeeded.push(allHosts[i]);
        } else {
          let reason = r.reason?.body;
          try { reason = JSON.parse(reason)?.detail ?? JSON.parse(reason)?.title ?? reason; } catch {}
          failed.push({ host: allHosts[i], reason: reason ?? String(r.reason) });
        }
      });
      if (failed.length > 0) {
        console.warn(`${failed.length} downtime request(s) failed:`, failed);
      }
      logOp({ parentHost: host, mode: includeChildren, type, comment,
               startTime, endTime, succeeded, failed });
      return res.status(201).json({ success: true, hostsAffected: succeeded.length, failed: failed.length });
    }

    await checkmkFetch(endpoint, { method: 'POST', body: JSON.stringify(makePayload(host)) });
    logOp({ parentHost: host, mode: 'none', type, comment, startTime, endTime,
             succeeded: [host], failed: [] });
    res.status(201).json({ success: true, hostsAffected: 1 });
  } catch (err) {
    console.error('Error setting downtime:', err);
    res.status(err.status ?? 500).json({ error: 'Failed to set downtime', detail: err.body });
  }
});


app.get('/api/log', (req, res) => res.json(recentOps));
app.delete('/api/log', (req, res) => { recentOps.length = 0; res.json({ success: true }); });

app.get('/api/build', (req, res) => res.json({ version }));

app.listen(PORT, () => {
  console.log(`Checkmk Downtime Manager running on http://localhost:${PORT}`);
  console.log(`Checkmk API: ${BASE_API}`);
});
