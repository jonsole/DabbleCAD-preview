// Runs CuraEngine (compiled to WebAssembly) off the main thread.
//
// Protocol (all messages are plain objects):
//   in : { cmd: 'slice', jobId, base, files: [{ name, data: ArrayBuffer }], args: string[] }
//        base is the folder (ending in /) that holds the CuraEngine package, which is a separate
//        AGPL-3.0 download and not part of this repository.
//   out: { cmd: 'progress', jobId, value }      value 0..1
//        { cmd: 'log', jobId, str }             engine stdout/stderr, for diagnostics
//        { cmd: 'done', jobId, gcode }          gcode is a Uint8Array (transferred)
//        { cmd: 'error', jobId, error }
//
// The engine can only run once per instance (it calls exit when finished), so the main thread
// starts a fresh worker for every slice.
//
// CuraEngine is licensed under the AGPL-3.0 and is loaded at run time from the engine package
// (https://github.com/jonsole/DabbleCAD-curaengine), not bundled with DabbleCAD.

/* global importScripts */
var Module = {
  noInitialRun: true,
  print: (str) => onLine(str),
  printErr: (str) => onLine(str),
  onAbort: () => post({ cmd: 'error', error: 'The slicing engine stopped unexpectedly (it may have run out of memory).' }),
};

function onLine(str) {
  // The header at the top of the G-code is a placeholder; the real values arrive here at the end.
  if (/^;FLAVOR:/.test(str)) header = [];
  if (header && /^;/.test(str)) header.push(str);
  const m = /Progress:([\w+]+):(\d+):(\d+)/.exec(str);
  if (m) {
    const stages = ['slice', 'layerparts', 'inset+skin', 'support', 'export'];
    const stage = Math.max(0, stages.indexOf(m[1]));
    const total = parseInt(m[3], 10) || 1;
    post({ cmd: 'progress', value: (parseInt(m[2], 10) / total + stage) / stages.length });
  } else post({ cmd: 'log', str });
}

let currentJob = -1;
let header = null;
function post(msg, transfer) { self.postMessage({ ...msg, jobId: currentJob }, transfer || []); }

let base = '';
let ready = null;
function loadEngine(folder) {
  if (ready) return ready;
  base = folder;
  Module.locateFile = (name) => base + name;
  ready = new Promise((resolve) => { Module.onRuntimeInitialized = resolve; });
  importScripts(base + 'CuraEngine.js');
  return ready;
}

async function fetchBytes(name) {
  const res = await fetch(name);
  if (!res.ok) throw new Error(`Could not load ${name} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function withRealHeader(gcode) {
  if (!header || !header.length) return gcode;
  const head = new TextDecoder().decode(gcode.subarray(0, Math.min(gcode.length, 2048)));
  const m = /^;FLAVOR:[\s\S]*?;MAXZ:[^\n]*\n/m.exec(head);
  if (!m) return gcode;
  const fresh = new TextEncoder().encode(header.join('\n') + '\n');
  const out = new Uint8Array(fresh.length + gcode.length - (m.index + m[0].length));
  out.set(gcode.subarray(0, m.index));
  out.set(fresh, m.index);
  out.set(gcode.subarray(m.index + m[0].length), m.index + fresh.length);
  return out;
}

async function slice({ base: folder, files, args }) {
  await loadEngine(folder);
  // the glue defines FS and callMain as globals; Module.FS is only an abort() stub in this build
  const FS = self.FS;
  FS.writeFile('fdmprinter.def.json', await fetchBytes(base + 'fdmprinter.def.json'));
  FS.writeFile('fdmextruder.def.json', await fetchBytes(base + 'fdmextruder.def.json'));
  for (const f of files) FS.writeFile(f.name, new Uint8Array(f.data));
  try {
    self.callMain(args);
  } catch (err) {
    // callMain reports a normal exit by throwing ExitStatus
    if (!(err && (err.name === 'ExitStatus' || typeof err.status === 'number'))) throw err;
    if (err.status) throw new Error(`The slicing engine exited with code ${err.status}`);
  }
  let gcode;
  try { gcode = FS.readFile('output.gcode', { encoding: 'binary' }); } catch { gcode = null; }
  if (!gcode || !gcode.length) throw new Error('The slicing engine produced no G-code. Is the model inside the printer bed?');
  gcode = withRealHeader(gcode);
  post({ cmd: 'done', gcode }, [gcode.buffer]);
}

self.addEventListener('message', async (e) => {
  const d = e.data;
  if (d.cmd !== 'slice') return;
  currentJob = d.jobId;
  try { await slice(d); } catch (err) { post({ cmd: 'error', error: (err && err.message) || String(err) }); }
});
