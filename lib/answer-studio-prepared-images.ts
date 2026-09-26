/** Per-run, bounded single-flight cache. Keys include source hash and page ID;
 * context reviews/retries reuse the same encoded pixels. Never global across
 * users, never persisted, and rejected work is immediately evicted.
 */
export function studioPreparedImages<T extends {id:string;hash:string}>(
  prepare:(page:T)=>Promise<string>,maxEntries=8,maxCharacters=24_000_000,
) {
  const entries=new Map<string,{promise:Promise<string>;size:number}>();
  let characters=0;
  const remove=(key:string)=>{const entry=entries.get(key);if(entry){characters-=entry.size;entries.delete(key);}};
  const trim=()=>{while(entries.size>maxEntries||characters>maxCharacters)remove(entries.keys().next().value!);};
  return (page:T):Promise<string>=>{
    const key=JSON.stringify([page.id,page.hash]),hit=entries.get(key);
    if(hit){entries.delete(key);entries.set(key,hit);return hit.promise;}
    const entry={promise:Promise.resolve(''),size:0};
    entry.promise=Promise.resolve().then(()=>prepare(page)).then(image=>{
      if(entries.get(key)===entry){entry.size=image.length;characters+=entry.size;trim();}
      return image;
    },error=>{if(entries.get(key)===entry)remove(key);throw error;});
    entries.set(key,entry);trim();return entry.promise;
  };
}
