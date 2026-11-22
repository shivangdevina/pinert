import json
from uuid import uuid4
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.responses import StreamingResponse

from payments_analyst.cors import frontend_origins, configure_cors


def test_origins_are_exact_and_deduplicated():
    assert frontend_origins(' https://payscope.vercel.app/,http://127.0.0.1:4173,https://payscope.vercel.app ')==[
        'https://payscope.vercel.app','http://127.0.0.1:4173']
    assert frontend_origins('')==[]


@pytest.mark.parametrize('origin',['*','https://*.vercel.app','http://example.com','https://example.com/path',
    'https://name:secret@example.com','https://example.com?secret=value','https://example.com/#fragment',
    'https://example.com:bad','example.com'])
def test_invalid_or_broad_origins_are_refused(origin):
    with pytest.raises(ValueError):frontend_origins(origin)


def test_allowed_vercel_origin_can_send_authorized_json_and_receive_stream():
    app=FastAPI();configure_cors(app,'https://payscope.vercel.app')
    @app.post('/chat/stream')
    def stream():
        return StreamingResponse(iter(['data: '+json.dumps({'type':'result','data':{'id':str(uuid4())}})+'\n\n']),media_type='text/event-stream')
    with TestClient(app) as client:
        options=client.options('/chat/stream',headers={'Origin':'https://payscope.vercel.app',
            'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'})
        assert options.status_code==200
        response=client.post('/chat/stream',json={},headers={'Origin':'https://payscope.vercel.app','Authorization':'Bearer test'})
        assert response.status_code==200 and response.headers['access-control-allow-origin']=='https://payscope.vercel.app'
        assert response.headers['content-type'].startswith('text/event-stream') and '"type": "result"' in response.text
        assert 'access-control-allow-credentials' not in response.headers
        denied=client.options('/chat/stream',headers={'Origin':'https://other.vercel.app',
            'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type'})
        assert denied.status_code==400 and 'access-control-allow-origin' not in denied.headers


def test_same_origin_local_app_does_not_require_a_cors_setting():
    app=FastAPI();configure_cors(app,'')
    @app.get('/health')
    def health():return {'status':'ok'}
    with TestClient(app) as client:
        assert client.get('/health').status_code==200
        assert 'access-control-allow-origin' not in client.get('/health',headers={'Origin':'https://unlisted.vercel.app'}).headers
