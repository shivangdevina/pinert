import {escapeHTML as e,money,number,currentWindow,toPaise,segmentLabel} from './view-model.js';
import {rankingChart,simulationChart} from './charts.js';
import {consumeAnalysisStream} from './analysis-stream.js';
import {AuthClient} from './auth-client.js';
import {apiUrl} from './api-url.js';

const $=id=>document.getElementById(id);
let auth=null,config=null,profile=null;
const authHeaders=()=>auth?.session?.access_token?{Authorization:`Bearer ${auth.session.access_token}`} : {};
const state={datasets:[],previous:null,busy:false,generation:0,abort:null};
const windows=dataset=>`Current: ${currentWindow(dataset)} · History: ${currentWindow({current_start:dataset.history_start,window_end:dataset.current_start})}`;
const labels={initial_bank:'Bank',initial_payment_method:'Payment method',business_date:'Date',merchant_category:'Merchant type',completed_orders:'Completed payments',successful_orders:'Successful payments',pending_orders:'Pending payments',net_contribution_paise:'Money after costs (INR)',success_rate_pct:'Payment success (%)',merchant_fee_paise:'Fees earned (INR)',processing_cost_paise:'Payment costs (INR)',loss_provision_paise:'Estimated losses (INR)',last_failure_code:'Reported failure code',failed_orders:'Failed payments'};
const label=key=>labels[key]||key.replace(/_paise$/,' (INR)').replace(/_pct$/,' (%)').replaceAll('_',' ');
const format=(key,value)=>value==null?'—':key.endsWith('_paise')?money(value):key.endsWith('_pct')&&Number.isFinite(value)?`${value.toFixed(2)}%`:typeof value==='number'?number(value):String(value);
async function api(path,{body,signal}={}){
  const sessionGeneration=auth?.generation;
  const response=await fetch(apiUrl(path),{method:body?'POST':'GET',headers:{...authHeaders(),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal});
  let data;try{data=await response.json();}catch{throw new Error('The server returned an unreadable response.');}
  if(sessionGeneration!==auth?.generation)throw new Error('Your access changed. Please try again.');
  if(response.status===401&&auth?.session){auth.clear();lockWorkspace('Your session expired. Sign in again.');}
  if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'This question could not be processed. Check the inputs and try again.');
  return data;
}
function feedback(text){$('feedback').hidden=!text;$('feedback').textContent=text;}
function setBusy(value){state.busy=value;$('send-button').disabled=value||!state.datasets.length;$('question').disabled=!state.datasets.length;$('dataset-select').disabled=value||!state.datasets.length;document.querySelectorAll('[data-question]').forEach(button=>button.disabled=value);$('question-form').setAttribute('aria-busy',String(value));}
function scrollToMessage(node){node.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});}
function newChat(){state.generation++;state.abort?.abort();state.previous=null;$('conversation').replaceChildren();$('welcome').hidden=false;feedback('');setBusy(false);$('question').value='';$('question').focus();}
function download(saved){const url=URL.createObjectURL(new Blob([JSON.stringify(saved,null,2)],{type:'application/json'}));const anchor=document.createElement('a');anchor.href=url;anchor.download=`payscope-${saved.id}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function renderTable(target,result){
  if(!result.rows.length){target.innerHTML='<p class="empty-text">No matching observations were returned. Try broader filters.</p>';return;}
  const cols=result.columns;
  target.innerHTML=`<div class="table-scroll"><table><caption class="sr-only">Executed query results</caption><thead><tr>${cols.map(col=>`<th scope="col">${e(label(col))}</th>`).join('')}</tr></thead><tbody>${result.rows.map(row=>`<tr>${cols.map(col=>`<td>${e(format(col,row[col]))}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="caveat">${result.rows.length} results</p>`;
}
function renderChart(target,result){
  const numeric=result.columns.filter(col=>result.rows.some(row=>Number.isFinite(row[col])));
  const dimensions=result.columns.filter(col=>!numeric.includes(col));
  if(!numeric.length||result.rows.length<2)return;
  target.className='result-chart';
  const selector=document.createElement('select');selector.className='chart-select';selector.setAttribute('aria-label','Chart measure');
  selector.innerHTML=numeric.map(col=>`<option value="${e(col)}">${e(label(col))}</option>`).join('');
  const graphic=document.createElement('div');target.append(selector,graphic);
  function draw(){
    const col=selector.value,points=result.rows.slice(0,30),values=points.map(row=>Number.isFinite(row[col])?row[col]:0),lo=Math.min(0,...values),hi=Math.max(0,...values),span=Math.max(1,hi-lo);
    const left=160,right=610,top=15,height=points.length*29+48,x=value=>left+(value-lo)/span*(right-left);
    const body=points.map((row,i)=>{const value=row[col],y=top+i*29,caption=dimensions.map(dim=>row[dim]??'Unknown').join(' / ')||`Result ${i+1}`;if(!Number.isFinite(value))return `<text x="155" y="${y+12}" text-anchor="end" font-size="10" fill="#7d8f73">${e(caption.slice(0,27))} · no value</text>`;return `<text x="149" y="${y+12}" text-anchor="end" font-size="10" fill="#7d8f73">${e(caption.slice(0,27))}</text><rect x="${Math.min(x(0),x(value))}" y="${y}" width="${Math.max(1,Math.abs(x(value)-x(0)))}" height="18" rx="3" fill="${value<0?'#c28b76':'#7d9f74'}"><title>${e(caption)}: ${e(format(col,value))}</title></rect>`;}).join('');
    graphic.innerHTML=`<svg viewBox="0 0 660 ${height}" role="img" aria-label="${e(label(col))} by ${e(dimensions.join(', ')||'result row')}"><title>${e(label(col))} · first ${points.length} rows; exact values in table</title><line x1="${x(0)}" x2="${x(0)}" y1="8" y2="${height-28}" stroke="#d7e0ce"/>${body}<text x="160" y="${height-7}" font-size="10" fill="#7d8f73">${e(format(col,lo))}</text><text x="610" y="${height-7}" text-anchor="end" font-size="10" fill="#7d8f73">${e(format(col,hi))}</text></svg>`;
  }
  selector.addEventListener('change',draw);draw();
}
function renderEvidence(target,saved){
  const report=saved.analysis,answer=report.answer||{};
  const groups=[['Findings','facts'],['Explanations','explanations'],['Recommendations','recommendations'],['Hypotheses','hypotheses']];
  const anchor=id=>`evidence-${saved.id}-${id}`;
  const references=groups.filter(([,key])=>answer[key]?.length).map(([heading,key])=>`<h3>${heading}</h3>${answer[key].map(item=>`<article class="evidence-reference" id="${e(anchor(item.id))}"><p><span class="evidence-id">${e(item.id)}</span> ${e(item.text)}</p>${item.source?`<p class="claim-source">Source: ${e(item.source)}</p>`:''}${item.status?`<p class="claim-source">Verification: ${e(item.status.replaceAll('_',' '))}</p>`:''}${item.evidence_ids?.length?`<p class="claim-source">References: ${item.evidence_ids.map(id=>`<a href="#${e(anchor(id))}">${e(id)}</a>`).join(', ')}</p>`:''}${item.evidence?.length?`<details><summary>Source details</summary><pre>${e(JSON.stringify(item.evidence,null,2))}</pre></details>`:''}${item.scenario_note?`<p class="caveat">${e(item.scenario_note)}</p>`:''}</article>`).join('')}`).join('');
  target.className='evidence answer-evidence';
  target.innerHTML=`<summary>See evidence</summary><div class="evidence-content"><h3>Dataset and scope</h3><p>Dataset ${e(report.dataset.id)} · ${e(windows(report.dataset))} · ${e(report.calculation_version)}</p><p>Filters: ${e(JSON.stringify(report.filters))}</p><section class="claim-references"><h3>References and sources</h3>${references||'<p>No individual references were recorded for this report.</p>'}</section>${report.research?.result?'<details class="evidence"><summary>Supporting research results</summary><div class="research-results"></div></details>':''}<details class="evidence"><summary>Assumptions and limitations</summary><ul>${report.caveats.map(item=>`<li>${e(item)}</li>`).join('')}</ul><pre>${e(JSON.stringify(report.method,null,2))}</pre></details><button class="download" type="button">Download this answer and evidence</button></div>`;
  target.querySelector('button').addEventListener('click',()=>download(saved));
  const supporting=target.querySelector('.research-results');if(supporting)renderTable(supporting,report.research.result);
}

function renderAnalysisSteps(target,steps,queries=[],pending=false){
  const opened=target.open;target.className='analysis-steps';
  target.innerHTML=`<summary>${pending?'Analysing your question…':'Analysis steps'}</summary><ol>${steps.map(step=>`<li class="step-${e(step.status)}"><strong>${step.status==='completed'?'✓':step.status==='running'?'◌':'!'} ${e(step.title)}</strong>${step.detail?`<p>${e(step.detail)}</p>`:''}${Number.isFinite(step.duration_ms)?`<small>${(step.duration_ms/1000).toFixed(1)} s</small>`:''}</li>`).join('')}</ol>${queries.length?`<details class="sql-trace"><summary>SQL queries and parameters · ${queries.length} queries</summary>${queries.map(query=>`<h3>${e(query.template_id)}</h3><p>${e(query.execution)} · ${e(query.row_count)} rows${query.database_role?` · ${e(query.database_role)}`:''}</p><pre>${e(query.sql)}</pre><pre>${e(JSON.stringify(query.parameters,null,2))}</pre>`).join('')}</details>`:''}`;
  target.open=opened;
}
async function chatApi(body,{signal,onStep}){
  const response=await fetch(apiUrl('/chat/stream'),{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify(body),signal});
  if(!response.ok){let data;try{data=await response.json();}catch{}throw new Error(typeof data?.detail==='string'?data.detail:'The analysis request could not be processed.');}
  return consumeAnalysisStream(response.body,onStep);
}

function renderSimulation(target,saved){
  const segments=saved.analysis.segments.filter(segment=>segment.reference_scenario);
  if(!segments.length)return;
  target.className='simulation';target.innerHTML=`<summary>What-if · test recovery after costs</summary><p class="caveat">Assumption, not a prediction: retry each eligible failed order once. Change the fraction of the observed gap recovered and the intervention cost.</p><div class="sim-inputs"><label>Segment <select data-field="segment">${segments.map(segment=>`<option value="${e(segment.segment_id)}">${e(segmentLabel(segment))}</option>`).join('')}</select></label><label>Recovery <input data-field="recovery" type="range" min="0" max="100" step="5" value="50"><output>50%</output></label><label>Cost (₹) <input data-field="cost" type="number" min="0" max="10000000" step="0.01" value="0"></label><button class="button secondary" data-field="calculate" type="button">Calculate scenario</button></div><p class="sim-net" data-field="net">—</p><p class="caveat" data-field="status" role="status">Choose assumptions, then calculate.</p><div class="simulation-chart"></div><details><summary>Cost breakdown</summary><div data-field="costs"></div></details>`;
  const field=key=>target.querySelector(`[data-field="${key}"]`);
  let version=0;
  field('recovery').addEventListener('input',()=>{target.querySelector('output').textContent=`${field('recovery').value}%`;invalidate();});
  function invalidate(){version++;field('net').textContent='—';field('status').textContent='Inputs changed. Calculate to update the saved scenario.';target.querySelector('.simulation-chart').replaceChildren();field('costs').replaceChildren();}
  field('cost').addEventListener('input',invalidate);field('segment').addEventListener('change',invalidate);
  field('calculate').addEventListener('click',async()=>{
    const sequence=++version;field('calculate').disabled=true;field('status').textContent='Calculating and saving the scenario…';
    try{const scenario={segment_id:field('segment').value,recovery_fraction:Number(field('recovery').value)/100,intervention_cost_paise:toPaise(field('cost').value)};
      const response=await api(`/analyses/${saved.id}/scenarios`,{body:scenario});if(sequence!==version)return;
      const s=response.scenario,r=s.result;field('net').textContent=money(r.incremental_net_contribution_paise);field('net').className=`sim-net ${r.incremental_net_contribution_paise<0?'negative':'positive'}`;
      field('status').textContent=`${number(r.additional_successful_orders)} additional successes · ${r.break_even_within_historical_gap?`break-even at ${(r.break_even_recovery_fraction*100).toFixed(1)}% recovery`:'no break-even within the observed gap'} · scenario saved`;
      simulationChart(target.querySelector('.simulation-chart'),s);
      field('costs').innerHTML=[['Additional fees',r.additional_merchant_fees_paise],['Successful retry costs',-r.successful_retry_cost_paise],['Failed retry costs',-r.failed_retry_cost_paise],['Modelled loss',-r.additional_loss_provision_paise],['Intervention cost',-r.intervention_cost_paise]].map(([key,value])=>`<p>${e(key)}: ${money(value)}</p>`).join('');
    }catch(error){if(sequence===version){field('net').textContent='—';field('status').textContent=error.message;}}finally{field('calculate').disabled=false;}
  });
}
function renderNextActions(target,saved,onPlan){
  target.className='next-actions';
  target.innerHTML=`<div class="next-actions-heading"><div><p class="label">RESEARCH → COMPARE → SIMULATE</p><h3>Next actions</h3></div><span class="scope-tag">Read-only research</span></div><p class="caveat">Compare specific fixes by extra money retained after all retry costs. These are alternatives, not benefits to add together.</p><div class="action-assumptions"><label>Assumed historical gap recovered <input data-action-field="recovery" type="range" min="0" max="100" step="5" value="50"><output>50%</output></label><label>Additional cost per action (₹)<input data-action-field="cost" type="number" min="0" max="10000000" step="0.01" value="0"></label><button class="button primary-action" data-action-field="run" type="button">Research, rank & simulate</button></div><p data-action-field="status" class="caveat" role="status">Preparing action research…</p><div data-action-field="results"></div>`;
  const field=name=>target.querySelector(`[data-action-field="${name}"]`);let plan=null,sequence=0,selectedId=null;
  function dirty(){sequence++;target.querySelector('output').textContent=`${field('recovery').value}%`;field('results').hidden=true;field('status').textContent='Assumptions changed. Apply them to update both action rankings and the what-if outcome.';}
  field('recovery').addEventListener('input',dirty);field('cost').addEventListener('input',dirty);
  function renderSelected(){
    const action=plan.actions.find(item=>item.action_id===selectedId),box=field('results').querySelector('.action-simulation');if(!action||!action.scenario)return;
    const scenario=action.scenario,result=scenario.result;
    const costs=result.successful_retry_cost_paise+result.failed_retry_cost_paise+result.additional_loss_provision_paise+result.intervention_cost_paise;
    box.innerHTML=`<h3>What-if simulation</h3><p>${e(action.title)}</p><div class="action-metrics"><div><small>Extra money after costs</small><strong class="${result.incremental_net_contribution_paise<0?'negative':'positive'}">${money(result.incremental_net_contribution_paise)}</strong></div><div><small>Additional successful payments</small><strong>${number(result.additional_successful_orders)}</strong></div><div><small>Payments receiving one extra attempt</small><strong>${number(result.eligible_orders_retried)}</strong></div></div><p class="caveat">${result.break_even_within_historical_gap?`Break-even at ${(result.break_even_recovery_fraction*100).toFixed(1)}% gap recovery.`:'No break-even within the observed historical gap.'} Conditional historical net range: ${scenario.net_impact_interval_paise.map(money).join(' to ')}. This range does not measure whether retries will work.</p><div class="simulation-chart"></div><div class="table-scroll"><table><caption class="sr-only">What-if cost breakdown</caption><tbody>${[['Extra merchant fees',result.additional_merchant_fees_paise],['Successful retry processing',-result.successful_retry_cost_paise],['Failed retry processing',-result.failed_retry_cost_paise],['Estimated extra losses',-result.additional_loss_provision_paise],['Additional action cost',-result.intervention_cost_paise],['Net change',result.incremental_net_contribution_paise]].map(([name,value])=>`<tr><th>${e(name)}</th><td>${money(value)}</td></tr>`).join('')}</tbody></table></div><p class="caveat">Compared with doing nothing: ${money(result.additional_merchant_fees_paise)} extra fees minus ${money(costs)} total extra costs. Recovery is an assumption; no payment is retried.</p>`;
    simulationChart(box.querySelector('.simulation-chart'),scenario);
  }
  function renderPlan(){
    const box=field('results'),ranked=plan.actions.filter(action=>action.rank),supported=plan.actions.filter(action=>action.scenario);
    box.hidden=false;
    const cards=ranked.slice(0,3).map(action=>`<article class="action-card"><div class="action-card-heading"><span class="rank-chip">#${action.rank}</span><h4>${e(action.title)}</h4></div><div class="action-metrics"><div><small>Extra net at your assumption</small><strong>${money(action.expected_net_paise)}</strong></div><div><small>Conservative net estimate</small><strong>${money(action.conservative_net_paise)}</strong></div><div><small>Eligible payments</small><strong>${number(action.eligible_orders)}</strong></div></div><p>${number(action.scenario.result.additional_successful_orders)} additional successes modelled. ${e(action.reason)}</p><button class="download" data-inspect-action="${e(action.action_id)}" type="button">Explore this action ↓</button></article>`).join('');
    box.innerHTML=`<p class="caveat">Research checked ${plan.research.failure_groups_checked} failure groups and ${plan.research.eligible_payments_checked} eligible payments using SELECT-only access. Ranked at ${Number(plan.settings.recovery_fraction)*100}% gap recovery and ${money(plan.settings.intervention_cost_paise)} additional cost per alternative.</p>${ranked.length?cards:'<p class="no-action">No retry action has a positive conservative net benefit under these assumptions. Change the assumptions to explore break-even; do not treat an unprofitable scenario as a recommendation.</p>'}<details class="evidence"><summary>All action alternatives, ranking rule & research</summary><p>${e(plan.ranking_method)}</p><p>${e(plan.limits)}</p><div class="table-scroll"><table><thead><tr><th>Rank</th><th>Action</th><th>Extra net</th><th>Conditional lower net</th><th>Evidence status</th></tr></thead><tbody>${plan.actions.map(action=>`<tr><td>${action.rank||'—'}</td><td>${e(action.title)}</td><td>${money(action.expected_net_paise)}</td><td>${money(action.conservative_net_paise)}</td><td>${e(action.status.replaceAll('_',' '))}: ${e(action.reason)}</td></tr>`).join('')}</tbody></table></div><ul>${plan.assumptions.map(text=>`<li>${e(text)}</li>`).join('')}</ul><p class="caveat">Research role: ${e(plan.research.database_role)} · plan saved in Supabase. Detailed SQL is under Analysis steps.</p></details>${plan.investigations.length?`<details class="evidence"><summary>Other issues needing more evidence</summary>${plan.investigations.map(item=>`<p><strong>${e(item.title)}</strong> — observed contribution ${money(item.observed_net_paise)}. ${e(item.reason)}</p>`).join('')}</details>`:''}${supported.length?`<div class="action-selector"><label>Choose an action to simulate<select data-action-field="select">${supported.map(action=>`<option value="${e(action.action_id)}">${action.rank?`#${action.rank} `:'Unranked · '}${e(action.title)}</option>`).join('')}</select></label></div><div class="action-simulation"></div>`:'<p class="caveat">Simulation is withheld until there is sufficient comparable history and valid pricing.</p>'}`;
    if(supported.length){
      const best=ranked[0]||[...supported].sort((a,b)=>b.expected_net_paise-a.expected_net_paise)[0];
      if(!supported.some(action=>action.action_id===selectedId))selectedId=best.action_id;
      field('select').value=selectedId;field('select').addEventListener('change',()=>{selectedId=field('select').value;renderSelected();});
      box.querySelectorAll('[data-inspect-action]').forEach(button=>button.addEventListener('click',()=>{selectedId=button.dataset.inspectAction;field('select').value=selectedId;renderSelected();box.querySelector('.action-simulation').scrollIntoView({behavior:'smooth',block:'start'});}));
      renderSelected();
    }
  }
  async function build(){
    const current=++sequence;field('run').disabled=true;field('results').hidden=true;field('status').textContent='Separate recommendation workflow: verifying history, researching failure types and prices with read-only access, then comparing net benefit…';
    try{const settings={recovery_fraction:Number(field('recovery').value)/100,intervention_cost_paise:toPaise(field('cost').value)};
      const response=await api(`/analyses/${saved.id}/next-actions`,{body:settings});if(current!==sequence)return;
      plan=response.plan;saved.action_plan=response;onPlan(response);renderPlan();field('status').textContent=`Action plan ready · ${plan.ranked_count} alternatives qualify for a controlled test · no live changes made.`;
    }catch(error){if(current===sequence){field('status').textContent=error.message;field('results').hidden=true;}}
    finally{field('run').disabled=false;}
  }
  field('run').addEventListener('click',build);build();
}

function renderAnswer(target,saved){
  const report=saved.analysis;target.replaceChildren();
  const trace=document.createElement('details');target.append(trace);renderAnalysisSteps(trace,report.analysis_steps||[],report.query_evidence);
  const intro=document.createElement('div');
  intro.innerHTML=`<h2>${e(report.answer?.title||'Here is what your data shows.')}</h2>`;target.append(intro);
  if(report.answer){
    for(const [heading,key] of [['What happened','facts'],['What it means','explanations'],['What to do next','recommendations']]){
      const items=key==='explanations'?(report.answer.explanations||[]).filter(item=>item.status==='verified_data'||item.status==='not_established'):report.answer[key]||[];
      const displayItems=key==='explanations'&&!items.length?[{kind:'explanation',text:'The result shows what happened, but a supporting check is needed to identify why.'}]:items;
      if(!displayItems.length)continue;const section=document.createElement('section');section.innerHTML=`<h3>${heading}</h3>${displayItems.map(item=>`<p data-kind="${e(item.kind)}">${e(item.text)}${item.scenario_note?`<br><span class="caveat">${e(item.scenario_note)}</span>`:''}</p>`).join('')}`;target.append(section);
    }
  }else{const p=document.createElement('p');p.textContent='Here are the results for your question.';target.append(p);}
  const actions=document.createElement('section');target.append(actions);
  const actionEvidence=document.createElement('details');
  renderNextActions(actions,saved,response=>{renderAnalysisSteps(trace,[...(report.analysis_steps||[]),...response.plan.workflow_steps],[...report.query_evidence,...response.plan.query_evidence]);actionEvidence.innerHTML=`<summary>Action-plan assumptions and research counts</summary><p>${e(response.plan.ranking_method)}</p><ul>${response.plan.assumptions.map(text=>`<li>${e(text)}</li>`).join('')}</ul><pre>${e(JSON.stringify(response.plan.research,null,2))}</pre>`;});
  const chart=document.createElement('div');target.append(chart);renderChart(chart,report.sql_result);
  const table=document.createElement('div');target.append(table);renderTable(table,report.sql_result);
  if(report.segments.length){const ranking=document.createElement('div');ranking.className='ranking-chart';target.append(ranking);rankingChart(ranking,report.segments);const note=document.createElement('p');note.className='caveat';note.textContent='These are what-if estimates after costs. Actual recovery must be tested before changing live payments.';target.append(note);
    const detail=document.createElement('details');detail.className='evidence';detail.innerHTML=`<summary>See rank and evidence status for every segment</summary><div class="table-scroll"><table><thead><tr><th>Rank</th><th>Segment</th><th>Status</th><th>Reference net</th><th>Net range</th></tr></thead><tbody>${report.segments.map(s=>`<tr><td>${s.rank??'—'}</td><td>${e(segmentLabel(s))}</td><td>${e(s.status)}</td><td>${money(s.reference_scenario?.incremental_net_contribution_paise)}</td><td>${s.net_impact_interval_paise?.map(money).join(' to ')||'—'}</td></tr>`).join('')}</tbody></table></div>`;target.append(detail);
    
  }
  const caveat=document.createElement('p');caveat.className='caveat';caveat.textContent='Observed comparisons do not establish causation. Costs and transaction data are synthetic; fixed overhead is excluded.';target.append(caveat);
  const evidence=document.createElement('details');target.append(evidence);renderEvidence(evidence,saved);actionEvidence.className='evidence';evidence.querySelector('.evidence-content').append(actionEvidence);
  const followups=document.createElement('div');followups.className='followups';followups.innerHTML=['Break that down by payment method','Compare that with history','Which payment issue should we fix first?'].map(q=>`<button data-question="${e(q)}" type="button">${e(q)} ↗</button>`).join('');target.append(followups);
}
async function ask(question){
  if(state.busy||!question||question.length<3)return;
  const dataset=state.datasets[Number($('dataset-select').value)];if(!dataset)return;
  const generation=state.generation;state.abort=new AbortController();setBusy(true);feedback('');$('welcome').hidden=true;
  const user=document.createElement('article');user.className='message user-message';const bubble=document.createElement('div');bubble.className='user-bubble';bubble.textContent=question;user.append(bubble);
  const reply=document.createElement('article');reply.className='message assistant-message';reply.innerHTML='<div class="assistant-heading"><span aria-hidden="true">✳</span> PayScope analyst</div><div class="assistant-body"><p class="pending" role="status">Analysing your payment data…</p></div>';
  $('conversation').append(user,reply);$('question').value='';$('question').style.height='auto';scrollToMessage(user);
  const liveTrace=document.createElement('details');reply.querySelector('.assistant-body').prepend(liveTrace);const liveSteps=[];
  renderAnalysisSteps(liveTrace,liveSteps,[],true);
  try{const saved=await chatApi({dataset_id:dataset.id,question,previous_analysis_id:state.previous},{signal:state.abort.signal,onStep:step=>{if(generation!==state.generation)return;const existing=liveSteps.findIndex(item=>item.id===step.id);if(existing===-1)liveSteps.push(step);else liveSteps[existing]=step;renderAnalysisSteps(liveTrace,liveSteps,[],true);}});if(generation!==state.generation)return;
    const target=reply.querySelector('.assistant-body');
    if(saved.status==='NEEDS_CLARIFICATION'){target.innerHTML='<h2>Let’s clarify that.</h2>';const steps=document.createElement('details');target.prepend(steps);renderAnalysisSteps(steps,saved.analysis_steps||liveSteps);const text=document.createElement('p');text.textContent=saved.clarification;target.append(text);const examples=document.createElement('div');examples.className='followups';examples.innerHTML=saved.suggested_questions.map(q=>`<button data-question="${e(q)}">${e(q)}</button>`).join('');target.append(examples);}
    else{state.previous=saved.id;renderAnswer(target,saved);}
  }catch(error){if(error.name!=='AbortError'){const target=reply.querySelector('.assistant-body');target.replaceChildren();const text=document.createElement('p');text.textContent=error.message;target.append(text);const note=document.createElement('p');note.className='caveat';note.textContent='No fabricated answer or preview data was substituted.';target.append(note);const trace=document.createElement('details');target.prepend(trace);renderAnalysisSteps(trace,liveSteps.map(step=>step.status==='running'?{...step,status:'failed',detail:'This step did not complete.'}:step));}}
  finally{if(generation===state.generation){setBusy(false);$('question').focus();}}
}
function lockWorkspace(message='Sign in to access your payment data.'){
  state.datasets=[];profile=null;newChat();$('dataset-select').innerHTML='<option>Sign in to continue</option>';
  $('connection-status').textContent='Sign-in required';$('access-scope').textContent='Private customer workspace';
  $('window-label').textContent='Your assigned data only';$('model-checks').hidden=true;
  $('sign-in-form').hidden=false;$('sign-out').hidden=true;$('sign-in-status').textContent=message;
}
async function loadWorkspace(){
  profile=await api('/me');const response=await api('/datasets');state.datasets=response.datasets;
  $('access-scope').textContent=profile.scope_label;
  $('model-checks').hidden=!['demo','pine_admin'].includes(profile.role);
  $('dataset-select').innerHTML=state.datasets.map((d,i)=>`<option value="${i}">Snapshot · ${e(String(d.id).slice(0,8))}</option>`).join('');
  if(!state.datasets.length)throw new Error('No dataset is assigned to your workspace. Contact Pine Labs.');
  $('connection-status').textContent='Supabase connected';$('window-label').textContent=currentWindow(state.datasets[0]);setBusy(false);
  if(!config.model_configured)feedback('Supabase is connected. Configure Gemini on the server to ask questions.');
}
async function bootstrap(){try{
  config=await api('/app-config');auth=new AuthClient(config,()=>lockWorkspace('Your session expired. Sign in again.'));
  if(config.access_mode==='rbac'){
    $('access-mode-note').textContent='Sign in with your assigned account. Your access is managed by Pine Labs; roles cannot be chosen here.';
    lockWorkspace();return;
  }
  await loadWorkspace();
}catch(error){$('connection-status').textContent='Connection unavailable';feedback(error.message);}}
$('access-button').addEventListener('click',()=>{$('access-dialog').showModal();});
$('sign-in-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.currentTarget.querySelector('button');button.disabled=true;$('sign-in-status').textContent='Signing in…';
  try{
    await auth.signIn($('sign-in-email').value.trim(),$('sign-in-password').value);$('sign-in-password').value='';
    newChat();await loadWorkspace();$('sign-in-form').hidden=true;$('sign-out').hidden=false;$('sign-in-status').textContent=profile.scope_label;$('access-dialog').close();
  }catch(error){auth?.clear();$('sign-in-password').value='';lockWorkspace(error.message);}
  finally{button.disabled=false;}
});
$('sign-out').addEventListener('click',async()=>{const result=auth.signOut();lockWorkspace('Signed out.');await result;});
$('question-form').addEventListener('submit',event=>{event.preventDefault();if($('question-form').reportValidity())ask($('question').value.trim());});
$('question').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('question-form').requestSubmit();}});
$('question').addEventListener('input',()=>{$('question').style.height='auto';$('question').style.height=`${Math.min(130,$('question').scrollHeight)}px`;});
document.addEventListener('click',event=>{const button=event.target.closest('[data-question]');if(button)ask(button.dataset.question);});
async function showModelChecks(){
  const dataset=state.datasets[Number($('dataset-select').value)];if(!dataset)return;
  const dialog=$('evaluation-dialog'),target=$('evaluation-content');target.textContent='Loading saved evaluation…';dialog.showModal();
  try{const response=await api(`/query-evaluations/latest?dataset_id=${encodeURIComponent(dataset.id)}`),report=response.evaluation;
    if(!report){target.textContent='No benchmark has been run for this dataset yet. The developer can run the known-answer suite; opening this view does not call Gemini.';return;}
    target.innerHTML=`<p class="evaluation-score ${response.status==='PASS'?'positive':'negative'}">${e(response.status)} · ${report.passed}/${report.total} checks passed</p><p>${response.status==='STALE'?'Configuration changed since this run. These results do not validate the current model/prompt.':'Compared actual executed results with independently calculated synthetic-data answers.'}</p><p class="caveat">Model: ${e(report.model)} · ${e(report.completed_at)} · ${e(report.suite_version)}</p><p class="caveat">${e(report.caveat)}</p>${report.cases.map(test=>`<details class="evidence"><summary>${e(test.status)} · ${e(test.question)}</summary><p>${e(test.detail)}</p><p class="caveat">SQL executed: ${test.sql_executed?'yes':'no'} · expected: ${e(test.expected_behavior)}</p>${test.generated_sql?`<pre>${e(test.generated_sql)}</pre>`:''}<h3>Expected result</h3><pre>${e(JSON.stringify(test.expected_rows,null,2))}</pre>${test.actual_rows?`<h3>Actual result</h3><pre>${e(JSON.stringify(test.actual_rows,null,2))}</pre>`:''}</details>`).join('')}`;
  }catch(error){target.textContent=error.message;}
}
$('model-checks').addEventListener('click',showModelChecks);
$('new-chat').addEventListener('click',newChat);$('dataset-select').addEventListener('change',()=>{newChat();$('window-label').textContent=currentWindow(state.datasets[Number($('dataset-select').value)]);});
bootstrap();
