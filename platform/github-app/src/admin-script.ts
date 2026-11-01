/** Self-hosted progressive enhancement; every navigation/form works without it. */
export const ADMIN_SCRIPT = `(()=>{addEventListener('DOMContentLoaded',()=>{
const menu=document.querySelector('[data-menu-button]'),side=document.getElementById('admin-sidebar'),overlay=document.querySelector('.sidebar-overlay'),close=document.querySelector('[data-menu-close]');
let previous,previousOverflow='';
const focusable=()=>side?[...side.querySelectorAll('a[href],button:not([disabled]),select:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(x=>x.getClientRects().length&&getComputedStyle(x).visibility==='visible'):[];
const focusInside=()=>{if(!side?.hasAttribute('data-open'))return;const target=close||focusable()[0];target?.focus()};
const setOpen=open=>{
 if(!menu||!side)return;
 const workspace=document.querySelector('.admin-workspace');
 // Capture focus before inert can blur the trigger. Wait for the visible drawer
 // to render before focusing it; synchronous focus can fail during its transition.
 if(open){previous=document.activeElement!==document.body?document.activeElement:menu;previousOverflow=document.body.style.overflow;}
 menu.setAttribute('aria-expanded',String(open));side.toggleAttribute('data-open',open);overlay?.toggleAttribute('data-open',open);
 if(open){side.setAttribute('aria-modal','true');side.setAttribute('role','dialog');document.body.style.overflow='hidden';if(workspace)workspace.inert=true;requestAnimationFrame(focusInside);}
 else{side.removeAttribute('role');side.removeAttribute('aria-modal');if(workspace)workspace.inert=false;document.body.style.overflow=previousOverflow;(previous?.isConnected?previous:menu).focus();}
};
menu?.addEventListener('click',()=>setOpen(menu.getAttribute('aria-expanded')!=='true'));close?.addEventListener('click',()=>setOpen(false));overlay?.addEventListener('click',()=>setOpen(false));
document.addEventListener('keydown',e=>{
 if(!side?.hasAttribute('data-open'))return;
 if(e.key==='Escape'){e.preventDefault();setOpen(false);return;}
 if(e.key!=='Tab')return;
 const f=focusable();if(!f.length){e.preventDefault();return;}
 const outside=!side.contains(document.activeElement);
 if(outside||(e.shiftKey&&document.activeElement===f[0])){e.preventDefault();(e.shiftKey?f[f.length-1]:f[0]).focus();}
 else if(!e.shiftKey&&document.activeElement===f[f.length-1]){e.preventDefault();f[0].focus();}
});
const mq=matchMedia('(min-width:721px)');mq.addEventListener('change',()=>{if(mq.matches&&side?.hasAttribute('data-open'))setOpen(false)});
const pickers=[...document.querySelectorAll('[data-account-picker]')];
const closePickers=except=>pickers.forEach(p=>{if(p!==except)p.open=false});
pickers.forEach(p=>{const trigger=p.querySelector('summary'),links=()=>[...p.querySelectorAll('a[href]')];
 p.addEventListener('toggle',()=>{trigger.setAttribute('aria-expanded',String(p.open));if(p.open)closePickers(p)});
 p.addEventListener('keydown',e=>{if(e.key==='Escape'&&p.open){e.preventDefault();e.stopPropagation();p.open=false;trigger.focus();return;}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();p.open=true;const items=links(),i=items.indexOf(document.activeElement);const next=e.key==='Home'?0:e.key==='End'?items.length-1:e.key==='ArrowUp'?(i<=0?items.length-1:i-1):(i+1)%items.length;items[next]?.focus();
 });
 p.addEventListener('focusout',e=>{if(e.relatedTarget&&p.contains(e.relatedTarget))return;requestAnimationFrame(()=>{if(!p.contains(document.activeElement))p.open=false})});
});
document.addEventListener('click',e=>{if(!pickers.some(p=>p.contains(e.target)))closePickers()});
menu?.addEventListener('click',()=>closePickers());
const aiForm=document.querySelector('.ai-provider-form');
const syncAIFields=()=>{if(!aiForm)return;const own=aiForm.querySelector('input[name=mode]:checked')?.value==='byok',fields=aiForm.querySelector('[data-ai-byok-fields]'),platform=aiForm.querySelector('[data-ai-platform-hint]');if(fields)fields.hidden=!own;if(platform)platform.hidden=own;['base_url','model'].forEach(name=>{const input=aiForm.querySelector('[name='+name+']');if(input)input.required=own})};
aiForm?.addEventListener('change',e=>{if(e.target.name==='mode')syncAIFields()});syncAIFields();
document.querySelectorAll('[data-key-visibility]').forEach(button=>button.addEventListener('click',()=>{const input=document.getElementById(button.getAttribute('aria-controls'));if(!input)return;const show=input.type==='password';input.type=show?'text':'password';button.setAttribute('aria-pressed',String(show));button.textContent=show?button.dataset.hide:button.dataset.show}));
const settingsForm=document.querySelector('form[data-settings-form],form[action^="/admin/repo?"]'),language=document.getElementById('lang'),originalLanguage=language?.value;
const snapshot=()=>settingsForm?JSON.stringify([...new FormData(settingsForm)].map(([key,value])=>[key,typeof value==='string'?value:value.name])):'';
const initialSettings=snapshot();let leaving=false;
const dirty=()=>!!settingsForm&&!leaving&&snapshot()!==initialSettings;
const confirmLeave=()=>!dirty()||confirm(document.querySelector('.admin-app')?.dataset.unsavedMessage||'You have unsaved settings. Leave this page?');
addEventListener('beforeunload',e=>{if(dirty()){e.preventDefault();e.returnValue=''}});
document.addEventListener('click',e=>{const link=e.target.closest?.('a[href]');if(!link||e.defaultPrevented||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey||link.hasAttribute('download')||link.target&&link.target!=='_self')return;const target=new URL(link.href,location.href),here=new URL(location.href);if(target.origin===here.origin&&target.pathname===here.pathname&&target.search===here.search)return;if(!confirmLeave()){e.preventDefault();e.stopImmediatePropagation()}else leaving=true},true);
document.addEventListener('change',e=>{if(e.target!==language)return;if(!confirmLeave()){language.value=originalLanguage;e.preventDefault();e.stopImmediatePropagation()}else leaving=true},true);
const pending=new Map();
const restoreForms=()=>{pending.forEach((state,form)=>{form.removeAttribute('aria-busy');form.removeAttribute('data-pending');state.buttons.forEach(([b,html,aria])=>{b.innerHTML=html;if(aria===null)b.removeAttribute('aria-disabled');else b.setAttribute('aria-disabled',aria)});state.status.remove()});pending.clear()};
// Keep submitter name/value enabled so switches and confirmation actions reach
// the server unchanged. The submit event guard blocks repeat pointer/keyboard submits.
document.addEventListener('submit',e=>{const form=e.target;if(!(form instanceof HTMLFormElement)||form.method.toLowerCase()!=='post'||e.defaultPrevented)return;
 if(pending.has(form)){e.preventDefault();return;}
 if(form!==settingsForm&&(!form.target||form.target==='_self')&&dirty()){if(!confirmLeave()){e.preventDefault();return;}leaving=true;}
 const app=document.querySelector('.admin-app'),buttons=[...form.querySelectorAll('button:not([type=button]),input[type=submit]')].filter(b=>!b.disabled),state={buttons:buttons.map(b=>[b,b.innerHTML,b.getAttribute('aria-disabled')]),status:document.createElement('p')};
 if(form===settingsForm)leaving=true;form.setAttribute('aria-busy','true');form.setAttribute('data-pending','');buttons.forEach(b=>b.setAttribute('aria-disabled','true'));if(e.submitter?.tagName==='BUTTON')e.submitter.textContent=app?.dataset.submitting||'Submitting…';
 state.status.className='form-pending';state.status.setAttribute('role','status');state.status.textContent=app?.dataset.submitHint||'Waiting for the server.';form.append(state.status);pending.set(form,state);
});
addEventListener('pageshow',e=>{restoreForms();syncAIFields();if(e.persisted){leaving=false;if(side?.hasAttribute('data-open'))setOpen(false);closePickers()}});
document.querySelectorAll('[data-local-filter]').forEach(form=>{const search=form.querySelector('input[type=search]'),status=form.querySelector('select[name=processing]'),clear=form.querySelector('[data-search-clear]'),rows=[...document.querySelectorAll('[data-repo-row]')],empty=document.querySelector('[data-filter-empty]');
 const filter=sync=>{const q=(search?.value||'').trim().toLowerCase(),s=status?.value||'';let count=0;rows.forEach(row=>{const visible=(!q||row.dataset.repoName.toLowerCase().includes(q))&&(!s||row.dataset.processing===s);row.hidden=!visible;if(visible)count++});if(empty)empty.hidden=count>0;if(clear)clear.hidden=!search?.value;
  if(sync){const u=new URL(location.href);if(search?.value.trim())u.searchParams.set('q',search.value.trim());else u.searchParams.delete('q');if(s)u.searchParams.set('processing',s);else u.searchParams.delete('processing');history.replaceState(history.state,'',u.pathname+u.search+u.hash);document.querySelectorAll('[data-repo-pagination] a,[data-repo-settings],[data-repo-row] a[href^="/admin/repo?"],[data-repo-toggle]').forEach(element=>{const attribute=element.tagName==='FORM'?'action':'href',link=new URL(element.getAttribute(attribute),location.origin),prefix=element.closest('[data-repo-pagination]')?'':'return_';[['q',search?.value.trim()||''],['processing',s]].forEach(([key,value])=>{if(value)link.searchParams.set(prefix+key,value);else link.searchParams.delete(prefix+key)});element.setAttribute(attribute,link.pathname+link.search)})}
 };
 search?.addEventListener('input',()=>filter(true));status?.addEventListener('change',()=>filter(true));clear?.addEventListener('click',()=>{search.value='';filter(true);search.focus()});form.addEventListener('submit',e=>{e.preventDefault();filter(true)});
 addEventListener('pageshow',()=>filter(false));
});
})})()`;
