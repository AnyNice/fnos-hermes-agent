<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { NAlert, NButton, NCard, NCheckbox, NEmpty, NFormItem, NInput, NInputNumber, NModal, NSelect, NSpace, NSpin, NTabPane, NTabs, NTag, useDialog, useMessage } from 'naive-ui';
import { native } from '../api';
import { useRuntime } from '../stores/runtime';

type EnvInfo = { is_set:boolean; redacted_value?:string; description?:string; url?:string; category?:string; is_password?:boolean; advanced?:boolean; provider?:string; provider_label?:string; provider_primary?:boolean; provider_profiles?:Array<{provider:string;provider_label:string;description?:string;url?:string;primary?:boolean}> };
type ProviderGroup = { id:string; label:string; description:string; url?:string; fields:Array<[string,EnvInfo]>; configured:boolean };

const runtime=useRuntime();const message=useMessage();const dialog=useDialog();
// v0.21.164 首装门控：核心（dashboard）未 ready 时，配置类写操作注定 502——提前拦截并说明现状，
// 避免首装冷启动（~1min）窗口里用户反复点「保存」刷红 toast、误判为配置填错。
// 返回 ''=放行；status 未拉取（null）时放行（api 层 502 友好标记兜底）。
function coreNotReady():string{const s=runtime.status?.backend?.state;if(!s||s==='ready')return'';if(s==='starting')return'核心服务初始化中，请稍候片刻再试';if(s==='unresponsive')return'核心服务无响应，可到「概览 → 运行管理」重启工作服务';return'核心服务未运行，请先到「概览 → 运行管理」启动工作服务';}
function blockIfNotReady():boolean{const tip=coreNotReady();if(tip)message.warning(tip);return !!tip;}
const tab=ref('presets');const loading=ref(true);const error=ref('');const errorLevel=ref<'error'|'warning'>('error');const busy=ref(false);const keyword=ref('');
const env=ref<Record<string,EnvInfo>>({});const custom=ref<any>({endpoints:[],current:{}});const model=ref<any>({});const oauth=ref<any[]>([]);
const presetModal=ref(false);const selected=ref<ProviderGroup|null>(null);const presetValues=reactive<Record<string,string>>({});const makeDefault=ref(true);
const customModal=ref(false);const customForm=reactive<any>({id:'',name:'',base_url:'',model:'',api_key:'',api_mode:'',context_length:null,discover_models:true,make_default:true});
const discoveredModels=ref<string[]>([]);const discoveredDetails=ref<any[]>([]);const validateState=ref<'idle'|'running'|'ok'|'warn'|'fail'|'cached'>('idle');
const modelOptions=computed(()=>{const list=[...discoveredModels.value];if(customForm.model&&!list.includes(customForm.model))list.unshift(customForm.model);return list.map(id=>({label:id,value:id}));});

function groupsFromEnv(source:Record<string,EnvInfo>):ProviderGroup[]{
  const groups=new Map<string,ProviderGroup>();
  const add=(id:string,label:string,description:string,url:string|undefined,key:string,info:EnvInfo)=>{
    if(!id)return;let group=groups.get(id);if(!group){group={id,label:label||id,description:description||'',url,fields:[],configured:false};groups.set(id,group);}
    if(!group.fields.some(([name])=>name===key))group.fields.push([key,info]);group.configured ||= !!info.is_set;
  };
  for(const [key,info] of Object.entries(source)){
    if(info.category!=='provider')continue;
    add(info.provider||'',info.provider_label||info.provider||'',info.description||'',info.url,key,info);
    for(const profile of info.provider_profiles||[])add(profile.provider,profile.provider_label,profile.description||info.description||'',profile.url||info.url,key,info);
  }
  return [...groups.values()].map(group=>({...group,fields:group.fields.sort((a,b)=>Number(!!b[1].provider_primary)-Number(!!a[1].provider_primary)||Number(!!a[1].advanced)-Number(!!b[1].advanced))})).sort((a,b)=>Number(b.configured)-Number(a.configured)||a.label.localeCompare(b.label));
}
const providers=computed(()=>{const q=keyword.value.trim().toLowerCase();return groupsFromEnv(env.value).filter(row=>!q||`${row.label} ${row.id} ${row.description}`.toLowerCase().includes(q));});

