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
//  IT ALSO RUNS buildClassroomQuestions ITSELF, which is not the same
//  thing as running every build(). That function does work of its own on
//  each question AFTER the template returns — deciding whether printing a
//  chart's values would answer it, rewriting an unreadable chart kind —
//  and that work is OUTSIDE the per-template try/catch. A chart missing a
//  field it reads does not lose its question, it takes the whole lesson
//  down. Exactly that shipped: the new scatter and box charts had no
//  `series`, every build() passed, and a 6-8 lesson threw before it drew
//  anything.
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
// The music questions refuse to build without a recording, so the sound
// catalogue has to be in the sandbox or six templates would report as
// "never built" and look broken.
vm.runInContext(read('docs/js/community-bird-sounds.js'),ctx);
vm.runInContext(read('docs/js/classroom-standards.js'),ctx);
vm.runInContext(read('docs/js/community-classroom.js'),ctx);

// ── Synthetic feeders: several DIFFERENT fortnights ─────────────────
//
// Three weeks, not one. A single synthetic week cannot distinguish "the
// guard is working" from "the guard is broken": order-the-days needs an
// unambiguous busiest day, and the first two data sets this harness used
// both happened to tie at the top, so it reported zero builds and looked
// exactly like a bug in the template. A template is only a problem if it
// builds in NONE of them.
const SP=['Northern Cardinal','Blue Jay','Carolina Chickadee','Tufted Titmouse',
          'House Finch','Mourning Dove'];
const mk=(id,name,rs,home)=>vm.runInContext('cmSummarize',ctx)(id,name,rs,home);

function makeRows(seed){
  const rows=[]; let id=0; const now=Date.now();
  for(let d=13; d>=0; d--){
    const day=new Date(now - d*86400000);
    // Deterministic per seed, and deliberately uneven: real daily counts
    // are not a formula and templates that need a clear maximum, a mode or
    // a spread must meet data that has one.
    const n = 3 + ((d*d*7 + d*13 + seed*29) % 31);
    for(let i=0;i<n;i++){
      const tm=new Date(day); tm.setHours(6+(i*3)%12, (i*13)%60, 0, 0);
      rows.push({id:'det'+seed+'-'+(++id), feeder_id:'f1',
        species:SP[(d+i+seed)%SP.length],
        // 0-100, which is what the detector actually reports. This fixture
        // used to say 0.7-0.9 on a 0-1 scale, which matched the `>= 0.65`
        // thresholds that had been broken since they were written and so
        // reported them working. Test data that agrees with the bug is worse
        // than no test data.
        //
        // The spread is wide WITHIN a species, because that is what real
        // data does: 177 Northern Cardinals at one feeder ran from 38% to
        // 97%, since the camera's confidence is mostly about how clear the
        // photograph was rather than which bird it is. A fixture whose
        // species each sat in a tidy 20-point band hid that entirely.
        confidence: 36 + ((i*17 + d*11)%55) + ((d+i+seed)%SP.length),
        detected_at:tm.toISOString(),
        image_url:'https://example.invalid/s'+id+'.jpg',
        video_url: i%9===0 ? 'https://example.invalid/v'+id+'.mp4' : null,
        temperature: 34 + ((d*5 + seed*7)%26),
        // Overwhelmingly Common with the odd unusual one, as a real
        // fortnight is, and capitalised the way production sends it.
        rarity: (d*31 + i*7) % 37 === 0 ? 'Uncommon'
              : (d*31 + i*7) % 97 === 0 ? 'Rare' : 'Common',
        latitude: 39.3 + d*0.001, longitude: -76.6 - d*0.001, zip_code:'21210'});
    }
  }
  return rows;
}

const WORLDS = [0,1,2].map(seed => {
  const rows = makeRows(seed);
  const s14  = mk('f1','our feeder',rows,true);
  const half = rows.filter((_,i)=>i%2===0).map(r=>({...r,feeder_id:'f2'}));
  const pool = Object.assign(mk(null,'the school feeders',rows.concat(half),false),
    {isPool:true, feeders:[mk('f1','Courtyard',rows,false), mk('f2','Library',half,false)]});
  return { seed, s14, pool };
});
const s14 = WORLDS[0].s14, pool = WORLDS[0].pool;

const cmWindow=vm.runInContext('cmWindow',ctx);
const cmRng=vm.runInContext('cmRng',ctx);
const T=vm.runInContext('CLASSROOM_TEMPLATES',ctx);
const ALIGN=(()=>{vm.runInContext(read('docs/js/classroom-alignment.js'),ctx);
  return vm.runInContext('CLASSROOM_TEMPLATE_STANDARDS',ctx);})();

