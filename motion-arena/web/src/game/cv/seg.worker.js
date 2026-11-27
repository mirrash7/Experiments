// BREAKLIGHT CV: segmentation worker. Keeps MediaPipe ImageSegmenter inference + mask read-back + cutout compositing off
// the main thread. Protocol (see segmenter.js): init -> ready|error; frame -> result|fail.
// tasks-vision loads its wasm glue with importScripts(), which module workers don't support: shim it with a synchronous
// fetch + global eval of the (same-origin, bundled) loader script.
if (typeof self.importScripts === 'function') {
  let native = true;
  try { self.importScripts(); } catch { native = false; }
  if (!native) {
    self.importScripts = (...urls) => {
      for (const u of urls) {
        const x = new XMLHttpRequest();
        x.open('GET', String(u), false);
        x.send();
        if (x.status !== 200) throw new Error(`importScripts shim: ${x.status} ${u}`);
        (0, eval)(x.responseText);   // global scope: `var ModuleFactory` becomes self.ModuleFactory
      }
    };
  }
}

let core = null;
const ready = import('./seg-core.js');

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const { SegCore } = await ready;
      core = new SegCore();
      const info = await core.init(m);
      self.postMessage({ type: 'ready', ...info });
    } catch (err) { self.postMessage({ type: 'error', message: String(err?.message || err) }); }
    return;
  }
  if (m.type === 'frame') {
    if (!core?.seg) { m.bitmap?.close?.(); self.postMessage({ type: 'fail', id: m.id, message: 'not ready' }); return; }
    try {
      const r = core.segment(m.bitmap, m);
      const transfer = [r.cutout]; if (r.small) transfer.push(r.small);
      self.postMessage({ type: 'result', id: m.id, t: m.t, hires: !!m.hires, ...r }, transfer);
    } catch (err) { m.bitmap?.close?.(); self.postMessage({ type: 'fail', id: m.id, hires: !!m.hires, message: String(err?.message || err) }); }
    return;
  }
  if (m.type === 'close') { core?.close(); core = null; self.close(); }
};
