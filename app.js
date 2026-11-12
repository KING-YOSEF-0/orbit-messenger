const API = '/api';
let token = localStorage.getItem('orbitToken') || '';
let me = null;
let activePerson = null;
let activeServer = null;
let selectedAvatar = null;
let clearAvatar = false;
let activeView = 'messages';
let peopleTab = 'discover';
let searchTimer;
let pollTimer;
let mediaRecorder = null;
let recordingChunks = [];
let toastTimer;

const $ = selector => document.querySelector(selector);
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600); }
function paintAvatar(element,user,kind='person-avatar') {
  if (!element || !user) return;
  element.className = kind;
  if (user.hasAvatar && user.id) {
    const img=document.createElement('img'); img.alt=''; img.src=`/api/avatar/${user.id}?token=${encodeURIComponent(token)}`; element.replaceChildren(img);
  } else element.textContent=(user.displayName||user.username||'?').charAt(0).toUpperCase();
}
async function api(path, options = {}) {
  const headers = { ...(options.body ? {'Content-Type':'application/json'} : {}), ...(token ? {Authorization:`Bearer ${token}`} : {}), ...(options.headers || {}) };
  const response = await fetch(API + path, {...options, headers});
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
function authScreen(register = false) {
  $('#authScreen').classList.remove('hidden'); $('#appScreen').classList.add('hidden');
  $('#authTitle').textContent = register ? 'Create your account' : 'Welcome back';
  $('#authSubtitle').textContent = register ? 'Your username is how people will find you.' : 'Sign in to pick up where your conversations left off.';
  $('#displayNameField').classList.toggle('hidden', !register);
  $('#authDisplayName').required = register;
  $('#authPassword').autocomplete = register ? 'new-password' : 'current-password';
  $('#authSubmit').innerHTML = register ? 'Create account <span>→</span>' : 'Sign in <span>→</span>';
  $('#authSwitchText').textContent = register ? 'Already have an account?' : 'New to Orbit?';
  $('#authSwitch').textContent = register ? 'Sign in' : 'Create an account';
  $('#authError').textContent = '';
  $('#authForm').dataset.mode = register ? 'register' : 'login';
}
function showApp() {
  $('#authScreen').classList.add('hidden'); $('#appScreen').classList.remove('hidden');
  const initial = (me.displayName || me.username || '?').charAt(0).toUpperCase();
  paintAvatar($('#profileInitial'),me,'profile-avatar'); paintAvatar($('#railInitial'),me,'rail-user'); paintAvatar($('#bigInitial'),me,'profile-big-avatar');
  $('#sidebarDisplayName').textContent = me.displayName; $('#sidebarUsername').textContent = '@' + me.username;
  $('#profilePreviewName').textContent = me.displayName; $('#profilePreviewUser').textContent = '@' + me.username;
  $('#editDisplayName').value = me.displayName; $('#editUsername').value = me.username; $('#editBio').value = me.bio || '';
  selectedAvatar=null; clearAvatar=false;
  clearInterval(pollTimer); pollTimer = setInterval(() => { refreshConversations(); refreshServers(); refreshRequestsBadge(); if (activePerson && activeView === 'chat') loadMessages(false); if (activeServer && activeView === 'server') loadServerMessages(false); }, 4000);
  refreshConversations(); refreshServers(); refreshRequestsBadge(); setView('messages');
  const invite=new URLSearchParams(location.search).get('invite');
  if(invite){api('/servers/join',{method:'POST',body:JSON.stringify({inviteCode:invite})}).then(({server})=>{history.replaceState({},'',location.pathname);refreshServers();openServer(server);toast(`Joined ${server.name}.`);}).catch(e=>toast(e.message));}
}
async function boot() {
  if (!token) return authScreen(false);
  try { const result = await api('/me'); if (!result.user) throw new Error('Sign in to continue.'); me = result.user; showApp(); }
  catch { token = ''; localStorage.removeItem('orbitToken'); authScreen(false); }
}

$('#authSwitch').addEventListener('click', () => authScreen($('#authForm').dataset.mode !== 'register'));
$('#authForm').addEventListener('submit', async e => {
  e.preventDefault(); const mode = $('#authForm').dataset.mode;
  const data = {username:$('#authUsername').value.trim(),password:$('#authPassword').value};
  if (mode === 'register') data.displayName = $('#authDisplayName').value.trim();
  $('#authSubmit').disabled = true; $('#authError').textContent = '';
  try { const result = await api('/' + (mode === 'register' ? 'register' : 'login'), {method:'POST',body:JSON.stringify(data)}); token = result.token; me = result.user; localStorage.setItem('orbitToken', token); showApp(); }
  catch (error) { $('#authError').textContent = error.message; }
  finally { $('#authSubmit').disabled = false; }
});

function setView(view) {
  activeView = view;
  ['messagesView','chatView','serverChatView','peopleView','profileView'].forEach(id => $('#' + id).classList.add('hidden'));
  if (view === 'chat') $('#chatView').classList.remove('hidden');
  else if (view === 'server') $('#serverChatView').classList.remove('hidden');
  else if (view === 'people') { $('#peopleView').classList.remove('hidden'); peoplePage(peopleTab); }
  else if (view === 'profile') { $('#profileView').classList.remove('hidden'); $('#topTitle').textContent = 'Your profile'; }
  else { $('#messagesView').classList.remove('hidden'); $('#topTitle').textContent = 'Messages'; }
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === (view === 'chat' || view === 'server' ? 'messages' : view)));
  document.querySelector('[data-section="messages"]').classList.toggle('selected',view==='messages'||view==='chat');$('#railPeople').classList.toggle('selected',view==='people');
}
document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => { activePerson = null; setView(button.dataset.view); }));
document.querySelector('[data-section="messages"]').addEventListener('click',()=>{activePerson=null;activeServer=null;setView('messages');});
$('#railPeople').addEventListener('click', () => { activePerson = null; setView('people'); });
$('.rail-brand').addEventListener('click', () => $('#leftSidebar').classList.toggle('open'));
$('#profileButton').addEventListener('click', () => setView('profile'));
$('#newMessageBtn').addEventListener('click', () => { activePerson = null; setView('people'); peoplePage('discover'); });
$('#addPersonBtn').addEventListener('click', () => { activePerson = null; setView('people'); peoplePage('discover'); });
$('#startConversation').addEventListener('click', () => { activePerson = null; setView('people'); peoplePage('discover'); });
$('#searchOpen').addEventListener('click', () => { activePerson = null; setView('people'); peoplePage('discover'); setTimeout(() => $('#peopleSearch')?.focus(), 30); });
$('#helpBtn').addEventListener('click', () => toast('Orbit Messenger · Built by KING_YOSEF_'));
document.addEventListener('keydown', e => { if (e.key === '/' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); $('#searchOpen').click(); } });

