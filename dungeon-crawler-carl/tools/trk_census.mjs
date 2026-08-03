// CONTAMINATION METER, shared. A timing number taken while ANOTHER browser is
// live on this box is worthless, and the sibling workflows run headless:false
// — so `chrome.exe` counts, not just `chrome-headless-shell.exe`. A previous
// round's meter read "0 foreign" while fifteen foreign chrome.exe were live
// because it only looked at the headless shell name.
//
// Own-vs-foreign is resolved by walking the process tree UP from each browser
// pid to THIS node process, using one snapshot of the whole process table (no
// per-pid powershell calls — those cost more than the sample they guard).
import { execSync } from "node:child_process";

const NAMES = /^(chrome|chrome-headless-shell|msedge|firefox)\.exe$/i;

export function census(ownPid = process.pid) {
  let rows;
  try {
    const out = execSync(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress\"",
      { encoding: "utf8", maxBuffer: 32 << 20, stdio: ["ignore", "pipe", "ignore"] },
    );
    rows = JSON.parse(out);
  } catch (e) {
    return { ok: false, err: String(e).slice(0, 120) };
  }
  const parent = new Map();
  const name = new Map();
  for (const r of rows) { parent.set(r.ProcessId, r.ParentProcessId); name.set(r.ProcessId, r.Name); }
  const descendsFromUs = (pid) => {
    let cur = pid;
    for (let i = 0; i < 24; i++) {
      if (cur === ownPid) return true;
      const p = parent.get(cur);
      if (p === undefined || p === 0 || p === cur) return false;
      cur = p;
    }
    return false;
  };
  let own = 0, foreign = 0;
  const foreignPids = [];
  for (const [pid, n] of name) {
    if (!NAMES.test(n)) continue;
    if (descendsFromUs(pid)) own++;
    else { foreign++; foreignPids.push(pid); }
  }
  return { ok: true, own, foreign, foreignPids: foreignPids.slice(0, 12) };
}
