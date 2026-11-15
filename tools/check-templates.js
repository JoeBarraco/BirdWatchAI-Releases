#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  Build every question template against synthetic feeder data
// ════════════════════════════════════════════════════════════════════
//
//  Usage:  node tools/check-templates.js [id,id,...] [--nulls]
//
//  128 templates times three grade bands times two data sources is 500-odd
//  build() calls, and clicking through a lesson exercises about eight of
//  them. A template that throws is swallowed by buildClassroomQuestions
//  and sits the week out looking exactly like "not enough data" — the
//  comment there says so — which is how a broken question disappears for
//  months without anybody noticing.
//
//  This runs the real file in a vm with a stubbed DOM, builds every
//  template, and RENDERS every chart it produces both before and after the
//  reveal. A chart that builds and then throws in its renderer is a blank
//  slide on a projector, and the build alone would not catch it.
//
//  Returning null is fine and expected — it is how a template says this
//  week's data cannot carry it. Throwing is not. Only throwing fails the
//  run; --nulls lists the rest if you want to see which guards fired.
//
//  THE DATA IS SYNTHETIC AND TIDY, which means a template that builds here
//  can still return null on a real quiet feeder. This checks that the code
//  runs, not that a lesson is full.
// ════════════════════════════════════════════════════════════════════
const fs=require('fs'), vm=require('vm'), path=require('path');
const R=require('path').join(__dirname,'..');
const read=p=>fs.readFileSync(path.join(R,p),'utf8');

const noop=()=>{};
const el=()=>new Proxy({style:{},classList:{add:noop,remove:noop,contains:()=>false},
  dataset:{},children:[],appendChild:noop,setAttribute:noop,removeAttribute:noop,
  addEventListener:noop,querySelector:()=>null,querySelectorAll:()=>[],
  getBoundingClientRect:()=>({width:0,height:0,top:0,left:0}),innerHTML:'',textContent:'',value:''},
  {get:(t,k)=> k in t ? t[k] : undefined, set:(t,k,v)=>{t[k]=v;return true;}});

const ctx={
  console, Math, Date, JSON, Map, Set, Array, Object, String, Number, Boolean,
  isFinite, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  setTimeout:noop, clearTimeout:noop, setInterval:noop, clearInterval:noop,
  requestAnimationFrame:noop, fetch:async()=>({ok:false,json:async()=>[]}),
  localStorage:{getItem:()=>null,setItem:noop,removeItem:noop},
  location:{href:'',search:'',hash:''},
  navigator:{userAgent:'node'},
  SUPABASE_URL:'https://example.invalid', sbHeaders:()=>({}), sbRpc:async()=>({data:null,error:null}),
  hasAuthSession:()=>false, fetchAllRows:async()=>[], signPrivateMedia:async()=>{},
  isPrivateMedia:()=>false, myCommunities:[], esc:s=>String(s==null?'':s),
  escJs:s=>String(s==null?'':s), escAttr:s=>String(s==null?'':s),
};
ctx.addEventListener=noop; ctx.removeEventListener=noop; ctx.matchMedia=()=>({matches:false,addEventListener:noop,addListener:noop});
ctx.window=ctx; ctx.globalThis=ctx; ctx.self=ctx;
ctx.document=new Proxy({createElement:el,getElementById:()=>null,querySelector:()=>null,
  querySelectorAll:()=>[],addEventListener:noop,removeEventListener:noop,
  body:el(), documentElement:el(), head:el()},{get:(t,k)=> k in t?t[k]:noop});
vm.createContext(ctx);

try { vm.runInContext(read('docs/js/community-us-map.js'),ctx); } catch(e){}
vm.runInContext(read('docs/js/classroom-standards.js'),ctx);
vm.runInContext(read('docs/js/community-classroom.js'),ctx);

// ── Synthetic feeder: 14 days, 6 species, photos, clips, temps, GPS ──
const SP=['Northern Cardinal','Blue Jay','Carolina Chickadee','Tufted Titmouse',
          'House Finch','Mourning Dove'];
const rows=[]; let id=0;
const now=Date.now();
for(let d=13; d>=0; d--){
  const day=new Date(now - d*86400000);
  const n = 6 + ((d*7)%14);                      // varied daily counts
  for(let i=0;i<n;i++){
    const t=new Date(day); t.setHours(6+(i*3)%12, (i*13)%60, 0, 0);
    rows.push({id:'det'+(++id), feeder_id:'f1', species:SP[(d+i)%SP.length],
      confidence:0.7+((i%3)*0.1), detected_at:t.toISOString(),
      image_url:'https://example.invalid/s'+id+'.jpg',
      video_url: i%9===0 ? 'https://example.invalid/v'+id+'.mp4' : null,
      temperature: 38 + ((d*5)%22), rarity:'common',
      latitude: 39.3 + d*0.001, longitude: -76.6 - d*0.001, zip_code:'21210'});
  }
}
const mk=(id,name,rs,home)=>vm.runInContext('cmSummarize',ctx)(id,name,rs,home);
const s14=mk('f1','our feeder',rows,true);
const half=rows.filter((_,i)=>i%2===0).map(r=>({...r,feeder_id:'f2'}));
const pool=Object.assign(mk(null,'the school feeders',rows.concat(half),false),
  {isPool:true, feeders:[mk('f1','Courtyard',rows,false), mk('f2','Library',half,false)]});

const cmWindow=vm.runInContext('cmWindow',ctx);
const cmRng=vm.runInContext('cmRng',ctx);
const T=vm.runInContext('CLASSROOM_TEMPLATES',ctx);
const ALIGN=(()=>{vm.runInContext(read('docs/js/classroom-alignment.js'),ctx);
  return vm.runInContext('CLASSROOM_TEMPLATE_STANDARDS',ctx);})();

const only=process.argv.slice(2).find(a=>!a.startsWith('--'))||null;
let built=0, nulled=0, threw=0; const kinds=new Set();
const chartHtml=vm.runInContext('classroomChartHtml',ctx);
const problems=[], nulls=[];
for(const t of T){
  if(only && !only.split(',').includes(t.id)) continue;
  for(const band of t.bands){
    for(const [label,src] of [['single',s14],['pool',pool]]){
      const s=cmWindow(src,7);
      if(src.isPool){ s.isPool=true; s.feeders=src.feeders.map(f=>cmWindow(f,7)); }
      try{
        const q=t.build({s, s14:src, band, rng:cmRng(t.id+band+label),
                         feeder:src.name, source:src,
                         room:{id:'r1', grade_band:band, name:'Room A'}});
        if(q && q.prompt){
          built++;
          // Render the chart both ways. A chart that builds and then throws
          // in its renderer is a blank slide on a projector.
          if(q.chart){
            for(const rev of [false,true]){
              const html=chartHtml(q.chart,rev);
              if(typeof html!=='string'||!html.length) throw new Error('chart '+q.chart.kind+' rendered empty');
              kinds.add(q.chart.kind);
            }
          }
        } else { nulled++; nulls.push(`${t.id}/${band}/${label}`); }
      }catch(e){ threw++; problems.push(`${t.id}/${band}/${label}: ${e.message}`); }
    }
  }
}
console.log(`built ${built}  returned-null ${nulled}  THREW ${threw}`);
console.log('chart kinds rendered: '+[...kinds].sort().join(', '));
if(problems.length){ console.log('\nERRORS:'); problems.forEach(p=>console.log('  '+p)); }
if(process.argv.includes('--nulls')&&nulls.length){ console.log('\nnull:'); nulls.forEach(n=>console.log('  '+n)); }
process.exitCode = threw ? 1 : 0;
