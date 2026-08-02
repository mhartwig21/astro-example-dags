// The SEALED state, EARNED. No state poking: a mutated world is precisely what
// the verifier refuses, which is why every previous capture of this screen
// shows REFUSED. The crawler walks in, never swings, and the collapse timer
// does the job the sim was always going to do.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const API = "http://localhost:5441";
mkdirSync("tools/_r2", { recursive: true });
const b = await chromium.launch({ args:["--use-angle=swiftshader","--enable-unsafe-swiftshader","--disable-gpu-sandbox"] });
// Play small: under SwiftShader the fill rate is what dilates sim time,
// and the collapse clock has to run in SIM seconds. The viewport goes back to
// 1600x900 before the verdict is photographed.
const p = await b.newPage({ viewport:{width:520,height:340}, deviceScaleFactor:1 });
p.on("pageerror", e=>console.error("PAGE ERROR:", e.message));
await p.addInitScript(() => {
  localStorage.setItem("dcc:token:v1","R2-SEALED-TOKEN-01");
  localStorage.setItem("dcc:name:v1","Carl");
  localStorage.setItem("dcc:consent:v1","public");
});
await p.goto(`http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets&debug=1&q=low`, {waitUntil:"load",timeout:120000});
await p.waitForFunction(()=>document.documentElement.dataset.assetsSettled==="1",null,{timeout:200000}).catch(()=>{});
await p.waitForTimeout(2500);
await p.click("#m-daily");
await p.waitForFunction(()=>document.getElementById("menu").classList.contains("casting"),null,{timeout:30000});
await p.waitForTimeout(900);
await p.click("#m-cast-go");
await p.waitForFunction(()=>window.__dcc?.state?.elapsed>0.2,null,{timeout:120000});
console.log("run:", await p.evaluate(()=>JSON.stringify({seed:window.__dcc.state.seed, runEvent:window.__dcc.runEvent})));
// The collapse clock is the honest executioner. Idle, in-sim, until it lands.
const t0=Date.now();
while (Date.now()-t0 < 20*60_000) {
  await p.waitForTimeout(4000);
  const st = await p.evaluate(()=>({s:window.__dcc.state.status, hp:Math.round(window.__dcc.state.players[0].hp), e:Math.round(window.__dcc.state.elapsed)}));
  console.log(Math.round((Date.now()-t0)/1000)+"s wall", JSON.stringify(st));
  if (st.s!=="playing") break;
}
await p.waitForFunction(()=>document.getElementById("recap")?.style.display==="flex",null,{timeout:90000});
await p.setViewportSize({width:1600,height:900});
await p.waitForTimeout(20000);
await p.evaluate(()=>{for(const a of document.getAnimations()){try{a.finish()}catch{}}});
await p.waitForTimeout(300);
console.log(await p.evaluate(()=>{
  const t=id=>(document.getElementById(id)?.innerText??"(hidden)").replace(/\n+/g," | ");
  return ["LADDER : "+t("recap-ladder"),"SEAL   : "+t("recap-seal"),"MARK   : "+t("recap-mark"),
          "BANKED : "+t("recap-banked"),"EARNED : "+t("recap-earned"),
          "sealClass: "+document.getElementById("recap-seal").className,
          "submitResult: "+JSON.stringify(window.__dcc.submitResult)].join("\n");
}));
await p.screenshot({timeout:300000,path:"tools/_r2/sealed-1600x900.png"});
await b.close();