async function refreshConversations() {
  if (!token) return;
  try {
    const {conversations} = await api('/conversations'); const list = $('#conversationList');
    if (!conversations.length) { list.innerHTML = '<div class="side-empty">Your conversations will appear here.</div>'; return; }
    list.replaceChildren(...conversations.map(person => {
      const button = document.createElement('button'); button.className = 'conversation-item' + (activePerson?.id === person.id ? ' selected' : '');
      const avatar = document.createElement('span'); paintAvatar(avatar,person,'conversation-avatar');
      const info = document.createElement('span'); info.className = 'conversation-info';
      const name = document.createElement('b'); name.textContent = person.displayName;
      const last = document.createElement('small'); last.textContent = person.lastMessage || '@' + person.username;
      info.append(name,last); button.append(avatar,info); button.addEventListener('click', () => openChat(person)); return button;
    }));
  } catch {}
}
async function refreshServers() {
  if (!token) return;
  try {
    const {servers}=await api('/servers');
    const makeEntry=(server,rail=false)=>{
      const button=document.createElement('button');button.className=(rail?'server-rail-button':'conversation-item server-list-item')+((activeServer?.id===server.id)?' selected':'');button.title=server.name;
      const mark=document.createElement('span');mark.className=rail?`server-rail-mark tone-${server.id%5}`:'conversation-avatar server-list-mark';mark.textContent=server.name.trim().charAt(0).toUpperCase();
      if(!rail){const info=document.createElement('span');info.className='conversation-info';const title=document.createElement('b');title.textContent=server.name;const count=document.createElement('small');count.textContent=`${server.memberCount} members · # general`;info.append(title,count);button.append(mark,info);}else button.append(mark);
      button.addEventListener('click',()=>openServer(server));return button;
    };
    const serverList=$('#serverList'),railList=$('#serverRailList');serverList.replaceChildren(...servers.map(s=>makeEntry(s)));railList.replaceChildren(...servers.map(s=>makeEntry(s,true)));
    if(!servers.length)serverList.innerHTML='<div class="side-empty">Create a server or join with an invite code.</div>';
  }catch{}
}
async function refreshRequestsBadge() {
  if (!token) return;
  try { const {requests} = await api('/requests'); const count = requests.length; ['requestBadge','tabRequestBadge'].forEach(id => { const badge=$('#'+id); badge.textContent=count; badge.classList.toggle('hidden',!count); }); } catch {}
}
function openChat(person) {
  activePerson = person; $('#topTitle').textContent = person.displayName;
  $('#chatDisplayName').textContent = person.displayName; $('#chatUsername').textContent = '@' + person.username; $('#chatFootName').textContent = person.displayName;
  paintAvatar($('#chatAvatar'),person);
  $('#messageInput').placeholder = `Message ${person.displayName}…`; setView('chat'); refreshConversations(); loadMessages(true);
}
async function loadMessages(scrollToEnd) {
  if (!activePerson) return;
  try {
    const {messages,allowed} = await api(`/messages/${activePerson.id}`);
    if (!allowed) { $('#chatMessages').innerHTML = '<div class="chat-empty"><p>You’re connected. Send a message to get the conversation started.</p></div>'; return; }
    const container=$('#chatMessages'); const oldLast=container.lastElementChild?.dataset.id;
    container.replaceChildren(...messages.map(message => {
      const row=document.createElement('div'); row.className='message-row'+(message.senderId===me.id?' mine':''); row.dataset.id=message.id;
      const avatar=document.createElement('span'); paintAvatar(avatar,message.sender);
      const content=document.createElement('div'); content.className='message-content';
      const meta=document.createElement('div'); meta.className='message-top'; const who=document.createElement('b'); who.textContent=message.sender.displayName; const time=document.createElement('time'); time.textContent=new Date(message.createdAt*1000).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}); meta.append(who,time); content.append(meta);
      if (message.text) { const bubble=document.createElement('div'); bubble.className='bubble'; bubble.textContent=message.text; content.append(bubble); }
      if (message.audioUrl) { const audio=document.createElement('audio'); audio.className='voice-player'; audio.controls=true; audio.preload='none'; audio.src=message.audioUrl; content.append(audio); }
      row.append(avatar,content); return row;
    }));
    if (scrollToEnd || oldLast !== container.lastElementChild?.dataset.id) container.scrollTop=container.scrollHeight;
  } catch(error) { if(error.message.includes('sign in')) signOut(); }
}

