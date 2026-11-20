// Builds data/market-trades.json from KeepTradeCut's public Trade Database.
// The database page loads its trades with a plain POST to /dynasty/trade-database/trades, which returns the latest
// ~25,000 dynasty trades (about three days) from many leagues, each with its league settings. We call it once a day,
// merge into the saved file so history keeps growing, and keep player names so the app can match them to Sleeper players.
import fs from "node:fs";
const BASE="https://keeptradecut.com",KEEP=15000,UA="Mozilla/5.0 (compatible; dynasty-desk-data-job)";
const PPR={1:0,2:.5,3:1,4:-1}; // 4 = KTC "tiered" scoring, which the app does not match to a league
export function extractPlayers(html){const k=html.indexOf("var playersArray = ");if(k<0)return null;let i=html.indexOf("[",k),d=0,s=false,e=false;
 for(let j=i;j<html.length;j++){const c=html[j];if(s){if(e)e=false;else if(c==="\\")e=true;else if(c==='"')s=false;continue}if(c==='"')s=true;else if(c==="[")d++;else if(c==="]"){d--;if(d===0)return JSON.parse(html.slice(i,j+1))}}return null}
export function compact(trades,players){const pm={};players.forEach(p=>{pm[p.playerID]=p});const used={},out=[];
 for(const t of trades){const st=t.settings||{};if(!t.teamOne||!t.teamTwo||!t.teamOne.playerIds.length||!t.teamTwo.playerIds.length)continue;
  const ok=ids=>ids.every(id=>pm[id]);if(!ok(t.teamOne.playerIds)||!ok(t.teamTwo.playerIds))continue;
  [...t.teamOne.playerIds,...t.teamTwo.playerIds].forEach(id=>{used[id]=[pm[id].playerName,pm[id].position]});
  out.push({id:String(t.id),d:Math.floor(Date.parse(t.date)/1000),sf:st.qBs===2?1:0,ppr:PPR[st.ppr]==null?-1:PPR[st.ppr],te:st.tep||0,tm:st.teams||12,a:t.teamOne.playerIds.map(String),b:t.teamTwo.playerIds.map(String)})}
 return{trades:out,players:used}}
async function main(){
 const hdr={"user-agent":UA,"accept-language":"en-US,en;q=0.9"};
 const page=await fetch(BASE+"/dynasty/trade-database",{headers:hdr});if(!page.ok)throw new Error("page HTTP "+page.status);
 const players=extractPlayers(await page.text());if(!players||players.length<100)throw new Error("could not read the player list");
 const r=await fetch(BASE+"/dynasty/trade-database/trades",{method:"POST",headers:{...hdr,"content-type":"application/json;",referer:BASE+"/dynasty/trade-database","x-requested-with":"XMLHttpRequest"}});
 if(!r.ok)throw new Error("trades HTTP "+r.status);const raw=await r.json();if(!Array.isArray(raw)||raw.length<100)throw new Error("unexpected trades response");
 const fresh=compact(raw,players);
 let old={trades:[],players:{}};try{old=JSON.parse(fs.readFileSync("data/market-trades.json","utf8"));if(!old.players||!old.trades)old={trades:[],players:{}}}catch(e){}
 const seen=new Set(fresh.trades.map(t=>t.id)),merged=fresh.trades.concat(old.trades.filter(t=>!seen.has(t.id))).sort((a,b)=>b.d-a.d||(+b.id)-(+a.id)).slice(0,KEEP);
 const pm={...old.players,...fresh.players},need=new Set();merged.forEach(t=>t.a.concat(t.b).forEach(id=>need.add(id)));Object.keys(pm).forEach(id=>{if(!need.has(id))delete pm[id]});
 fs.mkdirSync("data",{recursive:true});fs.writeFileSync("data/market-trades.json",JSON.stringify({t:Date.now(),src:"keeptradecut",trades:merged,players:pm}));
 console.log("received",raw.length,"usable",fresh.trades.length,"kept",merged.length)}
if(process.argv[1]&&process.argv[1].endsWith("crawl-trades.mjs"))main().catch(e=>{console.error("FAILED:",e.message);process.exit(1)});
