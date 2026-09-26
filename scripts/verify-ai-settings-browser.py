"""Real React settings controls; mocks admin HTTP and Link navigation only.
Does not contact a relay, disclose credentials or change a real database.
"""
import argparse, functools, json, threading
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright, expect

def main():
    ap=argparse.ArgumentParser();ap.add_argument('harness');ap.add_argument('--out',default='ai-settings-browser-results');ap.add_argument('--chromium');args=ap.parse_args()
    out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(SimpleHTTPRequestHandler,directory=args.harness))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    config={'name':'test','baseUrl':'https://old.example/v1','wireApi':'auto','modelCatalog':[{'id':'vision-a'}], 'recognitionModel':'vision-a','textModel':'','diagramModel':'','gradingModel':'','enabled':True,'hasApiKey':True,'updatedAt':1}
    calls=[];ready=True;errors=[];results={}
    with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True,executable_path=args.chromium)
        page=browser.new_page(viewport={'width':1280,'height':1000});page.on('pageerror',lambda error:errors.append(str(error)))
        def admin(route):
            nonlocal config
            if route.request.method=='PUT':
                body=route.request.post_data_json;calls.append(('save',body));config={k:v for k,v in body.items() if k!='apiKey'}
                config.update({'hasApiKey':True,'updatedAt':2});route.fulfill(json={'config':config})
            else:route.fulfill(json={'config':config,'environmentFallback':{'configured':False},'encryptionReady':ready})
        def models(route):
            calls.append(('models',route.request.post_data_json));route.fulfill(json={'models':[{'id':'vision-b'}],'latencyMs':1})
        page.route('**/api/admin/ai-provider',admin);page.route('**/api/admin/ai-provider/models',models)
        try:
            page.goto(f'http://127.0.0.1:{server.server_port}/')
            save=page.get_by_role('button',name='保存配置',exact=True);discover=page.get_by_role('button',name='获取上游模型',exact=True)
            expect(save).to_be_enabled();expect(page.get_by_label('API Key',exact=True)).to_have_value('')
            page.get_by_label('Base URL',exact=True).fill('https://new.example/v1')
            expect(save).to_be_disabled();expect(discover).to_be_disabled();expect(page.get_by_role('status')).to_contain_text('Base URL 已变化');assert not calls
            page.get_by_label('API Key',exact=True).fill('browser-only-test-key')
            page.get_by_label('API 协议',exact=True).select_option('antigravity_gemini');discover.click()
            expect(page.get_by_text('已从上游获取 1 个模型 · 1 ms',exact=True)).to_be_visible()
            assert calls[0][1]['wireApi']=='antigravity_gemini';assert calls[0][1]['baseUrl']=='https://new.example/v1'
            expect(page.get_by_label('截图 / 文件识题',exact=True)).to_have_value('vision-a')
            page.get_by_label('截图 / 文件识题',exact=True).select_option('');expect(save).to_be_disabled()
            page.get_by_label('截图 / 文件识题',exact=True).select_option('vision-b');save.click()
            expect(page.get_by_label('API Key',exact=True)).to_have_value('');expect(save).to_be_enabled()
            page.reload();expect(page.get_by_label('Base URL',exact=True)).to_have_value('https://new.example/v1');expect(page.get_by_label('截图 / 文件识题',exact=True)).to_have_value('vision-b')
            page.get_by_label('启用数据库中的 Provider 配置',exact=True).uncheck();save.click()
            expect(page.get_by_text('数据库 Provider 已停用，将使用环境变量配置（如有）。',exact=True)).to_be_visible()
            ready=False;page.reload();expect(page.get_by_role('alert')).to_contain_text('AI_PROVIDER_ENCRYPTION_KEY')
            page.get_by_label('API Key',exact=True).fill('another-browser-test-key');expect(save).to_be_disabled()
            for name,width,height in [('desktop',1280,1000),('mobile',390,844)]:
                page.set_viewport_size({'width':width,'height':height});page.screenshot(path=str(out/f'{name}.png'),full_page=True)
                sizes=page.evaluate('({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})')
                assert sizes['scroll']<=sizes['width'],sizes;results[name]=sizes
            assert not errors,errors
            results.update({'changedEndpointRequiresNewKey':True,'emptyModelBlocksSave':True,'protocolSentForDiscovery':True,'selectedModelSurvivesCatalogRefresh':True,'savedKeyClearedFromInputs':True,'disabledProviderNotice':True,'missingEncryptionSecretNotice':True,'pageErrors':errors})
        finally:browser.close();server.shutdown()
    (out/'browser-results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
if __name__=='__main__':main()