const only=process.argv.slice(2).find(a=>!a.startsWith('--'))||null;
let built=0, nulled=0, threw=0; const kinds=new Set();
const chartHtml=vm.runInContext('classroomChartHtml',ctx);
const evidenceHtml=vm.runInContext('classroomEvidenceHtml',ctx);
const problems=[], nulls=[];
const neverBuilt=[];
for(const t of T){
  if(only && !only.split(',').includes(t.id)) continue;
  let anyBuilt=false;
  for(const band of t.bands){
    const pairs=[];
    WORLDS.forEach(w=>{ pairs.push(['single:'+w.seed,w.s14],['pool:'+w.seed,w.pool]); });
    for(const [label,src] of pairs){
      const s=cmWindow(src,7);
      if(src.isPool){ s.isPool=true; s.feeders=src.feeders.map(f=>cmWindow(f,7)); }
      try{
        const q=t.build({s, s14:src, band, rng:cmRng(t.id+band+label),
                         feeder:src.name, source:src,
                         room:{id:'r1', grade_band:band, name:'Room A'}});
        if(q && q.prompt){
          built++; anyBuilt=true;
          // Render the chart both ways. A chart that builds and then throws
          // in its renderer is a blank slide on a projector.
          if(q.chart){
            for(const rev of [false,true]){
              const html=chartHtml(q.chart,rev);
              if(typeof html!=='string'||!html.length) throw new Error('chart '+q.chart.kind+' rendered empty');
              kinds.add(q.chart.kind);
            }
            // ⚠ AND THE CHART HAS TO REACH THE SLIDE. classroomEvidenceHtml
            // returns ONE thing from a priority chain, so a question carrying
            // a photo as well as a chart used to draw the photo and drop the
            // chart entirely. Rendering the chart alone cannot see that: it
            // renders perfectly, into a slide that never asks for it. Three
            // questions shipped unanswerable that way - picto-read told a
            // class to "use the key" over a photograph of a bird - and a
            // teacher caught one in a lesson. Build the evidence a class
            // actually sees, and check the chart is in it.
            for(const rev of [false,true]){
              const ev=evidenceHtml(q,rev);
              if(typeof ev!=='string'||ev.indexOf('classroom-chart')<0){
                throw new Error('chart '+q.chart.kind+' never reaches the slide'
                  +(rev?' (revealed)':'')+' - outranked in classroomEvidenceHtml');
              }
            }
          }
        } else { nulled++; nulls.push(`${t.id}/${band}/${label}`); }
      }catch(e){ threw++; problems.push(`${t.id}/${band}/${label}: ${e.message}`); }
    }
  }
  if(!anyBuilt) neverBuilt.push(t.id);
}
// ── The whole pipeline, per band, which is where the last bug lived ──
const buildAll = vm.runInContext('buildClassroomQuestions', ctx);
let lessons = 0;
for (const band of ['k-2', '3-5', '6-8']) {
  for (const [label, src] of [['single', s14], ['pool', pool]]) {
    const data = { home: src, partners: [], all: [src], each: src.feeders || [src],
                   pooled: src.isPool ? src : null, scope: src.isPool ? 'community' : 'home' };
    try {
      const res = buildAll({ id: 'r1', grade_band: band, name: 'Room A' }, data, { all: true });
      if (!res || !Array.isArray(res.questions)) throw new Error('no questions array');
      lessons++;
    } catch (e) {
      threw++; problems.push(`buildClassroomQuestions/${band}/${label}: ${e.message}`);
    }
  }
}

console.log(`built ${built}  returned-null ${nulled}  THREW ${threw}`);
// Reported, NOT failed. A template that builds in none of these may be
// perfectly correct and simply need a condition the synthetic data has
// not got — percent-of-days wants a species that misses some days, and
// here every species appears every day. This list is a prompt to check,
// not a verdict. Only a throw fails the run.
if(neverBuilt.length){
  console.log(`
Built in none of the ${WORLDS.length} synthetic fortnights — worth a`);
  console.log(`look, though tidy test data explains most of them:`);
  neverBuilt.forEach(id=>console.log('  '+id));
}
console.log(`full lessons assembled: ${lessons} of 6`);
console.log('chart kinds rendered: '+[...kinds].sort().join(', '));
if(problems.length){ console.log('\nERRORS:'); problems.forEach(p=>console.log('  '+p)); }
if(process.argv.includes('--nulls')&&nulls.length){ console.log('\nnull:'); nulls.forEach(n=>console.log('  '+n)); }
process.exitCode = threw ? 1 : 0;
