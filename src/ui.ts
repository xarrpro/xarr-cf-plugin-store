// 两个页面(基于 Shoelace Web Components,CDN 零构建):
// STORE_HTML —— 公开橱窗(根 / 只展示不可下载;/<uuid> 注入 __DL_BASE__ 后可下载)
// ADMIN_HTML —— 管理后台(自定义密路径 /<ADMIN_PATH>,注入 __ADMIN_BASE__,令牌登录后增删查改/发版/令牌/下载入口)
// 内嵌 JS 全部用字符串拼接,避免反引号与 ${} 干扰外层模板字符串。

// Shoelace 资源(本地离线自托管,深色主题;组件已全部预注册,无 autoloader、无外部 CDN)
const SL_HEAD = `
<link rel="stylesheet" href="/vendor/shoelace.css">
<script type="module" src="/vendor/shoelace.js"></script>`;

const BASE_CSS = `
:root{--bg:#0f1115;--card:#1a1d24;--card2:#222631;--line:#2c313c;--fg:#e6e8ec;--mut:#9aa3b2}
:not(:defined){visibility:hidden}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
header{display:flex;align-items:center;gap:16px;padding:14px 22px;background:#141720;border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10}
.brand{font-size:18px;font-weight:700;white-space:nowrap}
.search{flex:1;display:flex;gap:10px;max-width:680px;align-items:center}
.search sl-input{flex:1}
main{max-width:1100px;margin:0 auto;padding:22px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:16px}
.pcard{cursor:pointer}
.pcard::part(base){background:var(--card);border:1px solid var(--line);transition:.15s}
.pcard:hover::part(base){border-color:var(--sl-color-primary-600);transform:translateY(-2px)}
.pcard h3{margin:0 0 4px;font-size:16px}
.pname{color:var(--mut);font-size:12px;font-family:ui-monospace,Menlo,monospace}
.pdesc{color:var(--mut);font-size:13px;min-height:38px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.cfoot{display:flex;justify-content:space-between;align-items:center;gap:8px}
.hint{color:var(--mut);text-align:center;padding:50px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{padding:11px 12px;text-align:left;border-bottom:1px solid var(--line);font-size:13px;vertical-align:middle}
th{background:var(--card2);color:var(--mut);font-weight:600}
tr:last-child td{border-bottom:none}
.actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.admin-bar{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;gap:10px;flex-wrap:wrap}
.rel{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)}
.rel:last-child{border-bottom:none}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--mut)}
.center{min-height:70vh;display:flex;align-items:center;justify-content:center}
.login-box{width:100%;max-width:400px}
.field{margin-bottom:14px}
.row{display:flex;gap:12px}.row>*{flex:1}
.modal-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
sl-dialog::part(panel){background:var(--card)}
`;

// 公共脚本:Shoelace 封装(toast / 确认框 / 通用弹框)+ 工具函数
const COMMON_JS = `
function $(id){return document.getElementById(id)}
function esc(s){s=(s==null?'':String(s));return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
var TYPE_MAP={1:'支付插件',2:'首页主题',3:'支付主题',4:'短信插件',5:'收银台主题'};
function typeName(t){return TYPE_MAP[t]||('类型 '+t)}
function ts(s){if(!s)return '-';var d=new Date(s*1000);return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2)}
function kb(n){if(n==null)return '-';if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(2)+' MB'}
function toast(message,variant){
  var a=document.createElement('sl-alert');
  a.variant=variant||'primary';a.closable=true;a.duration=3000;
  a.textContent=message;
  document.body.appendChild(a);
  customElements.whenDefined('sl-alert').then(function(){a.toast()});
}
function confirmDialog(message,opts){
  opts=opts||{};
  return new Promise(function(resolve){
    var d=document.createElement('sl-dialog');
    d.label=opts.title||'确认';
    var body=document.createElement('div');body.style.whiteSpace='pre-wrap';body.textContent=message;
    var cancel=document.createElement('sl-button');cancel.slot='footer';cancel.textContent='取消';
    var okb=document.createElement('sl-button');okb.slot='footer';okb.variant=opts.danger?'danger':'primary';okb.textContent=opts.ok||'确定';
    d.appendChild(body);d.appendChild(cancel);d.appendChild(okb);
    document.body.appendChild(d);
    function done(v){d.hide();resolve(v)}
    cancel.addEventListener('click',function(){done(false)});
    okb.addEventListener('click',function(){done(true)});
    d.addEventListener('sl-after-hide',function(e){if(e.target===d)d.remove()});
    customElements.whenDefined('sl-dialog').then(function(){d.show()});
  });
}
function openModal(html,label){var m=$('modal');$('modalBody').innerHTML=html;m.label=label||'';m.show();}
function closeModal(){$('modal').hide();}
`;

