// Clean, REVERSIBLE A/B for skeleton de-duplication. SkeletonUtils.clone mints
// one Skeleton per skinned mesh, so an 8-part rig recomputes and re-uploads the
// same bone matrices 8x a frame. Rebinding every mesh in a rig to one shared
// skeleton is pose-identical; this prices it. Tiny backbuffer so the delta is
// pure CPU. Interleaved A/B/A/B, median of reps.
import { chromium } from "playwright";
const flag=(n,d)=>{const i=process.argv.indexOf(n);return i>=0?process.argv[i+1]:d;};
const url=process.argv[2]?.startsWith("http")?process.argv[2]:"http://localhost:5291/iso.html?test&floor=8&level=16&seed=41&abilities=all&debug=1";
const reps=Number(flag("--reps",6)), nFrames=Number(flag("--frames",120));
const b=await chromium.launch({headless:false,args:["--use-angle=d3d11","--enable-gpu","--ignore-gpu-blocklist","--disable-gpu-vsync","--disable-frame-rate-limit"]});
const p=await b.newPage({viewport:{width:640,height:360},deviceScaleFactor:1});
p.on("pageerror",e=>console.error("PAGE ERROR:",e.message));
await p.goto(url,{waitUntil:"load",timeout:60000});
await p.waitForFunction(()=>document.documentElement.dataset.assetsSettled==="1",{timeout:180000}).catch(()=>{});
await p.waitForTimeout(2500);
await p.keyboard.down("w"); await p.waitForTimeout(2000); await p.keyboard.up("w");
for(const k of ["Space","q","e"]){await p.keyboard.press(k).catch(()=>{});await p.waitForTimeout(100);}
await p.evaluate(()=>{
  const R=window.__dcc.renderer, gl=R.renderer;
  const roots=n=>{const v=R[n],o=[];const t=e=>{if(!e||typeof e!=="object")return;if(e.isObject3D){o.push(e);return;}for(const s of Object.values(e))if(s&&s.isObject3D)o.push(s);};
    if(!v)return o; if(v instanceof Map)for(const e of v.values())t(e); else if(Array.isArray(e=v))for(const e2 of v)t(e2); else t(v); return o;};
  let ct=[],rt=[],frames=0,skelUpd=0,lastRaf=performance.now();
  const tick=()=>{const n=performance.now();rt.push(n-lastRaf);lastRaf=n;requestAnimationFrame(tick);};requestAnimationFrame(tick);
  const oC=R.composer.render.bind(R.composer);
  R.composer.render=function(...a){const t0=performance.now();const r=oC(...a);ct.push(performance.now()-t0);frames++;return r;};
  // record original skeletons so the variant is reversible
  const rigs=[];
  for(const n of ["monsters","playerMeshes"]) for(const root of roots(n)){
    const ms=[]; root.traverse(o=>{if(o.isSkinnedMesh&&o.skeleton)ms.push(o);});
    if(ms.length<2) continue;
    if(ms.some(m=>m.skeleton.bones.length!==ms[0].skeleton.bones.length)) continue;
    rigs.push({meshes:ms, orig:ms.map(m=>m.skeleton), bm:ms.map(m=>m.bindMatrix.clone())});
  }
  // count skeleton updates
  const allSkel=new Set(); R.scene.traverse(o=>{if(o.isSkinnedMesh&&o.skeleton)allSkel.add(o.skeleton);});
  for(const s of allSkel){const u=s.update.bind(s); s.update=function(){skelUpd++;return u();};}
  window.__sk={
    rigsEligible:rigs.length,
    skeletonsBefore:allSkel.size,
    skeletonsAfterShare:(()=>{let n=0;for(const r of rigs)n+=r.meshes.length-1;return allSkel.size-n;})(),
    apply(v){ if(v==="shared"){for(const r of rigs)for(let i=1;i<r.meshes.length;i++)r.meshes[i].bind(r.orig[0],r.bm[i]);}
              else {for(const r of rigs)for(let i=1;i<r.meshes.length;i++)r.meshes[i].bind(r.orig[i],r.bm[i]);} },
    reset(){ct=[];rt=[];frames=0;skelUpd=0;}, frames:()=>frames,
    result(){const md=v=>{const s=[...v].sort((a,c)=>a-c);return s.length?+s[s.length>>1].toFixed(2):0;};
      return{composerMs:md(ct),rafMs:md(rt),skelUpdatesPerFrame:+(skelUpd/Math.max(1,frames)).toFixed(1),frames};}
  };
});
const info=await p.evaluate(()=>({e:window.__sk.rigsEligible,b:window.__sk.skeletonsBefore,a:window.__sk.skeletonsAfterShare}));
console.log(`eligible rigs=${info.e}  skeletons ${info.b} -> ${info.a} if shared`);
const acc={separate:[],shared:[]}, upd={};
for(let r=0;r<reps;r++) for(const v of ["separate","shared"]){
  await p.evaluate(x=>window.__sk.apply(x),v);
  await p.waitForTimeout(400);
  await p.evaluate(()=>window.__sk.reset());
  await p.waitForFunction(f=>window.__sk.frames()>=f,nFrames,{timeout:60000}).catch(()=>{});
  const res=await p.evaluate(()=>window.__sk.result());
  acc[v].push(res.composerMs); upd[v]=res.skelUpdatesPerFrame;
}
const md=a=>{const s=[...a].sort((x,y)=>x-y);return s[s.length>>1];};
console.log("\nvariant   composerMed  skelUpd/frame   reps");
for(const v of ["separate","shared"]) console.log(v.padEnd(10),String(md(acc[v])).padStart(9),String(upd[v]).padStart(14),"  ",acc[v].join(","));
console.log(`delta: ${(md(acc.shared)-md(acc.separate)).toFixed(2)}ms (${(100*(md(acc.shared)-md(acc.separate))/md(acc.separate)).toFixed(1)}%)`);
await b.close();
