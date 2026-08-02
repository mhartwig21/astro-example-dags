// How OFTEN do JS engines disagree on the sim's Math primitives? Returns the
// per-function divergence RATE (differing results per 20k inputs) so the design
// can reason about whether a cross-engine replay diverges in practice.
import { chromium, firefox, webkit } from "playwright";

const DEV = process.env.DEV_URL ?? "http://localhost:5350";
const N = 20000;

const BATTERY = `(() => {
  const N = ${N};
  const buf = new DataView(new ArrayBuffer(8));
  const bits = (v) => { buf.setFloat64(0, v); return buf.getBigUint64(0).toString(16); };
  const out = {};
  const one = (name, f, gen) => {
    const a = new Array(N);
    for (let i = 0; i < N; i++) a[i] = bits(f(gen(i)));
    out[name] = a;
  };
  const x1 = (i) => (i * 0.00031) - 3.1;
  one("sin", Math.sin, x1); one("cos", Math.cos, x1); one("tan", Math.tan, x1);
  one("atan", Math.atan, x1); one("exp", Math.exp, x1);
  one("asin", Math.asin, (i) => (i / N) * 2 - 1);
  one("acos", Math.acos, (i) => (i / N) * 2 - 1);
  one("log", Math.log, (i) => (i + 1) * 0.0007);
  one("sqrt", Math.sqrt, (i) => (i + 1) * 0.0007);
  one("cbrt", Math.cbrt, (i) => (i + 1) * 0.0007);
  const a2 = new Array(N), pw = new Array(N), hy = new Array(N);
  for (let i = 0; i < N; i++) {
    const a = (i * 0.00017) - 1.7, b = (i * 0.00011) - 1.1;
    a2[i] = bits(Math.atan2(a, b));
    pw[i] = bits(Math.pow(Math.abs(a) + 0.01, b));
    hy[i] = bits(Math.hypot(a, b));
  }
  out.atan2 = a2; out.pow = pw; out.hypot = hy;
  return out;
})()`;

async function main(): Promise<void> {
  const nodeOut = (0, eval)(BATTERY) as Record<string, string[]>;
  const engines: Record<string, Record<string, string[]>> = {};
  for (const [name, launcher] of [["chromium", chromium], ["firefox", firefox], ["webkit", webkit]] as const) {
    try {
      const b = await launcher.launch();
      const page = await b.newPage();
      await page.goto(DEV + "/iso.html?test&noassets", { waitUntil: "domcontentloaded" });
      engines[name] = await page.evaluate(BATTERY) as Record<string, string[]>;
      await b.close();
    } catch {
      console.log(name + ": unavailable");
    }
  }
  const rows: Record<string, string | number>[] = [];
  for (const fn of Object.keys(nodeOut)) {
    const row: Record<string, string | number> = { fn };
    for (const eng of Object.keys(engines)) {
      let n = 0;
      for (let i = 0; i < N; i++) if (engines[eng][fn][i] !== nodeOut[fn][i]) n++;
      row[eng + " (per " + N + ")"] = n;
    }
    rows.push(row);
  }
  console.log("divergence from node(V8), inputs differing out of " + N + ":");
  console.table(rows);
}
void main();