function peoplePage(tab='discover', query='') {
  peopleTab=tab; $('#topTitle').textContent='People';
  document.querySelectorAll('.people-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===tab));
  const content=$('#peopleContent'); content.replaceChildren();
  if (tab==='discover') {
    const input=document.createElement('input'); input.className='search-field'; input.id='peopleSearch'; input.placeholder='Search by username…'; input.value=query; input.autocomplete='off';
    input.addEventListener('input',()=>{ clearTimeout(searchTimer); searchTimer=setTimeout(()=>searchPeople(input.value),230); }); content.append(input);
    const results=document.createElement('div'); results.id='peopleResults'; results.className='people-content-list'; content.append(results);
    if(query) searchPeople(query);
  } else loadRequests();
}
async function searchPeople(query) {
  const results=$('#peopleResults'); if(!results) return;
  if(query.trim().length<2){results.innerHTML='<div class="side-empty">Type at least 2 characters to search.</div>';return;}
  results.innerHTML='<div class="side-empty">Searching…</div>';
  try {
    const {people}=await api('/people?q='+encodeURIComponent(query.trim())); if(!$('#peopleResults'))return;
    if(!people.length){results.innerHTML='<div class="side-empty">No one found. Check the username and try again.</div>';return;}
    results.replaceChildren(...people.map(person=>{
      const row=document.createElement('div');row.className='person-result';const avatar=document.createElement('span');paintAvatar(avatar,person);
      const copy=document.createElement('div');copy.className='person-result-copy';const name=document.createElement('b');name.textContent=person.displayName;const handle=document.createElement('small');handle.textContent='@'+person.username;copy.append(name,handle);if(person.bio){const bio=document.createElement('p');bio.textContent=person.bio;copy.append(bio);}
      const action=document.createElement('button');action.className='small-action';
      if(person.relationship==='accepted'){action.textContent='Message';action.addEventListener('click',()=>openChat(person));}
      else if(person.relationship==='pending'){action.textContent=person.incoming?'Incoming request':'Request sent';action.disabled=true;}
      else{action.textContent='Add person';action.addEventListener('click',async()=>{try{await api('/requests',{method:'POST',body:JSON.stringify({username:person.username})});action.textContent='Request sent';action.disabled=true;toast('Friend request sent.');}catch(e){toast(e.message);}});}
      row.append(avatar,copy,action);return row;
    }));
  } catch(e){ if(results.isConnected) results.innerHTML=`<div class="side-empty">${escapeHTML(e.message)}</div>`; }
}
async function loadRequests(){
  const content=$('#peopleContent');content.innerHTML='<div class="people-content-list"><div class="side-empty">Loading requests…</div></div>';
  try{const {requests}=await api('/requests');if(!$('#peopleView').isConnected)return;const list=document.createElement('div');list.className='people-content-list';
    if(!requests.length){list.innerHTML='<div class="side-empty">No pending requests right now.</div>';}
    requests.forEach(person=>{const row=document.createElement('div');row.className='person-result';const avatar=document.createElement('span');paintAvatar(avatar,person);const copy=document.createElement('div');copy.className='person-result-copy';copy.innerHTML=`<b>${escapeHTML(person.displayName)}</b><small>@${escapeHTML(person.username)}</small>`;const accept=document.createElement('button');accept.className='small-action';accept.textContent='Accept';accept.addEventListener('click',async()=>{try{await api(`/requests/${person.id}`,{method:'PATCH',body:JSON.stringify({action:'accept'})});toast('You’re connected.');loadRequests();refreshConversations();refreshRequestsBadge();}catch(e){toast(e.message);}});const decline=document.createElement('button');decline.className='small-action';decline.textContent='Decline';decline.addEventListener('click',async()=>{try{await api(`/requests/${person.id}`,{method:'PATCH',body:JSON.stringify({action:'decline'})});loadRequests();refreshRequestsBadge();}catch(e){toast(e.message);}});row.append(avatar,copy,accept,decline);list.append(row);});content.replaceChildren(list);
  }catch(e){content.innerHTML=`<div class="side-empty">${escapeHTML(e.message)}</div>`;}
}
document.querySelectorAll('.people-tab').forEach(t=>t.addEventListener('click',()=>peoplePage(t.dataset.tab)));

function openServer(server){
  activePerson=null;activeServer=server;$('#topTitle').textContent=server.name;$('#serverHeadingName').textContent=server.name;$('#serverMemberCount').textContent=server.memberCount||1;$('#serverHeadingMark').textContent=server.name.trim().charAt(0).toUpperCase();$('#serverHeadingMark').className=`server-heading-mark tone-${server.id%5}`;setView('server');refreshServers();loadServerMessages(true);
}
async function loadServerMessages(scrollToEnd){
  if(!activeServer)return;
  try{const {messages}=await api(`/servers/${activeServer.id}/messages`);const box=$('#serverMessages');const oldLast=box.lastElementChild?.dataset.id;
    if(!messages.length){box.innerHTML='<div class="chat-empty"><p>Welcome to the server. Start the conversation in # general.</p></div>';return;}
    box.replaceChildren(...messages.map(message=>{const row=document.createElement('div');row.className='message-row'+(message.user.id===me.id?' mine':'');row.dataset.id=message.id;const avatar=document.createElement('span');paintAvatar(avatar,message.user);const content=document.createElement('div');content.className='message-content';const meta=document.createElement('div');meta.className='message-top';const who=document.createElement('b');who.textContent=message.user.displayName;const time=document.createElement('time');time.textContent=new Date(message.createdAt*1000).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});meta.append(who,time);const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=message.text;content.append(meta,bubble);row.append(avatar,content);return row;}));
    if(scrollToEnd||oldLast!==box.lastElementChild?.dataset.id)box.scrollTop=box.scrollHeight;
  }catch(error){toast(error.message);}
}
function serverModal(mode='choose',server=null){
  const root=$('#modalRoot');let content='';
  if(mode==='choose')content='<header class="modal-head"><b>Your server</b><button class="modal-close" aria-label="Close">×</button></header><p>Create a new community or join one with an invite code.</p><div class="server-modal-actions"><button class="server-choice" data-mode="create"><span>✳</span><b>Create a server</b><small>Start a space for your community</small><i>→</i></button><button class="server-choice" data-mode="join"><span>↗</span><b>Join a server</b><small>Enter an invite code from a friend</small><i>→</i></button></div>';
  if(mode==='create')content='<header class="modal-head"><b>Create a server</b><button class="modal-close" aria-label="Close">×</button></header><p>Give your community a name. You can invite people right after.</p><form id="serverModalForm"><label class="modal-label">SERVER NAME<input name="name" maxlength="40" minlength="2" placeholder="My community" required></label><div class="modal-actions"><button type="button" class="back-choice">Back</button><button class="primary">Create server</button></div></form>';
  if(mode==='join')content='<header class="modal-head"><b>Join a server</b><button class="modal-close" aria-label="Close">×</button></header><p>Paste the invite code a friend shared with you.</p><form id="serverModalForm"><label class="modal-label">INVITE CODE<input name="inviteCode" maxlength="20" placeholder="e.g. A1B2C3D4" required></label><div class="modal-actions"><button type="button" class="back-choice">Back</button><button class="primary">Join server</button></div></form>';
  if(mode==='invite'){
    const url=`${location.origin}${location.pathname}?invite=${encodeURIComponent(server.inviteCode)}`;
    content=`<header class="modal-head"><b>Invite people</b><button class="modal-close" aria-label="Close">×</button></header><p>Share this code or link so people can join <b>${escapeHTML(server.name)}</b>.</p><div class="invite-code-box"><small>INVITE CODE</small><strong>${escapeHTML(server.inviteCode)}</strong></div><label class="modal-label invite-url-label">INVITE LINK<input readonly value="${escapeHTML(url)}"></label><div class="modal-actions"><button type="button" class="primary" id="copyServerInvite">Copy invite link</button></div>`;
  }
  root.innerHTML=`<div class="modal-backdrop"><section class="modal server-modal">${content}</section></div>`;
  root.querySelector('.modal-close')?.addEventListener('click',()=>root.replaceChildren());
  root.querySelector('.modal-backdrop').addEventListener('click',e=>{if(e.target.classList.contains('modal-backdrop'))root.replaceChildren();});
  root.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>serverModal(button.dataset.mode)));
  root.querySelector('.back-choice')?.addEventListener('click',()=>serverModal('choose'));
  root.querySelector('#serverModalForm')?.addEventListener('submit',async e=>{e.preventDefault();const form=new FormData(e.currentTarget);const joining=mode==='join';try{const result=await api(joining?'/servers/join':'/servers',{method:'POST',body:JSON.stringify(joining?{inviteCode:form.get('inviteCode')}:{name:form.get('name')})});root.replaceChildren();await refreshServers();openServer(result.server);toast(joining?`Joined ${result.server.name}.`:`${result.server.name} is ready. Invite your people!`);if(!joining)serverModal('invite',result.server);}catch(error){toast(error.message);}});
  root.querySelector('#copyServerInvite')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(`${location.origin}${location.pathname}?invite=${server.inviteCode}`);toast('Invite link copied.');root.replaceChildren();}catch{toast(`Invite code: ${server.inviteCode}`);}});
}
$('#createServerBtn').addEventListener('click',()=>serverModal('create'));
$('#joinServerBtn').addEventListener('click',()=>serverModal('join'));
$('#addServerRail').addEventListener('click',()=>serverModal('choose'));
$('#serverInviteButton').addEventListener('click',()=>activeServer&&serverModal('invite',activeServer));
$('#serverMessageForm').addEventListener('submit',async e=>{e.preventDefault();if(!activeServer)return;const input=$('#serverMessageInput');const text=input.value.trim();if(!text)return;try{await api(`/servers/${activeServer.id}/messages`,{method:'POST',body:JSON.stringify({text})});input.value='';await loadServerMessages(true);}catch(error){toast(error.message);}});
$('#serverMessageInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#serverMessageForm').requestSubmit();}});

