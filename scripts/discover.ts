import { loadConfig } from '../src/config.js';
import { discoverServers, publicServer } from '../src/gateway/discovery.js';

const discovery = await discoverServers(loadConfig());
console.log(
  JSON.stringify(
    {
      sources: discovery.sources,
      servers: discovery.servers.map(publicServer),
      diagnostics: discovery.diagnostics,
    },
    null,
    2,
  ),
);
