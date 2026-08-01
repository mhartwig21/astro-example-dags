// Who calls renderer.render()? Captures a stack trace per call and counts
// distinct call sites, plus per-rig skeleton sharing.
import { chromium } from "playwright";
const url = process.argv[2] || "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const b = await chromium.launch({ headless:false, args:["--use-angle=d3d11","--enable-gpu","--ignore-gpu-blocklist","--disable-gpu-vsync","--disable-frame-rate-limit"] });
const p = await b.newPage({ viewport:{width:640,height:360}, deviceScaleFactor:1 });
p.on("pageerror",(e)=>console.error("PAGE ERROR:",e.message));
await p.goto(url,{waitUntil:"load",timeout:60000});
await p.waitForFunction(()=>document.documentElement.dataset.assetsSettled==="1",{timeout:180000}).catch(()=>{});
await p.waitForTimeout(2500);
await p.keyboard.down("w"); await p.waitForTimeout(2000); await p.keyboard.up("w");
for (const k of ["Space","q","e"]) { await p.keyboard.press(k).catch(()=>{}); await p.waitForTimeout(100); }
console.log(JSON.stringify(await p.evaluate(()=>new Promise(res=>{
  const R=window.__dcc.renderer, gl=R.renderer;
  const sites=new Map(); let frames=0, total=0;
  const sceneInfo=new Map();
  const oR=gl.render.bind(gl);
  gl.render=function(scene,cam){ total++;
    const st=(new Error()).stack.split("\n").slice(2,5).map(s=>s.trim().replace(/https?:\/\/[^ )]*\//,"")).join(" <- ");
    sites.set(st,(sites.get(st)||0)+1);
    let n=0; scene.traverse(()=>n++);
    const k=scene.uuid.slice(0,6)+`(${n} objs)`; sceneInfo.set(k,(sceneInfo.get(k)||0)+1);
    return oR(scene,cam); };
  const oC=R.composer.render.bind(R.composer);
  R.composer.render=function(...a){ const r=oC(...a); if(++frames>=60){ R.composer.render=oC; gl.render=oR;
    // skeleton sharing per monster rig
    const roots=[]; const v=R.monsters;
    if(v instanceof Map) for(const e of v.values()){ if(e&&e.isObject3D)roots.push(e); else if(e&&typeof e==="object") for(const s of Object.values(e)) if(s&&s.isObject3D)roots.push(s); }
    let rigs=0, skinned=0; const perRig=[];
    for(const rt of roots.slice(0,40)){ const sk=new Set(); let m=0;
      rt.traverse(o=>{ if(o.isSkinnedMesh){m++; sk.add(o.skeleton);} });
      if(m){rigs++; skinned+=m; perRig.push({skinnedMeshes:m, distinctSkeletons:sk.size});} }
    const agg={}; for(const r2 of perRig){ const k=`${r2.skinnedMeshes}mesh/${r2.distinctSkeletons}skel`; agg[k]=(agg[k]||0)+1; }
    res({frames, rendererRenderPerFrame:+(total/frames).toFixed(2),
      callSites:[...sites.entries()].sort((a,c)=>c[1]-a[1]).slice(0,10).map(([s,n])=>({perFrame:+(n/frames).toFixed(2), site:s})),
      scenesRendered:[...sceneInfo.entries()].sort((a,c)=>c[1]-a[1]).slice(0,8).map(([s,n])=>({perFrame:+(n/frames).toFixed(2), scene:s})),
      rigSkeletonSharing:agg, sampledRigs:rigs}); }
    return r; };
})),null,1));
await b.close();
