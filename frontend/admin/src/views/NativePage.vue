<script setup lang="ts">
import { computed, reactive, ref, toRef, watch } from 'vue';
import { NAlert, NButton, NCard, NCheckbox, NEmpty, NFormItem, NInput, NModal, NSelect, NSpace, NSwitch, NTabPane, NTabs, NTag, useDialog, useMessage } from 'naive-ui';
import { native } from '../api';
import { useResource } from '../composables';
import { useRuntime } from '../stores/runtime';
import ResourceState from '../components/ResourceState.vue';

const props = defineProps<{kind: string}>(); const runtime = useRuntime();
const tab = ref('toolsets'); const message = useMessage(); const dialog = useDialog(); const busy = ref(false);
const modal = ref(false); const form = reactive<Record<string,any>>({}); const editing = ref<any>(null);
const routes: Record<string,string> = { models:'/api/providers/custom-endpoints', tools:'/api/tools/toolsets', mcp:'/api/mcp/servers', messaging:'/api/messaging/platforms', cron:'/api/cron/jobs' };
const endpoint = computed(() => props.kind === 'tools' ? ({toolsets:'/api/tools/toolsets',skills:'/api/skills',plugins:'/api/dashboard/plugins/hub'}[tab.value]!) : routes[props.kind]);
const {data,loading,error,refresh} = useResource(async () => {
  const owner = runtime.profile;
  const result = await native(endpoint.value, owner);
  if (props.kind === 'models') return { entries:result, model:await native('/api/model/info',owner) };
  return result;
},[toRef(runtime,'profile'),endpoint]);
const rows = computed<any[]>(() => {
  const result = props.kind === 'models' ? data.value?.entries : data.value;
  if (Array.isArray(result)) return result;
  return result?.servers || result?.platforms || result?.endpoints || result?.plugins || [];
});
watch(() => runtime.profile, () => { modal.value=false;editing.value=null; });
async function mutate(path:string,method:string,body?:unknown) {
  const owner=runtime.profile;busy.value=true;
  try { const result=await native(path,owner,method,body);message.success('操作已完成');if(owner===runtime.profile){modal.value=false;await refresh();}return result; }
  catch(e){message.error((e as Error).message);throw e;}
  finally{busy.value=false;}
}
async function toggle(row:any,enabled:boolean) {
  let path='',body:any={enabled};
  if(props.kind==='tools') {
    path=tab.value==='skills'?'/api/skills/toggle':`/api/tools/toolsets/${encodeURIComponent(row.name)}`;
    body=tab.value==='skills'?{name:row.name,enabled}:{enabled};
  } else if(props.kind==='mcp') path=`/api/mcp/servers/${encodeURIComponent(row.name)}/enabled`;
  else path=`/api/messaging/platforms/${encodeURIComponent(row.id)}`;
  await mutate(path,'PUT',body).catch(()=>{});
}
function openForm(row:any=null) {
  Object.keys(form).forEach(key=>delete form[key]); editing.value=row;
  if(props.kind==='models') Object.assign(form,{name:'',base_url:'',model:'',api_key:'',make_default:true});
  if(props.kind==='mcp') Object.assign(form,{name:'',transport:'http',url:'',command:'',args:''});
  if(props.kind==='cron') Object.assign(form,{name:row?.name||'',prompt:row?.prompt||'',schedule:row?.schedule_display||row?.schedule?.display||'',paused:true});
  if(props.kind==='messaging') for(const field of row.env_vars || []) form[field.key]=field.is_password?'':field.value||'';
  modal.value=true;
}
async function save() {
  if(props.kind==='models') {
    if(!form.name.trim()||!form.base_url.trim()||!form.model.trim())return message.error('请填写名称、接口地址和模型 ID');
    try {const url=new URL(form.base_url);if(!['http:','https:'].includes(url.protocol))throw new Error();}catch{return message.error('请填写有效的 HTTP(S) 接口地址');}
    await mutate('/api/providers/custom-endpoints','POST',{...form,...(!form.api_key?{api_key:null}:{})}).catch(()=>{});
  } else if(props.kind==='mcp') {
    if(!form.name.trim()||!(form.transport==='http'?form.url.trim():form.command.trim()))return message.error('请填写名称和连接信息');
    const body=form.transport==='http'?{name:form.name,url:form.url}:{name:form.name,command:form.command,args:form.args.split('\n').filter(Boolean)};
    await mutate('/api/mcp/servers','POST',body).catch(()=>{});
  } else if(props.kind==='cron') {
    if(!form.prompt.trim()||!form.schedule.trim())return message.error('请填写任务内容和执行计划');
    await mutate(editing.value?`/api/cron/jobs/${encodeURIComponent(editing.value.id)}`:'/api/cron/jobs',editing.value?'PUT':'POST',editing.value?{updates:{name:form.name,prompt:form.prompt,schedule:form.schedule}}:{...form,deliver:'local'}).catch(()=>{});
  } else if(props.kind==='messaging') {
    const env:Record<string,string>={};for(const field of editing.value.env_vars||[]){const value=form[field.key];if(field.is_password?!value:value===(field.value||''))continue;env[field.key]=value;}
    await mutate(`/api/messaging/platforms/${encodeURIComponent(editing.value.id)}`,'PUT',{env}).catch(()=>{});
  }
}
function removeMcp(row:any) {dialog.warning({title:`移除 ${row.name}？`,content:'将移除该 MCP 的原生配置。',positiveText:'移除',negativeText:'取消',onPositiveClick:()=>mutate(`/api/mcp/servers/${encodeURIComponent(row.name)}`,'DELETE').catch(()=>{})});}
async function testMcp(row:any) { busy.value=true;const owner=runtime.profile;try{const r=await native(`/api/mcp/servers/${encodeURIComponent(row.name)}/test`,owner,'POST');r.ok?message.success(`连接成功，发现 ${r.tools?.length||0} 个工具`):message.error(r.error||'连接失败');}catch(e){message.error((e as Error).message);}finally{busy.value=false;} }
</script>
<template>
  <n-tabs v-if="kind==='tools'" v-model:value="tab" type="segment" class="mb"><n-tab-pane name="toolsets" tab="工具集"/><n-tab-pane name="skills" tab="技能"/><n-tab-pane name="plugins" tab="插件"/></n-tabs>
  <div class="toolbar"><span class="muted">配置归属：{{ runtime.profile }}</span><n-space><n-button @click="refresh">刷新</n-button><n-button v-if="['models','mcp','cron'].includes(kind)" type="primary" @click="openForm()">{{ {models:'添加自定义供应商',mcp:'添加 MCP',cron:'新建任务'}[kind] }}</n-button></n-space></div>
  <n-card v-if="kind==='models' && data" :bordered="false" class="mb"><div class="split"><div><span class="eyebrow">默认模型</span><h2>{{ data.model.model || '尚未设置' }}</h2><span class="muted">{{ data.model.provider || '请先配置模型供应商' }}</span></div><n-tag :bordered="false">原生配置</n-tag></div></n-card>
  <n-alert v-if="kind==='cron'" type="info" :bordered="false" class="mb">新任务默认暂停，检查后可启用。定时任务使用 Hermes 原生调度；执行依赖服务持续运行。</n-alert>
  <n-alert v-if="kind==='tools'&&tab==='plugins'" type="info" :bordered="false" class="mb">此处展示原生插件目录；插件安装、授权和浏览器兼容性正在接入验证。</n-alert>
  <ResourceState :loading="loading" :error="error" @retry="refresh">
    <n-card v-if="!rows.length" :bordered="false"><n-empty :description="kind==='models'?'尚未添加自定义供应商':'当前 Profile 暂无配置'" /></n-card>
    <div v-else class="resource-list"><n-card v-for="(row,index) in rows" :key="row.id||`${row.name}-${row.platform||index}`" :bordered="false">
      <div class="split"><div class="resource-description"><h3>{{ row.label||row.display_name||row.name||row.id }} <n-tag v-if="row.platform_label" size="small" :bordered="false">{{ row.platform_label }}</n-tag></h3><p>{{ row.description||row.base_url||row.url||row.command||row.prompt||'' }}</p><span v-if="row.model" class="muted">{{ row.model }}</span><span v-if="kind==='cron'" class="muted">{{ row.schedule_display || row.schedule?.display || '执行计划已配置' }}</span></div>
        <n-space align="center">
          <template v-if="kind==='tools' && tab!=='plugins'"><span class="muted">{{ row.available===false?'当前环境不可用':row.enabled?'已启用':'已停用' }}</span><n-switch :value="row.enabled" :disabled="busy" @update:value="value=>toggle(row,value)" /></template>
          <template v-if="kind==='mcp'"><n-button size="small" :loading="busy" @click="testMcp(row)">测试</n-button><n-button size="small" @click="removeMcp(row)">移除</n-button><n-switch :value="row.enabled!==false" :disabled="busy" @update:value="value=>toggle(row,value)" /></template>
          <template v-if="kind==='messaging'"><n-tag size="small" :type="row.configured?'success':'default'" :bordered="false">{{ row.configured?'已配置':'未配置' }}</n-tag><n-button size="small" @click="openForm(row)">配置</n-button><n-switch :value="row.enabled" :disabled="busy" @update:value="value=>toggle(row,value)" /></template>
          <template v-if="kind==='cron'"><n-tag size="small" :type="row.paused?'default':'success'" :bordered="false">{{ row.paused?'已暂停':'已启用' }}</n-tag><n-button size="small" @click="openForm(row)">编辑</n-button><n-button size="small" :loading="busy" @click="mutate(`/api/cron/jobs/${encodeURIComponent(row.id)}/${row.paused?'resume':'pause'}`,'POST').catch(()=>{})">{{ row.paused?'启用':'暂停' }}</n-button></template>
        </n-space>
      </div>
    </n-card></div>
  </ResourceState>
  <n-modal v-model:show="modal" preset="card" :title="kind==='messaging'?`${editing?.name} 配置`:kind==='cron'?(editing?'编辑任务':'新建任务'):kind==='mcp'?'添加 MCP':'添加自定义供应商'" style="width:560px;max-width:calc(100vw - 32px)">
    <p class="muted mb">保存到 {{ runtime.profile }} 的 Hermes 原生配置</p>
    <template v-if="kind==='models'"><n-form-item label="供应商名称"><n-input v-model:value="form.name" placeholder="例如：我的模型服务" /></n-form-item><n-form-item label="接口地址"><n-input v-model:value="form.base_url" placeholder="https://example.com/v1" /></n-form-item><n-form-item label="模型 ID"><n-input v-model:value="form.model" placeholder="填写供应商提供的模型 ID" /></n-form-item><n-form-item label="API Key"><n-input v-model:value="form.api_key" type="password" show-password-on="click" placeholder="可选；留空不写入密钥" /></n-form-item><n-checkbox v-model:checked="form.make_default">设为默认模型</n-checkbox></template>
    <template v-if="kind==='mcp'"><n-form-item label="服务名称"><n-input v-model:value="form.name" /></n-form-item><n-form-item label="连接方式"><n-select v-model:value="form.transport" :options="[{label:'HTTP / SSE',value:'http'},{label:'本地命令（在 NAS 执行）',value:'stdio'}]" /></n-form-item><n-form-item v-if="form.transport==='http'" label="服务地址"><n-input v-model:value="form.url" placeholder="https://example.com/mcp" /></n-form-item><template v-else><n-form-item label="命令"><n-input v-model:value="form.command" placeholder="例如 npx" /></n-form-item><n-form-item label="参数（每行一个）"><n-input v-model:value="form.args" type="textarea" /></n-form-item></template></template>
    <template v-if="kind==='cron'"><n-form-item label="任务名称"><n-input v-model:value="form.name" /></n-form-item><n-form-item label="执行计划"><n-input v-model:value="form.schedule" placeholder="例如：0 9 * * *" /></n-form-item><n-form-item label="任务内容"><n-input v-model:value="form.prompt" type="textarea" :autosize="{minRows:4,maxRows:10}" /></n-form-item></template>
    <template v-if="kind==='messaging'"><n-form-item v-for="field in editing?.env_vars || []" :key="field.key" :label="field.prompt||field.key"><n-input v-model:value="form[field.key]" :type="field.is_password?'password':'text'" :placeholder="field.is_password&&field.is_set?'已配置，留空保留原值':field.description" show-password-on="click" /></n-form-item><n-alert type="info" :bordered="false">留空的密码保留原值。平台配对与扫码流程尚待逐平台接入。</n-alert></template>
    <template #footer><div class="modal-footer"><n-button @click="modal=false">取消</n-button><n-button type="primary" :loading="busy" @click="save">保存</n-button></div></template>
  </n-modal>
</template>
