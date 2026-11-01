// Loaded by UAT into the commands it runs (NODE_OPTIONS=--require). Notes
// each outgoing connection and HTTP request, and how it went, as JSON lines
// in the file UAT_TRACE_FILE names, so a call's trace in UAT shows what this
// service called. Watches without listening: no handlers are added, so an
// error the app doesn't handle still crashes it as it would without UAT.
'use strict';
(function () {
  const file = process.env.UAT_TRACE_FILE;
  if (!file || globalThis.__uatTrace) return;
  globalThis.__uatTrace = true;

  let fs, net, dc;
  try {
    fs = require('fs');
    net = require('net');
    dc = require('diagnostics_channel');
  } catch {
    return;
  }

  let n = 0;
  const next = () => process.pid + '.' + ++n;
  const note = (o) => {
    try {
      o.t = Date.now();
      fs.appendFileSync(file, JSON.stringify(o) + '\n');
    } catch {}
  };
  note({ k: 'hi', pid: process.pid });

  // http, https, fetch and database drivers all connect through net.Socket
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    try {
      watch(this, args);
    } catch {}
    return connect.apply(this, args);
  };

  function watch(socket, args) {
    let a = args[0];
    if (Array.isArray(a)) a = a[0]; // already normalized by net.connect
    let host, port;
    if (a && typeof a === 'object') {
      if (a.path) return; // a Unix socket
      host = a.host;
      port = a.port;
    } else if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
      port = a;
      host = typeof args[1] === 'string' ? args[1] : undefined;
    } else return;
    port = Number(port);
    if (!port) return;
    const c = next();
    let open = false;
    note({ k: 'connect', c, host: host || 'localhost', port });
    const emit = socket.emit;
    socket.emit = function (event, ...rest) {
      try {
        if (event === 'connect' && !open) {
          open = true;
          note({ k: 'open', c });
        } else if (event === 'error' && !open) {
          open = true;
          const e = rest[0] || {};
          note({ k: 'fail', c, code: e.code, msg: String(e.message || '').slice(0, 200) });
        }
      } catch {}
      return emit.call(this, event, ...rest);
    };
  }

  const requests = new WeakMap();
  const on = (name, fn) => {
    const safe = (msg) => {
      try {
        fn(msg);
      } catch {}
    };
    try {
      if (dc.subscribe) dc.subscribe(name, safe);
      else dc.channel(name).subscribe(safe);
    } catch {}
  };
  const begin = (request, host, port, method, path) => {
    const r = next();
    requests.set(request, r);
    note({ k: 'req', r, host, port, method, path: String(path || '/').slice(0, 300) });
  };
  const end = (request, extra) => {
    const r = requests.get(request);
    if (r) note({ k: extra.status ? 'res' : 'rerr', r, ...extra });
  };

  // http and https
  on('http.client.request.start', ({ request }) => {
    const header = String((request.getHeader && request.getHeader('host')) || request.host || '');
    const m = header.match(/^\[?([^\]]*?)\]?(?::(\d+))?$/);
    const tls = request.protocol === 'https:';
    begin(request, request.host || (m && m[1]), Number((m && m[2]) || (tls ? 443 : 80)), request.method, request.path);
  });
  on('http.client.response.finish', ({ request, response }) => end(request, { status: response.statusCode }));
  on('http.client.request.error', ({ request, error }) => end(request, { code: (error && error.code) || 'error' }));

  // fetch (undici)
  on('undici:request:create', ({ request }) => {
    const u = new URL(String(request.origin));
    begin(request, u.hostname, Number(u.port) || (u.protocol === 'https:' ? 443 : 80), request.method, request.path);
  });
  on('undici:request:headers', ({ request, response }) => end(request, { status: response.statusCode }));
  on('undici:request:error', ({ request, error }) => end(request, { code: (error && error.code) || 'error' }));
})();
