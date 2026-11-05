// node site/test_core.mjs [path/to/gd_*_dfu.zip]   (compares against tools/watchdog_flash.py output)
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
await import("./core.js");                                   // classic script: sets globalThis.WatchdogCore
const { loadValve, makeUF2, parseInfo, planFor, SD_ADDR, APP_ADDR } = globalThis.WatchdogCore;

const here = dirname(fileURLToPath(import.meta.url));
const zip = process.argv[2] || join(homedir(), ".local/share/Steam/steamapps/common/SteamVR/drivers/indexhmd/resources/firmware/radio/gd_1558748372_dfu.zip");
assert(existsSync(zip), "zip not found: " + zip);

const v = await loadValve(readFileSync(zip), true);
const out = mkdtempSync(join(tmpdir(), "wf-"));
execFileSync("python3", [join(here, "../tools/watchdog_flash.py"), "--zip", zip, "build", "--out", out], { stdio: "pipe" });
const pyApp = readFileSync(join(out, "valve_radio_app.uf2")), pySd = readFileSync(join(out, "valve_s140_6.1.1.uf2"));
assert.deepEqual(Buffer.from(makeUF2(v.app, APP_ADDR)), pyApp, "app UF2 differs from python tool");
assert.deepEqual(Buffer.from(makeUF2(v.sd, SD_ADDR)), pySd, "SD UF2 differs from python tool");
console.log("ok  app+SD UF2 byte-identical to tools/watchdog_flash.py (and therefore to uf2conv)");
assert(v.notes[0].startsWith("audio device disabled")); console.log("ok  audio patch applied:", v.notes[0]);

const v2 = await loadValve(readFileSync(zip), false); assert.equal(v2.notes.length, 0);
assert.equal(v2.app[0x1839D], 0xB1); assert.equal(v.app[0x1839D], 0xB9); console.log("ok  patch toggle");

const t1000 = parseInfo(readFileSync(join(here, "../backup/t1000e/INFO_UF2.TXT"), "utf8"));
let p = planFor(t1000); assert.deepEqual(p.steps.map(s => s.kind), ["sd", "app"]); console.log("ok  T1000-E (S140 7.3.0) -> SD + app");
p = planFor({ SoftDevice: "S140 6.1.1" }); assert.deepEqual(p.steps.map(s => s.kind), ["app"]); console.log("ok  RAK (S140 6.1.1) -> app only");
p = planFor({ SoftDevice: "S132 6.1.1" }); assert(!p.ok); console.log("ok  S132 refused");
assert(planFor({ SoftDevice: "S132 6.1.1" }, { force: true }).ok);
p = planFor({}); assert(p.warnings.length && p.steps.length === 2); console.log("ok  unknown SoftDevice -> warn + SD + app");

let threw = false; try { await loadValve(Buffer.from("not a zip at all, definitely not")); } catch { threw = true; } assert(threw); console.log("ok  garbage rejected");
console.log("\nall passed");
