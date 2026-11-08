const empty=()=>({ids:[],sizes:{},request:null});
const key=account=>'duallink.screenshot-draft.'+account;
export function readScreenshotDraft(storage,account){
  if(!account)return empty();
  try{
    const saved=JSON.parse(storage.getItem(key(account))||'null');
    if(!saved||!Array.isArray(saved.ids)||saved.ids.length>20)return empty();
    const ids=[...new Set(saved.ids.filter(id=>typeof id==='string'&&id.length>0&&id.length<=100))];
    const sizes=Object.fromEntries(ids.filter(id=>Number.isFinite(saved.sizes?.[id])&&saved.sizes[id]>=0).map(id=>[id,saved.sizes[id]]));
    const request=typeof saved.request?.requestId==='string'&&typeof saved.request?.signature==='string'&&saved.request.signature.length<40000?{requestId:saved.request.requestId,signature:saved.request.signature}:null;
    return {ids,sizes,request};
  }catch{return empty();}
}
export function writeScreenshotDraft(storage,account,draft){
  if(!account)return;
  try{storage.setItem(key(account),JSON.stringify(draft));}catch{}
}
