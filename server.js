require('./env')(__dirname); // Load settings from the .env file
const express=require('express'),path=require('path'),fs=require('fs'),crypto=require('crypto'),multer=require('multer');
const {DatabaseSync}=require('node:sqlite');
const templates=require('./templates');
const PORT=process.env.PORT||3000;
const IS_PROD=process.env.NODE_ENV==='production';
if(process.env.PORT && !IS_PROD) throw new Error('Production security: hosted deployments must set NODE_ENV=production.');
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||(!IS_PROD?'admin123':'');
const SECRET=process.env.SECRET||(!IS_PROD?'local-development-secret-change-before-deploy':'');
if(IS_PROD && (!ADMIN_PASSWORD || ADMIN_PASSWORD.length<14 || ['admin123','password','change-me-please'].includes(ADMIN_PASSWORD))) throw new Error('Production security: ADMIN_PASSWORD must be a unique password of at least 14 characters.');
if(IS_PROD && (!SECRET || SECRET.length<32 || SECRET==='change-me-please')) throw new Error('Production security: SECRET must be a random secret of at least 32 characters.');
if(IS_PROD){try{const u=new URL(process.env.BASE_URL||'');if(u.protocol!=='https:'||!u.hostname||u.username||u.password)throw new Error();}catch{throw new Error('Production security: BASE_URL must be your canonical https:// domain, e.g. https://tourney.example.com');}}
const DATA=process.env.DATA_DIR||path.join(__dirname,'data');
fs.mkdirSync(path.join(DATA,'uploads'),{recursive:true,mode:0o700});
try{if(process.platform!=='win32')fs.chmodSync(DATA,0o700);}catch{}

// ---------- Database ----------
const db=new DatabaseSync(path.join(DATA,'app.db'));
db.exec(`
create table if not exists organizations(id integer primary key,slug text unique not null,name text not null,whatsapp text default '');
create table if not exists tournaments(id integer primary key,org_id integer not null references organizations(id),slug text not null,title text not null,game text default '',
 entry_fee text default '',prize text default '',starts_at text default '',slots integer default 0,description text default '',form_fields text not null,status text default 'open',unique(org_id,slug));
create table if not exists registrations(id integer primary key,tournament_id integer not null references tournaments(id),answers text not null,paid integer default 0,created_at text default current_timestamp);
`);
db.exec(`
create table if not exists matches(id integer primary key,tournament_id integer not null references tournaments(id),number integer not null);
create table if not exists results(id integer primary key,match_id integer not null references matches(id) on delete cascade,rank integer not null,names text not null,kills integer default 0,reg_id integer);
`);
try{db.exec('alter table tournaments add column scoring text');}catch(e){}
for(const c of ['email text','pass_hash text',"upi text default ''",'credits integer default 0']){try{db.exec('alter table organizations add column '+c);}catch(e){}}
try{db.exec('create unique index if not exists org_email on organizations(email)');}catch(e){}
try{db.exec('alter table tournaments add column live integer default 0');db.exec('update tournaments set live=1');}catch(e){}
try{db.exec('alter table tournaments add column scans integer default 0');}catch(e){}
db.exec(`create table if not exists purchases(id integer primary key,org_id integer not null,plan text,credits integer,price text,utr text,status text default 'pending',created_at text default current_timestamp);`);
for(const c of ['room_id','room_password']){try{db.exec(`alter table tournaments add column ${c} text default ''`);}catch(e){}}
try{db.exec('alter table tournaments add column room_released integer default 0');}catch(e){}
try{db.exec('alter table registrations add column token text');}catch(e){}
for(const r of db.prepare('select id from registrations where token is null').all())db.prepare('update registrations set token=? where id=?').run(crypto.randomBytes(24).toString('hex'),r.id);
const slugify=s=>String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'x';

