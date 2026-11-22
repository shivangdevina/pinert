import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {apiUrl,normalizeApiBase} from '../src/payments_analyst/static/api-url.js';
import {buildFrontend} from '../scripts/build-frontend.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

test('local and deployed API requests preserve endpoint paths and query strings',()=>{
  assert.equal(apiUrl('/datasets'),'/datasets');
  assert.equal(apiUrl('/chat/stream','https://payscope-api.onrender.com/'),'https://payscope-api.onrender.com/chat/stream');
  assert.equal(apiUrl('/query-evaluations/latest?dataset_id=abc','https://payscope-api.onrender.com'),'https://payscope-api.onrender.com/query-evaluations/latest?dataset_id=abc');
});

test('production rejects missing, insecure, credential-bearing and non-origin backend settings',()=>{
  for(const value of ['', 'http://example.com', 'http://127.0.0.1:8000', 'https://localhost',
      'https://user:password@example.com','https://example.com/api','https://example.com?token=secret','https://example.com/#fragment']){
    assert.throws(()=>normalizeApiBase(value,{production:true}));
  }
  assert.equal(normalizeApiBase('http://127.0.0.1:8000'),'http://127.0.0.1:8000');
  for(const path of ['https://example.com','//example.com','/\\example.com'])assert.throws(()=>apiUrl(path));
});

test('build publishes only static assets and one public backend address',()=>{
  const output=join(root,'.tmp',`frontend-build-${randomUUID()}`);
  const built=buildFrontend({backendUrl:'https://payscope-api.onrender.com',production:true,outputDir:output});
  assert.deepEqual(readdirSync(built).sort(),['assets','index.html']);
  assert.deepEqual(readdirSync(join(built,'assets')).sort(),['analysis-stream.js','api-url.js','app.js','auth-client.js','charts.js','client-config.js','styles.css','view-model.js']);
  const config=readFileSync(join(built,'assets','client-config.js'),'utf8');
  assert.match(config,/export const API_BASE_URL = "https:\/\/payscope-api.onrender.com";/);
  assert.doesNotMatch(config,/TOKEN|GEMINI|PASSWORD|SUPABASE_RUNTIME/);
  assert.ok(readFileSync(join(built,'index.html'),'utf8').includes('/assets/app.js'));
  const app=readFileSync(join(built,'assets','app.js'),'utf8');
  assert.match(app,/fetch\(apiUrl\(path\)/);
  assert.match(app,/fetch\(apiUrl\('\/chat\/stream'\)/);
  assert.ok(!existsSync(join(built,'.env')));
});

test('invalid deployment settings fail before replacing a previous output',()=>{
  const output=join(root,'.tmp',`frontend-build-${randomUUID()}`);
  buildFrontend({backendUrl:'https://payscope-api.onrender.com',production:true,outputDir:output});
  const before=readFileSync(join(output,'assets','client-config.js'),'utf8');
  assert.throws(()=>buildFrontend({backendUrl:'',production:true,outputDir:output}));
  assert.equal(readFileSync(join(output,'assets','client-config.js'),'utf8'),before);
  assert.throws(()=>buildFrontend({outputDir:root}));
});
