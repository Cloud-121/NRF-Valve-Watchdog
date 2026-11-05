(function () {
// core.js — pure logic, no DOM. Classic script (works from file://); exposes globalThis.WatchdogCore.
// Also imported by test_core.mjs (Node).
// Mirrors tools/watchdog_flash.py; the two must stay byte-for-byte compatible.

const FAMILY = 0xADA52840;       // nRF52840 UF2 family id
const SD_ADDR = 0x1000;
const APP_ADDR = 0x26000;
const NEED_SD = "S140 6.1.1";
const VALVE_VID = 0x28de;
const VALVE_PIDS = { 0x2101: "Watchman Dongle", 0x2102: "Valve VR Radio" };

// Verified against gd_1558748372_dfu: disables the Index HMD audio device so the radio shows up alone.
const AUDIO_PATCH = { offset: 0x1839D, from: 0xB1, to: 0xB9 };
const NAME_CHECK = { offset: 0x162E0, bytes: [...new TextEncoder().encode("Valve VR Radio")].concat([0]) };

// ---- UF2 ---------------------------------------------------------------------------------
function makeUF2(data, base, family = FAMILY) {
  const n = Math.ceil(data.length / 256);
  const out = new Uint8Array(n * 512);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < n; i++) {
    const o = i * 512;
    dv.setUint32(o + 0, 0x0A324655, true);
    dv.setUint32(o + 4, 0x9E5D5157, true);
    dv.setUint32(o + 8, 0x2000, true);                 // familyID present
    dv.setUint32(o + 12, base + i * 256, true);
    dv.setUint32(o + 16, 256, true);
    dv.setUint32(o + 20, i, true);
    dv.setUint32(o + 24, n, true);
    dv.setUint32(o + 28, family, true);
    out.set(data.subarray(i * 256, i * 256 + 256), o + 32);   // remainder stays zero-padded
    dv.setUint32(o + 508, 0x0AB16F30, true);
  }
  return out;
}

// ---- minimal ZIP reader (stored + deflate) ------------------------------------------------
async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip file");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt zip directory");
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
    const lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lelen;
    const raw = u8.subarray(start, start + csize);
    files[name] = method === 0 ? raw.slice() : method === 8 ? await inflateRaw(raw) : (() => { throw new Error("Unsupported zip method " + method); })();
    p += 46 + nlen + elen + clen;
  }
  return files;
}

// ---- Valve package -> {sd, app, notes} ------------------------------------------------------
async function loadValve(zipBuf, patchAudio = true) {
  const files = await readZip(zipBuf);
  if (!files["manifest.json"]) throw new Error("manifest.json missing - this is not a SteamVR gd_*_dfu.zip");
  const man = JSON.parse(new TextDecoder().decode(files["manifest.json"])).manifest;
  if (!man.softdevice || !man.application) throw new Error("Package has no softdevice/application entries");
  const sdName = man.softdevice.bin_file;
  if (!sdName.includes("6.1.1")) throw new Error(`Unexpected SoftDevice (${sdName}); this tool only knows S140 6.1.1`);
  const sd = files[sdName];
  const app = files[man.application.bin_file].slice();
  const notes = [];
  if (patchAudio) {
    const { offset, from, to } = AUDIO_PATCH;
    const okName = NAME_CHECK.bytes.every((b, i) => app[NAME_CHECK.offset + i] === b);
    if (app.length > offset && app[offset] === from && okName) {
      app[offset] = to;
      notes.push(`audio device disabled (0x${offset.toString(16).toUpperCase()}: ${from.toString(16)} -> ${to.toString(16)})`);
    } else {
      notes.push("Firmware version differs from the verified one - audio patch SKIPPED (radio should still work).");
    }
  }
  return { sd, app, notes, sdName, appName: man.application.bin_file };
}

// ---- INFO_UF2.TXT ---------------------------------------------------------------------------
function parseInfo(text) {
  const kv = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (line.startsWith("UF2 Bootloader")) kv.Bootloader = line.trim();
    else if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return kv;
}

// Decide what to write for a given bootloader. Returns {ok, blocked, steps[], warnings[]}.
function planFor(info, { forceSd = false, force = false } = {}) {
  const sd = info.SoftDevice || "";
  const warnings = [];
  if (sd.startsWith("S132") && !force)
    return { ok: false, blocked: "This board reports an S132 (nRF52832) SoftDevice. Valve's radio firmware is nRF52840-only.", steps: [], warnings };
  if (!sd.startsWith("S140")) warnings.push("The bootloader doesn't report an S140 SoftDevice - assuming nRF52840 and writing the SoftDevice too.");
  const steps = [];
  if (forceSd || sd !== NEED_SD) steps.push({ kind: "sd", label: `Write Valve SoftDevice ${NEED_SD} @ 0x${SD_ADDR.toString(16)}`, note: "replaces the board's current SoftDevice; the board resets afterwards" });
  steps.push({ kind: "app", label: `Write Valve radio application @ 0x${APP_ADDR.toString(16)}`, note: "" });
  return { ok: true, steps, warnings };
}

globalThis.WatchdogCore = { FAMILY, SD_ADDR, APP_ADDR, NEED_SD, VALVE_VID, VALVE_PIDS, AUDIO_PATCH, NAME_CHECK, makeUF2, readZip, loadValve, parseInfo, planFor };
})();
