/**
 * route-templates — Single source of truth for (METHOD, path) → fixture
 * file mapping. Imported by MockBackend.js (consumer), the recording
 * plugin (producer), and the FixtureCoverage planner (also producer).
 *
 * Update both sides by editing this file only.
 *
 * Helpers exported:
 *   ROUTE_TEMPLATES  — { 'GET /path': 'template/with/{param}.json' }
 *   SKIP_ROUTES      — routes the recorder should never persist
 *   safeFileName(s)  — filesystem-safe version of a param value
 *   shortHash(s)     — FNV-1a 32-bit hex; used for {sha1} placeholders
 *   parseUrl(url)    — split '/path?k=v&...' into { path, params }
 *   resolveTemplate(tpl, params)
 *                    — substitute every {param} (incl. special {sha1},
 *                       {encodedQuery}, {imageBase}, {target},
 *                       {nearestPosition}, {address})
 */

export const ROUTE_TEMPLATES = {
  'GET /ttd/trace-info':                'ttd/trace-info.json',
  'GET /ttd/modules':                   'ttd/modules.json',
  'GET /ttd/threads':                   'ttd/threads.json',
  'GET /ttd/events/lifetime':           'ttd/events-lifetime.json',
  'GET /memory/layout':                 'memory-layout.json',
  'GET /pe':                            'pe/{imageBase}.json',
  'GET /function-calls':                'function-calls/{target}.json',
  'GET /strings':                       'strings/{encodedQuery}.json',
  'GET /page':                          'pages/{address}.json',
  'GET /page/svg':                      'pages/{address}.svg',
  'GET /page/render/code':              'pages/{address}.code.json',
  'GET /page/render/data':              'pages/{address}.data.json',
  'GET /callstack':                     'callstacks/{major}_{minor}_{threadId}.json',
  'GET /registers':                     'registers/{major}_{minor}_{threadId}.json',
  'GET /ttd/mem-access':                'mem-access/{start_addr}_{end_addr}_{mode}.json',
  'GET /command/execute':               'command/{sha1}.json',
  'GET /environment':                   'environment.json',
  'GET /model':                         'model/{sha1}.json',
};

export const SKIP_ROUTES = new Set([
  'GET /server/status', // poll noise
]);

export function safeFileName(s) {
  const raw = String(s ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 200);
  // Normalize hex addresses: strip leading zeros after 0x/0X prefix
  // so 0x00007ffc73722140 and 0x7ffc73722140 both become 0x7ffc73722140.
  return raw.replace(/^0[xX](0+)([0-9a-fA-F]+)$/i, (_, zeros, hex) => '0x' + hex.toLowerCase());
}

export function shortHash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function parseUrl(url) {
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return { path: url, params: {} };
  const path = url.substring(0, qIdx);
  const params = {};
  for (const part of url.substring(qIdx + 1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) params[decodeURIComponent(part)] = '';
    else params[decodeURIComponent(part.substring(0, eq))] = decodeURIComponent(part.substring(eq + 1));
  }
  return { path, params };
}

export function resolveTemplate(template, params) {
  return template
    .replace(/\[([^\]]+)\]/g, '_$1')
    .replace(/\{([^}]+)\}/g, (_, name) => {
      if (name === 'sha1') return shortHash(JSON.stringify(params));
      if (name === 'encodedQuery') return safeFileName(params.q || 'empty');
      if (name === 'imageBase') return safeFileName(params.imageBase || 'default');
      if (name === 'target') return safeFileName(params.target || 'all');
      if (name === 'major' || name === 'minor') {
        return safeFileName(params[name] ?? '0');
      }
      if (name === 'threadId' || name === 'thread_id') {
        return safeFileName(params.threadId || params.thread_id || '0');
      }
      if (name === 'start_addr' || name === 'end_addr' || name === 'mode') {
        return safeFileName(params[name] ?? 'unknown');
      }
      return safeFileName(params[name] ?? 'unknown');
    });
}

/**
 * Look up the template for a (method, path) pair.
 * Used by the planner and recorder so neither needs to know the route map.
 */
export function templateFor(method, path) {
  return ROUTE_TEMPLATES[`${method} ${path}`] || null;
}