import { chromium } from "playwright";
const API = "http://localhost:5439";
const W = Number(process.env.W ?? 1600), H = Number(process.env.H ?? 900);
const b = await chromium.launch({ args:["--use-angle=swiftshader","--enable-unsafe-swiftshader","--disable-gpu-sandbox"] });
const p = await b.newPage({ viewport:{width:W,height:H} });
p.on("pageerror", e=>console.error("PAGE ERROR:", e.message));
await p.addInitScript(() => { localStorage.setItem("dcc:token:v1","CONSENT-PROBE-01"); localStorage.setItem("dcc:name:v1","Carl"); });
await p.goto(`http://localhost:5430/iso.html?api=${encodeURIComponent(API)}&noassets&debug=1`, {waitUntil:"load",timeout:120000});
await p.waitForFunction(()=>document.documentElement.dataset.assetsSettled==="1",null,{timeout:200000}).catch(()=>{});
await p.waitForTimeout(2500);
await p.click("#m-solo");
await p.waitForFunction(()=>document.getElementById("menu").classList.contains("casting"),null,{timeout:30000});
await p.waitForTimeout(1000); await p.click("#m-cast-go");
await p.waitForFunction(()=>document.getElementById("menu").style.display==="none",null,{timeout:30000});
await p.waitForTimeout(4000);
for (let i=0;i<3;i++){ await p.keyboard.down("w"); await p.waitForTimeout(600); await p.keyboard.up("w"); }
await p.evaluate(()=>{const s=window.__dcc.state;s.players[0].hp=0;s.players[0].alive=false;s.status="dead";});
await p.waitForFunction(()=>document.getElementById("recap")?.style.display==="flex",null,{timeout:60000});
await p.waitForTimeout(2500);
await p.evaluate(()=>{for(const a of document.getAnimations()){try{a.finish()}catch{}}});
await p.waitForTimeout(300);
console.log(await p.evaluate(()=>{
  const panel=document.querySelector("#recap .panel");
  const cs=getComputedStyle(panel);
  const r=document.getElementById("recap");
  const c=document.getElementById("consent");
  const btn=document.querySelector("#consent .cbtns");
  return JSON.stringify({
    viewport:[innerWidth,innerHeight],
    consenting:r.className,
    consentVisible:getComputedStyle(c).display,
    consentH:getComputedStyle(document.documentElement).getPropertyValue("--consent-h"),
    recapPadBottom:getComputedStyle(r).paddingBottom,
    panelMaxH:cs.maxHeight, panelH:Math.round(panel.getBoundingClientRect().height),
    panelTop:Math.round(panel.getBoundingClientRect().top),
    panelBottom:Math.round(panel.getBoundingClientRect().bottom),
    scrollH:panel.scrollHeight, clientH:panel.clientHeight,
    cardH:Math.round(c.getBoundingClientRect().height),
    btnBottom:Math.round(btn.getBoundingClientRect().bottom),
  },null,1);
}));
await p.screenshot({timeout:300000,path:`tools/_r2/consent-${W}x${H}.png`});
await b.close();
