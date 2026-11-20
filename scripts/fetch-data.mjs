// Nightly data job for Dynasty Desk. Runs on GitHub Actions and writes data/values.json (market sources) and
// data/history.json (daily expert values). Parsing code is copied from index.html so both stay identical.
import fs from "node:fs";
const pr=(...a)=>console.log(...a);
const pkey=n=>n.toLowerCase().replace(/['.]/g,"").replace(/[^a-z0-9 ]/g," ").replace(/\b(jr|sr|ii|iii|iv)\b/g,"").replace(/\s+/g," ").trim();
const pickKey=n=>{const m=/^(\d{4}) (Early|Mid|Late) (\d)(st|nd|rd|th)/.exec(n);return m?m[1]+" "+m[3]+m[4]+" ("+m[2]+")":n};
function csvRows(t){const rows=[];let r=[],c="",q=false;for(let i=0;i<t.length;i++){const ch=t[i];if(q){if(ch==='"'){if(t[i+1]==='"'){c+='"';i++}else q=false}else c+=ch}else if(ch==='"')q=true;else if(ch===","){r.push(c);c=""}else if(ch==="\n"){r.push(c);rows.push(r);r=[];c=""}else if(ch!=="\r")c+=ch}if(c||r.length){r.push(c);rows.push(r)}return rows}
const near=(v,a)=>a.reduce((b,x)=>Math.abs(x-v)<Math.abs(b-v)?x:b,a[0]);
const KTCU="https://keeptradecut.com/dynasty-rankings?format=2";
function parseKTC(t){t=String(t||"").trim();let arr=null;
 try{const tg=/<script[^>]*id=["']ktc-players["'][^>]*>([\s\S]*?)<\/script>/.exec(t);if(t[0]==="["){arr=JSON.parse(t)}else if(tg){arr=JSON.parse(tg[1])}else{const i=t.indexOf("playersArray");if(i<0)return null;const a=t.indexOf("[",i);if(a<0)return null;let d=0,q=false,e=-1;
  for(let j=a;j<t.length;j++){const c=t[j];if(q){if(c==="\\")j++;else if(c==='"')q=false}else if(c==='"')q=true;else if(c==="[")d++;else if(c==="]"){d--;if(d===0){e=j;break}}}
  if(e<0)return null;arr=JSON.parse(t.slice(a,e+1))}}catch(x){return null}
 if(!Array.isArray(arr))return null;const raw=[];let mx=0;
 arr.forEach(x=>{const n=x.playerName||x.name,pos=x.position||x.pos,sf=x.superflexValues,v=sf&&sf.value!=null?sf.value:(x.superflex!=null?x.superflex:x.value);if(!n||!(+v>0))return;raw.push([n,pos,+v]);mx=Math.max(mx,+v)});
 if(raw.length<50)return null;const m={};
 raw.forEach(([n,pos,v])=>{let nm=n,ps=pos;if(pos==="RDP"||/^\d{4} /.test(n)){if(!/^202[7-9]/.test(n))return;nm=pickKey(n);ps="PICK"}m[pkey(nm)]={n:nm,pos:ps,v:Math.round(v/mx*10000)}});return m}

const LEAGUES={A:"1314551881690787840",B:"1376273128933593088"};
const get=async(u,t=30000)=>{const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),t);try{const r=await fetch(u,{signal:ac.signal,headers:{"user-agent":"dynasty-desk-data-job"}});if(!r.ok)throw new Error("HTTP "+r.status);return r}finally{clearTimeout(tm)}};
let old={};try{old=JSON.parse(fs.readFileSync("data/values.json","utf8"))}catch(e){}
const out={t:Date.now(),dp:old.dp||{},fc:old.fc||{A:{},B:{}},kt:old.kt||{},ok:{}};
// DynastyProcess (experts)
try{const t=await(await get("https://raw.githubusercontent.com/dynastyprocess/data/master/files/values.csv")).text();
 const R=csvRows(t),H=R[0],ix=n=>H.indexOf(n),L=[];let mx=0;
 R.slice(1).forEach(r=>{if(r.length<H.length)return;const v=+r[ix("value_2qb")];if(!(v>1))return;let n=r[ix("player")];const pos=r[ix("pos")];if(pos==="PICK"){if(!/^202[7-9]/.test(n))return;n=pickKey(n)}L.push({n,pos,age:+r[ix("age")]||0,tm:r[ix("team")]||"",v});mx=Math.max(mx,v)});
 const dp={};L.forEach(x=>{dp[pkey(x.n)]={n:x.n,pos:x.pos,age:x.age,tm:x.tm,v:Math.round(x.v/mx*10000)}});
 if(L.length>50){out.dp=dp;out.dpDate=String((R[1]||[])[ix("scrape_date")]||"");out.ok.dp=true}}catch(e){pr("DP failed",e.message)}
// FantasyCalc (market), settings from Sleeper
out.fc=out.fc||{A:{},B:{}};
for(const lg of["A","B"]){try{let ppr=lg==="A"?0.5:1,teams=12,qbs=2,tep="none";
 try{const li=await(await get("https://api.sleeper.app/v1/league/"+LEAGUES[lg])).json(),sc=li.scoring_settings||{};if(sc.rec!=null)ppr=near(+sc.rec,[0,.5,1]);teams=near(li.total_rosters||12,[8,10,12,14]);qbs=(li.roster_positions||[]).includes("SUPER_FLEX")?2:1;const te=sc.bonus_rec_te||0;tep=te>=1?"te++":te>=.5?"te+":"none"}catch(e){}
 const a=await(await get("https://api.fantasycalc.com/values/current?isDynasty=true&numQbs="+qbs+"&numTeams="+teams+"&ppr="+ppr+(tep!=="none"?"&tep="+tep:""))).json();let mx=0;a.forEach(x=>{mx=Math.max(mx,x.value)});
 const m={};a.forEach(x=>{const pl=x.player;m[pkey(pl.name)]={n:pl.name,pos:pl.position,age:pl.maybeAge||0,v:Math.round(x.value/mx*10000),sid:pl.position==="PICK"?null:pl.sleeperId,tr:x.trend30Day||0}});
 if(a.length>50){out.fc[lg]=m;out.ok["fc"+lg]=true}}catch(e){pr("FC "+lg+" failed",e.message)}}
// KeepTradeCut (crowd)
try{const km=parseKTC(await(await get(KTCU,45000)).text());if(km&&Object.keys(km).length>50){out.kt=km;out.ok.kt=true}}catch(e){pr("KTC failed",e.message)}
fs.mkdirSync("data",{recursive:true});fs.writeFileSync("data/values.json",JSON.stringify(out));
// history: one row per day with expert values for the top 400 players
if(out.ok.dp){let h={rows:[]};try{h=JSON.parse(fs.readFileSync("data/history.json","utf8"))}catch(e){}
 const d=new Date().toISOString().slice(0,10),top=Object.entries(out.dp).sort((a,b)=>b[1].v-a[1].v).slice(0,400),row={d,v:Object.fromEntries(top.map(([k,x])=>[k,x.v]))};
 h.rows=(h.rows||[]).filter(r=>r.d!==d).concat(row).slice(-90);fs.writeFileSync("data/history.json",JSON.stringify(h))}
pr("done",JSON.stringify(out.ok),"dp",Object.keys(out.dp).length,"kt",Object.keys(out.kt).length);