$('#messageForm').addEventListener('submit',async e=>{e.preventDefault();if(!activePerson)return;const input=$('#messageInput');const text=input.value.trim();if(!text)return;const button=$('.send-button');button.disabled=true;try{await api('/messages',{method:'POST',body:JSON.stringify({recipientId:activePerson.id,text})});input.value='';await loadMessages(true);refreshConversations();}catch(error){toast(error.message);}finally{button.disabled=false;input.focus();}});
$('#messageInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#messageForm').requestSubmit();}});
async function sendAudio(file){if(!file||!activePerson)return;if(!file.type.startsWith('audio/'))return toast('Choose an audio file.');if(file.size>7*1024*1024)return toast('Audio must be smaller than 7 MB.');try{const data=await file.arrayBuffer();let binary='';new Uint8Array(data).forEach(b=>binary+=String.fromCharCode(b));const audioData=btoa(binary);await api('/messages',{method:'POST',body:JSON.stringify({recipientId:activePerson.id,audioData,audioMime:file.type||'audio/webm'})});await loadMessages(true);refreshConversations();toast('Voice note sent.');}catch(error){toast(error.message);}}
$('#audioFile').addEventListener('change',e=>{sendAudio(e.target.files[0]);e.target.value='';});
$('#voiceButton').addEventListener('click',async()=>{
  if(mediaRecorder?.state==='recording'){mediaRecorder.stop();$('#voiceButton').textContent='◉';$('#voiceButton').classList.remove('recording');return;}
  if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){$('#audioFile').click();toast('Microphone recording needs a secure connection. Choose an audio file instead.');return;}
  try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});mediaRecorder=new MediaRecorder(stream);recordingChunks=[];mediaRecorder.ondataavailable=event=>{if(event.data.size)recordingChunks.push(event.data);};mediaRecorder.onstop=()=>{stream.getTracks().forEach(track=>track.stop());const blob=new Blob(recordingChunks,{type:mediaRecorder.mimeType||'audio/webm'});sendAudio(new File([blob],`voice-note-${Date.now()}.webm`,{type:blob.type}));};mediaRecorder.start();$('#voiceButton').textContent='■';$('#voiceButton').classList.add('recording');toast('Recording… tap ■ to send your voice note.');}catch{toast('Microphone access was not available. Choose an audio file instead.');$('#audioFile').click();}
});

