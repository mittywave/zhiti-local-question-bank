import type { StudioDraft, StudioPage } from './answer-studio';

type StoredDraft=StudioDraft&{storageRevision?:2};
const imageKey=(owner:string,page:Pick<StudioPage,'id'|'hash'>)=>[owner,page.id,page.hash];
const identity=(page:Pick<StudioPage,'id'|'hash'>)=>JSON.stringify([page.id,page.hash]);
async function database() {
  return new Promise<IDBDatabase>((resolve,reject)=>{
    let blocked=false;
    const request=indexedDB.open('mitty-answer-studio',2);
    request.onupgradeneeded=()=>{
      const db=request.result;
      if(!db.objectStoreNames.contains('drafts'))db.createObjectStore('drafts');
      if(!db.objectStoreNames.contains('pageImages'))db.createObjectStore('pageImages');
    };
    request.onsuccess=()=>{if(blocked){request.result.close();return;}request.result.onversionchange=()=>request.result.close();resolve(request.result);};
    request.onerror=()=>reject(request.error);
    request.onblocked=()=>{blocked=true;reject(new Error('请先关闭旧版转录页签，再重试本地草稿存储升级'));};
  });
}
/** v2 stores immutable source images once. Checkpoints write only metadata and
 * recognition records; image inserts, removals and the draft switch are atomic.
 * Existing v1 drafts read unchanged and migrate on their first successful write.
 */
export async function studioStorage(owner:string,action:'read'|'write'|'delete',value?:StudioDraft):Promise<StudioDraft|null> {
  if(!owner)throw new Error('Login is required to save a draft');
  if(action==='write'&&!value)throw new Error('Missing draft to save');
  // Never structured-clone large image strings on every checkpoint.
  const metadata:StoredDraft|undefined=value?structuredClone({...value,pages:value.pages.map(p=>({...p,image:''})),storageRevision:2 as const}):undefined;
  const sourceImages=new Map(value?.pages.map(p=>[identity(p),p.image]));
  const db=await database();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(['drafts','pageImages'],action==='read'?'readonly':'readwrite');
    const drafts=tx.objectStore('drafts'),images=tx.objectStore('pageImages');
    let result:StudioDraft|null=null,localError:Error|undefined;
    const fail=(message:string)=>{localError=new Error(message);tx.abort();};
    const request=drafts.get(owner);
    request.onsuccess=()=>{
      try {
      const previous=request.result as StoredDraft|undefined;
      if(action==='read'){
        if(!previous)return;
        result=previous;
        if(previous.storageRevision!==2)return;
        delete previous.storageRevision;
        for(const page of previous.pages){
          const image=images.get(imageKey(owner,page));
          image.onsuccess=()=>{
            if(typeof image.result!=='string'||!image.result)fail(`Missing local source image for page ${page.page}; do not overwrite this draft`);
            else page.image=image.result;
          };
        }
        return;
      }
      const oldPages=previous?.storageRevision===2?previous.pages:[];
      const oldKeys=new Set(oldPages.map(identity));
      const newKeys=new Set(action==='write'?metadata!.pages.map(identity):[]);
      // Clean up sources removed by a new import/delete; other owners are untouched.
      for(const page of oldPages)if(!newKeys.has(identity(page)))images.delete(imageKey(owner,page));
      if(action==='delete'){drafts.delete(owner);return;}
      for(const page of metadata!.pages){
        if(oldKeys.has(identity(page)))continue;
        const image=sourceImages.get(identity(page));
        if(!image){fail(`Missing source image for page ${page.page}`);return;}
        images.put(image,imageKey(owner,page));
      }
      drafts.put(metadata,owner);
      }catch(error){localError=error instanceof Error?error:new Error(String(error));tx.abort();}
    };
    tx.oncomplete=()=>{db.close();resolve(result);};
    tx.onabort=tx.onerror=()=>{db.close();reject(localError||tx.error||new Error('Local save failed; preserve your source files'));};
  });
}
