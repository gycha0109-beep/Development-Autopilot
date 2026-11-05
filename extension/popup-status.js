// Fast, read-only popup data path. It must never enter the serialized
// bridgeSync / chat dispatch queue or mutate the registry.
import {STORAGE_KEY, normalizedRegistry} from "./core.js";
import {BRIDGE_CONFIG_KEY, BRIDGE_BASE} from "./bridge-core.js";
import {classifyChatGPTRoute} from "./chat-routes.js";

export async function readPopupStatus({
  chromeApi=chrome,
  fetchImpl=fetch,
  timeoutMs=4500
}={}){
  const [allTabs,stored,allGroups]=await Promise.all([
    chromeApi.tabs.query({}),
    chromeApi.storage.local.get([STORAGE_KEY,BRIDGE_CONFIG_KEY]),
    chromeApi.tabGroups?.query?chromeApi.tabGroups.query({}).catch(()=>[]):[]
  ]);
  const registry=normalizedRegistry(stored?.[STORAGE_KEY]);
  const config=stored?.[BRIDGE_CONFIG_KEY];
  const tabs=allTabs.filter(t=>Number.isInteger(t?.id)&&
      classifyChatGPTRoute(t.url)==="existing")
    .map(t=>({id:t.id,title:t.title||"",url:t.url,active:t.active===true,
      groupId:t.groupId??-1,groupTitle:allGroups.find(g=>g.id===t.groupId)?.title||""}));
  const base={
    tabs, registry:{sessions:registry.sessions},
    paired:Boolean(config?.token),connected:false,
    sessions:[],repositories:[],repositoryDirectory:null,
    globalStopped:false,error:""
  };
  if(!config?.token)
    return {...base,error:"로컬 서버와 연결되지 않았습니다. 관리 화면에서 연결을 확인하세요."};

  // An unresponsive local server must never hide the browser chat list.
  const controller=new AbortController();
  let timer;
  const deadline=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      controller.abort();
      reject(Error("POPUP_LOCAL_SERVER_TIMEOUT"));
    },timeoutMs);
  });
  try{
    const response=await Promise.race([
      fetchImpl(BRIDGE_BASE+"/api/v1/bridge/macro-state",{
        method:"POST",
        headers:{"Content-Type":"application/json",
          Authorization:"Bearer "+config.token},
        body:"{}",
        signal:controller.signal
      }),
      deadline
    ]);
    if(!response.ok)throw Error("POPUP_LOCAL_SERVER_HTTP_"+response.status);
    const result=await Promise.race([response.json(),deadline]);
    if(!Array.isArray(result?.sessions)||
       typeof result.globalStopped!=="boolean")
      throw Error("POPUP_LOCAL_SERVER_INVALID_STATE");
    return {...base,connected:true,
      sessions:result.sessions,
      repositories:Array.isArray(result.repositories)?result.repositories:[],
      repositoryDirectory:result.repositoryDirectory||null,
      globalStopped:result.globalStopped};
  }catch(error){
    return {...base,error:String(error?.message||"POPUP_LOCAL_SERVER_UNAVAILABLE")};
  }finally{
    clearTimeout(timer);
  }
}
