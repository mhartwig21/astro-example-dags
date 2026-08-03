// WHO ELSE IS USING THIS LAPTOP — the shared contamination meter.
//
// Extracted so every perf tool in here gates on the SAME definition of "clean".
// It exists because two plausible-looking definitions were both wrong, and
// each of them produced a published number that was not about this game:
//
//  1. "Count chrome-headless-shell." The sibling workflow launches Playwright
//     with headless:false for the same reason our tools do (headless-new routes
//     through SwiftShader on this box), so its browsers are chrome.exe. The
//     counter read 0 while FIFTEEN foreign chrome.exe processes were live, and
//     one staged scene swung 14 -> 39 ms GPU inside a single four-minute run.
//
//  2. "Wait for machine-wide CPU < 30%." Our OWN browser rendering the game at
//     60 fps is 25-40% of this laptop, so that gate can never open. It didn't:
//     twelve minutes, zero samples taken.
//
// What actually predicts contamination is how much CPU the foreign browsers
// BURNED DURING OUR WINDOW. Own vs foreign is resolved by walking the process
// tree from the calling node process (Playwright's browser is our child), and
// the load is a delta of cumulative processor-time across the sample — so a
// sibling browser merely parked on a page costs nothing, and one actually
// benchmarking is caught even if it starts mid-window.
import { execFileSync } from "node:child_process";
import { cpus } from "node:os";

const CORES = cpus().length;

/** Cumulative CPU-seconds for foreign vs own browser processes, plus counts. */
export function probeLoad(ownPid = process.pid) {
  try {
    const ps = `$c=(Get-Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 2).CounterSamples|%{$_.CookedValue};` +
      `$g=0; try{$g=((Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -SampleInterval 1 -MaxSamples 1 -ErrorAction Stop).CounterSamples|Measure-Object CookedValue -Sum).Sum}catch{};` +
      `$procs=@(Get-CimInstance Win32_Process -Filter "Name='chrome.exe' or Name='chrome-headless-shell.exe'" -ErrorAction SilentlyContinue);` +
      `$own=New-Object System.Collections.Generic.HashSet[int];` +
      `[void]$own.Add(${ownPid}); $changed=$true; while($changed){ $changed=$false; foreach($p in $procs){ if(-not $own.Contains([int]$p.ProcessId) -and $own.Contains([int]$p.ParentProcessId)){ [void]$own.Add([int]$p.ProcessId); $changed=$true } } }` +
      `$f=@($procs | Where-Object { -not $own.Contains([int]$_.ProcessId) });` +
      `$o=@($procs | Where-Object { $own.Contains([int]$_.ProcessId) });` +
      // KernelModeTime/UserModeTime are cumulative 100-ns ticks since start.
      //
      // Summed with an explicit loop, NOT `Measure-Object -Property @{e={...}}`:
      // Windows PowerShell 5.1 (which is what this box runs) rejects a
      // calculated-property hashtable there. It did not fail the command — it
      // wrote an error to stderr, left the sum $null, and the `if(-not $fs)`
      // guard then coerced that to a confident 0. Every window scored "0%
      // foreign load, CLEAN" while ten foreign browsers were live. A gate that
      // reports clean when it is broken is worse than no gate.
      `$fs=0.0; foreach($p in $f){ $fs = $fs + [double]$p.KernelModeTime + [double]$p.UserModeTime };` +
      `$os=0.0; foreach($p in $o){ $os = $os + [double]$p.KernelModeTime + [double]$p.UserModeTime };` +
      `Write-Output ("{0:N1},{1:N1},{2},{3},{4},{5}" -f (($c|Measure-Object -Average).Average),$g,$f.Count,$procs.Count,($fs/1e7),($os/1e7))`;
    const out = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", timeout: 40000 }).trim();
    const parts = out.split(",");
    if (parts.length !== 6 || parts.some((p) => !Number.isFinite(Number(p)))) {
      return { at: Date.now(), error: `unparseable probe output: ${out.slice(0, 120)}` };
    }
    const [cpu, gpu3d, foreign, total, fsec, osec] = parts.map(Number);
    // SELF-CHECK. A live process has necessarily burned some CPU since it
    // started, so "processes exist but their total CPU time is exactly zero" is
    // not a quiet box — it is a broken instrument, which is exactly how the
    // Measure-Object bug above disguised itself as a clean reading.
    if (foreign > 0 && fsec <= 0) {
      return { at: Date.now(), error: `instrument broken: ${foreign} foreign browser procs report 0 CPU-seconds` };
    }
    return {
      at: Date.now(),
      cpuPct: cpu, gpu3dPct: gpu3d,
      foreignBrowserProcs: foreign, totalBrowserProcs: total,
      foreignCpuSec: fsec, ownCpuSec: osec,
    };
  } catch (e) { return { at: Date.now(), error: String(e.message).slice(0, 120) }; }
}

/** Foreign browser CPU consumed between two probes, as % of the whole machine. */
export function foreignLoadPct(a, b) {
  if (!a || !b || a.error || b.error) return null;
  const secs = (b.at - a.at) / 1000;
  if (secs <= 0) return null;
  return +(((b.foreignCpuSec - a.foreignCpuSec) / secs / CORES) * 100).toFixed(1);
}

/**
 * Block until the foreign browsers go quiet.
 * `limitPct` is % of the WHOLE machine; 3% of a 16-thread box is under half a
 * core, below the point where it can move a 16.7 ms frame budget. Not zero: a
 * parked sibling browser still ticks timers and a zero gate would never open.
 */
export async function waitForIdle(label, { limitPct = 3, maxWaitMs = 420000, ownPid = process.pid, log = console.log } = {}) {
  const t0 = Date.now();
  let prev = probeLoad(ownPid);
  let announced = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, 6000));
    const now = probeLoad(ownPid);
    const fl = foreignLoadPct(prev, now);
    if (fl !== null && fl <= limitPct) {
      if (Date.now() - t0 > 7000) log(`  [idle gate] foreign browsers quiet (${fl}% of box) after ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      return { idle: true, load: now, foreignLoadPct: fl };
    }
    if (!announced) { log(`  [idle gate] waiting before ${label}: ${now.foreignBrowserProcs} foreign browser procs burning ${fl}% of the box`); announced = true; }
    if (Date.now() - t0 > maxWaitMs) {
      log(`  [idle gate] gave up after ${(maxWaitMs / 1000).toFixed(0)}s; foreign load still ${fl}% — treat what follows as an UPPER BOUND`);
      return { idle: false, load: now, foreignLoadPct: fl };
    }
    prev = now;
  }
}
