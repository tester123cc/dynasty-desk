// Nightly grading job for Dynasty Desk: records the site's predictions before games, grades them after,
// and retrains the few numbers the Week tab uses. Runs on GitHub Actions after fetch-data.mjs.
//
// Writes:
//   data/predictions.json  what the site predicted each week, frozen once that week's games start
//                          (weeks before grading started are rebuilt from Sleeper's archived projections and marked bt, "backtest")
//   data/grades.json       how those predictions did, the tuned model, and any alerts for the owner
//   data/model.json        the tuned numbers the app reads (spread of scores, projection bias per position)
//   data/h2h.json          every matchup result in both leagues (and earlier seasons once the leagues renew)
//
// The prediction math is the same as the Week tab in index.html (ptsOf, best lineup, normal win chance).
import fs from "node:fs";
const pr=(...a)=>console.log(...a);
const LEAGUES={A:"1314551881690787840",B:"1376273128933593088"};
const SLOTS={A:{QB:1,RB:2,WR:3,TE:1,FLEX:1,SF:1},B:{QB:1,RB:2,WR:2,TE:1,FLEX:2,SF:1}};
const PRIOR={sdK:.4,sdC:1.5,bias:{QB:1,RB:1,WR:1,TE:1}};
const rd=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){return d}};
const wr=(f,o)=>fs.writeFileSync(f,JSON.stringify(o));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function get(u,tries=3){for(let i=0;i<tries;i++){try{const ac=new AbortController(),tm=setTimeout(()=>ac.abort(),45000);
  const r=await fetch(u,{signal:ac.signal,headers:{"user-agent":"dynasty-desk-grader"}});clearTimeout(tm);if(r.ok)return r.json();if(r.status===404)return null}catch(e){}await sleep(1500*(i+1))}throw new Error("failed "+u)}
