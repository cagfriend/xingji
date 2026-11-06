const DB='xingji-photo-cache';
function openDb(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB,1);req.onupgradeneeded=()=>req.result.createObjectStore('photos');req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function getBlob(key){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction('photos');const req=tx.objectStore('photos').get(key);req.onsuccess=()=>resolve(req.result??null);req.onerror=()=>reject(req.error);tx.oncomplete=()=>db.close();tx.onerror=()=>db.close();});}
async function putBlob(key,value){const db=await openDb();return new Promise((resolve,reject)=>{const tx=db.transaction('photos','readwrite');tx.objectStore('photos').put(value,key);tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>{db.close();reject(tx.error);};tx.onabort=()=>{db.close();reject(tx.error);};});}
export function createPhotoCache({native,localFiles,convertFileSrc}){
 const urls=new Map();
 return async function cachePhoto(photo,{force=false,previousPhoto}={}){
  if(!photo||typeof photo!=='object')return photo;
  const remote=photo.remoteImage||photo.image;
  const previous=previousPhoto??photo;
  let fallback=null;
  if(previous.localUri?.startsWith('file:')){
   if(native){try{const check=await localFiles.call({action:'photoExists',uri:previous.localUri});if(check?.exists)fallback={...previous,image:convertFileSrc(previous.localUri)};}catch{}}
  } else if(previous.localUri?.startsWith('idb:')){
   try{const blob=await getBlob(previous.localUri.slice(4));if(blob){const image=urls.get(previous.localUri)||URL.createObjectURL(blob);urls.set(previous.localUri,image);fallback={...previous,image};}}catch{}
  }
  if(fallback&&!force)return fallback;
  if(!remote)return fallback||photo;
  const candidates=[remote,photo.thumbnail].filter((v,i,a)=>v&&!a.slice(0,i).includes(v));
  for(const candidate of candidates){
   try{
    if(native){const result=await localFiles.call({action:'cachePhoto',url:candidate,force});return {...photo,image:convertFileSrc(result.localUri),remoteImage:remote,localUri:result.localUri,cachedImage:candidate};}
    const response=await fetch(candidate);if(!response.ok)throw new Error('下载失败');const blob=await response.blob();if(blob.size>4*1024*1024)throw new Error('照片超过 4 MB');
    const id=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(candidate)).then(buf=>[...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,'0')).join(''));
    await putBlob(id,blob);const localUri=`idb:${id}`;const image=URL.createObjectURL(blob);urls.set(localUri,image);return {...photo,image,remoteImage:remote,localUri,cachedImage:candidate};
   }catch{}
  }
  return fallback||{...photo,image:remote,remoteImage:remote};
 };
}
