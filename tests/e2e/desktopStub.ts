import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
export async function startDesktopStub() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Стенд моста</title></head><body>
<h1 id="chat">Стенд Teams</h1><div class="nt"><button aria-haspopup="dialog" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.getElementById('bell').hidden=false">Уведомления</button></div><div id="bell" hidden>Уведомления открыты</div><div id="messages"></div>
<script>
window.calls=[];window.delivered=[];window.failReplies=0;
window.startBridge=async(protocol='1.1',id=1)=>{
 const bridge=window.schemaDesktop;if(!bridge)return;
 for(const name of ['navigate','reply','markRead','timer','focus','windowState'])bridge.on(name,async(data)=>{
  window.calls.push({name,data});
  if(name==='navigate'){history.pushState({},'',data.link);document.getElementById('chat').textContent=data.link;}
  if(name==='reply'){
   if(window.failReplies-->0)return{ok:false,error:'Нет связи'};
   if(!window.delivered.some(item=>item.requestId===data.requestId))window.delivered.push(data);
   document.getElementById('messages').textContent=data.text;
  }
  if(name==='focus')await bridge.send('focus',data.until?{until:data.until}:null);
  if(name==='timer')await bridge.send('timer',{state:'run',task:{id:data.taskId||4,mark:'АР1',title:'Тестовая задача'},startedAt:new Date().toISOString(),elapsedSec:0,reason:null});
  return{ok:true};
 });
 await bridge.send('hello',{protocol,user:{id,shortName:'Иванова И.И.'},serverVersion:'0.10.0'});
};
</script></body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