const api=p=>get("https://api.sleeper.app/v1"+p);
const pkey=n=>n.toLowerCase().replace(/['.]/g,"").replace(/[^a-z0-9 ]/g," ").replace(/\b(jr|sr|ii|iii|iv)\b/g,"").replace(/\s+/g," ").trim();
const r1=x=>Math.round(x*10)/10,r3=x=>Math.round(x*1000)/1000;
const phi=z=>{const t=1/(1+.2316419*Math.abs(z)),d=.3989423*Math.exp(-z*z/2),p=d*t*(.3193815+t*(-.3565638+t*(1.781478+t*(-1.821256+t*1.330274))));return z>0?1-p:p};
const gradeLetter=n=>n>=.30?"A+":n>=.18?"A":n>=.08?"A−":n>=-.08?"B":n>=-.18?"C":n>=-.30?"D":"F";

// ---------- shared prediction math ----------
function ptsOf(st,sc,half){const ref=half?st.pts_half_ppr:st.pts_ppr;
 if(sc){let t=0,hit=0;for(const k in st){if(sc[k]!=null&&!/^pts_/.test(k)){t+=sc[k]*st[k];hit++}}if(hit&&!(ref!=null&&(t<-5||t>2*ref+8)))return t}
 return ref!=null?ref:st.pts_ppr||0}
function bestLineup(cands,sl){const ps=cands.slice().sort((a,b)=>b.v-a.v),used=new Set(),out=[];
 const take=el=>{const x=ps.find(y=>!used.has(y.id)&&el.includes(y.pos));if(x){used.add(x.id);out.push(x)}};
 ["QB","RB","WR","TE"].forEach(pos=>{for(let i=0;i<sl[pos];i++)take([pos])});
 for(let i=0;i<sl.FLEX;i++)take(["RB","WR","TE"]);for(let i=0;i<(sl.SF||0);i++)take(["QB","RB","WR","TE"]);return{out,used}}
const sdOf=(v,m)=>m.sdK*Math.max(0,v)+m.sdC;
function winP(xa,xb,m){const ta=xa.reduce((s,v)=>s+v,0),tb=xb.reduce((s,v)=>s+v,0),va=xa.concat(xb).reduce((s,v)=>s+sdOf(v,m)**2,0);return phi((ta-tb)/Math.sqrt(va||1))}

// one week's predictions for a league, from the projections feed and that week's matchups (rosters and set lineups)
function predictWeek(lg,proj,ents,sc,POS,m){const half=lg==="A",sl=SLOTS[lg],pp=id=>{const x=proj[id],pos=POS[id];if(!x||!pos)return 0;return ptsOf(x,sc,half)*((m.bias||{})[pos]||1)};
 const team={};
 ents.forEach(e=>{const cands=(e.players||[]).filter(id=>POS[id]).map(id=>({id,pos:POS[id],v:pp(id)}));const B=bestLineup(cands,sl);
  const set=(e.starters||[]).filter(id=>id&&id!=="0");const setx=set.map(pp);
  team[e.roster_id]={mid:e.matchup_id,set,setx,best:B.out.map(x=>x.id),bestx:B.out.map(x=>x.v),cands}});
 const games=[],seen=new Set();
 for(const r in team){const t=team[r];if(t.mid==null||seen.has(t.mid))continue;const o=Object.keys(team).find(k=>k!==r&&team[k].mid===t.mid);if(!o)continue;seen.add(t.mid);
  const xa=(t.setx.length?t.setx:t.bestx).map(r1),xb=(team[o].setx.length?team[o].setx:team[o].bestx).map(r1);
  games.push({a:+r,b:+o,xa,xb,p:r3(winP(xa,xb,m))})}
 const calls=[];
 for(const r in team){const t=team[r];if(!t.set.length)continue;const st=new Set(t.set),bs=new Set(t.best),ins=t.best.filter(id=>!st.has(id)),outs=t.set.filter(id=>!bs.has(id));
  const left=outs.slice();ins.forEach(id=>{let j=left.findIndex(o=>POS[o]===POS[id]);if(j<0)j=0;const o=left.splice(j,1)[0];if(!o)return;const ps=pp(id),pb=pp(o);if(ps-pb<.5)return;calls.push({r:+r,s:id,b:o,ps:r1(ps),pb:r1(pb)})})}
 // raw projections (no bias) for everyone rostered with a real projection, used to train the bias
 const raw={};ents.forEach(e=>(e.players||[]).forEach(id=>{const x=proj[id];if(x&&POS[id]){const v=ptsOf(x,sc,half);if(v>=3)raw[id]=r1(v)}}));
 return{games,calls,raw}}

// ---------- data ----------
const state=await api("/state/nfl");const SEASON=+state.season,CUR=+(state.display_week||state.week)||0;
pr("state",SEASON,"week",CUR,state.season_type);
const players=await api("/players/nfl");const POS={},NAME={};
for(const id in players){const p=players[id];if(["QB","RB","WR","TE"].includes(p.position)){POS[id]=p.position;NAME[id]=p.full_name||((p.first_name||"")+" "+(p.last_name||"")).trim()}}
const PC={};async function projFor(y,w){const k=y+"|"+w;if(PC[k])return PC[k];
 const r=await get("https://api.sleeper.app/projections/nfl/"+y+"/"+w+"?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE").catch(()=>null),P={};
 (Array.isArray(r)?r:Object.entries(r||{}).map(([k,v])=>({player_id:k,stats:v}))).forEach(x=>{if(x&&x.player_id&&x.stats&&x.stats.pts_ppr!=null)P[x.player_id]=x.stats});return PC[k]=P}

const PRED=rd("data/predictions.json",{v:1,weeks:{}});
const MODEL0=Object.assign({},PRIOR,rd("data/model.json",{}));
const H2H={};const results={};const ROSW={};// ROSW[lg][week][roster] = that week's roster (Sleeper ids)// results[lg][y][w] = matchups (final)
const tradeLog={};

for(const lg of ["A","B"]){
 // walk this league and its earlier seasons
 let id=LEAGUES[lg],hops=0;H2H[lg]={seasons:[]};results[lg]={};tradeLog[lg]=[];
 while(id&&id!=="0"&&hops<5){const li=await api("/league/"+id);if(!li)break;const y=+li.season,sc=li.scoring_settings||null,pws=(li.settings&&li.settings.playoff_week_start)||15;
  const last=y===SEASON?Math.min(CUR,17):17,weeks={};results[lg][y]={};
  for(let w=1;w<=last;w++){const ms=await api("/league/"+id+"/matchups/"+w).catch(()=>null);if(!ms||!ms.length)continue;
   if(y===SEASON){(ROSW[lg]=ROSW[lg]||{})[w]=Object.fromEntries(ms.map(e=>[e.roster_id,e.players||[]]))}
   const done=y<SEASON||w<CUR,started=ms.some(e=>(e.points||0)>0);
   if(done&&started){results[lg][y][w]=ms;const g={};ms.forEach(e=>{if(e.matchup_id!=null)(g[e.matchup_id]=g[e.matchup_id]||[]).push(e)});
    weeks[w]=Object.values(g).filter(x=>x.length===2).map(([a,b])=>[a.roster_id,r1(a.points||0),b.roster_id,r1(b.points||0)]);weeks[w].po=w>=pws?1:0}
   // predictions: only for the current season's regular season and playoffs
   if(y!==SEASON)continue;const key=lg+"|"+y+"|"+w,have=PRED.weeks[key];
   if(w===CUR&&!started&&!(have&&have.frozen)){// live prediction for this week, refreshed each run until games start
    const P=await projFor(y,w);if(Object.keys(P).length<50)continue;const pw=predictWeek(lg,P,ms,sc,POS,MODEL0);
    PRED.weeks[key]={lg,y,w,made:Date.now(),bt:0,model:{sdK:MODEL0.sdK,sdC:MODEL0.sdC,bias:MODEL0.bias},...pw};pr("predicted",key,pw.games.length,"games",pw.calls.length,"calls")}
   else if(have&&!have.bt&&started&&!have.frozen){have.frozen=1}
   else if(!have&&done&&started){// backtest: rebuild the pre-game view from Sleeper's archived projections with the untrained model
    const P=await projFor(y,w);if(Object.keys(P).length<50)continue;const pw=predictWeek(lg,P,ms,sc,POS,PRIOR);
    PRED.weeks[key]={lg,y,w,made:Date.now(),bt:1,frozen:1,model:PRIOR,...pw};pr("backtest",key,pw.games.length)}}
  H2H[lg].seasons.push({y,league:id,pws,teams:{},weeks});
  try{const us=await api("/league/"+id+"/users"),ros=await api("/league/"+id+"/rosters"),um={};(us||[]).forEach(u=>{um[u.user_id]=(u.metadata&&u.metadata.team_name)||u.display_name});
   (ros||[]).forEach(r=>{H2H[lg].seasons.at(-1).teams[r.roster_id]=um[r.owner_id]||"Team "+r.roster_id})}catch(e){}
  // trades this season (for grading the site's trade grades)
  for(let w=1;w<=last;w++){const tx=await api("/league/"+id+"/transactions/"+w).catch(()=>[]);(tx||[]).filter(t=>t.type==="trade"&&t.status==="complete").forEach(t=>tradeLog[lg].push({y,w,t:t.status_updated||t.created,adds:t.adds||{},pk:t.draft_picks||[],r:t.roster_ids}))}
  id=li.previous_league_id;hops++}
 H2H[lg].seasons.sort((a,b)=>a.y-b.y)}

// ---------- grade ----------
const wk=[];const ssAll=[],gAll=[],projAll={QB:[],RB:[],WR:[],TE:[]};
for(const key of Object.keys(PRED.weeks).sort()){const p=PRED.weeks[key],ms=results[p.lg]&&results[p.lg][p.y]&&results[p.lg][p.y][p.w];if(!ms)continue;
 const pts={},tp={};ms.forEach(e=>{tp[e.roster_id]=e.points||0;Object.assign(pts,e.players_points||{})});
 const games=p.games.map(g=>{const sa=tp[g.a]||0,sb=tp[g.b]||0,out=sa>sb?1:sa<sb?0:.5;return{...g,sa:r1(sa),sb:r1(sb),out}});
 const calls=p.calls.filter(c=>pts[c.s]!=null&&pts[c.b]!=null).map(c=>({...c,as:r1(pts[c.s]),ab:r1(pts[c.b]),hit:pts[c.s]>pts[c.b]?1:pts[c.s]<pts[c.b]?0:.5}));
 const pos={};for(const id in p.raw){const ps=POS[id];if(!ps||pts[id]==null)continue;(pos[ps]=pos[ps]||{n:0,proj:0,act:0,ae:0});const z=pos[ps];z.n++;z.proj+=p.raw[id];z.act+=pts[id];z.ae+=Math.abs(pts[id]-p.raw[id]);projAll[ps].push([p.raw[id],pts[id],p.bt])}
 const brier=games.length?games.reduce((s,g)=>s+(g.p-g.out)**2,0)/games.length:null;
 games.forEach(g=>gAll.push({...g,bt:p.bt,lg:p.lg,w:p.w}));calls.forEach(c=>ssAll.push({...c,bt:p.bt,lg:p.lg,w:p.w}));
 wk.push({lg:p.lg,y:p.y,w:p.w,bt:p.bt,games,brier:brier==null?null:r3(brier),acc:games.length?r3(games.reduce((s,g)=>s+(g.p===.5?.5:(g.p>.5)===(g.out===1)?1:g.out===.5?.5:0),0)/games.length):null,
  calls:{n:calls.length,hit:calls.reduce((s,c)=>s+c.hit,0),net:r1(calls.reduce((s,c)=>s+c.as-c.ab,0)),list:calls.map(c=>({r:c.r,s:NAME[c.s]||c.s,b:NAME[c.b]||c.b,ps:c.ps,pb:c.pb,as:c.as,ab:c.ab,hit:c.hit}))},
  pos:Object.fromEntries(Object.entries(pos).map(([k,z])=>[k,{n:z.n,proj:r1(z.proj),act:r1(z.act),mae:r1(z.ae/z.n)}]))})}

// ---------- train ----------
// projection bias per position: actual / projected, shrunk toward 1 with 300 points of pseudo-data, capped at 0.8 to 1.2
const bias={},biasRaw={};for(const ps in projAll){const a=projAll[ps],sp=a.reduce((s,x)=>s+x[0],0),sa=a.reduce((s,x)=>s+x[1],0);biasRaw[ps]=sp?r3(sa/sp):null;bias[ps]=r3(Math.max(.8,Math.min(1.2,(sa+300)/(sp+300))))}
// spread of scores: the sdK that best explains who actually won (log-likelihood over every graded game), shrunk toward the prior
let sdK=PRIOR.sdK;if(gAll.length>=12){let best=null;for(let k=.15;k<=.9001;k+=.025){const m={sdK:k,sdC:PRIOR.sdC},ll=gAll.reduce((s,g)=>{const p=Math.min(.999,Math.max(.001,winP(g.xa,g.xb,m)));return s+(g.out===1?Math.log(p):g.out===0?Math.log(1-p):.5*Math.log(p*(1-p)))},0);if(!best||ll>best.ll)best={k,ll}}
 const wgt=gAll.length/(gAll.length+40);sdK=r3(wgt*best.k+(1-wgt)*PRIOR.sdK)}
const MODEL={t:Date.now(),n:gAll.length,nProj:Object.values(projAll).reduce((s,a)=>s+a.length,0),sdK,sdC:PRIOR.sdC,bias,biasRaw};

// ---------- summary ----------
const sum=a=>a.reduce((s,x)=>s+x,0),avg=a=>a.length?sum(a)/a.length:null;
const winSum=sub=>{const g=sub;if(!g.length)return{n:0};const cal=[[.5,.6],[.6,.7],[.7,.8],[.8,.9],[.9,1.01]].map(([lo,hi])=>{const x=g.map(q=>q.p>=.5?{p:q.p,o:q.out}:{p:1-q.p,o:1-q.out}).filter(q=>q.p>=lo&&q.p<hi);return{lo,hi:Math.min(hi,1),n:x.length,pred:x.length?r3(avg(x.map(q=>q.p))):null,act:x.length?r3(avg(x.map(q=>q.o))):null}});
 return{n:g.length,brier:r3(avg(g.map(q=>(q.p-q.out)**2))),acc:r3(avg(g.map(q=>q.p===.5?.5:(q.p>.5)===(q.out===1)?1:q.out===.5?.5:0))),cal}};
const ssSum=a=>({n:a.length,hit:a.length?r3(sum(a.map(c=>c.hit))/a.length):null,net:r1(sum(a.map(c=>c.as-c.ab)))});

// trade grades: what the site's values said at the time vs what happened since (values now, points scored since)
const H=(()=>{const m={};[rd("data/history-weekly.json",{rows:[]}),rd("data/history.json",{rows:[]})].forEach(h=>(h.rows||[]).forEach(r=>{m[r.d]=r}));return Object.values(m).sort((a,b)=>a.d<b.d?-1:1)})();
const valAt=(k,d)=>{let v=null;for(const r of H){if(r.d>d)break;if(r.v[k]!=null)v=r.v[k]}return v},valNow=k=>{for(let i=H.length-1;i>=0;i--)if(H[i].v[k]!=null)return H[i].v[k];return null};
const sfx={1:"1st",2:"2nd",3:"3rd",4:"4th"};
const trades=[];for(const lg of ["A","B"])for(const t of tradeLog[lg]){const d=new Date(t.t).toISOString().slice(0,10),sides={};t.r.forEach(r=>sides[r]={got:[],v0:0,v1:0,pts:0,unk:0});
 const add=(r,name,k,sid)=>{const s=sides[r];if(!s)return;const a=valAt(k,d),b=valNow(k);if(a==null||b==null){s.unk++;s.got.push(name);return}s.got.push(name);s.v0+=a;s.v1+=b;if(sid){for(const w in (results[lg][t.y]||{})){if(+w<=t.w)continue;const e=results[lg][t.y][w].find(x=>x.roster_id===r);if(e&&(e.starters||[]).includes(sid))s.pts+=(e.players_points||{})[sid]||0}}};
 for(const sid in t.adds)add(t.adds[sid],NAME[sid]||sid,pkey(NAME[sid]||""),sid);
 t.pk.forEach(p=>add(p.owner_id,p.season+" "+sfx[p.round]+" (pick)",pkey(p.season+" "+sfx[p.round]),null));
 const rs=Object.keys(sides).map(Number);if(rs.length!==2)continue;const [a,b]=rs,A=sides[a],B=sides[b];if(!A.v0&&!B.v0)continue;
 const d0=(A.v0-B.v0)/Math.max(A.v0,B.v0,1),d1=(A.v1-B.v1)/Math.max(A.v1,B.v1,1),age=Math.round((Date.now()-t.t)/864e5);
 const fav=Math.abs(d0)<.08?null:d0>0?a:b,now=Math.abs(d1)<.08?null:d1>0?a:b;
 trades.push({lg,y:t.y,w:t.w,d,age,a,b,ga:A.got,gb:B.got,grade:gradeLetter(d0),d0:r3(d0),d1:r3(d1),fav,now,ptsA:r1(A.pts),ptsB:r1(B.pts),unk:A.unk+B.unk,mature:age>=28,held:fav==null?null:fav===now?1:now==null?.5:0})}
const mt=trades.filter(t=>t.mature&&t.held!=null);

// ---------- the site's own trade ideas and buy-low / sell-high calls (data/idea-log.json from record-ideas.mjs) ----------
// After 28 days: an offer paid off if what you would have received gained value relative to what you would have sent (expert values),
// a buy-low call if the market moved up relative to the experts (the gap closed), a sell-high call if it moved down.
const mAt=(lg,k,d)=>{let v=null;for(const r of H){if(r.d>d)break;if(r.m&&r.m[lg]&&r.m[lg][k]!=null)v=r.m[lg][k]}return v};
const mNow=(lg,k)=>{for(let i=H.length-1;i>=0;i--){const r=H[i];if(r.m&&r.m[lg]&&r.m[lg][k]!=null)return r.m[lg][k]}return null};
const PTS={};for(const lg in results)for(const y in results[lg])for(const w in results[lg][y])results[lg][y][w].forEach(e=>{const P=e.players_points||{};for(const sid in P)((PTS[lg]=PTS[lg]||{})[sid]=PTS[lg][sid]||{})[y*100+ +w]=P[sid]});
const wkOf=d=>CUR-Math.round((Date.now()-Date.parse(d))/(7*864e5));
const ILOG=rd("data/idea-log.json",{rows:[]}).rows,ideas=[];
for(const r of ILOG){const age=Math.round((Date.now()-Date.parse(r.d))/864e5);if(age<28)continue;
 const sum=(xs,f)=>{let t=0,miss=0;for(const x of xs){const v=x.k?f(x.k):null;if(v==null)miss++;else t+=v}return{t,miss}};
 const pts=xs=>{let t=0;const w0=SEASON*100+wkOf(r.d);for(const x of xs){const P=x.s&&PTS[r.lg]&&PTS[r.lg][x.s];if(P)for(const k in P)if(+k>w0)t+=P[k]}return r1(t)};
 if(r.kind==="offer"){const g0=sum(r.give,k=>valAt(k,r.d)),g1=sum(r.give,valNow),t0=sum(r.get,k=>valAt(k,r.d)),t1=sum(r.get,valNow);
  if(g0.miss+t0.miss>(r.give.length+r.get.length)/2||!g0.t||!t0.t)continue;
  const rel=t1.t/t0.t-g1.t/g0.t;ideas.push({...r,age,rel:r3(rel),hit:Math.abs(rel)<.02?.5:rel>0?1:0,ptsGet:pts(r.get),ptsGive:pts(r.give)})}
 else{const x=(r.get[0]||r.give[0]);if(!x||!x.k)continue;const m0=mAt(r.lg,x.k,r.d),m1=mNow(r.lg,x.k),e0=valAt(x.k,r.d),e1=valNow(x.k);if(!m0||!m1||!e0||!e1)continue;
  const rel=m1/m0-e1/e0,sgn=r.kind==="buylow"?1:-1;ideas.push({...r,age,rel:r3(rel),hit:Math.abs(rel)<.02?.5:sgn*rel>0?1:0})}}
const isum=a=>({n:a.length,hit:a.length?r3(avg(a.map(x=>x.hit))):null,rel:a.length?r3(avg(a.map(x=>x.rel))):null});
const offs=ideas.filter(x=>x.kind==="offer"),grp=(a,f)=>{const o={};a.forEach(x=>{(o[f(x)]=o[f(x)]||[]).push(x)});return Object.fromEntries(Object.entries(o).map(([k,v])=>[k,isum(v)]))};
// learning: each engine and label's record, shrunk toward even with 20 ideas of pseudo-data; the app nudges its ranking by it
const byEL=grp(offs,x=>x.eng+"|"+x.lab),adjI=Object.fromEntries(Object.entries(byEL).map(([k,v])=>[k,r3((v.hit-.5)*v.n/(v.n+20))]));
const IDEAS={logged:ILOG.length,pending:ILOG.length-ideas.length,offers:isum(offs),byEng:grp(offs,x=>x.eng),byLab:grp(offs,x=>x.lab),buylow:isum(ideas.filter(x=>x.kind==="buylow")),sellhigh:isum(ideas.filter(x=>x.kind==="sellhigh")),adj:adjI,
 recent:ideas.sort((a,b)=>b.d<a.d?-1:1).slice(0,40).map(x=>({d:x.d,lg:x.lg,team:x.team,kind:x.kind,eng:x.eng,lab:x.lab,partner:x.partner,give:(x.give||[]).map(g=>g.n),get:(x.get||[]).map(g=>g.n),rel:x.rel,hit:x.hit,ptsGet:x.ptsGet,ptsGive:x.ptsGive}))};

// ---------- alerts: when the owner should come in and have the model looked at ----------
const alerts=[];const live=wk.filter(x=>!x.bt&&x.games.length),lw=[...new Set(live.map(x=>x.y*100+x.w))].sort((a,b)=>a-b).slice(-3);
const lastLive=lw.map(k=>live.filter(x=>x.y*100+x.w===k));
if(lastLive.length===3&&lastLive.every(ws=>avg(ws.map(x=>x.brier))>.25))alerts.push({lvl:"alert",area:"Win chances",msg:"Weekly win chances have been worse than a coin flip three weeks running.",fix:"Ask Claude to review the Week tab model (projection source, spread of scores, injuries)."});
const ga=winSum(gAll);if(ga.n>=36&&ga.brier>.245)alerts.push({lvl:"alert",area:"Win chances",msg:`Over ${ga.n} graded games the win chances score ${ga.brier} (a coin flip scores 0.25).`,fix:"Ask Claude to look at why projections are not separating winners from losers."});
const fav=gAll.filter(g=>Math.max(g.p,1-g.p)>=.7);if(fav.length>=15){const fw=avg(fav.map(g=>g.p>=.5?g.out:1-g.out));if(fw<.55)alerts.push({lvl:"alert",area:"Win chances",msg:`Teams given 70%+ won only ${Math.round(fw*100)}% of ${fav.length} games; the site is overconfident.`,fix:"Ask Claude to widen the spread of scores or check the projections."})}
const ssLive=lw.flatMap(k=>ssAll.filter(c=>!c.bt&&c.y*100+c.w===k));if(lw.length===3&&ssLive.length>=8&&avg(ssLive.map(c=>c.hit))<.45)alerts.push({lvl:"alert",area:"Start/sit",msg:`Start/sit calls were right only ${Math.round(avg(ssLive.map(c=>c.hit))*100)}% of the time over the last three weeks (${ssLive.length} calls).`,fix:"Ask Claude to check the start/sit logic and the projection source."});
for(const ps in biasRaw){const n=projAll[ps].length;if(n>=60&&biasRaw[ps]!=null&&(biasRaw[ps]<.8||biasRaw[ps]>1.2))alerts.push({lvl:"alert",area:"Projections",msg:`${ps} projections are off by ${Math.round(Math.abs(biasRaw[ps]-1)*100)}% (${biasRaw[ps]<1?"too high":"too low"}), beyond what the automatic correction is allowed to fix.`,fix:"Ask Claude to check how projections are scored for this league."})}
if(mt.length>=6&&avg(mt.map(t=>t.held))<.4)alerts.push({lvl:"alert",area:"Trade grades",msg:`Only ${Math.round(avg(mt.map(t=>t.held))*100)}% of graded trades still favor the side the site picked a month later (${mt.length} trades).`,fix:"Ask Claude to review the value blend and trade grading."});
if(IDEAS.offers.n>=20&&IDEAS.offers.hit<.4)alerts.push({lvl:"alert",area:"Trade ideas",msg:`Only ${Math.round(IDEAS.offers.hit*100)}% of the site's trade ideas paid off a month later (${IDEAS.offers.n} ideas).`,fix:"Ask Claude to review the trade suggestion engine."});
{const bs=[...ideas.filter(x=>x.kind!=="offer")];if(bs.length>=20&&avg(bs.map(x=>x.hit))<.4)alerts.push({lvl:"alert",area:"Buy low / sell high",msg:`Only ${Math.round(avg(bs.map(x=>x.hit))*100)}% of buy-low and sell-high calls went the right way (${bs.length} calls).`,fix:"Ask Claude to review the buy/sell finder thresholds."})}
for(const ps in biasRaw){const n=projAll[ps].length;if(n>=60&&biasRaw[ps]!=null&&Math.abs(biasRaw[ps]-1)>=.1&&biasRaw[ps]>=.8&&biasRaw[ps]<=1.2)alerts.push({lvl:"watch",area:"Projections",msg:`${ps} projections run ${Math.round(Math.abs(biasRaw[ps]-1)*100)}% ${biasRaw[ps]<1?"high":"low"}; the site now corrects for it.`,fix:""})}

const liveWeeks=Object.values(PRED.weeks).filter(p=>!p.bt&&p.y===SEASON).map(p=>p.w);
const G={t:Date.now(),season:SEASON,week:CUR,liveFrom:liveWeeks.length?Math.min(...liveWeeks):CUR+1,model:MODEL,prior:PRIOR,
 win:{all:winSum(gAll),live:winSum(gAll.filter(g=>!g.bt)),bt:winSum(gAll.filter(g=>g.bt))},
 ss:{all:ssSum(ssAll),live:ssSum(ssAll.filter(c=>!c.bt))},
 proj:Object.fromEntries(Object.entries(projAll).map(([k,a])=>[k,{n:a.length,ratio:biasRaw[k],mae:a.length?r1(avg(a.map(x=>Math.abs(x[1]-x[0])))):null}])),
 ideas:IDEAS,
 trades:{n:trades.length,mature:mt.length,held:mt.length?r3(avg(mt.map(t=>t.held))):null,list:trades.sort((a,b)=>b.d<a.d?-1:1).slice(0,60)},
 weeks:wk.map(x=>({lg:x.lg,y:x.y,w:x.w,bt:x.bt,n:x.games.length,brier:x.brier,acc:x.acc,calls:x.calls,pos:x.pos,games:x.games.map(g=>({a:g.a,b:g.b,p:g.p,sa:g.sa,sb:g.sb,out:g.out}))})),
 alerts};
fs.mkdirSync("data",{recursive:true});
// league value race: each team's roster that week plus the draft picks it owned that week (next two drafts, rounds 1-4,
// ownership replayed from this season's trades), priced at the expert values of that date
const race={};for(const lg in ROSW){const wks=Object.keys(ROSW[lg]).map(Number).sort((a,b)=>a-b),teams={},picks={},dates=[];
 const rids=Object.keys(ROSW[lg][wks[0]]).map(Number),own={};for(const y of [SEASON+1,SEASON+2])for(let r=1;r<=4;r++)for(const o of rids)own[y+"|"+r+"|"+o]=o;
 const tl=(tradeLog[lg]||[]).filter(t=>t.y===SEASON).sort((a,b)=>a.t-b.t);let ti=0;
 for(const w of wks){const d=new Date(Date.now()-7*864e5*Math.max(0,CUR-w)).toISOString().slice(0,10);dates.push(d);
  while(ti<tl.length&&tl[ti].w<=w){(tl[ti].pk||[]).forEach(p=>{const k=p.season+"|"+p.round+"|"+p.roster_id;if(k in own)own[k]=p.owner_id});ti++}
  // next year's picks priced by the original team's standing that week (bottom third early, middle mid, top third late)
  const se=(H2H[lg].seasons||[]).find(x=>x.y===SEASON),rec={};rids.forEach(o=>rec[o]={w:0,pf:0});
  if(se)for(const ww in se.weeks){if(+ww>w)continue;(se.weeks[ww]||[]).forEach(([a,pa,b,pb])=>{if(rec[a]){rec[a].pf+=pa;if(pa>pb)rec[a].w++}if(rec[b]){rec[b].pf+=pb;if(pb>pa)rec[b].w++}})}
  const ordr=rids.slice().sort((a,b)=>rec[a].w-rec[b].w||rec[a].pf-rec[b].pf),tier=o=>{const i=ordr.indexOf(o),n=ordr.length;return i<n/3?"early":i<2*n/3?"mid":"late"};
  const pv={};for(const k in own){const [y,r,o]=k.split("|");const v=(+y===SEASON+1?valAt(pkey(y+" "+sfx[r]+" "+tier(+o)),d):null)??valAt(pkey(y+" "+sfx[r]),d);if(v)pv[own[k]]=(pv[own[k]]||0)+v}
  for(const rid in ROSW[lg][w]){let t=0;for(const sid of ROSW[lg][w][rid]){const v=valAt(pkey(NAME[sid]||""),d);if(v)t+=v}
   (teams[rid]=teams[rid]||[]).push(Math.round(t+(pv[rid]||0)));(picks[rid]=picks[rid]||[]).push(Math.round(pv[rid]||0))}}
 race[lg]={weeks:wks,dates,teams,picks}}
wr("data/value-race.json",{t:Date.now(),src:"expert values (DynastyProcess) on each week's rosters plus the picks each team owned that week",race});
wr("data/predictions.json",PRED);wr("data/grades.json",G);wr("data/model.json",MODEL);wr("data/h2h.json",H2H);
pr("graded",gAll.length,"games",ssAll.length,"calls",trades.length,"trades","model",JSON.stringify({sdK,bias}),"alerts",alerts.length);
