// Nightly: log the site's own trade suggestions and buy-low / sell-high calls so grade.mjs can grade them a month later.
// Opens index.html in headless Chrome (playwright-core, the runner's own Chrome), lets it sync with Sleeper, then for every
// team in both leagues reads getOffers() (the same trade ideas that team sees) and buySell(). Appends to data/idea-log.json:
// one row per idea, at most once a week for the same team and idea.
// Locally (no Sleeper) run with ALLOW_OFFLINE=1 to test against the embedded snapshot; nothing is written then unless WRITE=1.
import fs from "node:fs";import http from "node:http";import path from "node:path";import {createRequire} from "node:module";
const req=createRequire(import.meta.url);let pw;try{pw=req("playwright-core")}catch(e){pw=req("playwright")}
const chromium=pw.chromium;
const ROOT=process.cwd(),PORT=8799,MIME={".html":"text/html",".json":"application/json",".js":"text/javascript",".css":"text/css"};
const srv=http.createServer((q,r)=>{const f=path.join(ROOT,decodeURIComponent(q.url.split("?")[0]));if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);return r.end()}
 r.writeHead(200,{"content-type":MIME[path.extname(f)]||"application/octet-stream"});fs.createReadStream(f).pipe(r)}).listen(PORT);
const exe=process.env.CHROME_PATH||["/usr/bin/google-chrome","/usr/bin/chromium","/opt/pw-browsers/chromium"].find(p=>fs.existsSync(p));
const browser=await chromium.launch(exe&&!process.env.ALLOW_OFFLINE?{executablePath:exe,args:["--no-sandbox"]}:{});
const page=await browser.newPage();page.on("pageerror",e=>console.log("page error",e.message));
await page.goto(`http://localhost:${PORT}/index.html`);
let st="";for(let i=0;i<120;i++){st=await page.evaluate(()=>typeof ST!=="undefined"?ST.k:"");if(st==="ok"||st==="err")break;await new Promise(r=>setTimeout(r,1000))}
console.log("sync",st);
if(st!=="ok"&&!process.env.ALLOW_OFFLINE){console.log("Sleeper sync did not finish; nothing recorded");await browser.close();srv.close();process.exit(0)}
await new Promise(r=>setTimeout(r,8000));// market trades, history and injuries load after sync
const rows=await page.evaluate(()=>{const out=[],d=new Date().toISOString().slice(0,10);
 const sidOf=id=>{try{sidOfPid(id);return(SIDREV[id]||[])[0]||null}catch(e){return null}};
 const keyOf=id=>{const p=byId(id);if(!p)return null;if(p.pos!=="PICK")return pkey(p.name);const m=/^pk_\w_(\d)_\d+(?:_(\d\d))?$/.exec(id);if(!m)return null;const y=m[2]?2000+ +m[2]:SEAS()+1;return pkey(y+" "+["","1st","2nd","3rd","4th"][+m[1]])};
 const pack=ids=>ids.map(id=>({id,k:keyOf(id),s:sidOf(id),n:pname(id)}));
 for(const lg of ["A","B"]){S.trade.league=lg;for(const t of (ROST[lg]||[])){S.viewAs=Object.assign({},S.viewAs,{[lg]:t.n});applyMe();const {L,R,me}=C();if(!me)continue;
  let offers=[];try{offers=getOffers(L,me,R,false)||[]}catch(e){}
  const eng=rbOffers(L,me,R)?"rebuild":"buy";
  offers.forEach(o=>out.push({d,lg,team:t.n,kind:"offer",eng,lab:o.lab,partner:o.t.n,give:pack(o.c),get:pack(gets(o))}));
  let B={buy:[],sell:[]};try{B=buySell(L,R,me)}catch(e){}
  B.buy.slice(0,5).forEach(r=>out.push({d,lg,team:t.n,kind:"buylow",partner:r.own,get:pack([r.p.id]),give:[],mr:r.mr,er:r.er}));
  B.sell.slice(0,5).forEach(r=>out.push({d,lg,team:t.n,kind:"sellhigh",give:pack([r.p.id]),get:[],mr:r.mr,er:r.er}))}}
 return out});
await browser.close();srv.close();
console.log("ideas found",rows.length,"offers",rows.filter(r=>r.kind==="offer").length);
if(process.env.ALLOW_OFFLINE&&!process.env.WRITE){console.log(JSON.stringify(rows.slice(0,3),null,1));process.exit(0)}
const F="data/idea-log.json";let log={rows:[]};try{log=JSON.parse(fs.readFileSync(F,"utf8"))}catch(e){}
const sig=r=>[r.lg,r.team,r.kind,(r.give||[]).map(x=>x.id).sort().join("+"),(r.get||[]).map(x=>x.id).sort().join("+")].join("|");
const recent=new Map();log.rows.forEach(r=>{const s=sig(r);if(!recent.has(s)||recent.get(s)<r.d)recent.set(s,r.d)});
const wk=new Date(Date.now()-6*864e5).toISOString().slice(0,10);let added=0;
for(const r of rows){const s=sig(r);if(recent.has(s)&&recent.get(s)>=wk)continue;log.rows.push(r);recent.set(s,r.d);added++}
log.rows=log.rows.slice(-6000);fs.writeFileSync(F,JSON.stringify(log));console.log("logged",added,"new ideas; total",log.rows.length);