$('#chooseAvatar').addEventListener('click',()=>$('#avatarFile').click());
$('#avatarFile').addEventListener('change',async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  if(!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type))return toast('Choose a JPG, PNG, WEBP, or GIF image.');
  if(file.size>10*1024*1024)return toast('Choose an image smaller than 10 MB.');
  try{const bitmap=await createImageBitmap(file);const scale=Math.min(1,512/Math.max(bitmap.width,bitmap.height));const canvas=document.createElement('canvas');canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);canvas.getContext('2d').drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();const dataUrl=canvas.toDataURL('image/jpeg',.84);selectedAvatar=dataUrl.split(',')[1];clearAvatar=false;const preview=new Image();preview.src=dataUrl;preview.alt='';$('#bigInitial').replaceChildren(preview);toast('Photo ready — save your profile to apply it.');}
  catch{toast('That image could not be opened. Try another photo.');}
});
$('#removeAvatar').addEventListener('click',()=>{selectedAvatar=null;clearAvatar=true;paintAvatar($('#bigInitial'),{...me,hasAvatar:false},'profile-big-avatar');toast('Photo will be removed when you save.');});
$('#profileForm').addEventListener('submit',async e=>{e.preventDefault();try{const payload={displayName:$('#editDisplayName').value,username:$('#editUsername').value,bio:$('#editBio').value};if(selectedAvatar){payload.avatarData=selectedAvatar;payload.avatarMime='image/jpeg';}if(clearAvatar)payload.removeAvatar=true;const result=await api('/profile',{method:'PATCH',body:JSON.stringify(payload)});me=result.user;showApp();setView('profile');toast('Profile updated.');}catch(error){toast(error.message);}});
$('#chatProfileBtn').addEventListener('click',()=>{
  if(!activePerson)return;
  const root=$('#modalRoot');
  root.innerHTML=`<div class="modal-backdrop"><section class="modal"><header class="modal-head"><b>Profile</b><button class="modal-close" aria-label="Close">×</button></header><div class="profile-cover"><span class="profile-big-avatar">${escapeHTML((activePerson.displayName||activePerson.username).charAt(0).toUpperCase())}</span><div><b>${escapeHTML(activePerson.displayName)}</b><small>@${escapeHTML(activePerson.username)}</small></div></div><p>${escapeHTML(activePerson.bio||'No bio yet.')}</p><div class="modal-actions"><button class="primary">Close</button></div></section></div>`;
  paintAvatar(root.querySelector('.profile-big-avatar'),activePerson,'profile-big-avatar');
  root.querySelector('.modal-close').addEventListener('click',()=>root.replaceChildren());root.querySelector('.modal-actions button').addEventListener('click',()=>root.replaceChildren());root.querySelector('.modal-backdrop').addEventListener('click',e=>{if(e.target.classList.contains('modal-backdrop'))root.replaceChildren();});
});
async function signOut(){try{await api('/logout',{method:'POST',body:'{}'});}catch{}token='';me=null;activePerson=null;activeServer=null;localStorage.removeItem('orbitToken');clearInterval(pollTimer);authScreen(false);}
$('#logoutButton').addEventListener('click',signOut);
boot();
