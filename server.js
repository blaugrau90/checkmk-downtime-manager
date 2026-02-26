const express = require('express');
const path = require('path');
const { version } = require('./package.json');
if (process.env.CHECKMK_IGNORE_SSL === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// Helper: fetch all descendants of a host via parent-child relationships
async function getDescendants(site, rootHostName, recursive) {
  const url = `/domain-types/host_config/collections/all?site=${encodeURIComponent(site)}`;
  const data = await checkmkFetch(url);
  const allHosts = data?.value ?? [];

  // Build parent → children map
  const childrenOf = {};
  for (const h of allHosts) {
    const parents = h.extensions?.attributes?.parents ?? [];
    for (const p of parents) {
      if (!childrenOf[p]) childrenOf[p] = [];
      childrenOf[p].push(h.id);
    }
  }

  // BFS: direct children only, or full tree if recursive
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
    const hosts = (data?.value ?? []).map((h) => ({
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
      await Promise.all(allHosts.map(h =>
        checkmkFetch(endpoint, { method: 'POST', body: JSON.stringify(makePayload(h)) })
      ));
      return res.status(201).json({ success: true, hostsAffected: allHosts.length });
    }

    await checkmkFetch(endpoint, { method: 'POST', body: JSON.stringify(makePayload(host)) });
    res.status(201).json({ success: true, hostsAffected: 1 });
  } catch (err) {
    console.error('Error setting downtime:', err);
    res.status(err.status ?? 500).json({ error: 'Failed to set downtime', detail: err.body });
  }
});

app.get('/api/build', (req, res) => res.json({ version }));

app.listen(PORT, () => {
  console.log(`Checkmk Downtime Manager running on http://localhost:${PORT}`);
  console.log(`Checkmk API: ${BASE_API}`);
});
