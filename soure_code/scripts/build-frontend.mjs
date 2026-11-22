import {cpSync,existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {normalizeApiBase} from '../src/payments_analyst/static/api-url.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const source=join(root,'src','payments_analyst','static');
const publicAssets=['analysis-stream.js','api-url.js','app.js','auth-client.js','charts.js','styles.css','view-model.js'];

export function buildFrontend({backendUrl=process.env.BACKEND_API_URL||'',production=process.env.VERCEL==='1',outputDir=join(root,'dist')}={}){
  const apiBase=normalizeApiBase(backendUrl,{production});
  const output=resolve(outputDir),temporary=join(root,'.tmp');
  // Any recursive removal is limited to dist or one named build-test directory.
  if(output!==join(root,'dist')&&!(dirname(output)===temporary&&basename(output).startsWith('frontend-build-')))
    throw new Error('Frontend output must stay in this project’s dist or build-test directory.');
  mkdirSync(dirname(output),{recursive:true});
  const parent=relative(realpathSync(root),realpathSync(dirname(output)));
  if(isAbsolute(parent)||parent==='..'||parent.startsWith(`..${sep}`))throw new Error('Frontend output leaves the project.');
  if(existsSync(output)&&lstatSync(output).isSymbolicLink())throw new Error('Frontend output cannot be a symbolic link.');
  if(existsSync(output))rmSync(output,{recursive:true,force:true});
  mkdirSync(join(output,'assets'),{recursive:true});
  cpSync(join(source,'index.html'),join(output,'index.html'));
  for(const name of publicAssets)cpSync(join(source,name),join(output,'assets',name));
  writeFileSync(join(output,'assets','client-config.js'),`// Public backend address only. No server credentials.\nexport const API_BASE_URL = ${JSON.stringify(apiBase)};\n`);
  if(!readFileSync(join(output,'index.html'),'utf8').includes('/assets/app.js'))throw new Error('Frontend entrypoint is missing.');
  return output;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  try{buildFrontend();process.stdout.write('Frontend built in dist. Only public assets were included.\n');}
  catch(error){process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
