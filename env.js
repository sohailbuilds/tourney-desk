// Load .env files consistently across Node.js versions and handle common Windows text-file formatting issues.
const fs=require('fs'),path=require('path');
module.exports=function load(dir){
 for(const name of ['.env','.env.txt']){
  const f=path.join(dir,name);if(!fs.existsSync(f))continue;
  let n=0;
  for(const line of fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'').split(/\r?\n/)){
   if(line.trim().startsWith('#'))continue;
   const m=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);if(!m)continue;
   let v=m[2];if(/^(['"]).*\1$/.test(v))v=v.slice(1,-1);else v=v.replace(/\s+#.*$/,'');
   if(v===''||process.env[m[1]])continue; // Ignore empty values; existing environment variables take precedence.
   process.env[m[1]]=v;n++;
  }
  console.log(`[.env] Loaded ${name}; found ${n} settings (${f})`);return;
 }
 console.log('[.env] File not found. Expected location: '+path.join(dir,'.env'));
};