// ============ 公开橱窗页 ============
export const STORE_HTML = `<!doctype html>
<html lang="zh-CN" class="sl-theme-dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>插件中心</title>
${SL_HEAD}
<style>${BASE_CSS}</style>
</head>
<body>
<header>
  <div class="brand">🧩 插件中心</div>
  <div class="search">
    <sl-input id="q" placeholder="搜索插件名称 / 标题…" clearable size="medium"></sl-input>
    <sl-select id="type" value="" size="medium" style="min-width:140px">
      <sl-option value="">全部类型</sl-option>
      <sl-option value="1">支付插件</sl-option>
      <sl-option value="2">首页主题</sl-option>
      <sl-option value="3">支付主题</sl-option>
      <sl-option value="4">短信插件</sl-option>
      <sl-option value="5">收银台主题</sl-option>
    </sl-select>
  </div>
</header>
<main>
  <sl-alert id="dlNotice" variant="warning" open style="display:none;margin-bottom:16px">
    🔒 当前为公开浏览模式,仅展示插件信息。接入与安装请通过授权的下载入口地址。
  </sl-alert>
  <sl-alert id="srcPanel" variant="primary" open style="display:none;margin-bottom:16px">
    <strong>🔌 插件源接入地址</strong>
    <div class="mono" id="srcUrl" style="word-break:break-all;margin:6px 0"></div>
    <sl-button size="small" id="srcCopy">复制地址</sl-button>
    <div style="margin-top:8px;color:var(--mut);font-size:13px">复制此地址 → 填入 merchant-server 后台「应用商店 / 仓库地址」→ 刷新即可同步并安装下方插件。本页仅供浏览,不提供直接下载。</div>
  </sl-alert>
  <div id="grid" class="grid"></div>
  <div id="emptyHint" class="hint" style="display:none">暂无插件</div>
</main>
<sl-dialog id="modal" label=""><div id="modalBody"></div></sl-dialog>
<script>
var DL_BASE='__DL_BASE__';
${COMMON_JS}
function copyText(t){
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(function(){toast('已复制','success')},function(){toast('复制失败,请手动复制','warning')})}
  else{toast('浏览器不支持自动复制,请手动复制','warning')}
}
if(DL_BASE){
  var srcUrl=location.origin+DL_BASE+'/source';
  $('srcUrl').textContent=srcUrl;$('srcPanel').style.display='block';
  $('srcCopy').addEventListener('click',function(){copyText(srcUrl)});
}else{$('dlNotice').style.display='block'}
function jget(path){return fetch(path).then(function(r){return r.json()})}
function loadPublic(){
  var q=$('q').value.trim(),t=$('type').value;
  var u='/api/plugins?';
  if(q)u+='q='+encodeURIComponent(q)+'&';
  if(t)u+='type='+encodeURIComponent(t);
  jget(u).then(function(j){
    var list=(j&&j.data)||[];
    var g=$('grid');g.innerHTML='';
    $('emptyHint').style.display=list.length?'none':'block';
    list.forEach(function(p){
      var c=document.createElement('sl-card');c.className='pcard';
      var ver=p.latest_version?'<sl-tag size="small" variant="success">v'+esc(p.latest_version)+'</sl-tag>':'<sl-tag size="small" variant="neutral">未发布</sl-tag>';
      c.innerHTML='<h3>'+esc(p.title)+'</h3><div class="pname">'+esc(p.name)+'</div>'+
        '<div class="pdesc">'+esc(p.description||'暂无描述')+'</div>'+
        '<div slot="footer" class="cfoot"><sl-tag size="small">'+esc(typeName(p.type))+'</sl-tag>'+ver+'</div>';
      c.addEventListener('click',function(){openDetail(p.name)});
      g.appendChild(c);
    });
  }).catch(function(){toast('加载失败','danger')});
}
function openDetail(name){
  jget('/api/plugins/'+encodeURIComponent(name)).then(function(j){
    if(!j||j.code!==200){toast('加载失败','danger');return}
    var p=j.data.plugin, rels=j.data.releases||[];
    var h='<div class="mono" style="margin-bottom:8px">'+esc(p.name)+' · '+esc(typeName(p.type))+(p.author?' · '+esc(p.author):'')+'</div>';
    h+='<p style="color:var(--mut);margin-top:0">'+esc(p.description||'暂无描述')+'</p>';
    if(p.homepage)h+='<p><a href="'+esc(p.homepage)+'" target="_blank" rel="noopener">'+esc(p.homepage)+'</a></p>';
    h+='<sl-divider></sl-divider><b>版本('+rels.length+')</b>';
    if(!rels.length)h+='<div class="hint">暂无发布版本</div>';
    rels.forEach(function(r){
      h+='<div class="rel"><div><b>v'+esc(r.version)+'</b> <sl-tag size="small" variant="neutral">'+esc(r.channel)+'</sl-tag><div class="mono">'+kb(r.package_size)+' · '+ts(r.created_at)+'</div></div></div>';
    });
    openModal(h, p.title);
  });
}
var _t;
$('q').addEventListener('sl-input',function(){clearTimeout(_t);_t=setTimeout(loadPublic,250)});
$('type').addEventListener('sl-change',loadPublic);
customElements.whenDefined('sl-input').then(loadPublic);
</script>
</body>
</html>`;