async function load(){const owner=runtime.profile;loading.value=true;error.value='';try{const [nextEnv,nextCustom,nextModel,nextOauth]=await Promise.all([native('/api/env',owner),native('/api/providers/custom-endpoints',owner),native('/api/model/info',owner),native('/api/providers/oauth',owner)]);if(owner!==runtime.profile)return;env.value=nextEnv;custom.value=nextCustom;model.value=nextModel;oauth.value=nextOauth.providers||[];}catch(e){if(owner===runtime.profile){error.value=(e as Error).message;errorLevel.value=(e as any)?.coreNotReady?'warning':'error';}}finally{if(owner===runtime.profile)loading.value=false;}}
watch(()=>runtime.profile,()=>{presetModal.value=false;customModal.value=false;void load();});onMounted(()=>void load());
function openPreset(group:ProviderGroup){selected.value=group;Object.keys(presetValues).forEach(k=>delete presetValues[k]);makeDefault.value=!group.configured;presetModal.value=true;}
async function savePreset(){if(blockIfNotReady())return;if(!selected.value)return;const entries=Object.entries(presetValues).filter(([,value])=>value.trim());if(!entries.length)return message.warning('请输入至少一项配置');busy.value=true;const owner=runtime.profile;try{
  const primary=entries.find(([key])=>selected.value?.fields.find(([name])=>name===key)?.[1].is_password);
  if(primary){const validation:any=await native('/api/providers/validate',owner,'POST',{key:primary[0],value:primary[1]});if(validation.reachable&&validation.ok===false)throw new Error(validation.message||'供应商拒绝了该凭据');}
  for(const [key,value] of entries)await native('/api/env',owner,'PUT',{key,value,provider_setup:true});
  if(makeDefault.value){const recommended:any=await native(`/api/model/recommended-default?provider=${encodeURIComponent(selected.value.id)}`,owner);if(recommended.model){const result:any=await native('/api/model/set',owner,'POST',{scope:'main',provider:selected.value.id,model:recommended.model});if(result.confirm_required)await native('/api/model/set',owner,'POST',{scope:'main',provider:selected.value.id,model:recommended.model,confirm_expensive_model:true});}else message.warning('凭据已保存；该供应商暂未返回推荐模型，请在 Hermes 工作界面选择模型。');}
  message.success(`${selected.value.label} 已保存`);presetModal.value=false;await load();
}catch(e){message.error((e as Error).message);}finally{busy.value=false;}}
function clearCredential(key:string,label:string){dialog.warning({title:`移除 ${label} 凭据？`,content:`将从 ${runtime.profile} 中清除 ${key}，不会删除历史会话。`,positiveText:'移除',negativeText:'取消',onPositiveClick:async()=>{busy.value=true;try{await native('/api/env',runtime.profile,'DELETE',{key});message.success('凭据已移除');await load();}catch(e){message.error((e as Error).message);}finally{busy.value=false;}}});}
function openCustom(row:any=null){Object.assign(customForm,{id:row?.id||'',name:row?.name||'',base_url:row?.base_url||'',model:row?.model||row?.models?.[0]||'',api_key:'',api_mode:row?.api_mode||'',context_length:row?.context_length||null,discover_models:row?.discover_models!==false,make_default:!row});discoveredModels.value=row?.models? [...row.models]:[];discoveredDetails.value=[];validateState.value=row?.models?.length?'cached':'idle';customModal.value=true;}
// v0.21.166 模型发现缓存：编辑已有接口时，后端 /custom-endpoints 列表行已带回上次保存时持久化的
// models 目录（CustomEndpointUpdate.models，见 #69988），直接回填「模型 ID」下拉，
// 无需重填 apikey 重新测试；validateState='cached' 提示缓存存在、可重新测试刷新。
async function validateCustom(){if(blockIfNotReady())return;if(!customForm.base_url.trim())return message.warning('请先填写接口地址');busy.value=true;validateState.value='running';try{const result:any=await native('/api/providers/custom-endpoints/validate',runtime.profile,'POST',{...customForm});discoveredModels.value=result.models||[];discoveredDetails.value=result.model_details||[];if(discoveredModels.value.length&&!customForm.model)customForm.model=discoveredModels.value[0];if(result.ok){validateState.value='ok';message.success(`连接成功，发现 ${discoveredModels.value.length} 个模型`);}else{validateState.value='warn';message.warning(result.message||'接口可访问，但未完成模型验证');}}catch(e){validateState.value='fail';message.error((e as Error).message);}finally{busy.value=false;}}
async function saveCustom(){if(blockIfNotReady())return;if(!customForm.name.trim()||!customForm.base_url.trim()||!customForm.model.trim())return message.error('请填写名称、接口地址和模型 ID');busy.value=true;try{await native('/api/providers/custom-endpoints',runtime.profile,'POST',{...customForm,api_key:customForm.api_key||null,models:discoveredModels.value.length?[...new Set(discoveredModels.value)]:undefined,model_details:discoveredDetails.value.length?discoveredDetails.value:undefined});message.success('自定义接口已保存');customModal.value=false;await load();}catch(e){message.error((e as Error).message);}finally{busy.value=false;}}
async function activateCustom(row:any){if(blockIfNotReady())return;busy.value=true;try{await native(`/api/providers/custom-endpoints/${encodeURIComponent(row.id)}/activate`,runtime.profile,'POST');message.success('已设为默认模型');await load();}catch(e){message.error((e as Error).message);}finally{busy.value=false;}}
function removeCustom(row:any){dialog.warning({title:`删除 ${row.name}？`,content:'将移除接口配置与对应凭据，不会删除历史会话。',positiveText:'删除',negativeText:'取消',onPositiveClick:async()=>{await native(`/api/providers/custom-endpoints/${encodeURIComponent(row.id)}`,runtime.profile,'DELETE');message.success('已删除');await load();}});}
</script>

