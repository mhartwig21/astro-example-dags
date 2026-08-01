// Per-actor / per-prop draw-call anatomy: how many meshes each monster rig,
// player, weapon and dressing prop contributes, and how much geometry/material
// sharing exists between them (i.e. how instanceable they are).
import { chromium } from "playwright";
const url = process.argv[2] || "http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const b = await chromium.launch({ headless:false, args:["--use-angle=d3d11","--enable-gpu","--ignore-gpu-blocklist","--disable-gpu-vsync","--disable-frame-rate-limit"] });
const p = await b.newPage({ viewport:{width:1440,height:852}, deviceScaleFactor:2 });
p.on("pageerror",(e)=>console.error("PAGE ERROR:",e.message));
await p.goto(url,{waitUntil:"load",timeout:60000});
await p.waitForFunction(()=>document.documentElement.dataset.assetsSettled==="1",{timeout:180000}).catch(()=>{});
await p.waitForTimeout(2500);
await p.keyboard.down("w"); await p.waitForTimeout(2200); await p.keyboard.up("w");
for (const k of ["Space","q","e","c"]) { await p.keyboard.press(k).catch(()=>{}); await p.waitForTimeout(120); }
console.log(JSON.stringify(await p.evaluate(()=>{
  const R=window.__dcc.renderer, scene=R.scene;
  const roots=(name)=>{const v=R[name],out=[];const take=e=>{if(!e||typeof e!=="object")return;if(e.isObject3D){out.push(e);return;}for(const s of Object.values(e))if(s&&s.isObject3D)out.push(s);};
    if(!v)return out; if(v instanceof Map)for(const e of v.values())take(e); else if(Array.isArray(v))for(const e of v)take(e); else take(v); return out;};
  const anat=(list)=>{
    const per=[],geo=new Map(),mat=new Map(); let meshes=0,skinned=0,cast=0,vis=0,tris=0;
    for(const r of list){ let n=0;
      r.traverse(o=>{ if(!(o.isMesh||o.isSkinnedMesh||o.isSprite))return; n++; meshes++;
        if(o.isSkinnedMesh)skinned++; if(o.castShadow)cast++; if(o.visible&&r.visible)vis++;
        if(o.geometry){geo.set(o.geometry.uuid,(geo.get(o.geometry.uuid)||0)+1);
          const g=o.geometry, idx=g.index?g.index.count:(g.attributes.position?g.attributes.position.count:0); tris+=idx/3;}
        const ms=Array.isArray(o.material)?o.material:(o.material?[o.material]:[]);
        for(const m of ms) mat.set(m.uuid,(mat.get(m.uuid)||0)+1); });
      per.push(n); }
    per.sort((a,b)=>b-a);
    return {actors:list.length, meshes, skinnedMeshes:skinned, casters:cast, visibleMeshes:vis, tris:Math.round(tris),
      meshesPerActor:{max:per[0]||0, median:per[per.length>>1]||0, min:per[per.length-1]||0},
      distinctGeometries:geo.size, distinctMaterials:mat.size,
      geoReuse:+(meshes/Math.max(1,geo.size)).toFixed(2), matReuse:+(meshes/Math.max(1,mat.size)).toFixed(2)};
  };
  // dressing props = non-instanced children of floorGroup
  const props=R.floorGroup.children.filter(c=>!c.isInstancedMesh);
  const chunks=R.floorGroup.children.filter(c=>c.isInstancedMesh);
  // instanced chunk meshes: XZ extent of instances tells 12-tile vs 36-tile bucket
  const buckets=[];
  for(const c of chunks){
    const a=c.instanceMatrix.array; let x0=1e9,x1=-1e9,z0=1e9,z1=-1e9;
    for(let i=0;i<c.count;i++){const o=i*16;x0=Math.min(x0,a[o+12]);x1=Math.max(x1,a[o+12]);z0=Math.min(z0,a[o+14]);z1=Math.max(z1,a[o+14]);}
    const g=c.geometry, idx=g.index?g.index.count:(g.attributes.position?g.attributes.position.count:0);
    buckets.push({span:Math.round(Math.max(x1-x0,z1-z0)), count:c.count, triPer:idx/3, cast:!!c.castShadow,
      geo:g.parameters?`${g.type}`:`glTF[${idx}]`});
  }
  const bySpan={};
  for(const bk of buckets){ const k=bk.span<=13?"fine(<=12 tiles)":bk.span<=38?"super(<=36 tiles)":"map-wide";
    const e=bySpan[k]||(bySpan[k]={meshes:0,instances:0,tris:0}); e.meshes++; e.instances+=bk.count; e.tris+=Math.round(bk.triPer*bk.count); }
  const byGeo={};
  for(const bk of buckets){ const e=byGeo[bk.geo]||(byGeo[bk.geo]={meshes:0,instances:0,spanMax:0,cast:bk.cast,triPer:bk.triPer});
    e.meshes++; e.instances+=bk.count; e.spanMax=Math.max(e.spanMax,bk.span); }
  return {
    monsters:anat(roots("monsters")), players:anat(roots("playerMeshes")),
    breakables:anat(roots("breakableMeshes")), loot:anat(roots("loot")),
    props:anat(props),
    instancedChunks:{meshes:chunks.length, bySpan, byGeo},
    mapSize:`${window.__dcc.state.map.w}x${window.__dcc.state.map.h}`,
    mobCount:(window.__dcc.state.mobs||[]).filter(m=>m.alive).length,
    mobTotal:(window.__dcc.state.mobs||[]).length,
  };
}),null,1));
await b.close();