// ============ 管理后台页 ============
export const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN" class="sl-theme-dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>插件管理后台</title>
${SL_HEAD}
<script src="/vendor/fflate.js"></script>
<style>${BASE_CSS}</style>
</head>
<body>
<header>
  <div class="brand">🛠 插件管理后台</div>
  <div style="flex:1"></div>
  <span id="hbInfo" class="mono"></span>
  <sl-button id="logoutBtn" size="small" variant="default" style="display:none">退出</sl-button>
</header>
<main>
  <section id="loginView" class="center">
    <sl-card class="login-box">
      <div slot="header"><b>管理员登录</b></div>
      <p class="mono" id="uuidInfo"></p>
      <div class="field"><sl-input id="inTok" type="password" label="管理员令牌" placeholder="Bearer Token" password-toggle autofocus></sl-input></div>
      <sl-button id="loginBtn" variant="primary" style="width:100%">登录</sl-button>
      <p id="loginErr" class="mono" style="color:var(--sl-color-danger-600)"></p>
    </sl-card>
  </section>
  <section id="adminView" style="display:none">
    <div class="admin-bar">
      <b>插件管理</b>
      <div class="actions">
        <sl-button id="newPluginBtn" variant="primary" size="small">＋ 新建插件</sl-button>
        <sl-button id="gatewayBtn" size="small">下载入口</sl-button>
        <sl-button id="tokenBtn" size="small">令牌管理</sl-button>
      </div>
    </div>
    <table>
      <thead><tr><th>名称</th><th>标题</th><th>类型</th><th>最新版本</th><th>状态</th><th>操作</th></tr></thead>
      <tbody id="adminRows"></tbody>
    </table>
  </section>
