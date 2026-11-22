import {API_BASE_URL} from './client-config.js';

export function normalizeApiBase(value='',{production=false}={}){
  if(typeof value!=='string')throw new Error('The backend URL must be text.');
  const base=value.trim().replace(/\/+$/,'');
  if(!base){if(production)throw new Error('Set BACKEND_API_URL to the Render HTTPS service URL.');return '';}
  let parsed;try{parsed=new URL(base);}catch{throw new Error('Use a complete backend URL.');}
  const loopback=['localhost','127.0.0.1','[::1]'].includes(parsed.hostname);
  if(parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/'||
     (parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&loopback&&!production))||
     (production&&loopback))throw new Error('Use the backend HTTPS origin without a path, credentials or query.');
  return parsed.origin;
}

export function apiUrl(path,base=API_BASE_URL){
  if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//')||path.includes('\\'))
    throw new Error('Use an API path within the configured backend.');
  return normalizeApiBase(base)+path;
}
