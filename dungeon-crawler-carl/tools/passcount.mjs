// How many times per displayed frame does three.js walk the scene / rebuild the
// shadow map / update skeletons? Each renderer.render() re-does ALL of it.
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
  const R=window.__dcc.renderer, gl=R.renderer, gtao=R.gtao;
  let frames=0, rendererRender=0, shadowRender=0, shadowDraws=0, gbufDraws=0, skelUpdates=0, visWalks=0, visWalkObjs=0;
  const oR=gl.render.bind(gl); gl.render=function(...a){rendererRender++;return oR(...a);};
  let inShadow=false;
  const oS=gl.shadowMap.render.bind(gl.shadowMap); gl.shadowMap.render=function(...a){shadowRender++;inShadow=true;const r=oS(...a);inShadow=false;return r;};
  let inG=false;
  const oG=gtao.renderOverride.bind(gtao); gtao.renderOverride=function(...a){inG=true;const r=oG(...a);inG=false;return r;};
  const oV=gtao.overrideVisibility.bind(gtao); gtao.overrideVisibility=function(...a){visWalks++;let n=0;R.scene.traverse(()=>n++);visWalkObjs=n;return oV(...a);};
  const oB=gl.renderBufferDirect.bind(gl); gl.renderBufferDirect=function(...a){ if(inShadow)shadowDraws++; else if(inG)gbufDraws++; return oB(...a); };
  // skeleton updates: patch every Skeleton.update in the scene
  const skels=new Set(); R.scene.traverse(o=>{ if(o.isSkinnedMesh&&o.skeleton) skels.add(o.skeleton); });
  for(const s of skels){ const u=s.update.bind(s); s.update=function(){skelUpdates++;return u();}; }
  const oC=R.composer.render.bind(R.composer);
  R.composer.render=function(...a){ const r=oC(...a); if(++frames>=120){ R.composer.render=oC;
    res({frames, rendererRenderPerFrame:+(rendererRender/frames).toFixed(2), shadowMapRendersPerFrame:+(shadowRender/frames).toFixed(2),
      shadowDrawsPerFrame:+(shadowDraws/frames).toFixed(1), gtaoGBufferDrawsPerFrame:+(gbufDraws/frames).toFixed(1),
      skeletonsInScene:skels.size, skeletonUpdatesPerFrame:+(skelUpdates/frames).toFixed(1),
      gtaoVisibilityWalksPerFrame:+(visWalks/frames).toFixed(2), objectsPerVisibilityWalk:visWalkObjs,
      shadowMapSize:`${R.key.shadow.mapSize.x}x${R.key.shadow.mapSize.y}`, shadowAutoUpdate:gl.shadowMap.autoUpdate}); }
    return r; };
})),null,1));
await b.close();