// ---------- App + auth ----------
const app=express();
app.set('view engine','ejs');
app.set('trust proxy',1); // Detect HTTPS correctly behind the hosting proxy
app.locals.brand=process.env.BRAND||'Tourney Desk';
// Security headers; inline styles/scripts are retained because this app's current EJS views use them.
app.disable('x-powered-by');
app.use((req,res,next)=>{
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('X-Frame-Options','DENY');
 res.setHeader('Referrer-Policy','no-referrer');
 res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
 res.setHeader('Cross-Origin-Opener-Policy','same-origin');
 res.setHeader('Content-Security-Policy',"default-src 'self'; base-uri 'self'; form-action 'self' https://wa.me; frame-ancestors 'none'; object-src 'none'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https://generativelanguage.googleapis.com; upgrade-insecure-requests");
 if(IS_PROD)res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
 next();
});
app.use(express.urlencoded({extended:false,limit:'256kb',parameterLimit:200}));
app.use((req,res,next)=>{
 const cookies=Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf('=');return i<0?[x,'']:[x.slice(0,i),x.slice(i+1)]}));
 let csrf=cookies.td_csrf;
 if(!csrf || !/^[a-f0-9]{48}$/.test(csrf)){csrf=crypto.randomBytes(24).toString('hex');res.append('Set-Cookie',`td_csrf=${csrf}; HttpOnly; SameSite=Strict; Path=/${IS_PROD?'; Secure':''}`);}
 res.locals.csrfToken=csrf;
 if(req.method==='POST' && !String(req.headers['content-type']||'').toLowerCase().startsWith('multipart/form-data')){
  const supplied=String(req.body?._csrf||'');
  if(!safeEqual(supplied,csrf))return res.status(403).send('Your request expired or is invalid. Refresh the page and try again.');
 }
 next();
});
app.use(express.static(path.join(__dirname,'public'),{fallthrough:true,maxAge:IS_PROD?'1h':0}));
const safeEqual=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
const getCookie=(req,name)=>{const part=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='));return part?part.slice(name.length+1):''};
const sign=value=>crypto.createHmac('sha256',SECRET).update(value).digest('hex');
const makeAdminToken=()=>{const payload=`${Date.now()+24*60*60*1000}.${crypto.randomBytes(16).toString('hex')}`;return `${payload}.${sign('admin:'+payload)}`;};
const isAdmin=req=>{const raw=getCookie(req,'adm'),parts=raw.split('.');if(parts.length!==3)return false;const [expires,nonce,sig]=parts,payload=`${expires}.${nonce}`;return /^\d+$/.test(expires)&&Number(expires)>Date.now()&&Number(expires)<Date.now()+25*60*60*1000&&/^[a-f0-9]{32}$/.test(nonce)&&safeEqual(sig,sign('admin:'+payload));};
const csrfMultipart=(req,res,next)=>safeEqual(String(req.body?._csrf||''),getCookie(req,'td_csrf'))?next():res.status(403).send('Your request expired or is invalid. Refresh the page and try again.');
const rateBuckets=new Map();
const rateLimit=(name,{windowMs=15*60*1000,max=10}={})=>(req,res,next)=>{
 const now=Date.now(),key=name+':'+(req.ip||req.socket.remoteAddress||'unknown');let b=rateBuckets.get(key);
 if(!b||now-b.start>windowMs)b={start:now,count:0};b.count++;rateBuckets.set(key,b);
 if(rateBuckets.size>5000)for(const [k,v] of rateBuckets)if(now-v.start>windowMs)rateBuckets.delete(k);
 if(b.count>max){res.setHeader('Retry-After',String(Math.ceil((windowMs-(now-b.start))/1000)));return res.status(429).send('Too many attempts. Please try again later.');}
 next();
};
const needAdmin=(req,res,next)=>isAdmin(req)?next():res.redirect('/admin/login');
const orgOf=req=>{const raw=getCookie(req,'org');if(!raw)return null;
 const [id,expires,nonce,sig]=raw.split('.'),payload=`${id}.${expires}.${nonce}`;
 if(!/^\d+$/.test(id||'')||!/^\d+$/.test(expires||'')||Number(expires)<=Date.now()||Number(expires)>Date.now()+25*60*60*1000||! /^[a-f0-9]{32}$/.test(nonce||'')||!safeEqual(sig||'',sign('org:'+payload)))return null;
 return db.prepare('select * from organizations where id=?').get(Number(id))||null;};
const setOrg=(res,id)=>{const expires=Date.now()+24*60*60*1000,nonce=crypto.randomBytes(16).toString('hex'),payload=`${id}.${expires}.${nonce}`;res.setHeader('Set-Cookie',`org=${payload}.${sign('org:'+payload)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${IS_PROD?'; Secure':''}`);};
const hashPw=pw=>{const salt=crypto.randomBytes(16).toString('hex');return salt+':'+crypto.scryptSync(pw,salt,32).toString('hex');};
const checkPw=(pw,h)=>{const [salt,hex]=String(h||'').split(':');if(!salt||!hex)return false;const a=Buffer.from(hex,'hex'),b=crypto.scryptSync(pw,salt,32);return a.length===b.length&&crypto.timingSafeEqual(a,b);};
const ownerOf=p=>{let m;
 if(m=p.match(/^\/t\/(\d+)/))return db.prepare('select org_id o from tournaments where id=?').get(+m[1])?.o;
 if(m=p.match(/^\/r\/(\d+)/))return db.prepare('select t.org_id o from registrations r join tournaments t on t.id=r.tournament_id where r.id=?').get(+m[1])?.o;
 if(m=p.match(/^\/m\/(\d+)/))return db.prepare('select t.org_id o from matches m join tournaments t on t.id=m.tournament_id where m.id=?').get(+m[1])?.o;};
const base=req=>(process.env.BASE_URL||`${req.protocol}://${req.get('host')}`).replace(/\/$/,'');

const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:12,fields:80,parts:100},fileFilter:(r,f,cb)=>cb(null,['image/jpeg','image/png','image/webp','image/gif'].includes(f.mimetype))});
function imageType(buf){
 if(!buf||buf.length<12)return null;
 if(buf[0]===0xff&&buf[1]===0xd8&&buf[2]===0xff)return {ext:'.jpg',mime:'image/jpeg'};
 if(buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {ext:'.png',mime:'image/png'};
 if(buf.subarray(0,4).toString()==='RIFF'&&buf.subarray(8,12).toString()==='WEBP')return {ext:'.webp',mime:'image/webp'};
 if(buf.subarray(0,6).toString()==='GIF87a'||buf.subarray(0,6).toString()==='GIF89a')return {ext:'.gif',mime:'image/gif'};
 return null;
}
function removeUploadedFiles(req){for(const f of req.files||[])if(f.filename){try{fs.unlinkSync(path.join(DATA,'uploads',f.filename));}catch{}}}
function persistRegistrationUploads(req,res,next){
 try{
  const checked=(req.files||[]).map(f=>({f,type:imageType(f.buffer)}));
  if(checked.some(x=>!x.type))return res.status(400).render('message',{msg:'Upload a valid JPG, PNG, WEBP, or GIF image.'});
  for(const {f,type} of checked){f.filename=crypto.randomBytes(24).toString('hex')+type.ext;fs.writeFileSync(path.join(DATA,'uploads',f.filename),f.buffer,{flag:'wx',mode:0o600});f.mimetype=type.mime;}
  next();
 }catch(e){removeUploadedFiles(req);next(e);}
}

app.get('/',(req,res)=>res.send('Tourney Desk is running. Admin: /admin'));

// ---------- Admin ----------
app.get('/admin/login',(req,res)=>res.render('login',{error:null}));
app.post('/admin/login',rateLimit('admin-login',{max:8}), (req,res)=>{
 if(!safeEqual(req.body.password||'',ADMIN_PASSWORD)) return res.status(401).render('login',{error:'Incorrect password.'});
 res.setHeader('Set-Cookie',`adm=${makeAdminToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${IS_PROD?'; Secure':''}`);res.redirect('/admin');
});
app.get('/admin/logout',(req,res)=>{res.setHeader('Set-Cookie',`adm=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${IS_PROD?'; Secure':''}`);res.redirect('/admin/login');});
// Admin uses /admin. Organizers use the separate /panel routes for their own data.
// These routes internally reuse the admin handlers while enforcing organizer ownership.
app.use((req,res,next)=>{
 const m=req.url.match(/^\/panel(\/(?:t|r|m)(?:\/.*)?)$/);
 if(m){req.url='/admin'+m[1];req.viaPanel=true;}
 res.locals.p=req.viaPanel?'/panel':'/admin';
 next();
});
app.use('/admin',(req,res,next)=>{
 if(!req.viaPanel)return isAdmin(req)?next():res.redirect('/admin/login');
 const o=orgOf(req);if(!o)return res.redirect('/panel/login');
 req.isOrg=true;req.org=o;
 if(req.path==='/t/new')return next();
 if(req.method==='POST'&&req.path==='/t'){req.body.org_id=o.id;return next();}
 if(/^\/(t|r|m)\/\d+/.test(req.path)&&ownerOf(req.path)===o.id)return next();
 res.redirect('/panel');
});
app.use('/uploads',(req,res,next)=>{
 if(isAdmin(req))return next();const o=orgOf(req);
 if(o&&db.prepare('select 1 from registrations r join tournaments t on t.id=r.tournament_id where t.org_id=? and r.answers like ?').get(o.id,'%'+path.basename(req.path)+'%'))return next();
 res.redirect('/admin/login');},express.static(path.join(DATA,'uploads')));

app.get('/admin',(req,res)=>{
 const orgs=db.prepare('select * from organizations order by name').all();
 const ts=db.prepare(`select t.*,o.slug org_slug,o.name org_name,(select count(*) from registrations r where r.tournament_id=t.id) regs
  from tournaments t join organizations o on o.id=t.org_id order by t.id desc`).all();
 res.render('admin',{orgs,ts,base:base(req),purchases:db.prepare("select p.*,o.name org_name from purchases p join organizations o on o.id=p.org_id where p.status='pending' order by p.id").all()});
});
app.post('/admin/org',(req,res)=>{
 const {name,whatsapp}=req.body; if(!name) return res.redirect('/admin');
 try{db.prepare('insert into organizations(slug,name,whatsapp) values(?,?,?)').run(slugify(name),name,whatsapp||'');}catch(e){}
 res.redirect('/admin');
});
app.get('/admin/t/new',(req,res)=>res.render('tournament_new',{orgs:req.isOrg?[req.org]:db.prepare('select * from organizations order by name').all(),templates,org:req.isOrg?req.org.id:(req.query.org||''),error:null}));
app.post('/admin/t',(req,res)=>{
 const b=Object.fromEntries(['org_id','title','game','entry_fee','prize','starts_at','slots','description','form_fields'].map(k=>[k,req.body[k]??'']));let fields;
 try{fields=JSON.parse(b.form_fields);if(!Array.isArray(fields))throw 0;}catch(e){
  return res.status(400).render('tournament_new',{orgs:req.isOrg?[req.org]:db.prepare('select * from organizations').all(),templates,org:b.org_id,error:'Form fields must be a valid JSON array.'});}
 let slug=slugify(b.title);
 try{db.prepare(`insert into tournaments(org_id,slug,title,game,entry_fee,prize,starts_at,slots,description,form_fields,live) values(?,?,?,?,?,?,?,?,?,?,?)`)
  .run(+b.org_id,slug,b.title,b.game,b.entry_fee,b.prize,b.starts_at,+b.slots||0,b.description,JSON.stringify(fields),req.isOrg?0:1);}
 catch(e){slug+='-'+Date.now().toString(36).slice(-4);
  db.prepare(`insert into tournaments(org_id,slug,title,game,entry_fee,prize,starts_at,slots,description,form_fields,live) values(?,?,?,?,?,?,?,?,?,?,?)`)
  .run(+b.org_id,slug,b.title,b.game,b.entry_fee,b.prize,b.starts_at,+b.slots||0,b.description,JSON.stringify(fields),req.isOrg?0:1);}
 res.redirect(req.isOrg?'/panel':'/admin');
});
const loadT=id=>{const t=db.prepare(`select t.*,o.slug org_slug,o.name org_name,o.whatsapp org_wa from tournaments t join organizations o on o.id=t.org_id where t.id=?`).get(+id);
 if(t)t.fields=JSON.parse(t.form_fields);return t;};
const loadR=id=>db.prepare('select * from registrations where tournament_id=? order by id').all(+id).map(r=>({...r,answers:JSON.parse(r.answers)}));

app.get('/admin/t/:id',(req,res)=>{
 const t=loadT(req.params.id);if(!t)return res.sendStatus(404);
 res.render('registrations',{t,regs:loadR(t.id),link:`${base(req)}/${t.org_slug}/${t.slug}`});
});
app.post('/admin/r/:id/paid',(req,res)=>{
 db.prepare('update registrations set paid=1-paid where id=?').run(+req.params.id);
 res.redirect(req.get('referer')||res.locals.p);
});
app.post('/admin/r/:id/delete',(req,res)=>{db.prepare('delete from registrations where id=?').run(+req.params.id);res.redirect(req.get('referer')||res.locals.p);});
app.post('/admin/t/:id/status',(req,res)=>{
 db.prepare(`update tournaments set status=case status when 'open' then 'closed' else 'open' end where id=?`).run(+req.params.id);
 res.redirect(req.get('referer')||res.locals.p);
});
app.get('/admin/t/:id/export.csv',(req,res)=>{
 const t=loadT(req.params.id);if(!t)return res.sendStatus(404);
 const q=v=>{let x=String(v??'');if(/^[\s\u0000-\u001f]*[=+@-]/.test(x))x="'"+x;return `"${x.replace(/"/g,'""')}"`;};
 const head=['#','Paid','Time',...t.fields.map(f=>f.label)];
 const rows=loadR(t.id).map((r,i)=>[i+1,r.paid?'Yes':'No',r.created_at,...t.fields.map(f=>f.type==='file'&&r.answers[f.key]?`${base(req)}/uploads/${r.answers[f.key]}`:r.answers[f.key])]);
 res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${t.slug}.csv"`});
 res.send('\ufeff'+[head,...rows].map(r=>r.map(q).join(',')).join('\r\n'));
});

// ---------- Matches, scoring, leaderboard ----------
const {norm,leaderboard}=require('./scoring');const {readScreenshots}=require('./gemini');
const memUp=multer({storage:multer.memoryStorage(),limits:{fileSize:8*1024*1024,files:8,fields:300,parts:320},fileFilter:(r,f,cb)=>cb(null,['image/jpeg','image/png','image/webp','image/gif'].includes(f.mimetype))});
const DEFAULT_SCORING={placement_points:{1:15,2:12,3:10,4:8,5:6,6:4,7:2,8:1},per_kill:1};
const regLabel=r=>{const a=r.answers;return a.team_name||a.player_name||a.name||Object.values(a)[0]||'#'+r.id;};
function autoMatch(t,names){ // Match in-game names to registration answers using fuzzy matching.
 const ns=names.split('/').map(norm).filter(n=>n.length>=3);
 for(const r of loadR(t.id)){
  const vals=t.fields.filter(f=>f.type!=='file').map(f=>norm(r.answers[f.key])).filter(v=>v.length>=3);
  if(ns.some(n=>vals.some(v=>v===n||(n.length>=4&&v.includes(n))||(v.length>=5&&n.includes(v)))))return r.id;
 }return '';}
function board(t){
 const sc=JSON.parse(t.scoring||JSON.stringify(DEFAULT_SCORING));
 const regs=Object.fromEntries(loadR(t.id).map(r=>[r.id,regLabel(r)]));
 const rows=db.prepare('select r.* from results r join matches m on m.id=r.match_id where m.tournament_id=?').all(t.id)
  .map(r=>({key:r.reg_id?'r'+r.reg_id:'n'+norm(r.names),rank:r.rank,kills:r.kills,label:r.reg_id?regs[r.reg_id]:r.names}));
 return leaderboard(rows,sc);}
const editView=(res,t,rows,error)=>res.render('match_edit',{t,rows,error,regs:loadR(t.id).map(r=>({id:r.id,label:regLabel(r)}))});

app.get('/admin/t/:id/matches',(req,res)=>{
 const t=loadT(req.params.id);if(!t)return res.sendStatus(404);
 const matches=db.prepare('select m.*,(select count(*) from results where match_id=m.id) n from matches m where tournament_id=? order by number').all(t.id);
 res.render('matches',{t,matches,rows:board(t),scoring:JSON.stringify(JSON.parse(t.scoring||JSON.stringify(DEFAULT_SCORING)),null,1),error:req.query.e||'',hasKey:!!process.env.GEMINI_API_KEY});
});
app.post('/admin/t/:id/scoring',(req,res)=>{
 try{const sc=JSON.parse(req.body.scoring);if(typeof sc!=='object'||!sc)throw 0;db.prepare('update tournaments set scoring=? where id=?').run(JSON.stringify(sc),+req.params.id);res.redirect(`${res.locals.p}/t/${req.params.id}/matches`);}
 catch(e){res.redirect(`${res.locals.p}/t/${req.params.id}/matches?e=`+encodeURIComponent('Scoring must be valid JSON.'));}
});
app.post('/admin/t/:id/match/scan',rateLimit('scan-upload',{windowMs:60*60*1000,max:30}),memUp.array('shots',8),csrfMultipart,async(req,res)=>{
 const t=loadT(req.params.id);if(!t)return res.sendStatus(404);
 const A=k=>[].concat(req.body[k]??[]); // Include existing table rows when additional screenshots are uploaded.
 const prev=A('rank').map((r,i)=>({rank:+r,names:String(A('names')[i]||'').trim(),kills:+A('kills')[i]||0,reg:A('reg')[i]||'',unsure:A('unsure')[i]==='1'})).filter(r=>r.rank&&r.names);
 if((req.files||[]).some(f=>!imageType(f.buffer)))return res.status(400).send('Invalid image file. Upload a valid JPG, PNG, WEBP, or GIF image.');
 if(!req.files||!req.files.length){
  if(prev.length)return editView(res,t,prev,'Select a screenshot first, then click "Add More Screenshots".');
  return res.redirect(`${res.locals.p}/t/${t.id}/matches?e=`+encodeURIComponent('Select a screenshot.'));
 }
 if(req.isOrg&&(t.scans||0)+req.files.length>SCAN_LIMIT)return res.redirect(`${res.locals.p}/t/${t.id}/matches?e=`+encodeURIComponent(`This tournament has reached its screenshot limit (${SCAN_LIMIT}). Contact the platform administrator.`));
 try{const merged=await readScreenshots(req.files,prev);db.prepare('update tournaments set scans=coalesce(scans,0)+? where id=?').run(req.files.length,t.id);
  const rows=merged.map(r=>({...r,reg:r.reg||autoMatch(t,r.names)}));
  const miss=[];for(let i=1;i<=(rows.length?rows[rows.length-1].rank:0);i++)if(!rows.some(r=>r.rank===i))miss.push(i);
  const regs=loadR(t.id).length,bad=rows.filter(r=>r.unsure).length;
  editView(res,t,rows,[rows.length?`${rows.length} teams found.`:'No results could be read.',
   miss.length?`These ranks were not found: ${miss.join(', ')}. Upload the remaining screenshots using "Add More Screenshots" below.`:'',
   regs&&rows.length<regs?`(Registered teams: ${regs}; results found so far: ${rows.length}.)`:'',
   bad?`${bad} rows are outlined in red and need review.`:''].filter(Boolean).join(' '));
 }catch(e){res.redirect(`${res.locals.p}/t/${t.id}/matches?e=`+encodeURIComponent(e.message));}
});
app.get('/admin/t/:id/match/manual',(req,res)=>{
 const t=loadT(req.params.id);if(!t)return res.sendStatus(404);
 editView(res,t,Array.from({length:Math.min(+req.query.n||20,100)},(_,i)=>({rank:i+1,names:'',kills:0,reg:'',unsure:false})),'');
});
app.post('/admin/t/:id/match',(req,res)=>{
 const t=loadT(req.params.id);if(!t)return res.sendStatus(404);
 const A=k=>[].concat(req.body[k]??[]);const rk=A('rank'),nm=A('names'),ki=A('kills'),rg=A('reg');
 const n=db.prepare('select count(*) c from matches where tournament_id=?').get(t.id).c+1;
 const mid=Number(db.prepare('insert into matches(tournament_id,number) values(?,?)').run(t.id,n).lastInsertRowid);
 const ins=db.prepare('insert into results(match_id,rank,names,kills,reg_id) values(?,?,?,?,?)');
 rk.forEach((r,i)=>{if(!+r||!String(nm[i]||'').trim())return;ins.run(mid,+r,String(nm[i]).trim(),+ki[i]||0,+rg[i]||null);});
 res.redirect(`${res.locals.p}/t/${t.id}/matches`);
});
app.post('/admin/m/:id/delete',(req,res)=>{db.prepare('delete from results where match_id=?').run(+req.params.id);db.prepare('delete from matches where id=?').run(+req.params.id);res.redirect(req.get('referer')||res.locals.p);});
app.get('/:org/:slug/leaderboard',(req,res)=>{
 const t=findPublic(req.params.org,req.params.slug);if(!t)return res.status(404).render('message',{msg:'Tournament not found.'});
 res.render('leaderboard',{t,rows:board(t)});
});

// ---------- Room ID/password + player status page ----------
app.post('/admin/t/:id/room',(req,res)=>{
 db.prepare('update tournaments set room_id=?,room_password=?,room_released=? where id=?').run(String(req.body.room_id||'').trim(),String(req.body.room_password||'').trim(),req.body.released?1:0,+req.params.id);
 res.redirect(`${res.locals.p}/t/${req.params.id}`);
});
app.get('/r/:token',rateLimit('private-status',{windowMs:60*60*1000,max:120}),(req,res)=>{ // Each registration has a private link; the token identifies the player
 const r=db.prepare('select * from registrations where token=?').get(String(req.params.token));
 if(!r)return res.status(404).render('message',{msg:'This link is invalid or has expired.'});
 const t=db.prepare(`select t.*,o.slug org_slug,o.name org_name,o.whatsapp org_wa from tournaments t join organizations o on o.id=t.org_id where t.id=?`).get(r.tournament_id);
 const free=/^(|0|free|nil|-)$/i.test((t.entry_fee||'').trim()),a=JSON.parse(r.answers);
 const room=!t.room_released||!t.room_id?'hidden':(free||r.paid?'show':'unpaid');
 res.render('status',{t,r,room,free,label:a.team_name||a.player_name||a.name||'Player',hasResults:db.prepare('select count(*) c from matches where tournament_id=?').get(t.id).c>0});
});

// ---------- Organizer portal (signup, credits, publish) ----------
const PLANS=require('./plans');
const SIGNUP_CREDITS=process.env.SIGNUP_CREDITS===undefined?1:+process.env.SIGNUP_CREDITS;
const SCAN_LIMIT=+process.env.SCAN_LIMIT||40;
const isFree=f=>/^(|0|free|nil|-)$/i.test(String(f||'').trim());
const needOrg=(req,res,next)=>{const o=orgOf(req);if(!o)return res.redirect('/panel/login');req.org=o;next();};
const RESERVED=['admin','panel','r','uploads','signup','login'];
app.get('/panel/signup',(q,r)=>r.render('org_auth',{mode:'signup',error:null}));
app.get('/panel/login',(q,r)=>r.render('org_auth',{mode:'login',error:null}));
app.get('/panel/logout',(q,r)=>{r.setHeader('Set-Cookie',`org=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${IS_PROD?'; Secure':''}`);r.redirect('/panel/login');});
app.post('/panel/signup',rateLimit('org-signup',{max:5}), (req,res)=>{
 const b=req.body,email=String(b.email||'').trim().toLowerCase(),name=String(b.name||'').trim(),fail=m=>res.status(400).render('org_auth',{mode:'signup',error:m});
 if(!name||name.length>100||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||String(b.password||'').length<12||String(b.password||'').length>128)return fail('Enter a name, a valid email address, and a password between 12 and 128 characters.');
 if(db.prepare('select 1 from organizations where email=?').get(email))return fail('This email address is already registered.');
 let slug=slugify(name);if(RESERVED.includes(slug)||db.prepare('select 1 from organizations where slug=?').get(slug))slug+='-'+crypto.randomBytes(2).toString('hex');
 const id=Number(db.prepare('insert into organizations(slug,name,whatsapp,email,pass_hash,credits) values(?,?,?,?,?,?)').run(slug,name,String(b.whatsapp||''),email,hashPw(String(b.password)),SIGNUP_CREDITS).lastInsertRowid);
 setOrg(res,id);res.redirect('/panel');
});
app.post('/panel/login',rateLimit('org-login',{max:8}), (req,res)=>{
 const o=db.prepare('select * from organizations where email=?').get(String(req.body.email||'').trim().toLowerCase());
 if(!o||!checkPw(String(req.body.password||''),o.pass_hash))return res.status(401).render('org_auth',{mode:'login',error:'Incorrect email or password.'});
 setOrg(res,o.id);res.redirect('/panel');
});
app.get('/panel',needOrg,(req,res)=>{
 const ts=db.prepare('select t.*,(select count(*) from registrations r where r.tournament_id=t.id) regs from tournaments t where org_id=? order by id desc').all(req.org.id);
 res.render('panel',{o:req.org,ts,base:base(req)});
});
app.post('/panel/profile',needOrg,(req,res)=>{
 const upi=String(req.body.upi||'').trim();
 db.prepare('update organizations set upi=?,whatsapp=? where id=?').run(/^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(upi)?upi:'',String(req.body.whatsapp||'').trim(),req.org.id);
 res.redirect('/panel');
});
app.get('/panel/buy',needOrg,(req,res)=>res.render('buy',{o:req.org,plans:PLANS,upi:process.env.PLATFORM_UPI||'',need:!!req.query.need,ok:!!req.query.ok,
 list:db.prepare('select * from purchases where org_id=? order by id desc limit 10').all(req.org.id)}));
app.post('/panel/buy',needOrg,(req,res)=>{
 const p=PLANS.find(x=>x.id===req.body.plan),utr=String(req.body.utr||'').trim().slice(0,40);
 if(!p||utr.length<6)return res.redirect('/panel/buy');
 db.prepare('insert into purchases(org_id,plan,credits,price,utr) values(?,?,?,?,?)').run(req.org.id,p.name,p.credits,p.price,utr);
 res.redirect('/panel/buy?ok=1');
});
app.post('/admin/purchase/:id/approve',(req,res)=>{ // Admin-only action
 const p=db.prepare("select * from purchases where id=? and status='pending'").get(+req.params.id);
 if(p){db.prepare("update purchases set status='approved' where id=?").run(p.id);db.prepare('update organizations set credits=credits+? where id=?').run(p.credits,p.org_id);}
 res.redirect('/admin');
});
app.post('/admin/t/:id/publish',(req,res)=>{
 const t=db.prepare('select * from tournaments where id=?').get(+req.params.id);if(!t)return res.sendStatus(404);
 if(!t.live){
  if(req.isOrg){if(db.prepare('select credits from organizations where id=?').get(t.org_id).credits<1)return res.redirect('/panel/buy?need=1');
   db.prepare('update organizations set credits=credits-1 where id=?').run(t.org_id);}
  db.prepare('update tournaments set live=1 where id=?').run(t.id);
 }
 res.redirect(`${res.locals.p}/t/${t.id}`);
});

// ---------- Public ----------
const findPublic=(o,s)=>{const t=db.prepare(`select t.*,o.slug org_slug,o.name org_name,o.whatsapp org_wa,o.upi org_upi from tournaments t join organizations o on o.id=t.org_id where o.slug=? and t.slug=?`).get(o,s);
 if(t){t.fields=JSON.parse(t.form_fields);t.count=db.prepare('select count(*) c from registrations where tournament_id=?').get(t.id).c;t.hasResults=db.prepare('select count(*) c from matches where tournament_id=?').get(t.id).c>0;
 t.needsPay=!isFree(t.entry_fee)&&!!t.org_upi;const amt=(String(t.entry_fee).match(/\d+/)||[])[0];
 if(t.needsPay)t.fields.forEach(f=>{if(f.key==='payment_ss'){f.required=false;f.label='Payment screenshot (optional; UTR is sufficient)';}}); // A UTR is accepted as proof because some UPI apps block screenshots
 t.upiLink=t.needsPay?`upi://pay?pa=${encodeURIComponent(t.org_upi)}&pn=${encodeURIComponent(t.org_name)}${amt?'&am='+amt:''}&cu=INR`:'';}return t;};
const fullOrClosed=t=>!t.live||t.status!=='open'||(t.slots>0&&t.count>=t.slots);

app.get('/:org/:slug',(req,res)=>{
 const t=findPublic(req.params.org,req.params.slug);if(!t)return res.status(404).render('message',{msg:'Tournament not found.'});
 res.render('tournament',{t,closed:fullOrClosed(t),errors:[],values:{}});
});
app.post('/:org/:slug',rateLimit('registration',{windowMs:60*60*1000,max:20}),upload.any(),csrfMultipart,persistRegistrationUploads,(req,res)=>{
 const t=findPublic(req.params.org,req.params.slug);if(!t){removeUploadedFiles(req);return res.sendStatus(404);}
 if(fullOrClosed(t)){removeUploadedFiles(req);return res.render('tournament',{t,closed:true,errors:[],values:{}});}
 const files=Object.fromEntries((req.files||[]).map(f=>[f.fieldname,f.filename]));
 const answers={},errors=[];
 for(const f of t.fields){
  let v=f.type==='file'?files[f.key]:(f.type==='checkbox'?(req.body[f.key]?'Yes':''):String(req.body[f.key]||'').trim().slice(0,500));
  if(f.required&&!v)errors.push(`${f.label} is required.`);
  if(v)answers[f.key]=v;
 }
 if(t.needsPay){const u=String(req.body.utr||'').replace(/\s/g,'');
  if(!/^\d{12}$/.test(u))errors.push('The UTR must contain exactly 12 digits. Open the transaction in your payment history and look for "UTR" or "UPI Ref No".');
  else if(db.prepare("select 1 from registrations where tournament_id=? and json_extract(answers,'$.utr')=?").get(t.id,u))errors.push('This UTR has already been used.');
  else answers.utr=u;}
 if(errors.length){removeUploadedFiles(req);return res.status(400).render('tournament',{t,closed:false,errors,values:req.body});}
 // Synchronous database operations prevent slots from being oversold between the count check and insert
 const fresh=db.prepare('select count(*) c from registrations where tournament_id=?').get(t.id).c;
 if(t.slots>0&&fresh>=t.slots){removeUploadedFiles(req);return res.render('tournament',{t,closed:true,errors:[],values:{}});}
 const tok=crypto.randomBytes(24).toString('hex');
 db.prepare('insert into registrations(tournament_id,answers,token) values(?,?,?)').run(t.id,JSON.stringify(answers),tok);
 res.render('done',{t,link:`${base(req)}/r/${tok}`});
});
app.use((err,req,res,next)=>{if(err&&err.code==='LIMIT_FILE_SIZE')return res.status(413).render('message',{msg:'The uploaded file exceeds the size limit.'});if(err&&err.code==='LIMIT_FILE_COUNT')return res.status(400).render('message',{msg:'Too many files were uploaded.'});console.error('[request-error]',err&&err.message||'unknown');res.status(500).render('message',{msg:'Something went wrong. Please try again.'});});
app.listen(PORT,()=>console.log('Server running at http://localhost:'+PORT));
