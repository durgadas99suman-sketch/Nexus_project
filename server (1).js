// NEXUS server: zero dependencies, Node 20+. Real files, real shell, streaming Claude agent loop.
const http=require('http'),fs=require('fs'),fsp=fs.promises,path=require('path'),{spawn}=require('child_process'),crypto=require('crypto');
const E=process.env,PORT=E.PORT||3000,TOKEN=E.ACCESS_TOKEN||'',DATA=E.DATA_DIR||path.join(__dirname,'data'),WS=path.join(DATA,'workspace'),SD=path.join(DATA,'sessions');
const MODEL=E.MODEL||'claude-sonnet-5-5',CTX=+E.CTX_LIMIT||180000,THINK=E.THINKING||'adaptive',MAXT=+E.MAX_STEPS||60;
[WS,SD].forEach(d=>fs.mkdirSync(d,{recursive:true}));
process.on('unhandledRejection',e=>console.error(e));
const CE={...E};['ANTHROPIC_API_KEY','ANTHROPIC_API_KEY_2','ACCESS_TOKEN'].forEach(k=>delete CE[k]); // keep secrets out of agent shells
const P=p=>{const a=path.resolve(WS,String(p||'.'));if(a!==WS&&!a.startsWith(WS+path.sep))throw Error('Path is outside the workspace: '+p);return a};
const q=s=>"'"+String(s).replace(/'/g,"'\\''")+"'";
const cut=s=>s.length>30000?s.slice(0,12000)+`\n…[${s.length-27000} chars cut]…\n`+s.slice(-15000):s;
const walk=async(d,o=[])=>{for(const e of await fsp.readdir(d,{withFileTypes:true})){if(e.name==='node_modules'||e.name==='.git')continue;const f=path.join(d,e.name);e.isDirectory()?await walk(f,o):o.push(path.relative(WS,f))}return o};
const g2re=g=>new RegExp('^'+g.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*\*\//g,'\u0001').replace(/\*\*/g,'.*').replace(/\*/g,'[^/]*').replace(/\?/g,'[^/]').replace(/\u0001/g,'(?:.*/)?')+'$');
const sh=(cmd,ms,onData,signal)=>new Promise(r=>{const c=spawn('bash',['-lc',cmd],{cwd:WS,env:CE,detached:true});let o='';const kill=()=>{try{process.kill(-c.pid,'SIGKILL')}catch{}},t=setTimeout(()=>{o+='\n[timed out after '+ms/1000+'s]';kill()},ms),g=d=>{if(o.length<2e6)o+=d;onData&&onData(String(d))};signal&&signal.addEventListener('abort',kill,{once:true});c.stdout.on('data',g);c.stderr.on('data',g);c.on('error',e=>{clearTimeout(t);r({code:-1,o:String(e)})});c.on('close',code=>{clearTimeout(t);r({code,o})})});
/* ---------- tools: every call runs for real ---------- */
const str={type:'string'},num={type:'number'},bool={type:'boolean'},obj=(properties,required=[])=>({type:'object',properties,required});
const TOOLS={
read:{d:'Read a text file; returns numbered lines. Use offset/limit for big files.',s:obj({path:str,offset:num,limit:num},['path']),ro:1,
 f:async a=>{const L=(await fsp.readFile(P(a.path),'utf8')).split('\n'),o=Math.max(1,a.offset|0||1),n=Math.min(a.limit|0||2000,2000),e=o-1+n;return L.slice(o-1,e).map((l,i)=>(o+i)+'\t'+l).join('\n')+(e<L.length?`\n[${L.length-e} more lines; continue with offset=${e+1}]`:'')}},
write:{d:'Create or overwrite a file (creates folders). Prefer multi_edit to change existing files.',s:obj({path:str,content:str},['path','content']),
 f:async a=>{const f=P(a.path);await fsp.mkdir(path.dirname(f),{recursive:true});await fsp.writeFile(f,a.content);return`Wrote ${a.path} (${a.content.split('\n').length} lines)`}},
multi_edit:{d:'Apply many edits across one or MORE files in a single atomic call: all succeed or nothing is written. Each edit is {path, old, new, all?}. old must match exactly once unless all:true; edits to the same file apply in order. An empty old on a missing file creates it with new.',
 s:obj({edits:{type:'array',items:obj({path:str,old:str,new:str,all:bool},['path','old','new'])}},['edits']),
 f:async a=>{const E=a.edits,W=new Map(),errs=[];if(!Array.isArray(E)||!E.length)throw Error('edits[] is required');
  for(const[i,e]of E.entries()){try{if(typeof e.old!=='string'||typeof e.new!=='string')throw Error('old and new must be strings');const f=P(e.path);if(!W.has(f))W.set(f,await fsp.readFile(f,'utf8').catch(()=>null));const c=W.get(f);
   if(c===null){if(e.old!=='')throw Error('file not found');W.set(f,e.new);continue}
   if(e.old==='')throw Error('old is empty but the file exists; use write');
   const n=c.split(e.old).length-1;if(!n)throw Error('old text not found');if(n>1&&!e.all)throw Error(`old matches ${n} places; add context or set all:true`);
   W.set(f,e.all?c.split(e.old).join(e.new):c.replace(e.old,()=>e.new))}catch(x){errs.push(`edit ${i+1} (${e.path}): ${x.message}`)}}
  if(errs.length)throw Error('Nothing was written.\n'+errs.join('\n'));
  for(const[f,c]of W){await fsp.mkdir(path.dirname(f),{recursive:true});await fsp.writeFile(f,c)}
  return`Applied ${E.length} edit(s) to ${W.size} file(s): ${[...W.keys()].map(f=>path.relative(WS,f)).join(', ')}`}},
glob:{d:'List files matching a glob such as "src/**/*.js" (default "**/*"). Skips node_modules and .git.',s:obj({pattern:str}),ro:1,
 f:async a=>{const re=g2re(a.pattern||'**/*'),o=(await walk(WS)).filter(p=>re.test(p)).sort();return o.length?o.slice(0,500).join('\n')+(o.length>500?`\n[${o.length-500} more]`:''):'(no matches)'}},
grep:{d:'Search file contents with an extended regex (grep -E). Optional path and include glob like "*.js". Returns file:line:text.',s:obj({pattern:str,path:str,include:str},['pattern']),ro:1,
 f:async(a,c)=>{const d=path.relative(WS,P(a.path||'.'))||'.',r=await sh(`grep -rnIE --exclude-dir=node_modules --exclude-dir=.git ${a.include?'--include='+q(a.include):''} -e ${q(a.pattern)} ${q(d)} | head -150`,30000,null,c.signal);return r.o.trim()||'(no matches)'}},
bash:{d:'Run a shell command in the workspace (bash on real Linux: git, node, npm, python3, curl...). Non-interactive. Optional timeout in seconds (default 120, max 600). Fails the call on a non-zero exit.',s:obj({command:str,timeout:num},['command']),
 f:async(a,c)=>{const r=await sh(a.command,Math.min(a.timeout||120,600)*1000,c.out,c.signal);if(r.code)throw Error('exit '+r.code+'\n'+r.o);return r.o||'(no output)'}},
todo:{d:'Set the visible task checklist: todos:[{text,status:pending|in_progress|done}]. Use for tasks with 3+ steps and keep it current.',s:obj({todos:{type:'array',items:obj({text:str,status:{type:'string',enum:['pending','in_progress','done']}},['text','status'])}},['todos']),
 f:async(a,c)=>{c.s.todos=a.todos;return'Todo list updated'}},
fetch_url:{d:'Fetch a URL and return its readable text (first 20k chars).',s:obj({url:str},['url']),ro:1,
 f:async a=>{const r=await fetch(a.url,{signal:AbortSignal.timeout(20000)});return(await r.text()).replace(/<(script|style)[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,20000)}}};
async function run(u,emit,signal,s){const T=TOOLS[u.name],t0=Date.now();emit({t:'tool_start',id:u.id,name:u.name,input:u.input});let ok=true,out;
 try{if(!T)throw Error('Unknown tool: '+u.name);out=await T.f(u.input||{},{out:d=>emit({t:'tool_out',id:u.id,d}),signal,s})}catch(e){ok=false;out='ERROR: '+e.message}
 out=cut(String(out==null?'':out));emit({t:'tool_result',id:u.id,ok,ms:Date.now()-t0,out:out.slice(0,8000)});
 return{type:'tool_result',tool_use_id:u.id,content:out||'(empty)',...(ok?{}:{is_error:true})}}
/* ---------- sessions: the full API transcript (thinking blocks included) is stored ---------- */
const sp=id=>path.join(SD,id+'.json'),loadS=async id=>{try{return JSON.parse(await fsp.readFile(sp(id),'utf8'))}catch{return{id,title:'',ts:Date.now(),messages:[],todos:[]}}},saveS=s=>{s.ts=Date.now();return fsp.writeFile(sp(s.id),JSON.stringify(s))};
/* Keep all thinking. When the context passes 70%, strip thinking from the OLDEST replies first (never the last two).
   Only if that is not enough, shorten the oldest tool outputs. */
const est=M=>Math.ceil(JSON.stringify(M).length/3.5);
function prune(M,emit){let n=est(M);if(n<CTX*.7)return;let th=0,rs=0;
 for(const i of M.flatMap((m,i)=>m.role==='assistant'?[i]:[]).slice(0,-2)){if(n<CTX*.55)break;const c=M[i].content.filter(x=>x.type!=='thinking'&&x.type!=='redacted_thinking');if(c.length<M[i].content.length){th+=M[i].content.length-c.length;M[i].content=c.length?c:[{type:'text',text:'…'}];n=est(M)}}
 for(let i=0;i<M.length-6&&n>=CTX*.7;i++){const m=M[i];if(m.role==='user'&&Array.isArray(m.content)){for(const b of m.content)if(b.type==='tool_result'&&typeof b.content==='string'&&b.content.length>400){b.content=b.content.slice(0,300)+'\n…[older output removed to save context]';rs++}n=est(M)}}
 if(th||rs)emit({t:'pruned',thinking:th,results:rs})}
const cached=M=>{const l=M[M.length-1],c=typeof l.content==='string'?[{type:'text',text:l.content}]:l.content.slice();c[c.length-1]={...c[c.length-1],cache_control:{type:'ephemeral'}};return[...M.slice(0,-1),{...l,content:c}]};
const sysText=async()=>{let pi='';for(const n of['NEXUS.md','CLAUDE.md'])try{pi='\n\nProject instructions ('+n+'):\n'+(await fsp.readFile(path.join(WS,n),'utf8')).slice(0,4000);break}catch{}
return`You are NEXUS, a coding agent in a real Linux workspace on a server (cwd = project root). Tools act on real files and run real commands; nothing is simulated.
- Explore with glob, grep and read, not bash cat or find. Read a file before editing it.
- Change code with multi_edit: put every edit, across all files, into ONE call (it is atomic). Use write only for new files.
- Call independent tools in the same turn so they run in parallel.
- For work with 3 or more steps, keep the todo list current.
- Run builds and tests with bash and fix failures before you say you are done.
- Be concise. Report only what tool results confirm.
Date: ${new Date().toISOString().slice(0,10)}. Node ${process.version}.${pi}`};
/* ---------- Claude streaming (key order: user's local key, Render key, Render backup key) ---------- */
const TMS=THINK==='off'?[null]:/^\d+$/.test(THINK)?[{type:'enabled',budget_tokens:+THINK},null]:[{type:'adaptive'},{type:'enabled',budget_tokens:12000},null];let tmi=0;
async function stream(body,keys,signal,emit){let last='';
 for(const[src,key]of keys){
  const r=await fetch(E.ANTHROPIC_BASE_URL||'https://api.anthropic.com/v1/messages',{method:'POST',signal,headers:{'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify(body)});
  if(!r.ok){const tx=await r.text();last=`${src} key: HTTP ${r.status} ${tx.slice(0,200)}`;if([401,403,429,500,502,503,529].includes(r.status)){emit({t:'keyfail',src,m:last});continue}const e=Error(last);e.status=r.status;e.body=tx;throw e}
  emit({t:'key',src});
  const rd=r.body.getReader(),dec=new TextDecoder(),B=[];let buf='',stop,usage={};
  for(;;){const{done,value}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;
   while((i=buf.indexOf('\n\n'))>=0){const ev=buf.slice(0,i);buf=buf.slice(i+2);const dl=ev.split('\n').find(l=>l.startsWith('data:'));if(!dl)continue;let j;try{j=JSON.parse(dl.slice(5))}catch{continue}
    if(j.type==='message_start')usage={...j.message.usage};
    else if(j.type==='content_block_start'){B[j.index]={...j.content_block};if(j.content_block.type==='tool_use'){B[j.index]._j='';emit({t:'compose',name:j.content_block.name})}}
    else if(j.type==='content_block_delta'){const b=B[j.index],d=j.delta;
     if(d.type==='text_delta'){b.text+=d.text;emit({t:'text',d:d.text})}
     else if(d.type==='thinking_delta'){b.thinking+=d.thinking;emit({t:'think',d:d.thinking})}
     else if(d.type==='signature_delta')b.signature=(b.signature||'')+d.signature;
     else if(d.type==='input_json_delta')b._j+=d.partial_json}
    else if(j.type==='content_block_stop'){const b=B[j.index];if(b&&b.type==='tool_use'){try{b.input=JSON.parse(b._j||'{}')}catch{b.input={}}delete b._j}}
    else if(j.type==='message_delta'){stop=j.delta.stop_reason;Object.assign(usage,j.usage)}
    else if(j.type==='error')throw Error((j.error&&j.error.message)||'stream error')}}
  return{blocks:B.filter(Boolean),stop,usage}}
 throw Error('Every API key failed. Last: '+last)}
const busy=new Set();
async function chat(req,res){
 const b=await rb(req),id=b.session;
 if(!/^[\w-]{1,40}$/.test(id||'')||!String(b.text||'').trim())return send(res,400,{error:'session and text are required'});
 if(busy.has(id))return send(res,409,{error:'This chat is already running.'});
 const keys=[['local',req.headers['x-user-key']],['render',E.ANTHROPIC_API_KEY],['render-2',E.ANTHROPIC_API_KEY_2]].filter(k=>k[1]);
 res.writeHead(200,{'content-type':'application/x-ndjson','cache-control':'no-cache','x-accel-buffering':'no'});
 const emit=o=>res.writable&&res.write(JSON.stringify(o)+'\n'),ac=new AbortController(),hb=setInterval(()=>emit({t:'hb'}),15000);
 res.on('close',()=>ac.abort());busy.add(id);
 const s=await loadS(id);
 try{
  if(!keys.length)throw Error('No API key. Add yours in Settings, or set ANTHROPIC_API_KEY on Render.');
  s.messages.push({role:'user',content:String(b.text)});s.title=s.title||String(b.text).slice(0,50);
  const sys=await sysText(),TL=Object.entries(TOOLS).map(([name,t],i,a)=>({name,description:t.d,input_schema:t.s,...(i===a.length-1?{cache_control:{type:'ephemeral'}}:{})}));
  for(let n=0;n<MAXT&&!ac.signal.aborted;n++){
   prune(s.messages,emit);
   const mk=th=>({model:b.model||MODEL,max_tokens:32000,stream:true,system:[{type:'text',text:sys,cache_control:{type:'ephemeral'}}],tools:TL,messages:cached(s.messages),...(th?{thinking:th}:{})});
   let r;for(;;){try{r=await stream(mk(TMS[tmi]),keys,ac.signal,emit);break}catch(e){if(e.status===400&&/think/i.test(e.body||'')&&tmi<TMS.length-1){tmi++;continue}throw e}}
   s.messages.push({role:'assistant',content:r.blocks.filter(x=>x.type!=='text'||x.text.trim())});
   const u=r.usage;emit({t:'usage',used:(u.input_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0),ctx:CTX});
   const uses=r.blocks.filter(x=>x.type==='tool_use');if(!uses.length)break;
   const ro=uses.every(x=>TOOLS[x.name]&&TOOLS[x.name].ro),rs=[];
   if(ro)rs.push(...await Promise.all(uses.map(x=>run(x,emit,ac.signal,s))));else for(const x of uses)rs.push(await run(x,emit,ac.signal,s));
   s.messages.push({role:'user',content:rs});await saveS(s)}
 }catch(e){if(!ac.signal.aborted)emit({t:'error',m:e.message})}
 finally{const l=s.messages[s.messages.length-1];if(l&&l.role==='assistant'&&Array.isArray(l.content)){const t=l.content.filter(x=>x.type==='tool_use');if(t.length)s.messages.push({role:'user',content:t.map(x=>({type:'tool_result',tool_use_id:x.id,content:'[interrupted before this tool ran]',is_error:true}))})}
  await saveS(s).catch(()=>{});busy.delete(id);clearInterval(hb);emit({t:'done'});res.end()}}
/* ---------- http ---------- */
const send=(r,c,o)=>{r.writeHead(c,{'content-type':'application/json'});r.end(JSON.stringify(o))};
const rb=req=>new Promise(r=>{let b='';req.on('data',d=>b+=d);req.on('end',()=>{try{r(JSON.parse(b||'{}'))}catch{r({})}})});
const authed=req=>{const a=Buffer.from((req.headers.authorization||'').slice(7)),b=Buffer.from(TOKEN);return!!TOKEN&&a.length===b.length&&crypto.timingSafeEqual(a,b)};
http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://x'),p=u.pathname;
 if(p==='/healthz')return res.end('ok');
 if(!p.startsWith('/api/')){res.writeHead(200,{'content-type':'text/html;charset=utf-8'});return res.end(await fsp.readFile(path.join(__dirname,'public','index.html')))}
 if(!TOKEN)return send(res,503,{error:'Set the ACCESS_TOKEN environment variable on the server.'});
 if(!authed(req))return send(res,401,{error:'Wrong access token.'});
 if(p==='/api/config')return send(res,200,{model:MODEL,render:!!E.ANTHROPIC_API_KEY,ctx:CTX,thinking:THINK});
 if(p==='/api/files')return send(res,200,{files:(await walk(WS)).sort().slice(0,1000)});
 if(p==='/api/file')return send(res,200,{text:(await fsp.readFile(P(u.searchParams.get('p')),'utf8')).slice(0,300000)});
 if(p==='/api/sessions'){const o=[];for(const f of await fsp.readdir(SD)){try{const s=JSON.parse(await fsp.readFile(path.join(SD,f),'utf8'));o.push({id:s.id,title:s.title||'New chat',ts:s.ts})}catch{}}return send(res,200,{sessions:o.sort((a,b)=>b.ts-a.ts)})}
 if(p==='/api/session'){const id=u.searchParams.get('id')||'';if(!/^[\w-]{1,40}$/.test(id))return send(res,400,{error:'bad id'});return send(res,200,await loadS(id))}
 if(p==='/api/chat'&&req.method==='POST')return chat(req,res);
 send(res,404,{error:'Not found'})}catch(e){if(!res.headersSent)send(res,500,{error:e.message});else res.end()}}).listen(PORT,()=>console.log('NEXUS listening on :'+PORT+(TOKEN?'':' (ACCESS_TOKEN is not set: API is locked)')));
