import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { SimulatorModel, SCENARIOS } from './model.js';
import { ciResponse } from './ci-fixture.js';

const assets=new Map([['/simulator/app.js',['app.js','text/javascript']],['/simulator/style.css',['style.css','text/css']]]);
const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Autopilot Simulator</title><link rel="stylesheet" href="/simulator/style.css"></head><body><header>LOCAL SIMULATOR · synthetic scenarios · no ChatGPT account</header><div id="app"></div><script type="module" src="/simulator/app.js"></script></body></html>`;
export async function startSimulator({port=0,file=null}={}) {
  const model=new SimulatorModel({file});let origin;
  const headers=type=>({'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    'Content-Security-Policy':"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});
  const server=createServer(async(req,res)=>{
    const reply=(status,data,type='application/json')=>{res.writeHead(status,headers(type));res.end(type==='application/json'?JSON.stringify(data):data);};
    try {
      // Exact Host thwarts DNS rebinding. JSON + same-origin rejects browser CSRF.
      if(req.headers.host!==new URL(origin).host)return reply(403,{error:'HOST_REJECTED'});
      const url=new URL(req.url,origin),p=url.pathname.split('/').filter(Boolean);
      if(req.method==='GET') {
        if(url.pathname.startsWith('/v1/')||url.pathname.startsWith('/github/')){
          const result=ciResponse(url.pathname,url.searchParams,model.state.ci.ops);
          model.event(null,'ci_query',{path:url.pathname});return reply(result.status,result.data);
        }
        if(assets.has(url.pathname)){const [name,type]=assets.get(url.pathname);return reply(200,readFileSync(new URL(name,import.meta.url)),type);}
        if(url.pathname==='/simulator/api')return reply(200,{...model.snapshot(),scenarios:SCENARIOS});
        if(p[0]==='simulator'&&p[1]==='api'&&p[2]==='rooms'&&p.length===4)return reply(200,model.view(p[3]));
        if(/^\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)$/.test(url.pathname)){
          const id=p.at(-1);if(model.url(id)!==url.pathname)return reply(404,{error:'ROUTE_MISMATCH'});
          model.navigate(id);return reply(200,html,'text/html');
        }
        if(url.pathname==='/'||/^\/g\/g-p-[^/]+\/project$/.test(url.pathname))return reply(200,html,'text/html');
        return reply(404,{error:'NOT_FOUND'});
      }
      if(req.method!=='POST')return reply(405,{error:'METHOD_NOT_ALLOWED'});
      if(req.headers.origin!==origin||req.headers['content-type']!=='application/json')return reply(403,{error:'ORIGIN_REJECTED'});
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>131072)throw Error('BODY_TOO_LARGE');}
      const input=JSON.parse(raw);if(!input||Array.isArray(input)||typeof input!=='object')throw Error('INVALID_BODY');
      if(p[0]==='simulator'&&p[1]==='api'&&p[2]==='projects'&&p.length===4)return reply(200,model.setProjectRenderer(p[3],input.renderer));
      if(url.pathname==='/simulator/api/rooms'){const r=model.create(input);return reply(200,{...r,url:model.url(r.id)});}
      if(p[0]==='simulator'&&p[1]==='api'&&p[2]==='rooms'&&p.length===5){
        const id=p[3],action=p[4];
        if(action==='scenario')return reply(200,model.patch(id,input));
        if(action==='messages')return reply(200,model.send(id,input));
        if(action==='stop')return reply(200,model.stop(id));
        if(action==='title')return reply(200,model.patch(id,{title:input.title}));
      }
      if(p[0]==='simulator'&&p[1]==='api'&&p[2]==='ci'&&p.length===4)return reply(200,model.setCI(p[3],input));
      return reply(404,{error:'NOT_FOUND'});
    }catch(error){return reply(400,{error:error.message});}
  });
  await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});
  origin='http://127.0.0.1:'+server.address().port;
  return {origin,model,close:()=>new Promise((ok,no)=>{server.closeAllConnections();server.close(e=>e?no(e):ok());})};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const instance=await startSimulator({port:Number(process.env.SIMULATOR_PORT??48273),file:resolve(process.env.SIMULATOR_STATE??'.autopilot/simulator/state.json')});
  console.log(JSON.stringify({kind:'simulator',origin:instance.origin}));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>instance.close().then(()=>process.exit(0)));
}