</main>
<sl-dialog id="modal" label=""><div id="modalBody"></div></sl-dialog>
<script>
var ADMIN_BASE='__ADMIN_BASE__';
var DL_BASE='';
var TOKEN=sessionStorage.getItem('ps_token_'+ADMIN_BASE)||'';
${COMMON_JS}
$('uuidInfo').textContent='后台入口 '+ADMIN_BASE;
function adminBase(){return ADMIN_BASE}
function areq(method,path,body,raw,extraHeaders){
  var h={'Authorization':'Bearer '+TOKEN};
  var opt={method:method,headers:h};
  if(raw){opt.body=raw}
  else if(body!==undefined){h['Content-Type']='application/json';opt.body=JSON.stringify(body)}
  if(extraHeaders){for(var k in extraHeaders)h[k]=extraHeaders[k]}
  return fetch(adminBase()+path,opt).then(function(r){
    if(r.status===401){throw {code:4010,msg:'令牌失效,请重新登录'}}
    return r.json().then(function(j){if(j.code!==200)throw j;return j.data})
  })
}
function doLogin(){
  var tok=$('inTok').value.trim();
  if(!tok){$('loginErr').textContent='请输入令牌';return}
  TOKEN=tok;$('loginErr').textContent='验证中…';$('loginBtn').loading=true;
  areq('GET','/plugins').then(function(){
    sessionStorage.setItem('ps_token_'+ADMIN_BASE,tok);$('loginBtn').loading=false;enterAdmin();
  }).catch(function(e){$('loginBtn').loading=false;$('loginErr').textContent=(e&&e.message)||'登录失败:令牌错误'});
}
function logout(){TOKEN='';sessionStorage.removeItem('ps_token_'+ADMIN_BASE);$('adminView').style.display='none';$('loginView').style.display='flex';$('logoutBtn').style.display='none';$('hbInfo').textContent=''}
function enterAdmin(){
  $('loginView').style.display='none';$('adminView').style.display='block';$('logoutBtn').style.display='';
  $('hbInfo').textContent='管理后台';
  loadDlBase();loadAdmin();
}
// 后台内的「下载」按钮需要一个有效下载入口:取第一个签发的 UUID 作为预览用 DL_BASE
function loadDlBase(){
  areq('GET','/gateways').then(function(list){DL_BASE=(list&&list[0])?'/'+list[0].uuid:''}).catch(function(){DL_BASE=''});
}
function loadAdmin(){
  areq('GET','/plugins').then(function(list){
    var rows=$('adminRows');rows.innerHTML='';
    (list||[]).forEach(function(p){
      var tr=document.createElement('tr');
      var stTag=p.status===1?'<sl-tag size="small" variant="success">上架</sl-tag>':'<sl-tag size="small" variant="warning">下架</sl-tag>';
      tr.innerHTML='<td class="mono">'+esc(p.name)+'</td><td>'+esc(p.title)+'</td><td><sl-tag size="small">'+esc(typeName(p.type))+'</sl-tag></td><td>'+esc(p.latest_version||'-')+'</td><td>'+stTag+'</td>';
      var td=document.createElement('td');td.className='actions';
      td.innerHTML='<sl-button size="small" data-a="ver">版本</sl-button><sl-button size="small" data-a="edit">编辑</sl-button><sl-button size="small" data-a="tog">'+(p.status===1?'下架':'上架')+'</sl-button><sl-button size="small" data-a="del">软删</sl-button><sl-button size="small" variant="danger" data-a="purge">彻底删</sl-button>';
      td.querySelector('[data-a=ver]').addEventListener('click',function(){openVersions(p.name)});
      td.querySelector('[data-a=edit]').addEventListener('click',function(){openEdit(p)});
      td.querySelector('[data-a=tog]').addEventListener('click',function(){toggleStatus(p)});
      td.querySelector('[data-a=del]').addEventListener('click',function(){delPlugin(p.name)});
      td.querySelector('[data-a=purge]').addEventListener('click',function(){purgePlugin(p.name)});
      tr.appendChild(td);rows.appendChild(tr);
    });
  }).catch(function(e){if(e&&e.code===4010){logout();toast('请重新登录','warning')}else toast('加载失败','danger')});
}
function pluginForm(p){
  p=p||{};
  return '<div class="field"><sl-input id="fName" label="name(唯一标识)" value="'+esc(p.name)+'" '+(p.name?'disabled':'')+'></sl-input></div>'+
    '<div class="row"><div class="field"><sl-input id="fTitle" label="title 标题" value="'+esc(p.title)+'"></sl-input></div>'+
    '<div class="field"><sl-select id="fType" label="type 类型" value="'+(p.type?esc(p.type):'1')+'"><sl-option value="1">支付插件</sl-option><sl-option value="2">首页主题</sl-option><sl-option value="3">支付主题</sl-option><sl-option value="4">短信插件</sl-option><sl-option value="5">收银台主题</sl-option></sl-select></div></div>'+
    '<div class="field"><sl-input id="fAuthor" label="author 作者" value="'+esc(p.author)+'"></sl-input></div>'+
    '<div class="field"><sl-textarea id="fDesc" label="description 描述" rows="3" value="'+esc(p.description)+'"></sl-textarea></div>'+
    '<div class="field"><sl-input id="fHome" label="homepage 主页" value="'+esc(p.homepage)+'"></sl-input></div>';
}
function openNew(){openModal(pluginForm({})+'<div class="modal-foot"><sl-button onclick="closeModal()">取消</sl-button><sl-button variant="primary" onclick="saveNew()">创建</sl-button></div>','新建插件')}
function saveNew(){
  var b={name:$('fName').value.trim(),title:$('fTitle').value.trim(),type:Number($('fType').value),author:$('fAuthor').value.trim(),description:$('fDesc').value.trim(),homepage:$('fHome').value.trim()};
  if(!b.name||!b.title){toast('name 与 title 必填','warning');return}
  areq('POST','/plugins',b).then(function(){closeModal();loadAdmin();toast('已创建','success')}).catch(function(e){toast((e&&e.message)||'创建失败','danger')});
}
function openEdit(p){openModal(pluginForm(p)+'<div class="modal-foot"><sl-button onclick="closeModal()">取消</sl-button><sl-button variant="primary" onclick="saveEdit(\\''+esc(p.name)+'\\')">保存</sl-button></div>','编辑插件')}
function saveEdit(name){
  var b={title:$('fTitle').value.trim(),type:Number($('fType').value),author:$('fAuthor').value.trim(),description:$('fDesc').value.trim(),homepage:$('fHome').value.trim()};
  areq('PATCH','/plugins/'+encodeURIComponent(name),b).then(function(){closeModal();loadAdmin();toast('已保存','success')}).catch(function(e){toast((e&&e.message)||'保存失败','danger')});
}
function toggleStatus(p){
  var ns=p.status===1?2:1;
  areq('PATCH','/plugins/'+encodeURIComponent(p.name)+'/status',{status:ns}).then(function(){loadAdmin();toast(ns===1?'已上架':'已下架','success')}).catch(function(e){toast((e&&e.message)||'操作失败','danger')});
}
function delPlugin(name){
  confirmDialog('软删除插件 '+name+'?可恢复,不会删除版本文件。',{title:'软删除'}).then(function(okv){
    if(!okv)return;
    areq('DELETE','/plugins/'+encodeURIComponent(name)).then(function(){loadAdmin();toast('已软删除','success')}).catch(function(e){toast((e&&e.message)||'删除失败','danger')});
  });
}
function purgePlugin(name){
  confirmDialog('彻底删除插件 '+name+'?\\n将物理删除其所有版本文件,不可恢复!',{title:'⚠️ 彻底删除',danger:true,ok:'彻底删除'}).then(function(okv){
    if(!okv)return;
    confirmDialog('再次确认:彻底删除 '+name+' 及全部版本?',{title:'⚠️ 二次确认',danger:true,ok:'确认删除'}).then(function(ok2){
      if(!ok2)return;
      areq('DELETE','/plugins/'+encodeURIComponent(name)+'/purge').then(function(d){loadAdmin();toast('已彻底删除('+((d&&d.releases)||0)+' 个版本)','success')}).catch(function(e){toast((e&&e.message)||'删除失败','danger')});
    });
  });
}
function openVersions(name){
  areq('GET','/plugins/'+encodeURIComponent(name)).then(function(d){
    var rels=d.releases||[];
    var h='<div class="field"><label class="mono">方式①:选文件夹(自动按 manifest.name 打包成「插件名/」结构,支付/短信插件需含 plugin.lua,跳过 .DS_Store/.git/node_modules/*.log)</label><input id="pubDir" type="file" webkitdirectory style="display:block;margin-top:6px;color:var(--mut)"></div>';
    h+='<div class="field"><label class="mono">方式②:选已打好的 .zip(须为「插件名/...」顶层目录结构)</label><input id="pubFile" type="file" accept=".zip" style="display:block;margin-top:6px;color:var(--mut)"></div>';
    h+='<div class="row"><div class="field"><sl-input id="pubCh" label="渠道 channel" value="stable"></sl-input></div><div class="field" style="display:flex;align-items:flex-end"><sl-button id="pubBtn" variant="primary" onclick="doPublish(\\''+esc(name)+'\\')">上传发布</sl-button></div></div>';
    h+='<sl-divider></sl-divider><b>已有版本('+rels.length+')</b>';
    if(!rels.length)h+='<div class="hint">暂无</div>';
    rels.forEach(function(r){
      var st=r.status===1?'<sl-tag size="small" variant="success">上架</sl-tag>':'<sl-tag size="small" variant="warning">下架</sl-tag>';
      var dl=r.status===1?'<sl-button size="small" href="'+DL_BASE+'/dl/'+encodeURIComponent(name)+'/'+encodeURIComponent(r.version)+'">下载</sl-button>':'';
      var tog=r.status===1
        ?'<sl-button size="small" onclick="relStatus(\\''+esc(name)+'\\',\\''+esc(r.version)+'\\',\\''+esc(r.channel)+'\\',2)">下架</sl-button>'
        :'<sl-button size="small" variant="primary" onclick="relStatus(\\''+esc(name)+'\\',\\''+esc(r.version)+'\\',\\''+esc(r.channel)+'\\',1)">上架</sl-button>';
      var del='<sl-button size="small" variant="danger" onclick="delRelease(\\''+esc(name)+'\\',\\''+esc(r.version)+'\\',\\''+esc(r.channel)+'\\')">删除</sl-button>';
      h+='<div class="rel"><div><b>v'+esc(r.version)+'</b> <sl-tag size="small" variant="neutral">'+esc(r.channel)+'</sl-tag> '+st+'<div class="mono">'+kb(r.package_size)+' · '+ts(r.created_at)+'</div></div><div class="actions">'+dl+tog+del+'</div></div>';
    });
    openModal(h,'版本管理 · '+name);
  }).catch(function(e){toast((e&&e.message)||'加载失败','danger')});
}
function sha256hex(buf){return crypto.subtle.digest('SHA-256',buf).then(function(d){var a=Array.prototype.map.call(new Uint8Array(d),function(b){return ('0'+b.toString(16)).slice(-2)});return a.join('')})}
function isJunkPath(rel){
  var parts=rel.split('/');
  for(var i=0;i<parts.length;i++){var s=parts[i];
    if(s==='.DS_Store'||s==='Thumbs.db'||s==='.git'||s==='.svn'||s==='.hg'||s==='node_modules'||s==='.idea'||s==='.vscode')return true;}
  var last=parts[parts.length-1]||'';
  if(last.slice(-4)==='.log')return true;
  return false;
}
function stripTop(rel){var i=rel.indexOf('/');return i>=0?rel.slice(i+1):rel}
// 选文件夹 → 读 manifest.name → 重组成「{name}/...」结构打包(过滤垃圾文件),返回 Uint8Array
function buildZipFromFolder(files){
  var arr=Array.prototype.slice.call(files);
  if(!arr.length)return Promise.reject({msg:'文件夹为空'});
  if(typeof fflate==='undefined')return Promise.reject({msg:'打包库尚未加载完成,请稍候重试'});
  var maniFile=null;
  for(var i=0;i<arr.length;i++){if(stripTop(arr[i].webkitRelativePath||arr[i].name)==='manifest.json'){maniFile=arr[i];break}}
  if(!maniFile)return Promise.reject({msg:'所选文件夹根目录必须直接包含 manifest.json'});
  return maniFile.text().then(function(txt){
    var mani;try{mani=JSON.parse(txt)}catch(e){throw {msg:'manifest.json 不是合法 JSON'}}
    var name=mani&&mani.name;
    if(!name)throw {msg:'manifest.json 缺少 name 字段'};
    var type=Number(mani.type);
    var hasLua=arr.some(function(f){return stripTop(f.webkitRelativePath||f.name)==='plugin.lua'});
    if((type===1||type===4)&&!hasLua)throw {msg:'支付/短信插件缺少入口文件 plugin.lua'};
    var entries={};
    var jobs=arr.map(function(f){
      var rel=f.webkitRelativePath||f.name;
      if(isJunkPath(rel))return Promise.resolve();
      var inner=stripTop(rel);
      if(!inner||inner.slice(-1)==='/')return Promise.resolve();
      return f.arrayBuffer().then(function(buf){entries[name+'/'+inner]=new Uint8Array(buf)});
    });
    return Promise.all(jobs).then(function(){return fflate.zipSync(entries,{level:6})});
  });
}
function publishBuffer(name,buf,ch){
  return sha256hex(buf).then(function(sha){
    var path='/plugins/'+encodeURIComponent(name)+'/releases'+(ch!=='stable'?'?channel='+encodeURIComponent(ch):'');
    return areq('POST',path,undefined,buf,{'Content-Type':'application/zip','X-Package-Sha256':sha});
  });
}
function doPublish(name){
  var ch=$('pubCh').value.trim()||'stable';
  var dirFiles=$('pubDir')?$('pubDir').files:null;
  var zipF=$('pubFile')?$('pubFile').files[0]:null;
  var prep;
  if(dirFiles&&dirFiles.length){prep=buildZipFromFolder(dirFiles)}
  else if(zipF){prep=zipF.arrayBuffer().then(function(b){return new Uint8Array(b)})}
  else{toast('请选择文件夹或 .zip 文件','warning');return}
  $('pubBtn').loading=true;
  prep.then(function(u8){
    var buf=u8.buffer.slice(u8.byteOffset,u8.byteOffset+u8.byteLength);
    return publishBuffer(name,buf,ch);
  }).then(function(d){toast('发布成功 v'+(d&&d.version),'success');openVersions(name);loadAdmin()})
    .catch(function(e){if($('pubBtn'))$('pubBtn').loading=false;toast('发布失败:'+((e&&e.message)||'未知错误'),'danger')});
}
function relStatus(name,version,channel,status){
  areq('PATCH','/plugins/'+encodeURIComponent(name)+'/releases/'+encodeURIComponent(version)+'/status?channel='+encodeURIComponent(channel),{status:status}).then(function(){openVersions(name);loadAdmin();toast(status===1?'已上架':'已下架','success')}).catch(function(e){toast((e&&e.message)||'操作失败','danger')});
}
function delRelease(name,version,channel){
  confirmDialog('删除版本 v'+version+'('+channel+')?将物理删除该版本文件,不可恢复!',{title:'⚠️ 删除版本',danger:true,ok:'删除'}).then(function(okv){
    if(!okv)return;
    areq('DELETE','/plugins/'+encodeURIComponent(name)+'/releases/'+encodeURIComponent(version)+'?channel='+encodeURIComponent(channel)).then(function(){openVersions(name);loadAdmin();toast('已删除该版本','success')}).catch(function(e){toast((e&&e.message)||'删除失败','danger')});
  });
}
function openTokens(){
  areq('GET','/tokens').then(function(list){
    var h='<div class="row"><div class="field"><sl-input id="tkName" label="名称" placeholder="用途备注"></sl-input></div><div class="field" style="display:flex;align-items:flex-end"><sl-button id="tkBtn" variant="primary" onclick="issueTok()">签发新令牌</sl-button></div></div>';
    h+='<div id="tkNew"></div>';
    h+='<sl-divider></sl-divider><table><thead><tr><th>ID</th><th>名称</th><th>状态</th><th></th></tr></thead><tbody>';
    (list||[]).forEach(function(t){
      var stt=t.revoked?'<sl-tag size="small" variant="warning">已吊销</sl-tag>':'<sl-tag size="small" variant="success">有效</sl-tag>';
      h+='<tr><td class="mono">'+esc(t.id)+'</td><td>'+esc(t.name)+'</td><td>'+stt+'</td><td>'+(t.revoked?'':'<sl-button size="small" variant="danger" onclick="revokeTok(\\''+esc(t.id)+'\\')">吊销</sl-button>')+'</td></tr>';
    });
    h+='</tbody></table>';
    openModal(h,'令牌管理');
  }).catch(function(e){toast((e&&e.message)||'加载失败','danger')});
}
function issueTok(){
  var name=$('tkName').value.trim()||'unnamed';
  $('tkBtn').loading=true;
  areq('POST','/tokens',{name:name,expireAt:0}).then(function(d){
    $('tkBtn').loading=false;
    var box=$('tkNew');box.innerHTML='';
    var al=document.createElement('sl-alert');al.variant='success';al.open=true;al.closable=true;
    al.innerHTML='<b>🔑 新令牌(仅显示一次,请保存):</b><br><span class="mono" style="word-break:break-all">'+esc(d.plaintext)+'</span>';
    box.appendChild(al);
    toast('已签发','success');
  }).catch(function(e){$('tkBtn').loading=false;toast((e&&e.message)||'签发失败','danger')});
}
function revokeTok(id){
  confirmDialog('确认吊销令牌 '+id+'?',{title:'吊销令牌',danger:true,ok:'吊销'}).then(function(okv){
    if(!okv)return;
    areq('DELETE','/tokens/'+encodeURIComponent(id)).then(function(){openTokens();toast('已吊销','success')}).catch(function(e){toast((e&&e.message)||'失败','danger')});
  });
}
function gwLink(uuid){return location.origin+'/'+uuid}
function copyText(t){
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(function(){toast('已复制','success')},function(){toast('复制失败,请手动复制','warning')})}
  else{toast('浏览器不支持自动复制','warning')}
}
function openGateways(){
  areq('GET','/gateways').then(function(list){
    var h='<p class="mono" style="opacity:.7">下载入口 = 给别人分发的授权地址。访问该地址可浏览并下载插件;吊销后立即失效。可签发多个。</p>';
    h+='<div class="row"><div class="field"><sl-input id="gwName" label="备注" placeholder="如:某客户 / 某渠道"></sl-input></div><div class="field" style="display:flex;align-items:flex-end"><sl-button id="gwBtn" variant="primary" onclick="issueGw()">签发新入口</sl-button></div></div>';
    h+='<sl-divider></sl-divider><table><thead><tr><th>备注</th><th>下载地址</th><th></th></tr></thead><tbody>';
    (list||[]).forEach(function(g){
      var url=gwLink(g.uuid);
      h+='<tr><td>'+esc(g.name)+'</td><td class="mono" style="word-break:break-all">'+esc(url)+'</td><td class="actions"><sl-button size="small" onclick="copyText(\\''+esc(url)+'\\')">复制</sl-button><sl-button size="small" variant="danger" onclick="revokeGw(\\''+esc(g.uuid)+'\\')">吊销</sl-button></td></tr>';
    });
    h+='</tbody></table>';
    openModal(h,'下载入口管理');
  }).catch(function(e){toast((e&&e.message)||'加载失败','danger')});
}
function issueGw(){
  var name=$('gwName').value.trim()||'未命名';
  $('gwBtn').loading=true;
  areq('POST','/gateways',{name:name}).then(function(){$('gwBtn').loading=false;openGateways();loadDlBase();toast('已签发','success')}).catch(function(e){$('gwBtn').loading=false;toast((e&&e.message)||'签发失败','danger')});
}
function revokeGw(uuid){
  confirmDialog('吊销该下载入口?\\n'+gwLink(uuid)+'\\n吊销后该地址立即失效,不可恢复。',{title:'⚠️ 吊销下载入口',danger:true,ok:'吊销'}).then(function(okv){
    if(!okv)return;
    areq('DELETE','/gateways/'+encodeURIComponent(uuid)).then(function(){openGateways();loadDlBase();toast('已吊销','success')}).catch(function(e){toast((e&&e.message)||'失败','danger')});
  });
}
$('logoutBtn').addEventListener('click',logout);
$('loginBtn').addEventListener('click',doLogin);
$('newPluginBtn').addEventListener('click',openNew);
$('gatewayBtn').addEventListener('click',openGateways);
$('tokenBtn').addEventListener('click',openTokens);
$('inTok').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin()});
if(TOKEN){areq('GET','/plugins').then(function(){enterAdmin()}).catch(function(){logout()})}
</script>
</body>
</html>`;
