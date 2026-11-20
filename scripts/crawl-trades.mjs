// Builds data/market-trades.json: real dynasty trades sampled from public Sleeper leagues.
// Starts from the users in our two leagues, walks to the other leagues they play in, keeps dynasty leagues,
// and records completed two-team trades with the league's settings so the app can filter like a trade database.
import fs from "node:fs";
const API="https://api.sleeper.app/v1";
const SEEDS=["1314551881690787840","1376273128933593088"];
const MAX_LEAGUES=+process.env.MAX_LEAGUES||500, KEEP=4000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function j(path){for(let k=0;k<3;k++){try{const r=await fetch(API+path,{headers:{"user-agent":"dynasty-desk-market-job"}});if(r.status===429){await sleep(1500*(k+1));continue}if(!r.ok)return null;return await r.json()}catch(e){await sleep(500)}}return null}
async function pool(items,n,fn){const out=[];let i=0;await Promise.all(Array.from({length:n},async()=>{while(i<items.length){const k=i++;out[k]=await fn(items[k],k)}}));return out}
export function settingsOf(li){const sc=li.scoring_settings||{},rp=li.roster_positions||[];const rec=sc.rec==null?0:+sc.rec,te=sc.bonus_rec_te||0;
 return{sf:rp.includes("SUPER_FLEX")?1:0,ppr:rec>=.75?1:rec>=.25?.5:0,te:te>=1?2:te>=.5?1:0,tm:li.total_rosters||12}}
export function tradeOf(t,st,season){if(t.type!=="trade"||t.status!=="complete"||!t.roster_ids||t.roster_ids.length!==2)return null;
 const side=[[],[]],[r0]=t.roster_ids;for(const sid in(t.adds||{}))side[t.adds[sid]===r0?0:1].push("p:"+sid);
 (t.draft_picks||[]).forEach(k=>side[k.owner_id===r0?0:1].push("k:"+k.season+":"+k.round));
 if(!side[0].length||!side[1].length)return null;
 return{id:t.transaction_id,d:Math.floor((t.status_updated||t.created||0)/1000),...st,a:side[0],b:side[1]}}
async function main(){
 const state=await j("/state/nfl"),season=(state&&state.season)||String(new Date().getFullYear()),week=Math.max(1,Math.min(18,(state&&state.week)||1));
 let old={trades:[]};try{old=JSON.parse(fs.readFileSync("data/market-trades.json","utf8"))}catch(e){}
 const seen=new Set(old.trades.map(t=>t.id)),users=new Set(),leagues=new Map();
 for(const lid of SEEDS){const us=await j("/league/"+lid+"/users");(us||[]).forEach(u=>users.add(u.user_id))}
 // two hops: users of our leagues -> their leagues -> those leagues' users -> their leagues
 let frontier=[...users];
 for(let hop=0;hop<2&&leagues.size<MAX_LEAGUES*2;hop++){const next=new Set();
  await pool(frontier,6,async u=>{const ls=await j("/user/"+u+"/leagues/nfl/"+season);(ls||[]).forEach(l=>{if(l.settings&&l.settings.type===2&&!leagues.has(l.league_id))leagues.set(l.league_id,l)});await sleep(40)});
  if(hop===0&&leagues.size<MAX_LEAGUES){const ids=[...leagues.keys()].slice(0,150);await pool(ids,6,async id=>{const us=await j("/league/"+id+"/users");(us||[]).slice(0,14).forEach(x=>{if(!users.has(x.user_id)){users.add(x.user_id);next.add(x.user_id)}});await sleep(40)})}
  frontier=[...next].slice(0,400)}
 const ids=[...leagues.keys()].slice(0,MAX_LEAGUES);let added=0;
 await pool(ids,6,async id=>{const l=leagues.get(id),st=settingsOf(l);
  for(let w=1;w<=week;w++){const tx=await j("/league/"+id+"/transactions/"+w);(tx||[]).forEach(t=>{const x=tradeOf(t,st,season);if(x&&!seen.has(x.id)){seen.add(x.id);old.trades.push(x);added++}});await sleep(25)}});
 old.trades.sort((a,b)=>b.d-a.d);old.trades=old.trades.slice(0,KEEP);
 fs.mkdirSync("data",{recursive:true});fs.writeFileSync("data/market-trades.json",JSON.stringify({t:Date.now(),season,leagues:ids.length,trades:old.trades}));
 console.log("leagues",ids.length,"added",added,"kept",old.trades.length)}
if(process.argv[1]&&process.argv[1].endsWith("crawl-trades.mjs"))main();
