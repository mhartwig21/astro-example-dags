import { chromium } from "playwright";
const b = await chromium.launch({ headless: false, args: ["--use-angle=d3d11","--enable-gpu","--ignore-gpu-blocklist","--disable-gpu-vsync","--disable-frame-rate-limit"] });
const ctx = await b.newContext({ viewport:{width:640,height:360}, deviceScaleFactor:1 });
const p = await ctx.newPage();
await p.goto("http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1",{waitUntil:"load",timeout:60000});
await p.waitForFunction(()=>document.documentElement.dataset.assetsSettled==="1",{timeout:180000}).catch(()=>{});
await p.waitForTimeout(3000);
await p.keyboard.down("w"); await p.waitForTimeout(1200); await p.keyboard.up("w");
console.log(JSON.stringify(await p.evaluate(()=>{
  const r=window.__dcc.renderer, sc=r.scene, gl=r.renderer;
  const lights=[]; let casters=0, meshes=0, castShadowMeshes=0, receive=0, frustumOff=0;
  const geoVerts=new Map(); const matKinds={};
  sc.traverse(o=>{
    if(o.isLight) lights.push({t:o.type,shadow:!!o.castShadow,map:o.shadow?.mapSize?`${o.shadow.mapSize.width}`:null,vis:o.visible});
    if(o.castShadow) casters++;
    if(o.isMesh){ meshes++; if(o.castShadow) castShadowMeshes++; if(o.receiveShadow) receive++; if(!o.frustumCulled) frustumOff++;
      const g=o.geometry; if(g) geoVerts.set(g.uuid,(g.attributes?.position?.count)||0);
      for(const m of [].concat(o.material||[])) matKinds[m.type]=(matKinds[m.type]||0)+1;
    }
  });
  const inst=[]; sc.traverse(o=>{ if(o.isInstancedMesh) inst.push(o.count); });
  inst.sort((a,b)=>a-b);
  return {
    lights, shadowCastingLights: lights.filter(l=>l.shadow&&l.vis).length,
    meshes, castShadowMeshes, receiveShadowMeshes: receive, frustumCullingDisabled: frustumOff,
    instancedMeshes: inst.length, instanceCountHistogram: {
      "1":inst.filter(c=>c===1).length, "2-4":inst.filter(c=>c>=2&&c<=4).length,
      "5-9":inst.filter(c=>c>=5&&c<=9).length, "10-31":inst.filter(c=>c>=10&&c<32).length,
      "32+":inst.filter(c=>c>=32).length },
    totalInstances: inst.reduce((a,c)=>a+c,0),
    materialTypes: matKinds,
    programs: gl.info.programs.length,
    memory: gl.info.memory,
    pixelRatio: gl.getPixelRatio(), size: [gl.domElement.width, gl.domElement.height],
    powerPreference: gl.getContextAttributes?.()?.powerPreference ?? gl.getContext().getContextAttributes().powerPreference,
    antialias: gl.getContext().getContextAttributes().antialias,
  };
},), null, 1));
await b.close();
