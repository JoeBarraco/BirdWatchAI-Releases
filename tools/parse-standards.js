const fs=require('fs'),path=require('path');
const dir=process.argv[2]+'/std';
const out=[];
for(const f of fs.readdirSync(dir).filter(x=>x.endsWith('.html'))){
  const subj=f.replace('.html','');
  const h=fs.readFileSync(path.join(dir,f),'utf8');
  const re=/PreviewSliderDetail\('StandardDetail',\s*'(\d+)'[\s\S]*?<h5 class="card-title mb-0"[^>]*>\s*([^<]+?)\s*<\/h5>[\s\S]*?<p class="card-text trim-text"[^>]*>\s*([\s\S]*?)\s*<\/p>/g;
  let m,n=0;
  while((m=re.exec(h))){
    const text=m[3].replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
    out.push({subj,id:m[1],code:m[2].trim(),text});n++;
  }
  console.error(subj,n);
}
const seen=new Set(),uniq=out.filter(r=>!seen.has(r.code)&&seen.add(r.code));
if(!uniq.length) throw new Error('parsed 0 standards — the CPALMS card markup changed');
fs.writeFileSync(process.argv[2]+'/standards.json',JSON.stringify(uniq,null,0));
console.error('total unique',uniq.length);
