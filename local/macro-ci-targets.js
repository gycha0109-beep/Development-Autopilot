// Pure dependency expansion for GitHub CI polling. Keep primary and
// additional repositories independent; never infer an extra target as primary.
export function macroCiTargets(rows){
  const unique=new Map();
  for(const item of rows||[]){
    if(item?.mode!=="auto")continue;
    const candidates=[
      {repository:item.repository,branch:item.ci_branch},
      ...parseObservers(item.ci_observers_json)
    ];
    for(const target of candidates){
      if(!target?.repository||!target.branch)continue;
      const key=target.repository.toLowerCase()+"\0"+target.branch;
      if(!unique.has(key))unique.set(key,{
        repository:target.repository,branch:target.branch
      });
    }
  }
  return [...unique.values()];
}
function parseObservers(value){
  try{
    const parsed=typeof value==="string"?JSON.parse(value):value;
    return Array.isArray(parsed)?parsed:[];
  }catch{return [];}
}
