import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export const SCENARIOS = Object.freeze(['normal','generating','loading-error','conversation-error','disconnect','ci','cost','local-test','approval','length','quota','writing','ambiguous']);
export const CUES = Object.freeze({normal:'작업을 완료했습니다. 다음 작업이 남아 있습니다.',ci:'CI 확인 중입니다.',cost:'추가 비용 결제가 필요합니다.', 'local-test':'로컬 Windows 테스트가 필요합니다.',approval:'승인이 필요합니다.'});
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
const text = (value,max=30000) => { if(typeof value!=='string'||value.length>max)throw Error('INVALID_TEXT');return value; };
const integer = (value,max=3600000) => {if(!Number.isSafeInteger(value)||value<0||value>max)throw Error('INVALID_DELAY');return value;};
const copy = value => structuredClone(value);

// Only simulator-owned content is persisted. No account import or network fetch.
export class SimulatorModel {
  constructor({file=null,now=()=>Date.now()}={}) {
    this.file=file;this.now=now;
    this.state=file&&existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{version:1,sequence:0,rooms:{},events:[],ci:{}};
    if(this.state.version!==1)throw Error('SIMULATOR_STATE_VERSION');
  }
  save(){if(!this.file)return;mkdirSync(dirname(this.file),{recursive:true});writeFileSync(this.file+'.tmp',JSON.stringify(this.state));renameSync(this.file+'.tmp',this.file);}
  event(room,type,data={}){this.state.events.push({sequence:++this.state.sequence,at:this.now(),roomId:room?.id??null,type,...data});this.save();}
  room(id){if(!validId(id)||!this.state.rooms[id])throw Error('ROOM_NOT_FOUND');return this.state.rooms[id];}
  create(input={}) {
    const id=input.id??'sim-'+String(++this.state.sequence);
    if(!validId(id)||this.state.rooms[id])throw Error('INVALID_OR_DUPLICATE_ROOM');
    const project=input.project??null;if(project!==null&&(!validId(project)||!project.startsWith('g-p-')))throw Error('INVALID_PROJECT');
    const room={id,project,title:text(input.title??'Simulator 1',160),scenario:'normal',renderer:input.renderer??'current',
      turns:input.empty===true?[]:[{id:id+'-initial',userId:id+'-user-0',assistantId:id+'-reply-0',user:'Owned simulator request',answer:CUES.normal,state:'complete',readyAt:0}],
      responses:[],messages:[],requests:{},reloads:0,navigations:0,stops:0,recoverOnReload:true,duplicate:false,reverse:false,revision:0};
    if(!['current','legacy'].includes(room.renderer))throw Error('INVALID_RENDERER');
    this.state.rooms[id]=room;
    try{this.patch(id,input);}catch(error){delete this.state.rooms[id];throw error;}
    this.event(room,'created');return this.view(id);
  }
  patch(id,input={}) {
    const r=copy(this.room(id)),last=r.turns.at(-1);
    if(input.scenario!==undefined){if(!SCENARIOS.includes(input.scenario))throw Error('INVALID_SCENARIO');r.scenario=input.scenario;}
    if(input.answer!==undefined){const value=text(input.answer);if(last)last.answer=value;}
    else if(CUES[r.scenario]&&last)last.answer=CUES[r.scenario];
    for(const k of ['recoverOnReload','duplicate','reverse'])if(input[k]!==undefined){if(typeof input[k]!=='boolean')throw Error('INVALID_BOOLEAN');r[k]=input[k];}
    if(input.responses!==undefined){
      if(!Array.isArray(input.responses)||input.responses.length>100)throw Error('INVALID_RESPONSES');
      r.responses=input.responses.map(v=>({answer:text(v.answer??CUES.normal),delayMs:integer(v.delayMs??1000),scenario:v.scenario??'normal'}));
      if(r.responses.some(v=>!SCENARIOS.includes(v.scenario)))throw Error('INVALID_SCENARIO');
    }
    if(input.title!==undefined)r.title=text(input.title,160);
    if(input.draft!==undefined)r.draft=text(input.draft,1000);
    if(last){last.state=['generating','disconnect'].includes(r.scenario)?'streaming':'complete';last.readyAt=0;}
    r.revision++;this.state.rooms[id]=r;this.event(r,'scenario',{scenario:r.scenario});return this.view(id);
  }
  navigate(id){const r=this.room(id);r.navigations++;if(r.scenario==='loading-error'&&r.navigations>1){r.reloads++;if(r.recoverOnReload){r.scenario='normal';r.revision++;}}this.event(r,'navigation');return this.view(id);}
  settle(r){const t=r.turns.at(-1);if(t?.readyAt&&this.now()>=t.readyAt){t.readyAt=0;t.state='complete';r.scenario=t.afterScenario??'normal';r.revision++;this.event(r,'completed',{assistantId:t.assistantId});}}
  send(id,input){
    const r=this.room(id);this.settle(r);
    if(!validId(input.requestId))throw Error('INVALID_REQUEST_ID');
    // Server dedup is a second assertion surface, not a replacement for engine dedup.
    if(r.requests[input.requestId])return copy(r.requests[input.requestId]);
    if(r.turns.at(-1)&&r.turns.at(-1).state!=='complete')throw Error('STILL_GENERATING');
    const message=text(input.message);if(!message.trim())throw Error('EMPTY_MESSAGE');
    const n=r.messages.length+1,response=r.responses.shift()??{answer:CUES.normal,delayMs:1000,scenario:'normal'};
    r.messages.push({requestId:input.requestId,message,at:this.now()});
    r.turns.push({id:id+'-turn-'+n,userId:id+'-user-'+n,assistantId:id+'-reply-'+n,user:message,answer:response.answer,
      state:'streaming',readyAt:this.now()+response.delayMs,afterScenario:response.scenario});r.scenario='generating';r.revision++;
    const result={accepted:true,userId:r.turns.at(-1).userId};r.requests[input.requestId]=result;this.event(r,'send',{requestId:input.requestId});return copy(result);
  }
  stop(id){const r=this.room(id);if(r.turns.at(-1).state!=='complete'){r.stops++;r.turns.at(-1).state='complete';r.turns.at(-1).readyAt=0;r.scenario='normal';r.revision++;this.event(r,'stop');}return this.view(id);}
  view(id){const r=this.room(id);this.settle(r);return copy(r);}
  snapshot(){return {version:1,kind:'synthetic-chatgpt-simulator',rooms:Object.keys(this.state.rooms).map(id=>this.view(id)),events:copy(this.state.events),ci:copy(this.state.ci)};}
  url(id){const r=this.room(id);return r.project?'/g/'+r.project+'/c/'+r.id:'/c/'+r.id;}
  setCI(key,input){if(!validId(key)||!['running','success','failure','unknown'].includes(input.state))throw Error('INVALID_CI');this.state.ci[key]=copy(input);this.event(null,'ci',{key});return copy(input);}
}