<template>
  <n-card :bordered="false" class="mb"><div class="split"><div><span class="eyebrow">当前默认模型</span><h2>{{ model.model||'尚未设置' }}</h2><span class="muted">{{ model.provider||'请选择预设供应商或添加自定义接口' }}</span></div><n-tag :type="model.model?'success':'default'" :bordered="false">Profile: {{ runtime.profile }}</n-tag></div></n-card>
  <n-tabs v-model:value="tab" type="segment" class="mb"><n-tab-pane name="presets" tab="预设供应商"/><n-tab-pane name="custom" tab="自定义接口"/><n-tab-pane name="accounts" tab="OAuth 账户"/></n-tabs>
  <n-alert v-if="error" :type="errorLevel" :bordered="false" class="mb">{{ error }} <n-button text type="primary" @click="load">重试</n-button></n-alert>
  <div v-if="loading" class="state"><n-spin size="small"/>正在读取 Hermes 原生供应商目录…</div>
  <template v-else-if="tab==='presets'">
    <div class="toolbar"><n-input v-model:value="keyword" clearable placeholder="搜索 OpenAI、Anthropic、DeepSeek、Kimi…" style="max-width:420px"/><span class="muted">{{ providers.length }} 家原生预设</span></div>
    <div class="provider-grid"><n-card v-for="provider in providers" :key="provider.id" :bordered="false" class="provider-card"><div><div class="split"><h3>{{ provider.label }}</h3><n-tag size="small" :type="provider.configured?'success':'default'" :bordered="false">{{ provider.configured?'已连接':'未配置' }}</n-tag></div><p class="muted mt">{{ provider.description||provider.id }}</p></div><div class="provider-actions"><span class="muted">{{ provider.fields.length }} 项配置</span><n-button size="small" type="primary" secondary @click="openPreset(provider)">{{ provider.configured?'管理':'配置' }}</n-button></div></n-card></div>
  </template>
  <template v-else-if="tab==='custom'">
    <div class="toolbar"><span class="muted">OpenAI、Anthropic Messages 或 Codex Responses 兼容接口</span><n-button type="primary" @click="openCustom()">添加自定义接口</n-button></div>
    <n-empty v-if="!(custom.endpoints||[]).length" description="尚未添加自定义接口"/>
    <div v-else class="resource-list"><n-card v-for="row in custom.endpoints" :key="row.id" :bordered="false"><div class="split"><div class="resource-description"><h3>{{ row.name }} <n-tag v-if="custom.current?.provider===row.id" type="success" size="small" :bordered="false">当前默认</n-tag></h3><p>{{ row.base_url }}</p><span class="muted">{{ row.model||row.models?.join(', ') }}</span></div><n-space><n-button size="small" @click="openCustom(row)">编辑</n-button><n-button size="small" @click="activateCustom(row)">设为默认</n-button><n-button size="small" type="error" secondary @click="removeCustom(row)">删除</n-button></n-space></div></n-card></div>
  </template>
  <template v-else>
    <n-alert type="info" :bordered="false" class="mb">OAuth 登录由 Hermes 原生账户系统管理。需要浏览器授权或外部 CLI 的账户会显示对应方式。</n-alert>
    <div class="oauth-grid"><n-card v-for="row in oauth" :key="row.id" :bordered="false"><div class="split"><div><h3>{{ row.name }}</h3><p class="muted mt">{{ row.status?.connected||row.status?.configured?'已连接':row.cli_command||'可通过 Hermes 连接' }}</p></div><n-tag :type="row.status?.connected||row.status?.configured?'success':'default'" :bordered="false">{{ row.status?.connected||row.status?.configured?'已连接':'未连接' }}</n-tag></div><n-space class="mt"><n-button v-if="row.docs_url" size="small" tag="a" :href="row.docs_url" target="_blank">查看说明</n-button><n-button v-if="row.disconnectable&&(row.status?.connected||row.status?.configured)" size="small" type="error" secondary @click="native(`/api/providers/oauth/${encodeURIComponent(row.id)}`,runtime.profile,'DELETE').then(load)">断开</n-button></n-space></n-card></div>
  </template>

  <n-modal v-model:show="presetModal" preset="card" :title="`${selected?.label||''} 配置`" style="width:600px;max-width:calc(100vw - 32px)"><p class="muted mb">字段来自 Hermes 0.22.2 原生供应商目录，凭据保存到 {{ runtime.profile }}。</p><n-form-item v-for="([key,info]) in selected?.fields||[]" :key="key" :label="info.description||key"><n-input v-model:value="presetValues[key]" :type="info.is_password?'password':'text'" show-password-on="click" :placeholder="info.is_set?`已配置 ${info.redacted_value||''}；留空保持不变`:key"/><template #feedback><div class="split"><code>{{ key }}</code><n-button v-if="info.is_set" text type="error" size="tiny" @click="clearCredential(key,selected?.label||'')">清除此项</n-button></div></template></n-form-item><n-checkbox v-model:checked="makeDefault">保存后设为默认供应商，并选择 Hermes 推荐模型</n-checkbox><template #footer><div class="modal-footer"><n-button @click="presetModal=false">取消</n-button><n-button type="primary" :loading="busy" @click="savePreset">保存并验证</n-button></div></template></n-modal>
  <n-modal v-model:show="customModal" preset="card" title="自定义模型接口" style="width:600px;max-width:calc(100vw - 32px)"><n-form-item label="名称"><n-input v-model:value="customForm.name"/></n-form-item><n-form-item label="接口地址"><n-input v-model:value="customForm.base_url" placeholder="https://example.com/v1"/></n-form-item><n-form-item label="API 模式"><n-select v-model:value="customForm.api_mode" :options="[{label:'自动检测',value:''},{label:'OpenAI Chat Completions',value:'chat_completions'},{label:'OpenAI Codex Responses',value:'codex_responses'},{label:'Anthropic Messages',value:'anthropic_messages'}]"/></n-form-item><n-form-item label="模型 ID"><n-select v-model:value="customForm.model" filterable tag :options="modelOptions" :placeholder="discoveredModels.length?'从已发现模型中选择或输入':'先填写接口并测试，发现模型后从此处选择'" :disabled="!discoveredModels.length&&!customForm.model"/></n-form-item><n-alert v-if="validateState==='running'" type="info" :bordered="false" class="mb">正在测试连接并发现模型…</n-alert><n-alert v-else-if="validateState==='cached'" type="success" :bordered="false" class="mb">已缓存 {{ discoveredModels.length }} 个模型（上次测试发现并随接口保存）。无需重填 API Key 即可直接编辑保存；点「测试并发现模型」可刷新模型列表。</n-alert><n-alert v-else-if="validateState==='ok'" type="success" :bordered="false" class="mb">连接成功，已发现 {{ discoveredModels.length }} 个模型，可从「模型 ID」下拉中选择。</n-alert><n-alert v-else-if="validateState==='warn'" type="warning" :bordered="false" class="mb">接口可访问但未完成模型验证（该模型仍可能可用，可手动输入模型 ID 保存）。</n-alert><n-alert v-else-if="validateState==='fail'" type="error" :bordered="false" class="mb">连接测试失败，请检查接口地址、API Key 或网络。</n-alert><n-form-item label="上下文长度"><n-input-number v-model:value="customForm.context_length" clearable :min="1024" style="width:100%"/></n-form-item><n-form-item label="API Key"><n-input v-model:value="customForm.api_key" type="password" show-password-on="click" :placeholder="customForm.id?'留空保留原值':'可选'"/></n-form-item><n-checkbox v-model:checked="customForm.make_default">设为默认模型</n-checkbox><template #footer><div class="modal-footer"><n-button :loading="busy" @click="validateCustom">测试并发现模型</n-button><n-button type="primary" :loading="busy" @click="saveCustom">保存</n-button></div></template></n-modal>
</template>
