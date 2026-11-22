"""Open synthetic demo or verified customer/admin analytics; server-only credentials."""

import os
import json
from time import perf_counter
from pathlib import Path
from uuid import UUID

from fastapi import Depends, FastAPI, Request, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .access import access_mode, research_identity, customer_scope
from .cache import get_cache
from .cors import configure_cors
from .auth import bearer, require_user
from .analytics import analyse, scenario_from_analysis
from .contracts import (AnalysisBlocked, AnalysisRequest, BackendUnavailable,
                        CALCULATION_VERSION, QuestionRequest, ResourceNotFound, ScenarioRequest)
from .database import load_environment
from .planner import plan_question
from .presentation import present, present_query, apply_research
from .preview_routes import preview_enabled, router as preview_router
from .repository import SupabaseRepository
from .sql_analyst import ChatRequest, generate_plan
from .research import ReadOnlyResearchAgent
from .next_actions import (NextActionsWorkflow, NextActionRequest, ActionSimulationRequest,
                           ACTION_VERSION, action_request, action_scenario)

app = FastAPI(title="Payment Business Analyst", version="0.3.0",
              description="Supabase-only, evidence-backed structured analysis. All demo data is synthetic.")
configure_cors(app)
STATIC_PATH = Path(__file__).with_name("static")
app.include_router(preview_router)


