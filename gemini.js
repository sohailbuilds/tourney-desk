// Read match-result screenshots with Gemini. Change providers by updating this file.
const PROMPT=`This is a screenshot of a BGMI/PUBG Mobile match result screen: a list of teams with rank number and each player's name and "finishes" (kills).
Layout: ranks 1, 2 and 3 are on the LEFT and never scroll. The rest of the teams are in a list on the RIGHT that scrolls, so this screenshot may show only part of it (for example ranks 10 to 15).
Return ONLY a JSON array: [{"rank":4,"players":[{"name":"exact name as shown","kills":2},{"name":"...","kills":0}],"cut_off":false}].
Include every rank you can see, including the left ones. Copy names exactly, with symbols. Use null for a name or number you cannot read. Set "cut_off":true if that row is only partly visible (cut by the screen edge or covered by buttons). A team may have 1 to 4 players. Do not guess.`;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// Try models listed in GEMINI_MODEL first, then use these fallback models.
const models=()=>[...new Set([...(process.env.GEMINI_MODEL||'').split(',').map(x=>x.trim()).filter(Boolean),'gemini-3.5-flash','gemini-2.5-flash','gemini-3.1-flash-lite'])];

// For each screenshot, retry each model once after a short delay before trying the next model.
async function callGemini(f,key){
 let last='';
 for(const model of models()){
  for(let attempt=0;attempt<2;attempt++){
   let res;
   try{
    res=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(45000),
     body:JSON.stringify({contents:[{parts:[{text:PROMPT},{inline_data:{mime_type:f.mimetype,data:f.buffer.toString('base64')}}]}],generationConfig:{responseMimeType:'application/json',temperature:0}})});
   }catch(e){last=`${model} network: ${e.message}`;if(attempt===0){await sleep(2500);continue;}break;}
   if(res.ok)return res.json();
   const txt=(await res.text()).slice(0,200);last=`${model} ${res.status}: ${txt}`;
   if([429,500,502,503,504].includes(res.status)){if(attempt===0){await sleep(2500);continue;}break;} // If busy or rate-limited, try the next model.
   if(res.status===404)break; // This model may be unavailable; try the next one.
   throw new Error(`Gemini error ${res.status}: ${txt}`); // For 400/401/403 responses, retrying is unlikely to help.
  }
 }
 throw new Error('Gemini is busy or the free-tier limit may have been reached (all models were tried). Please try again in 1–2 minutes. Last error: '+last);
}

// Merge multiple screenshots by rank, remove overlapping duplicates, and flag uncertain rows.
const nk=x=>String(x||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const sameTeam=(a,b)=>{const x=nk(a.names),y=nk(b.names);return x.length>=3&&y.length>=3&&(x===y||x.includes(y)||y.includes(x));};
const quality=r=>(r.unsure?0:1000)+String(r.names||'').length; // Prefer complete rows with more detail
function mergeRows(list){
 const by=new Map();
 for(const r of list){
  const old=by.get(r.rank);
  if(!old){by.set(r.rank,{...r});continue;}
  if(sameTeam(old,r)){const best=quality(r)>quality(old)?r:old;by.set(r.rank,{...best,reg:old.reg||r.reg,note:best.unsure?(best.note||''):''});} // Overlapping screenshots: retain one row for the same team.
  else{old.unsure=true;old.note=`Conflicting team names were found for rank ${r.rank} (${r.names}); review this row.`;}
 }
 const rows=[...by.values()].sort((a,b)=>a.rank-b.rank);
 const flag=(r,m)=>{r.unsure=true;r.note=r.note||m;};
 for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++)if(sameTeam(rows[i],rows[j])){flag(rows[i],'This team name also appears under another rank.');flag(rows[j],'This team name also appears under another rank.');}
 const cnt={};rows.forEach(r=>{const c=r.names.split(' / ').length;cnt[c]=(cnt[c]||0)+1;});
 const mode=+Object.keys(cnt).sort((a,b)=>cnt[b]-cnt[a])[0]||0;
 rows.forEach(r=>{if(r.names.split(' / ').length<mode)flag(r,'Fewer players were detected; the row may be cut off.');});
 return rows;
}

// Merge newly scanned screenshots with any rows already present in the table.
async function readScreenshots(files,prev=[]){
 const key=(process.env.GEMINI_API_KEY||'').trim().replace(/^['"]|['"]$/g,'');if(!key)throw new Error('GEMINI_API_KEY is not configured. Add GEMINI_API_KEY to your .env file, then restart the server: '+require('path').join(__dirname,'.env'));
 const all=[...prev];
 for(const f of files){ // Send each screenshot separately.
  let arr=[];try{arr=JSON.parse((await callGemini(f,key)).candidates[0].content.parts[0].text);}catch(e){if(e.message.startsWith('Gemini'))throw e;}
  for(const t of Array.isArray(arr)?arr:[]){
   const rank=+t.rank;if(!rank)continue;
   const players=(t.players||[]).filter(p=>p&&p.name);
   all.push({rank,names:players.map(p=>p.name).join(' / '),kills:players.reduce((s,p)=>s+(+p.kills||0),0),
    unsure:!players.length||players.some(p=>p.kills==null)||t.cut_off===true,note:t.cut_off===true?'This row was cut off; review it.':''});
  }
 }
 return mergeRows(all.filter(r=>r.names));
}
module.exports={readScreenshots,mergeRows};
