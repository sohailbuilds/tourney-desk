// Pure functions for scoring configuration and leaderboard calculations; no database or AI dependencies.
const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const points=(rank,kills,sc)=>(sc.placement_points?.[rank]||0)+(kills||0)*(sc.per_kill||0);
// rows: [{key,label,rank,kills}] (har match ki har team ek row). Sort: total, kills, best placement.
function leaderboard(rows,sc){
 const m=new Map();
 for(const r of rows){
  const e=m.get(r.key)||{key:r.key,label:r.label,matches:0,wins:0,kills:0,placePts:0,total:0,best:99};
  e.matches++;e.kills+=r.kills;e.placePts+=sc.placement_points?.[r.rank]||0;
  e.total+=points(r.rank,r.kills,sc);if(r.rank===1)e.wins++;e.best=Math.min(e.best,r.rank);m.set(r.key,e);
 }
 return [...m.values()].sort((a,b)=>b.total-a.total||b.kills-a.kills||a.best-b.best);
}
module.exports={norm,points,leaderboard};