@app.get("/", include_in_schema=False)
def chat_page():
    return FileResponse(STATIC_PATH / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/app-config")
def public_configuration():
    load_environment()
    mode = os.environ.get("PLANNER_MODE", "gemini")
    model_ready = bool(os.environ.get("GEMINI_API_KEY") and os.environ.get("GEMINI_MODEL"))
    return JSONResponse({"preview_enabled": preview_enabled(), "access_mode": "public_shared" if access_mode() == "public_demo" else "rbac",
        "supabase_url": os.environ.get("SUPABASE_URL", ""),
        "supabase_publishable_key": os.environ.get("SUPABASE_PUBLISHABLE_KEY", "") if os.environ.get("SUPABASE_PUBLISHABLE_KEY", "").startswith("sb_publishable_") else "",
        "roles": {"customer": "Assigned customer data only", "pine_admin": "Pine Labs global data access"},
        "database_configured": bool(os.environ.get("SUPABASE_RUNTIME_DB_URL")),
        "planner_mode": mode, "model_configured": model_ready, "cache": get_cache().status(),
        "calculation_version": CALCULATION_VERSION}, headers={"Cache-Control": "no-store"})


def get_access_subject(credentials=Depends(bearer)):
    if access_mode() == "public_demo":
        return None
    user_id = require_user(credentials)
    if not SupabaseRepository().access_profile(user_id):
        raise HTTPException(403, "Your account has no active access assignment. Contact Pine Labs.")
    return user_id


def get_repository():
    return SupabaseRepository()


def get_research_agent():
    return ReadOnlyResearchAgent()


def get_next_actions_workflow():
    return NextActionsWorkflow()


@app.exception_handler(BackendUnavailable)
async def unavailable_handler(request: Request, error: BackendUnavailable):
    return JSONResponse(status_code=503, content={"detail": str(error)})


@app.exception_handler(AnalysisBlocked)
async def blocked_handler(request: Request, error: AnalysisBlocked):
    return JSONResponse(status_code=409, content={"detail": str(error), "status": "BLOCKED"})


@app.exception_handler(ResourceNotFound)
async def not_found_handler(request: Request, error: ResourceNotFound):
    return JSONResponse(status_code=404, content={"detail": str(error)})


@app.get("/health")
def health():
    # Liveness only: this does not claim that Supabase is connected or migrated.
    return {"status": "ok", "database": "supabase", "calculation_version": CALCULATION_VERSION,
            "mode": "natural_language_analytics", "database_readiness": "not_checked"}


@app.get("/me")
def current_access(user_id: UUID | None = Depends(get_access_subject), repository=Depends(get_repository)):
    if user_id is None:
        return {"role": "demo", "scope_label": "Open demo · All synthetic customers", "customer_id": None}
    return repository.access_profile(user_id)


@app.get("/datasets")
def datasets(user_id: UUID | None = Depends(get_access_subject), repository=Depends(get_repository)):
    return {"datasets": repository.list_datasets(user_id)}


@app.get("/query-evaluations/latest")
def latest_query_evaluation(dataset_id: UUID, user_id: UUID | None = Depends(get_access_subject), repository=Depends(get_repository)):
    # Read evidence only. Visitors cannot trigger paid model benchmark runs.
    if user_id is not None and repository.access_profile(user_id)["role"] != "pine_admin":
        raise HTTPException(403, "Global model benchmarks are available to Pine Labs admins only.")
    return repository.latest_query_evaluation(dataset_id, user_id=user_id)


@app.post("/analyses", status_code=201)
def create_analysis(body: AnalysisRequest, user_id: UUID | None = Depends(get_access_subject), repository=Depends(get_repository)):
    snapshot = repository.load_snapshot(user_id, body)
    report = analyse(snapshot, body)
    return repository.save_analysis(user_id, body, report)


@app.post("/questions", status_code=200)
def ask_question(body: QuestionRequest, user_id: UUID | None = Depends(get_access_subject), repository=Depends(get_repository)):
    compiled, planning = plan_question(body)
    if compiled is None:
        return planning
    snapshot = repository.load_snapshot(user_id, compiled)
    report = present(analyse(snapshot, compiled), body.question, planning)
    return repository.save_analysis(user_id, compiled, report)


def chat_workflow(body, user_id, repository, research_agent):
    """Yield actual execution events, not model reasoning or simulated progress."""
    from .planner import _explicit_filters
    from .contracts import EngineSettings
    from dataclasses import asdict
    import re
    trace, timers = [], {}
    def step(key, title, status, detail=""):
        event = {"id": key, "title": title, "status": status, "detail": detail}
        if status == "running":
            timers[key] = perf_counter()
        else:
            event["duration_ms"] = round((perf_counter() - timers.get(key, perf_counter())) * 1000)
            trace.append(event)
        return {"type": "step", "step": event}
    yield step("plan", "Understand your question", "running")
    previous_saved = repository.get_analysis(user_id, body.previous_analysis_id) if body.previous_analysis_id else None
    if previous_saved and previous_saved.get("customer_scope") is not None:
        profile = repository.access_profile(user_id)
        if str(profile.get("customer_id")) != str(previous_saved["customer_scope"]):
            raise AnalysisBlocked("Start a new chat for a global analysis. This saved report belongs to a customer scope.")
    previous = previous_saved["analysis"] if previous_saved else None
    if previous and str(previous["dataset"]["id"]) != str(body.dataset_id):
        raise AnalysisBlocked("Start a new chat after changing datasets.")
    datasets = repository.list_datasets(user_id)
    dataset = next((d for d in datasets if str(d["id"]) == str(body.dataset_id)), None)
    if not dataset:
        raise ResourceNotFound("Dataset not found.")
    plan = generate_plan(body.question, dataset, previous)
    yield step("plan", "Understand your question", "completed", "Selected the dataset and checked the question's supported scope.")
    if plan.decision == "clarify":
        yield {"type": "result", "data": {"status": "NEEDS_CLARIFICATION", "clarification": plan.clarification,
            "analysis_steps": trace, "suggested_questions": ["Show success rate by bank", "Show daily UPI net contribution", "Which issue should we fix first?"]}}
        return
    banks, methods = _explicit_filters(body.question)
    prior_filters = previous.get("filters", {}) if previous else {}
    reset = bool(re.search(r"\b(all|every)\b", body.question, re.I))
    compiled = AnalysisRequest(dataset_id=body.dataset_id,
        banks=body.banks or banks or ([] if reset else prior_filters.get("banks", [])),
        payment_methods=body.payment_methods or methods or ([] if reset else prior_filters.get("payment_methods", [])))
    if plan.intent in {"priorities", "drivers"} and re.search(r"\b(retail|digital|category|merchant)\b", body.question, re.I):
        yield {"type": "result", "data": {"status": "NEEDS_CLARIFICATION", "analysis_steps": trace,
            "clarification": "Category breakdowns are supported, but reliable impact ranking currently uses bank × payment method. Ask for a category breakdown or rank payment segments.", "suggested_questions": []}}
        return
    yield step("quality", "Check the source data", "running")
    snapshot = repository.load_snapshot(user_id, compiled)
    if (snapshot.diagnostics["order_count"] != snapshot.diagnostics["fact_count"] or
        snapshot.diagnostics["ledger_net_paise"] != snapshot.diagnostics["fact_net_paise"]):
        raise AnalysisBlocked("Source data does not reconcile. No numerical answer was produced.")
    yield step("quality", "Check the source data", "completed", "Order counts and financial totals reconcile.")
    yield step("query", "Run the payment analysis", "running")
    sql_result = repository.execute_generated(user_id, compiled, plan.sql)
    query_detail = ("Reused a previously executed query from Upstash after verifying your data access. "
                    if sql_result["evidence"].get("execution") == "CACHE_HIT" else "Executed a validated aggregate SELECT. ")
    yield step("query", "Run the payment analysis", "completed", query_detail + f"Retrieved {len(sql_result['rows'])} result rows.")
    yield step("calculate", "Compare results and calculate impact", "running")
    planning = {"mode": "gemini_sql", "label": "Gemini · generated and validated SQL", "plan": {"intent": plan.intent}}
    if plan.intent in {"priorities", "drivers"}:
        report = present(analyse(snapshot, compiled), body.question, planning)
    else:
        report = {"source": "supabase", "dataset": jsonable_dataset(snapshot.version),
                  "filters": compiled.model_dump(mode="json"), "question": body.question,
                  "planning": planning, "calculation_version": CALCULATION_VERSION, "segments": [],
                  "method": {"query": "Gemini generates an aggregate SELECT; server scopes dataset and filters, validates the AST, and executes read-only.", "settings": asdict(EngineSettings())},
                  "query_evidence": snapshot.query_evidence,
                  "caveats": ["Synthetic data and modelled costs; these are demonstration results.", "Observed differences do not establish cause. Pending orders are excluded from conversion.", "Money is net contribution after processing and modelled loss provision; fixed overhead is excluded."]}
    report["sql_result"] = sql_result
    report["query_evidence"] = [*report["query_evidence"], sql_result["evidence"]]
    if "answer" not in report:
        report = present_query(report)
    yield step("calculate", "Compare results and calculate impact", "completed", "Calculated facts from returned values; any financial ranking uses the deterministic evidence gates.")
    yield step("research", "Research the supporting evidence", "running", "A separate read-only agent can perform at most one supporting query.")
    with research_identity(user_id):
        research = research_agent.run(report)
    report = apply_research(report, research)
    yield step("research", "Research the supporting evidence", "completed" if research["status"] in {"completed", "not_needed"} else "unavailable", research["summary"])
    report["analysis_steps"] = trace
    saved = repository.save_analysis(user_id, compiled, report)
    yield {"type": "result", "data": saved}


@app.post("/chat")
def chat(body: ChatRequest, user_id: UUID | None = Depends(get_access_subject), repository=Depends(get_repository),
         research_agent=Depends(get_research_agent)):
    for event in chat_workflow(body, user_id, repository, research_agent):
        if event["type"] == "result":
            return event["data"]


@app.post("/chat/stream")
def stream_chat(body: ChatRequest, user_id: UUID | None = Depends(get_access_subject), repository=Depends(get_repository),
                research_agent=Depends(get_research_agent)):
    def events():
        try:
            for event in chat_workflow(body, user_id, repository, research_agent):
                yield "data: " + json.dumps(event, default=str) + "\n\n"
        except (AnalysisBlocked, ResourceNotFound, BackendUnavailable) as error:
            status = 409 if isinstance(error, AnalysisBlocked) else 404 if isinstance(error, ResourceNotFound) else 503
            yield "data: " + json.dumps({"type": "error", "detail": str(error), "status": status}) + "\n\n"
        except Exception:
            yield "data: " + json.dumps({"type": "error", "detail": "Analysis could not complete. Please try again.", "status": 500}) + "\n\n"
    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def jsonable_dataset(version):
    from fastapi.encoders import jsonable_encoder
    return jsonable_encoder(version)


@app.post("/analyses/{analysis_id}/next-actions", status_code=201)
def build_next_actions(analysis_id: UUID, body: NextActionRequest, repository=Depends(get_repository),
                       workflow=Depends(get_next_actions_workflow), user_id: UUID | None = Depends(get_access_subject)):
    saved = repository.get_analysis(user_id, analysis_id)
    original = saved["analysis"]
    if original["calculation_version"] != CALCULATION_VERSION:
        raise AnalysisBlocked("Run a new analysis before building recommendations with this calculation version.")
    scope = action_request(original)
    with customer_scope(saved.get("customer_scope")), research_identity(user_id):
        snapshot = repository.load_snapshot(user_id, scope)
        baseline = analyse(snapshot, scope)
        plan = workflow.run(baseline, body)
    if original["dataset"]["fingerprint"] != baseline["dataset"]["fingerprint"]:
        raise AnalysisBlocked("The dataset changed. Run a new analysis before building actions.")
    plan["query_evidence"] = [*baseline["query_evidence"], *plan["query_evidence"]]
    plan["workflow_steps"].insert(0, {"id":"action-baseline","title":"Verify the recommendation baseline","status":"completed",
        "detail":"Reconciled source data and rebuilt matched historical benchmarks for the exact supported scope."})
    return repository.save_action_plan(analysis_id, plan, user_id=user_id)


@app.get("/action-plans/{plan_id}")
def get_action_plan(plan_id: UUID, user_id: UUID | None = Depends(get_access_subject), repository=Depends(get_repository)):
    return repository.get_action_plan(plan_id, user_id=user_id)


@app.post("/action-plans/{plan_id}/simulations", status_code=201)
def simulate_action(plan_id: UUID, body: ActionSimulationRequest, user_id: UUID | None = Depends(get_access_subject), repository=Depends(get_repository)):
    saved = repository.get_action_plan(plan_id, user_id=user_id)
    if saved["plan"]["calculation_version"] != ACTION_VERSION:
        raise AnalysisBlocked("Rebuild the action plan before simulating with this version.")
    action = next((item for item in saved["plan"]["actions"] if item["action_id"] == body.action_id), None)
    if not action:
        raise ResourceNotFound("Action not found in this plan.")
    result = action_scenario(action, body)
    return repository.save_action_simulation(plan_id, body, result, user_id=user_id)


@app.get("/action-simulations/{identifier}")
def get_action_simulation(identifier: UUID, user_id: UUID | None = Depends(get_access_subject), repository=Depends(get_repository)):
    return repository.get_action_simulation(identifier, user_id=user_id)


@app.get("/analyses/{analysis_id}")
def get_analysis(analysis_id: UUID, user_id: UUID | None = Depends(get_access_subject), repository=Depends(get_repository)):
    return repository.get_analysis(user_id, analysis_id)


@app.get("/analyses/{analysis_id}/evidence")
def evidence(analysis_id: UUID, user_id: UUID | None = Depends(get_access_subject), repository=Depends(get_repository)):
    saved = repository.get_analysis(user_id, analysis_id)
    report = saved["analysis"]
    return {"analysis_id": str(analysis_id), "dataset": report["dataset"],
            "filters": report["filters"], "method": report["method"],
            "queries": report["query_evidence"], "caveats": report["caveats"]}


@app.post("/analyses/{analysis_id}/scenarios", status_code=201)
def create_scenario(analysis_id: UUID, body: ScenarioRequest, user_id: UUID | None = Depends(get_access_subject),
                    repository=Depends(get_repository)):
    saved = repository.get_analysis(user_id, analysis_id)
    if saved["analysis"]["calculation_version"] != CALCULATION_VERSION:
        raise AnalysisBlocked("Calculation version changed. Run a new analysis before simulating.")
    result = scenario_from_analysis(saved["analysis"], body)
    return repository.save_scenario(user_id, analysis_id, body, result)


@app.get("/scenarios/{scenario_id}")
def get_scenario(scenario_id: UUID, user_id: UUID | None = Depends(get_access_subject), repository=Depends(get_repository)):
    return repository.get_scenario(user_id, scenario_id)


app.mount("/assets", StaticFiles(directory=STATIC_PATH, check_dir=False), name="assets")
