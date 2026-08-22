// ============================================
// ÁGORA - app.js
// ============================================
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let state = {
  user: null,
  profile: null,
  servers: [],
  currentServerId: null,
  channels: [],
  currentChannelId: null,
  currentChannelType: null,
  messagesChannelSub: null,
  serverMembersCache: {}, // userId -> profile, for message rendering
  currentRoles: [],
  myPermissions: {}, // permissões do usuário no servidor atual (dono = tudo true)

  mode: "server", // "server" | "dm"
  friends: [],
  incomingRequests: [],
  outgoingRequests: [],
  currentDmUserId: null,
  unreadDm: new Set(), // userIds com mensagem nova ainda não vista
  voiceContext: null, // { type: "channel"|"dm", id } — sala de voz ativa no momento
};

// ============================================
// PERMISSÕES
// ============================================
const PERMISSION_LABELS = {
  manage_roles: "Gerenciar cargos (criar, editar, excluir)",
  assign_roles: "Atribuir cargos a membros",
  manage_channels: "Gerenciar canais (criar, excluir)",
  manage_server: "Editar servidor (renomear)",
  add_members: "Adicionar membros pelo nome de usuário",
};

function isServerOwner(serverId){
  const server = state.servers.find(s => s.id === serverId);
  return !!(server && state.user && server.owner_id === state.user.id);
}

async function computeMyPermissions(serverId){
  if(!serverId || !state.user) return {};
  if(isServerOwner(serverId)){
    const all = {};
    Object.keys(PERMISSION_LABELS).forEach(k => all[k] = true);
    return all;
  }
  const { data: memberRow } = await sb.from("server_members")
    .select("role_id, roles(permissions)")
    .eq("server_id", serverId).eq("user_id", state.user.id)
    .maybeSingle();
  return (memberRow && memberRow.roles && memberRow.roles.permissions) || {};
}

function hasPermission(perm){
  return !!state.myPermissions[perm];
}

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
function showAuthError(msg){ $("auth-error").textContent = msg || ""; }
function randomInviteCode(){ return Math.random().toString(36).slice(2, 8); }

// ============================================
// AUTH
// ============================================
let isSignupMode = false;

$("auth-toggle-btn").addEventListener("click", () => {
  isSignupMode = !isSignupMode;
  $("auth-subtitle").textContent = isSignupMode ? "Crie sua conta" : "Entre na sua conta";
  $("auth-submit-btn").textContent = isSignupMode ? "Criar conta" : "Entrar";
  $("auth-toggle-btn").textContent = isSignupMode ? "Já tem conta? Entrar" : "Não tem conta? Criar conta";
  showAuthError("");
});

$("auth-submit-btn").addEventListener("click", async () => {
  const email = $("auth-email").value.trim();
  const password = $("auth-password").value;
  if(!email || !password){ showAuthError("Preencha e-mail e senha."); return; }
  showAuthError("Carregando...");

  if(isSignupMode){
    const { data, error } = await sb.auth.signUp({ email, password });
    if(error){ showAuthError(error.message); return; }
    if(data.session){
      await onLoggedIn(data.session.user);
    } else {
      showAuthError("Conta criada! Verifique seu e-mail, ou já tente entrar.");
    }
  } else {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if(error){ showAuthError(error.message); return; }
    await onLoggedIn(data.user);
  }
});

async function checkExistingSession(){
  const { data } = await sb.auth.getSession();
  if(data.session){ await onLoggedIn(data.session.user); }
}

async function onLoggedIn(user){
  state.user = user;
  showAuthError("");

  // Load or create profile
  let { data: profile, error } = await sb.from("profiles").select("*").eq("id", user.id).single();
  if(!profile){
    const base = user.email.split("@")[0];
    let attempt = base;
    let created = null;
    for(let i = 0; i < 5 && !created; i++){
      const { data, error: insertError } = await sb.from("profiles").insert({
        id: user.id,
        username: attempt
      }).select().single();
      if(data){ created = data; break; }
      if(insertError && insertError.code === "23505"){
        // Nome de usuário já existe — tenta outro com um sufixo aleatório
        attempt = base + Math.floor(1000 + Math.random() * 9000);
      } else {
        break;
      }
    }
    profile = created;
  }
  state.profile = profile;

  $("auth-screen").style.display = "none";
  $("main-screen").classList.add("active");
  renderUserBar();
  await loadServers();
  subscribeToDmInbox();
  subscribeToUserEvents();
  await loadFriendsAndRequests();
}

$("btn-logout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

// ============================================
// PROFILE
// ============================================
function initials(username){
  return ((username || "?").trim()[0] || "?").toUpperCase();
}

function displayName(profile){
  return (profile && profile.nickname && profile.nickname.trim()) ? profile.nickname : ((profile && profile.username) || "Usuário");
}

function avatarHtml(profile){
  if(profile && profile.avatar_url){
    return `<img src="${profile.avatar_url}" alt="avatar">`;
  }
  return initials(profile && profile.username);
}

function bannerStyle(profile){
  if(profile && profile.banner_url){
    return `background-image:url('${profile.banner_url}')`;
  }
  return "";
}

function serverCoverStyle(server){
  if(server && server.banner_url){
    return `background-image:url('${server.banner_url}')`;
  }
  return "";
}

function serverIconHtml(server){
  if(server && server.banner_url){
    return `<img src="${server.banner_url}" alt="${escapeHtml(server.name)}">`;
  }
  return server.name.slice(0, 2).toUpperCase();
}

function renderUserBar(){
  $("my-avatar").innerHTML = avatarHtml(state.profile);
  $("my-username").textContent = displayName(state.profile);
}

let pendingAvatarFile = null;
let pendingAvatarRemoved = false;
let pendingBannerFile = null;
let pendingBannerRemoved = false;
let pendingServerCoverFile = null;
let pendingServerCoverRemoved = false;

function syncProfilePreview(){
  $("profile-preview-avatar").innerHTML = $("profile-photo-preview").innerHTML;
  $("profile-preview-name").textContent = $("profile-username-input").value.trim() || "Usuário";
}

$("btn-open-profile").addEventListener("click", () => {
  pendingAvatarFile = null;
  pendingAvatarRemoved = false;
  pendingBannerFile = null;
  pendingBannerRemoved = false;
  $("profile-username-input").value = state.profile.username;
  $("profile-nickname-input").value = state.profile.nickname || "";
  $("profile-bio-input").value = state.profile.bio || "";
  $("profile-photo-preview").innerHTML = avatarHtml(state.profile);
  $("avatar-file-input").value = "";
  $("profile-banner-preview").setAttribute("style", "" + bannerStyle(state.profile));
  $("banner-file-input").value = "";
  $("profile-error").textContent = "";
  document.querySelectorAll("#modal-profile .tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll("#modal-profile .tab-content").forEach(c => c.classList.remove("active"));
  document.querySelector('#modal-profile .tab-btn[data-tab="profile-main"]').classList.add("active");
  $("tab-profile-main").classList.add("active");
  syncProfilePreview();
  $("modal-profile").classList.add("active");
});

document.querySelectorAll("#modal-profile .tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#modal-profile .tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll("#modal-profile .tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
  });
});

$("profile-username-input").addEventListener("input", syncProfilePreview);

$("btn-choose-photo").addEventListener("click", () => $("avatar-file-input").click());

$("avatar-file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if(!file) return;
  pendingAvatarFile = file;
  pendingAvatarRemoved = false;
  const reader = new FileReader();
  reader.onload = (ev) => { $("profile-photo-preview").innerHTML = `<img src="${ev.target.result}" alt="preview">`; syncProfilePreview(); };
  reader.readAsDataURL(file);
});

$("btn-remove-photo").addEventListener("click", () => {
  pendingAvatarFile = null;
  pendingAvatarRemoved = true;
  $("profile-photo-preview").innerHTML = initials($("profile-username-input").value || state.profile.username);
  syncProfilePreview();
});

$("btn-choose-banner").addEventListener("click", () => $("banner-file-input").click());

$("banner-file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if(!file) return;
  pendingBannerFile = file;
  pendingBannerRemoved = false;
  const reader = new FileReader();
  reader.onload = (ev) => { $("profile-banner-preview").style.backgroundImage = `url('${ev.target.result}')`; };
  reader.readAsDataURL(file);
});

$("btn-remove-banner").addEventListener("click", () => {
  pendingBannerFile = null;
  pendingBannerRemoved = true;
  $("profile-banner-preview").style.backgroundImage = "";
});

async function uploadAvatarFile(file){
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${state.user.id}/avatar-${Date.now()}.${ext}`;
  const { error: uploadError } = await sb.storage.from("avatars").upload(path, file, { upsert: true });
  if(uploadError) throw uploadError;
  const { data } = sb.storage.from("avatars").getPublicUrl(path);
  return data.publicUrl;
}

async function uploadBannerFile(file){
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${state.user.id}/banner-${Date.now()}.${ext}`;
  const { error: uploadError } = await sb.storage.from("avatars").upload(path, file, { upsert: true });
  if(uploadError) throw uploadError;
  const { data } = sb.storage.from("avatars").getPublicUrl(path);
  return data.publicUrl;
}

async function uploadServerCoverFile(file){
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${state.user.id}/server-cover-${Date.now()}.${ext}`;
  const { error: uploadError } = await sb.storage.from("avatars").upload(path, file, { upsert: true });
  if(uploadError) throw uploadError;
  const { data } = sb.storage.from("avatars").getPublicUrl(path);
  return data.publicUrl;
}

$("btn-save-profile").addEventListener("click", async () => {
  const username = $("profile-username-input").value.trim();
  if(!username){ $("profile-error").textContent = "Digite um nome de usuário."; return; }

  const updates = {
    username,
    nickname: $("profile-nickname-input").value.trim() || null,
    bio: $("profile-bio-input").value.trim()
  };

  try{
    if(pendingAvatarFile){
      $("profile-error").textContent = "Enviando foto...";
      updates.avatar_url = await uploadAvatarFile(pendingAvatarFile);
    } else if(pendingAvatarRemoved){
      updates.avatar_url = null;
    }
    if(pendingBannerFile){
      $("profile-error").textContent = "Enviando banner...";
      updates.banner_url = await uploadBannerFile(pendingBannerFile);
    } else if(pendingBannerRemoved){
      updates.banner_url = null;
    }
  } catch(err){
    $("profile-error").textContent = "Erro ao enviar a imagem: " + err.message;
    return;
  }

  const { data, error } = await sb.from("profiles").update(updates).eq("id", state.user.id).select().single();
  if(error){
    if(error.code === "23505"){ $("profile-error").textContent = "Esse nome de usuário já está em uso. Escolha outro."; }
    else { $("profile-error").textContent = error.message; }
    return;
  }
  state.profile = data;
  renderUserBar();
  $("modal-profile").classList.remove("active");
});

// ============================================
// PROFILE HUB (clicar em qualquer avatar abre isso)
// ============================================
async function openProfileHub(userId){
  const { data: profile, error } = await sb.from("profiles").select("*").eq("id", userId).single();
  if(error || !profile) return;

  $("view-profile-banner").setAttribute("style", "" + bannerStyle(profile));
  $("view-profile-avatar").innerHTML = avatarHtml(profile);
  $("view-profile-name").textContent = displayName(profile);
  const usernameEl = $("view-profile-username");
  if(profile.nickname && profile.nickname.trim()){
    usernameEl.textContent = "@" + profile.username;
    usernameEl.style.display = "block";
  } else {
    usernameEl.textContent = "";
    usernameEl.style.display = "none";
  }
  const since = profile.created_at
    ? new Date(profile.created_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" })
    : "";
  $("view-profile-since").textContent = since ? "Membro desde " + since : "";

  const bioEl = $("view-profile-bio");
  if(profile.bio){ bioEl.textContent = profile.bio; bioEl.style.display = "block"; }
  else { bioEl.textContent = ""; bioEl.style.display = "none"; }

  await loadProfileHubRole(userId);
  $("modal-view-profile").classList.add("active");
}

async function loadProfileHubRole(userId){
  const badgeEl = $("view-profile-role-badge");
  const assignWrap = $("view-profile-role-assign");
  badgeEl.style.display = "none";
  assignWrap.style.display = "none";
  if(!state.currentServerId) return;

  const { data: memberRow } = await sb.from("server_members")
    .select("role_id, roles(id, name, color)")
    .eq("server_id", state.currentServerId).eq("user_id", userId)
    .maybeSingle();

  const currentRole = memberRow && memberRow.roles;
  if(currentRole){
    badgeEl.textContent = currentRole.name;
    badgeEl.style.background = currentRole.color;
    badgeEl.style.display = "inline-block";
  }

  if(hasPermission("assign_roles")){
    const { data: roles } = await sb.from("roles").select("*").eq("server_id", state.currentServerId).order("position", { ascending: true, nullsFirst: false });
    const select = $("view-profile-role-select");
    select.innerHTML = '<option value="">Sem cargo</option>' +
      (roles || []).map(r => `<option value="${r.id}"${memberRow && memberRow.role_id === r.id ? " selected" : ""}>${escapeHtml(r.name)}</option>`).join("");
    assignWrap.style.display = "flex";
    assignWrap.dataset.userId = userId;
  }
}

$("btn-apply-role").addEventListener("click", async () => {
  const userId = $("view-profile-role-assign").dataset.userId;
  if(!userId || !state.currentServerId) return;
  const roleId = $("view-profile-role-select").value || null;
  const { error } = await sb.from("server_members").update({ role_id: roleId }).eq("server_id", state.currentServerId).eq("user_id", userId);
  if(error){ alert("Erro ao atribuir cargo: " + error.message); return; }
  await loadProfileHubRole(userId);
  if($("member-list-panel").classList.contains("active")) loadServerMembers(state.currentServerId);
});

// ============================================
// SERVERS
// ============================================
async function loadServers(){
  const { data: memberships } = await sb.from("server_members").select("server_id").eq("user_id", state.user.id);
  const serverIds = (memberships || []).map(m => m.server_id);
  let servers = [];
  if(serverIds.length){
    const { data } = await sb.from("servers").select("*").in("id", serverIds);
    servers = data || [];
  }
  state.servers = servers;

  // Se eu tava vendo um servidor que não existe mais pra mim (fui removido/ele foi excluído), sai dele
  if(state.currentServerId && !servers.find(s => s.id === state.currentServerId)){
    state.currentServerId = null;
    state.currentChannelId = null;
    if(state.messagesChannelSub){ sb.removeChannel(state.messagesChannelSub); state.messagesChannelSub = null; }
    if(serverEventsSub){ sb.removeChannel(serverEventsSub); serverEventsSub = null; }
    $("content-header").style.display = "none";
    $("text-view").style.display = "none";
    $("voice-view").style.display = "none";
  }

  renderServerRail();

  if(servers.length && !state.currentServerId){
    selectServer(servers[0].id);
  } else if(!servers.length){
    $("server-name-label").textContent = "Selecione um servidor";
    $("channel-list").innerHTML = "";
    $("empty-state-text").textContent = "Crie ou entre em um servidor para começar";
    $("empty-state").style.display = "flex";
  }
}

// ============================================
// TEMPO REAL — mantém tudo atualizado sem precisar de F5
// ============================================

// Coisas que dizem respeito a mim em qualquer servidor: pedidos de amizade
// e ser adicionado/removido/ter meu cargo trocado em algum servidor.
function subscribeToUserEvents(){
  if(userEventsSub) return; // já ativa, uma inscrição basta pra toda a sessão
  const myId = state.user.id;
  userEventsSub = sb.channel("user-events-" + myId)
    .on("postgres_changes", { event: "*", schema: "public", table: "friend_requests", filter: `to_user=eq.${myId}` },
      () => loadFriendsAndRequests())
    .on("postgres_changes", { event: "*", schema: "public", table: "friend_requests", filter: `from_user=eq.${myId}` },
      () => loadFriendsAndRequests())
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "server_members", filter: `user_id=eq.${myId}` },
      () => loadServers())
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "server_members", filter: `user_id=eq.${myId}` },
      () => loadServers())
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "server_members", filter: `user_id=eq.${myId}` },
      async (payload) => {
        // Meu cargo mudou no servidor que eu tô vendo agora
        if(state.currentServerId && payload.new && payload.new.server_id === state.currentServerId){
          state.myPermissions = await computeMyPermissions(state.currentServerId);
          $("btn-edit-server").style.display = Object.values(state.myPermissions).some(Boolean) ? "" : "none";
        }
      })
    // Alguém está me ligando (linha nova em `calls` com callee_id = eu)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "calls", filter: `callee_id=eq.${myId}` },
      (payload) => { if(payload.new.status === "ringing") showIncomingCall(payload.new); })
    // Uma chamada que está tocando pra mim mudou (a pessoa cancelou antes de eu atender)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "calls", filter: `callee_id=eq.${myId}` },
      (payload) => handleIncomingCallUpdated(payload.new))
    // Uma chamada que EU comecei mudou (a pessoa atendeu ou recusou)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "calls", filter: `caller_id=eq.${myId}` },
      (payload) => handleMyCallUpdated(payload.new))
    .subscribe();
}

// Coisas que acontecem dentro de um servidor específico: canais, cargos, membros e o próprio servidor.
// É trocada toda vez que você entra em outro servidor.
function subscribeToServerEvents(serverId){
  if(serverEventsSub){ sb.removeChannel(serverEventsSub); serverEventsSub = null; }

  serverEventsSub = sb.channel("server-events-" + serverId)
    .on("postgres_changes", { event: "*", schema: "public", table: "channels", filter: `server_id=eq.${serverId}` },
      () => { if(state.currentServerId === serverId) reloadChannelsPreservingSelection(serverId); })
    .on("postgres_changes", { event: "*", schema: "public", table: "roles", filter: `server_id=eq.${serverId}` },
      async () => {
        if(state.currentServerId !== serverId) return;
        state.myPermissions = await computeMyPermissions(serverId);
        $("btn-edit-server").style.display = Object.values(state.myPermissions).some(Boolean) ? "" : "none";
        if($("modal-edit-server").classList.contains("active")) await loadRolesForEdit();
        if($("member-list-panel").classList.contains("active")) loadServerMembers(serverId);
      })
    .on("postgres_changes", { event: "*", schema: "public", table: "server_members", filter: `server_id=eq.${serverId}` },
      () => {
        if(state.currentServerId !== serverId) return;
        if($("member-list-panel").classList.contains("active")) loadServerMembers(serverId);
      })
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "servers", filter: `id=eq.${serverId}` },
      (payload) => {
        const idx = state.servers.findIndex(s => s.id === serverId);
        if(idx !== -1) state.servers[idx] = payload.new;
        renderServerRail();
        if(state.currentServerId !== serverId) return;
        $("server-name-label").textContent = payload.new.name;
        const coverEl = $("server-cover");
        coverEl.setAttribute("style", "" + serverCoverStyle(payload.new));
        coverEl.classList.toggle("has-cover", !!payload.new.banner_url);
        const codeEl = $("server-header").querySelector(".invite-code");
        if(codeEl) codeEl.textContent = "código: " + payload.new.invite_code;
      })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "servers", filter: `id=eq.${serverId}` },
      () => { if(state.currentServerId === serverId) loadServers(); })
    .subscribe();
}

// Recarrega a lista de canais sem "chutar" o usuário de volta pro primeiro canal
// se o canal que ele já estava vendo continuar existindo.
async function reloadChannelsPreservingSelection(serverId){
  const { data } = await sb.from("channels").select("*").eq("server_id", serverId).order("created_at");
  state.channels = data || [];
  renderChannelList();
  if($("modal-edit-server").classList.contains("active")) renderEditChannelList();

  const stillExists = state.channels.find(c => c.id === state.currentChannelId);
  if(!stillExists){
    const textChannels = state.channels.filter(c => c.type === "text");
    if(textChannels.length){
      selectChannel(textChannels[0]);
    } else {
      state.currentChannelId = null;
      $("content-header").style.display = "none";
      $("text-view").style.display = "none";
      $("voice-view").style.display = "none";
      $("empty-state-text").textContent = "Crie um canal para começar";
      $("empty-state").style.display = "flex";
    }
  }
}

function renderServerRail(){
  const wrap = $("server-icons");
  wrap.innerHTML = "";
  state.servers.forEach(server => {
    const el = document.createElement("div");
    el.className = "server-icon" + (server.id === state.currentServerId ? " active" : "");
    el.innerHTML = serverIconHtml(server);
    el.title = server.name;
    el.addEventListener("click", () => selectServer(server.id));
    wrap.appendChild(el);
  });
}

$("btn-add-server").addEventListener("click", () => {
  $("server-modal-error").textContent = "";
  $("new-server-name").value = "";
  $("join-server-code").value = "";
  $("modal-server").classList.add("active");
});

$("btn-create-server").addEventListener("click", async () => {
  const name = $("new-server-name").value.trim();
  if(!name){ $("server-modal-error").textContent = "Digite um nome."; return; }

  const inviteCode = randomInviteCode();
  const { data: server, error } = await sb.from("servers").insert({
    name, invite_code: inviteCode, owner_id: state.user.id
  }).select().single();
  if(error){ $("server-modal-error").textContent = error.message; return; }

  await sb.from("server_members").insert({ server_id: server.id, user_id: state.user.id });

  // Default channels
  await sb.from("channels").insert([
    { server_id: server.id, name: "geral", type: "text" },
    { server_id: server.id, name: "Sala de Voz", type: "voice" }
  ]);

  $("modal-server").classList.remove("active");
  await loadServers();
  selectServer(server.id);
});

$("btn-join-server").addEventListener("click", async () => {
  const code = $("join-server-code").value.trim().toLowerCase();
  if(!code){ $("server-modal-error").textContent = "Digite um código."; return; }

  const { data: server, error } = await sb.from("servers").select("*").eq("invite_code", code).single();
  if(error || !server){ $("server-modal-error").textContent = "Código inválido."; return; }

  await sb.from("server_members").upsert({ server_id: server.id, user_id: state.user.id });

  $("modal-server").classList.remove("active");
  await loadServers();
  selectServer(server.id);
});

async function selectServer(serverId){
  if(voiceState.channel) leaveVoiceChannel();
  state.mode = "server";
  state.currentServerId = serverId;
  state.currentChannelId = null;
  $("btn-dm-home").classList.remove("active");
  $("dm-sidebar-content").style.display = "none";
  $("server-sidebar-content").style.display = "flex";
  $("dm-view").style.display = "none";
  $("btn-toggle-members").style.display = "";
  renderServerRail();

  const server = state.servers.find(s => s.id === serverId);
  $("server-name-label").textContent = server ? server.name : "";
  const coverEl = $("server-cover");
  coverEl.setAttribute("style", "" + serverCoverStyle(server));
  coverEl.classList.toggle("has-cover", !!(server && server.banner_url));
  const header = $("server-header");
  let codeEl = header.querySelector(".invite-code");
  if(!codeEl){
    codeEl = document.createElement("span");
    codeEl.className = "invite-code";
    header.appendChild(codeEl);
  }
  codeEl.textContent = server ? "código: " + server.invite_code : "";
  codeEl.title = "Clique para copiar o código de convite";
  codeEl.onclick = () => { navigator.clipboard.writeText(server.invite_code); codeEl.textContent = "copiado!"; setTimeout(()=>{ codeEl.textContent = "código: " + server.invite_code; }, 1200); };

  state.myPermissions = await computeMyPermissions(serverId);
  const anyPermission = Object.values(state.myPermissions).some(Boolean);
  $("btn-edit-server").style.display = anyPermission ? "" : "none";

  await loadChannels(serverId);
  if($("member-list-panel").classList.contains("active")) loadServerMembers(serverId);
  subscribeToServerEvents(serverId);
}

// ============================================
// MEMBER LIST (painel da direita)
// ============================================
$("btn-toggle-members").addEventListener("click", () => {
  const panel = $("member-list-panel");
  const isNowActive = !panel.classList.contains("active");
  panel.classList.toggle("active", isNowActive);
  $("btn-toggle-members").classList.toggle("active", isNowActive);
  if(isNowActive && state.currentServerId) loadServerMembers(state.currentServerId);
});

async function loadServerMembers(serverId){
  const [membersRes, rolesRes] = await Promise.all([
    sb.from("server_members").select("user_id, role_id, profiles(id, username, nickname, avatar_url)").eq("server_id", serverId),
    sb.from("roles").select("*").eq("server_id", serverId).order("position", { ascending: true, nullsFirst: false })
  ]);
  if(membersRes.error){ console.error(membersRes.error); return; }
  const members = (membersRes.data || [])
    .filter(row => row.profiles)
    .map(row => ({ ...row.profiles, role_id: row.role_id }));
  renderMemberList(members, rolesRes.data || []);
}

function renderMemberList(members, roles){
  const panel = $("member-list-panel");
  panel.innerHTML = "";

  const rolesById = {};
  roles.forEach(r => { rolesById[r.id] = r; });

  const groups = roles.map(r => ({ role: r, members: [] }));
  const noRoleGroup = { role: null, members: [] };

  members.forEach(m => {
    const role = m.role_id ? rolesById[m.role_id] : null;
    const group = role ? groups.find(g => g.role.id === role.id) : null;
    (group || noRoleGroup).members.push(m);
  });
  groups.push(noRoleGroup);

  groups.forEach(g => {
    if(!g.members.length) return;
    g.members.sort((a, b) => a.username.localeCompare(b.username));

    const label = document.createElement("div");
    label.className = "member-group-label";
    label.textContent = (g.role ? g.role.name : "Membros").toUpperCase() + " — " + g.members.length;
    if(g.role) label.style.color = g.role.color;
    panel.appendChild(label);

    g.members.forEach(p => {
      const row = document.createElement("div");
      row.className = "member-row";
      row.style.cursor = "pointer";
      const nameStyle = g.role ? ` style="color:${g.role.color}"` : "";
      row.innerHTML = `<div class="avatar">${avatarHtml(p)}</div><span class="mname"${nameStyle}>${escapeHtml(displayName(p))}</span>`;
      row.addEventListener("click", () => openProfileHub(p.id));
      panel.appendChild(row);
    });
  });

  if(!members.length){
    panel.innerHTML = `<h3>Membros — 0</h3>`;
  }
}

// ============================================
// AMIGOS E MENSAGENS DIRETAS (DM)
// ============================================
$("btn-dm-home").addEventListener("click", enterDmMode);

function enterDmMode(){
  if(voiceState.channel && state.voiceContext && state.voiceContext.type === "channel") leaveVoiceChannel();
  state.mode = "dm";
  state.currentServerId = null;
  renderServerRail();
  $("btn-dm-home").classList.add("active");
  $("server-sidebar-content").style.display = "none";
  $("dm-sidebar-content").style.display = "flex";
  $("btn-toggle-members").style.display = "none";
  $("member-list-panel").classList.remove("active");

  if(state.currentDmUserId){
    openDm(state.currentDmUserId);
  } else {
    $("content-header").style.display = "none";
    $("text-view").style.display = "none";
    $("voice-view").style.display = "none";
    $("dm-view").style.display = "none";
    $("empty-state-text").textContent = "Selecione um amigo para conversar, ou adicione alguém pelo nome de usuário ao lado.";
    $("empty-state").style.display = "flex";
  }
  loadFriendsAndRequests();
}

async function loadFriendsAndRequests(){
  const myId = state.user.id;
  const { data: rows, error } = await sb.from("friend_requests")
    .select("*")
    .or(`from_user.eq.${myId},to_user.eq.${myId}`);
  if(error){ console.error(error); return; }

  const accepted = (rows || []).filter(r => r.status === "accepted");
  const incoming = (rows || []).filter(r => r.status === "pending" && r.to_user === myId);
  const outgoing = (rows || []).filter(r => r.status === "pending" && r.from_user === myId);

  const friendIds = accepted.map(r => (r.from_user === myId ? r.to_user : r.from_user));
  const otherIds = [...new Set([...friendIds, ...incoming.map(r => r.from_user), ...outgoing.map(r => r.to_user)])];

  if(otherIds.length){
    const { data: profiles } = await sb.from("profiles").select("*").in("id", otherIds);
    (profiles || []).forEach(p => state.serverMembersCache[p.id] = p);
  }

  state.friends = friendIds;
  state.incomingRequests = incoming;
  state.outgoingRequests = outgoing;
  renderFriendBadge();
  if(state.mode === "dm") renderFriendsList();
}

function renderFriendBadge(){
  const btn = $("btn-dm-home");
  let dot = btn.querySelector(".dm-badge-dot");
  const hasNotif = state.incomingRequests.length > 0 || state.unreadDm.size > 0;
  if(hasNotif){
    if(!dot){
      dot = document.createElement("span");
      dot.className = "dm-badge-dot";
      btn.appendChild(dot);
    }
  } else if(dot){
    dot.remove();
  }
}

function renderFriendsList(){
  const wrap = $("friend-list-wrap");
  wrap.innerHTML = "";

  if(state.incomingRequests.length){
    const label = document.createElement("div");
    label.className = "channel-group-label";
    label.textContent = "Solicitações";
    wrap.appendChild(label);

    state.incomingRequests.forEach(r => {
      const p = state.serverMembersCache[r.from_user] || { username: "Usuário" };
      const row = document.createElement("div");
      row.className = "friend-request-row";
      row.innerHTML = `<div class="avatar" style="width:28px; height:28px; font-size:13px;">${avatarHtml(p)}</div>` +
        `<span class="mname">${escapeHtml(displayName(p))}</span>` +
        `<span class="friend-accept" title="Aceitar">✓</span>` +
        `<span class="friend-decline" title="Recusar">✕</span>`;
      row.querySelector(".friend-accept").addEventListener("click", () => respondFriendRequest(r.id, true));
      row.querySelector(".friend-decline").addEventListener("click", () => respondFriendRequest(r.id, false));
      wrap.appendChild(row);
    });
  }

  const label2 = document.createElement("div");
  label2.className = "channel-group-label";
  label2.textContent = "Amigos — " + state.friends.length;
  wrap.appendChild(label2);

  if(!state.friends.length){
    const empty = document.createElement("div");
    empty.style.cssText = "color:var(--text-dim); font-size:13px; padding:4px 6px;";
    empty.textContent = "Ninguém por aqui ainda.";
    wrap.appendChild(empty);
  }

  state.friends
    .map(id => state.serverMembersCache[id])
    .filter(Boolean)
    .sort((a, b) => a.username.localeCompare(b.username))
    .forEach(p => {
      const row = document.createElement("div");
      row.className = "channel-item friend-row" + (state.currentDmUserId === p.id ? " active" : "");
      row.innerHTML = `<div class="avatar" style="width:24px; height:24px; font-size:12px;">${avatarHtml(p)}</div>` +
        `<span>${escapeHtml(displayName(p))}</span>` +
        (state.unreadDm.has(p.id) ? `<span class="friend-unread-dot"></span>` : "");
      row.addEventListener("click", () => openDm(p.id));
      wrap.appendChild(row);
    });

  if(state.outgoingRequests.length){
    const label3 = document.createElement("div");
    label3.className = "channel-group-label";
    label3.textContent = "Convites enviados";
    wrap.appendChild(label3);
    state.outgoingRequests.forEach(r => {
      const p = state.serverMembersCache[r.to_user] || { username: "Usuário" };
      const row = document.createElement("div");
      row.style.cssText = "padding:6px 8px; font-size:13px; color:var(--text-dim);";
      row.textContent = displayName(p) + " (aguardando resposta)";
      wrap.appendChild(row);
    });
  }
}

async function respondFriendRequest(requestId, accept){
  if(accept){
    const { error } = await sb.from("friend_requests").update({ status: "accepted" }).eq("id", requestId);
    if(error){ alert("Erro ao aceitar convite: " + error.message); return; }
  } else {
    await sb.from("friend_requests").delete().eq("id", requestId);
  }
  await loadFriendsAndRequests();
}

$("btn-send-friend-request").addEventListener("click", async () => {
  const uname = $("add-friend-username").value.trim();
  const errEl = $("friend-request-error");
  errEl.textContent = "";
  if(!uname) return;

  const { data: profile, error: findError } = await sb.from("profiles")
    .select("id, username").ilike("username", uname).maybeSingle();
  if(findError || !profile){ errEl.textContent = "Nenhum usuário encontrado com esse nome."; return; }
  if(profile.id === state.user.id){ errEl.textContent = "Você não pode adicionar a si mesmo."; return; }
  if(state.friends.includes(profile.id)){ errEl.textContent = "Vocês já são amigos."; return; }

  // Se a outra pessoa já te chamou, aceita na hora em vez de duplicar o pedido
  const existingIncoming = state.incomingRequests.find(r => r.from_user === profile.id);
  if(existingIncoming){
    await respondFriendRequest(existingIncoming.id, true);
    $("add-friend-username").value = "";
    return;
  }

  const { error } = await sb.from("friend_requests").insert({ from_user: state.user.id, to_user: profile.id });
  if(error){
    errEl.textContent = (error.code === "23505") ? "Você já enviou um convite pra essa pessoa." : error.message;
    return;
  }
  $("add-friend-username").value = "";
  await loadFriendsAndRequests();
});

async function openDm(userId){
  if(voiceState.channel && !(state.voiceContext && state.voiceContext.type === "dm" && state.voiceContext.id === userId)){
    leaveVoiceChannel();
  }
  state.currentDmUserId = userId;
  state.unreadDm.delete(userId);
  renderFriendBadge();
  if(state.mode === "dm") renderFriendsList();

  $("empty-state").style.display = "none";
  $("text-view").style.display = "none";
  $("voice-view").style.display = "none";

  const profile = state.serverMembersCache[userId] || { username: "Usuário" };
  $("content-header").style.display = "flex";
  $("content-header-title").textContent = "@" + (profile.username || "Usuário");
  $("dm-view-toggle").style.display = "flex";
  showDmMessagesView();

  await loadDmMessages(userId);
}

// Identificador estável da "sala" de voz de uma conversa privada (mesmo par de pessoas = mesma sala)
function dmRoomId(userIdA, userIdB){
  return "dm-" + [userIdA, userIdB].sort().join("_");
}

function isCurrentDmCallActive(){
  return !!(voiceState.channel && state.voiceContext && state.voiceContext.type === "dm" && state.voiceContext.id === state.currentDmUserId);
}

function showDmMessagesView(){
  $("dm-view").style.display = "flex";
  $("voice-view").style.display = "none";
  $("btn-dm-tab-messages").classList.add("active");
  $("btn-dm-tab-call").classList.remove("active");
}

function showDmCallView(){
  $("dm-view").style.display = "none";
  $("voice-view").style.display = "flex";
  $("btn-dm-tab-messages").classList.remove("active");
  $("btn-dm-tab-call").classList.add("active");

  const friend = state.serverMembersCache[state.currentDmUserId] || { username: "Usuário" };
  $("voice-channel-label").textContent = "Chamada com " + displayName(friend);
  $("btn-join-voice").textContent = "📞 Ligar";

  if(!isCurrentDmCallActive() && callState.status === "idle"){
    $("voice-room").style.display = "none";
    $("voice-join-prompt").style.display = "flex";
    $("voice-calling-status").style.display = "none";
  }
}

$("btn-dm-tab-messages").addEventListener("click", showDmMessagesView);
$("btn-dm-tab-call").addEventListener("click", showDmCallView);

async function loadDmMessages(otherUserId){
  const myId = state.user.id;
  const { data: messages, error } = await sb.from("dm_messages")
    .select("*")
    .or(`and(sender_id.eq.${myId},recipient_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},recipient_id.eq.${myId})`)
    .order("created_at", { ascending: true })
    .limit(200);
  if(error){ console.error(error); return; }
  renderDmMessages(messages || []);
}

function renderDmMessages(messages){
  const wrap = $("dm-messages");
  wrap.innerHTML = "";
  messages.forEach(m => wrap.appendChild(dmMessageEl(m)));
  wrap.scrollTop = wrap.scrollHeight;
}

function dmMessageEl(m){
  const profile = state.serverMembersCache[m.sender_id] || { username: "Usuário" };
  const el = document.createElement("div");
  el.className = "msg";
  const time = new Date(m.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  el.innerHTML = `
    <div class="avatar" style="cursor:pointer;">${avatarHtml(profile)}</div>
    <div class="msg-body">
      <div class="msg-head">${escapeHtml(displayName(profile))} <span class="time">${time}</span></div>
      <div class="msg-text"></div>
    </div>`;
  el.querySelector(".msg-text").textContent = m.content;
  el.querySelector(".avatar").addEventListener("click", () => openProfileHub(m.sender_id));
  return el;
}

async function sendDmMessage(){
  const input = $("dm-message-text");
  const content = input.value.trim();
  if(!content || !state.currentDmUserId) return;
  input.value = "";
  const { data, error } = await sb.from("dm_messages").insert({
    sender_id: state.user.id, recipient_id: state.currentDmUserId, content
  }).select().single();
  if(error){ alert("Erro ao enviar mensagem: " + error.message); return; }
  $("dm-messages").appendChild(dmMessageEl(data));
  $("dm-messages").scrollTop = $("dm-messages").scrollHeight;
}

$("btn-send-dm-message").addEventListener("click", sendDmMessage);
$("dm-message-text").addEventListener("keydown", (e) => { if(e.key === "Enter") sendDmMessage(); });

let dmInboxSub = null;
let userEventsSub = null;
let serverEventsSub = null;
function subscribeToDmInbox(){
  if(dmInboxSub) return; // já ativa, uma inscrição basta pra toda a sessão
  dmInboxSub = sb.channel("dm-inbox-" + state.user.id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "dm_messages", filter: `recipient_id=eq.${state.user.id}` },
      async (payload) => {
        const m = payload.new;
        if(!state.serverMembersCache[m.sender_id]){
          const { data: profile } = await sb.from("profiles").select("*").eq("id", m.sender_id).single();
          if(profile) state.serverMembersCache[m.sender_id] = profile;
        }
        if(state.mode === "dm" && state.currentDmUserId === m.sender_id){
          $("dm-messages").appendChild(dmMessageEl(m));
          $("dm-messages").scrollTop = $("dm-messages").scrollHeight;
        } else {
          state.unreadDm.add(m.sender_id);
          renderFriendBadge();
          if(state.mode === "dm") renderFriendsList();
        }
      })
    .subscribe();
}

// ============================================
// EDIT SERVER
// ============================================
$("btn-edit-server").addEventListener("click", async () => {
  if(!state.currentServerId) return;
  const server = state.servers.find(s => s.id === state.currentServerId);
  $("edit-server-name-input").value = server ? server.name : "";
  $("edit-server-error").textContent = "";
  pendingServerCoverFile = null;
  pendingServerCoverRemoved = false;
  $("server-cover-preview").setAttribute("style", "" + serverCoverStyle(server));
  $("server-cover-file-input").value = "";

  const owner = isServerOwner(state.currentServerId);
  $("edit-server-rename-row").style.display = hasPermission("manage_server") ? "" : "none";
  $("edit-server-add-channel-row").style.display = hasPermission("manage_channels") ? "" : "none";
  $("edit-server-create-role-row").style.display = hasPermission("manage_roles") ? "flex" : "none";
  $("edit-server-add-member-row").style.display = hasPermission("add_members") ? "" : "none";
  $("add-member-username").value = "";
  $("add-member-error").textContent = "";
  $("btn-delete-server").style.display = owner ? "" : "none";

  renderEditChannelList();
  await loadRolesForEdit();
  $("modal-edit-server").classList.add("active");
});

$("btn-choose-server-cover").addEventListener("click", () => $("server-cover-file-input").click());

$("server-cover-file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if(!file) return;
  pendingServerCoverFile = file;
  pendingServerCoverRemoved = false;
  const reader = new FileReader();
  reader.onload = (ev) => { $("server-cover-preview").style.backgroundImage = `url('${ev.target.result}')`; };
  reader.readAsDataURL(file);
});

$("btn-remove-server-cover").addEventListener("click", () => {
  pendingServerCoverFile = null;
  pendingServerCoverRemoved = true;
  $("server-cover-preview").style.backgroundImage = "";
});

$("btn-add-member").addEventListener("click", async () => {
  const uname = $("add-member-username").value.trim();
  if(!uname || !state.currentServerId) return;
  $("add-member-error").textContent = "Procurando...";

  const { data: profile, error: findError } = await sb.from("profiles")
    .select("id, username")
    .ilike("username", uname)
    .maybeSingle();

  if(findError || !profile){ $("add-member-error").textContent = "Nenhum usuário encontrado com esse nome."; return; }

  const { error } = await sb.from("server_members").upsert({ server_id: state.currentServerId, user_id: profile.id });
  if(error){ $("add-member-error").textContent = "Você não tem permissão para adicionar membros."; return; }

  $("add-member-error").textContent = `${profile.username} foi adicionado ao servidor!`;
  $("add-member-username").value = "";
  if($("member-list-panel").classList.contains("active")) loadServerMembers(state.currentServerId);
});

function renderEditChannelList(){
  const wrap = $("edit-channel-list");
  wrap.innerHTML = "";
  const canDelete = hasPermission("manage_channels");
  state.channels.forEach(c => {
    const row = document.createElement("div");
    row.className = "edit-channel-row";
    row.innerHTML = `<span>${c.type === "voice" ? "🎙️" : "💬"} ${escapeHtml(c.name)}</span>` +
      (canDelete ? `<span class="remove-x" title="Excluir canal">✕</span>` : "");
    if(canDelete) row.querySelector(".remove-x").addEventListener("click", () => deleteChannel(c.id));
    wrap.appendChild(row);
  });
}

// ============================================
// ROLES (cargos)
// ============================================
async function loadRolesForEdit(){
  if(!state.currentServerId) return;
  const { data } = await sb.from("roles").select("*").eq("server_id", state.currentServerId).order("position", { ascending: true, nullsFirst: false });
  state.currentRoles = data || [];
  renderEditRoleList();
}

let expandedRoleId = null;

function renderEditRoleList(){
  const wrap = $("edit-role-list");
  wrap.innerHTML = "";
  const canManage = hasPermission("manage_roles");

  state.currentRoles.forEach((r, i) => {
    const row = document.createElement("div");
    row.className = "edit-channel-row";
    row.innerHTML = `<span style="display:flex; align-items:center;"><span class="role-dot" style="background:${r.color}"></span>${escapeHtml(r.name)}</span>` +
      `<span style="margin-left:auto; display:flex; gap:2px; align-items:center;">` +
      (canManage ? `<span class="role-move-btn"${i === 0 ? ' style="opacity:.3; pointer-events:none;"' : ""} title="Mover para cima">▲</span>` +
      `<span class="role-move-btn"${i === state.currentRoles.length - 1 ? ' style="opacity:.3; pointer-events:none;"' : ""} title="Mover para baixo">▼</span>` +
      `<span class="role-perms-btn" title="Permissões do cargo" style="margin-left:6px; cursor:pointer;">🔧</span>` +
      `<span class="remove-x" title="Excluir cargo" style="margin-left:6px;">✕</span>` : "") +
      `</span>`;

    if(canManage){
      const [upBtn, downBtn] = row.querySelectorAll(".role-move-btn");
      upBtn.addEventListener("click", () => moveRole(i, -1));
      downBtn.addEventListener("click", () => moveRole(i, 1));
      row.querySelector(".role-perms-btn").addEventListener("click", () => {
        expandedRoleId = expandedRoleId === r.id ? null : r.id;
        renderEditRoleList();
      });
      row.querySelector(".remove-x").addEventListener("click", () => deleteRole(r.id));
    }
    wrap.appendChild(row);

    if(canManage && expandedRoleId === r.id){
      wrap.appendChild(rolePermissionsPanel(r));
    }
  });
}

function rolePermissionsPanel(role){
  const panel = document.createElement("div");
  panel.className = "role-perms-panel";
  panel.style.cssText = "background:var(--bg-mid); border-radius:8px; padding:10px 12px; margin:2px 0 8px; display:flex; flex-direction:column; gap:6px;";

  const perms = role.permissions || {};
  Object.keys(PERMISSION_LABELS).forEach(key => {
    const label = document.createElement("label");
    label.style.cssText = "display:flex; align-items:center; gap:8px; font-size:13px; color:var(--text-dim); cursor:pointer;";
    label.innerHTML = `<input type="checkbox" data-perm="${key}" ${perms[key] ? "checked" : ""}> ${PERMISSION_LABELS[key]}`;
    panel.appendChild(label);
  });

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn";
  saveBtn.style.cssText = "width:auto; padding:6px 14px; align-self:flex-end; margin-top:2px;";
  saveBtn.textContent = "Salvar permissões";
  saveBtn.addEventListener("click", async () => {
    const newPerms = {};
    panel.querySelectorAll("input[data-perm]").forEach(input => { newPerms[input.dataset.perm] = input.checked; });
    const { error } = await sb.from("roles").update({ permissions: newPerms }).eq("id", role.id);
    if(error){ $("edit-server-error").textContent = "Você não tem permissão para alterar as permissões deste cargo."; return; }
    await loadRolesForEdit();
  });
  panel.appendChild(saveBtn);

  return panel;
}

async function moveRole(index, direction){
  const target = index + direction;
  if(target < 0 || target >= state.currentRoles.length) return;

  const a = state.currentRoles[index];
  const b = state.currentRoles[target];
  const posA = a.position != null ? a.position : index;
  const posB = b.position != null ? b.position : target;

  const [resA, resB] = await Promise.all([
    sb.from("roles").update({ position: posB }).eq("id", a.id),
    sb.from("roles").update({ position: posA }).eq("id", b.id)
  ]);
  if(resA.error || resB.error){ $("edit-server-error").textContent = "Só o dono do servidor pode reordenar cargos."; return; }
  await loadRolesForEdit();
}

$("btn-create-role").addEventListener("click", async () => {
  const name = $("new-role-name").value.trim();
  const color = $("new-role-color").value;
  if(!name || !state.currentServerId) return;
  const nextPosition = state.currentRoles.length
    ? Math.max(...state.currentRoles.map(r => r.position || 0)) + 1
    : 1;
  const { error } = await sb.from("roles").insert({ server_id: state.currentServerId, name, color, position: nextPosition });
  if(error){ $("edit-server-error").textContent = "Só o dono do servidor pode criar cargos."; return; }
  $("new-role-name").value = "";
  await loadRolesForEdit();
});

async function deleteRole(roleId){
  if(!confirm("Excluir este cargo? Quem tiver ele atribuído fica sem cargo.")) return;
  const { error } = await sb.from("roles").delete().eq("id", roleId);
  if(error){ $("edit-server-error").textContent = "Só o dono do servidor pode excluir cargos."; return; }
  await loadRolesForEdit();
  if($("member-list-panel").classList.contains("active")) loadServerMembers(state.currentServerId);
}

$("btn-rename-server").addEventListener("click", async () => {
  const name = $("edit-server-name-input").value.trim();
  if(!name) return;

  const updates = { name };
  try{
    if(pendingServerCoverFile){
      $("edit-server-error").textContent = "Enviando capa...";
      updates.banner_url = await uploadServerCoverFile(pendingServerCoverFile);
    } else if(pendingServerCoverRemoved){
      updates.banner_url = null;
    }
  } catch(err){
    $("edit-server-error").textContent = "Erro ao enviar a imagem: " + err.message;
    return;
  }

  const { data, error } = await sb.from("servers").update(updates).eq("id", state.currentServerId).select().single();
  if(error){ $("edit-server-error").textContent = "Você não tem permissão para editar o servidor."; return; }
  $("edit-server-error").textContent = "";
  pendingServerCoverFile = null;
  pendingServerCoverRemoved = false;
  await loadServers();
  $("server-name-label").textContent = data.name;
  const coverEl = $("server-cover");
  coverEl.setAttribute("style", "" + serverCoverStyle(data));
  coverEl.classList.toggle("has-cover", !!data.banner_url);
});

$("btn-open-add-channel-from-edit").addEventListener("click", () => {
  $("new-channel-name").value = "";
  document.querySelectorAll("[data-channel-type]").forEach(b => b.classList.remove("active"));
  document.querySelector('[data-channel-type="text"]').classList.add("active");
  $("modal-channel").dataset.selectedType = "text";
  $("modal-channel").classList.add("active");
});

async function deleteChannel(channelId){
  if(!confirm("Excluir este canal? As mensagens dele também serão apagadas.")) return;
  const { error } = await sb.from("channels").delete().eq("id", channelId);
  if(error){ $("edit-server-error").textContent = "Só o dono do servidor pode excluir canais."; return; }
  await loadChannels(state.currentServerId);
  renderEditChannelList();
}

$("btn-delete-server").addEventListener("click", async () => {
  const server = state.servers.find(s => s.id === state.currentServerId);
  if(!server) return;
  if(!confirm(`Excluir o servidor "${server.name}" para sempre? Isso apaga todos os canais e mensagens dele.`)) return;

  const { error } = await sb.from("servers").delete().eq("id", server.id);
  if(error){ $("edit-server-error").textContent = "Só o dono do servidor pode excluí-lo."; return; }

  $("modal-edit-server").classList.remove("active");
  state.currentServerId = null;
  await loadServers();
});

// ============================================
// CHANNELS
// ============================================
async function loadChannels(serverId){
  const { data } = await sb.from("channels").select("*").eq("server_id", serverId).order("created_at");
  state.channels = data || [];
  renderChannelList();

  const textChannels = state.channels.filter(c => c.type === "text");
  if(textChannels.length){ selectChannel(textChannels[0]); }
}

function renderChannelList(){
  const wrap = $("channel-list");
  wrap.innerHTML = "";

  state.channels.filter(c => c.type === "text").forEach(c => wrap.appendChild(channelItemEl(c, "💬")));
  state.channels.filter(c => c.type === "voice").forEach(c => wrap.appendChild(channelItemEl(c, "🎙️")));

  const addRow = document.createElement("div");
  addRow.className = "channel-item";
  addRow.textContent = "+ Adicionar canal";
  addRow.style.color = "var(--text-dim)";
  addRow.addEventListener("click", () => {
    $("new-channel-name").value = "";
    document.querySelectorAll("[data-channel-type]").forEach(b => b.classList.remove("active"));
    document.querySelector('[data-channel-type="text"]').classList.add("active");
    $("modal-channel").dataset.selectedType = "text";
    $("modal-channel").classList.add("active");
  });
  wrap.appendChild(addRow);
}

function channelItemEl(channel, icon){
  const el = document.createElement("div");
  el.className = "channel-item" + (channel.id === state.currentChannelId ? " active" : "");
  el.textContent = icon + " " + channel.name;
  el.addEventListener("click", () => selectChannel(channel));
  return el;
}

document.querySelectorAll("[data-channel-type]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-channel-type]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    $("modal-channel").dataset.selectedType = btn.dataset.channelType;
  });
});

$("btn-create-channel").addEventListener("click", async () => {
  const name = $("new-channel-name").value.trim();
  if(!name || !state.currentServerId) return;
  const type = $("modal-channel").dataset.selectedType || "text";

  await sb.from("channels").insert({ server_id: state.currentServerId, name, type });
  $("modal-channel").classList.remove("active");
  await loadChannels(state.currentServerId);
  if($("modal-edit-server").classList.contains("active")) renderEditChannelList();
});

function selectChannel(channel){
  if(voiceState.channel && voiceState.roomChannelId !== channel.id) leaveVoiceChannel();
  state.currentChannelId = channel.id;
  state.currentChannelType = channel.type;
  renderChannelList();

  $("empty-state").style.display = "none";
  const header = $("content-header");
  header.style.display = "flex";
  $("content-header-title").textContent = (channel.type === "voice" ? "🎙️ " : "💬 ") + channel.name;
  $("dm-view-toggle").style.display = "none";

  if(channel.type === "text"){
    $("text-view").style.display = "flex";
    $("voice-view").style.display = "none";
    loadMessages(channel.id);
    subscribeToMessages(channel.id);
  } else {
    state.voiceContext = { type: "channel", id: channel.id };
    $("text-view").style.display = "none";
    $("voice-view").style.display = "flex";
    if(!voiceState.channel || voiceState.roomChannelId !== channel.id){
      $("voice-join-prompt").style.display = "flex";
    }
    $("voice-channel-label").textContent = channel.name;
    $("btn-join-voice").textContent = "Entrar na chamada";
  }
}

// ============================================
// TEXT MESSAGES
// ============================================
async function loadMessages(channelId){
  const { data: messages } = await sb.from("messages")
    .select("*")
    .eq("channel_id", channelId)
    .order("created_at", { ascending: true })
    .limit(200);

  const userIds = [...new Set((messages || []).map(m => m.user_id))];
  if(userIds.length){
    const { data: profiles } = await sb.from("profiles").select("*").in("id", userIds);
    (profiles || []).forEach(p => state.serverMembersCache[p.id] = p);
  }

  renderMessages(messages || []);
}

function renderMessages(messages){
  const wrap = $("messages");
  wrap.innerHTML = "";
  messages.forEach(m => wrap.appendChild(messageEl(m)));
  wrap.scrollTop = wrap.scrollHeight;
}

function messageEl(m){
  const profile = state.serverMembersCache[m.user_id] || { username: "Usuário" };
  const el = document.createElement("div");
  el.className = "msg";
  const time = new Date(m.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  el.innerHTML = `
    <div class="avatar" style="cursor:pointer;">${avatarHtml(profile)}</div>
    <div class="msg-body">
      <div class="msg-head">${escapeHtml(displayName(profile))} <span class="time">${time}</span></div>
      <div class="msg-text"></div>
    </div>`;
  el.querySelector(".msg-text").textContent = m.content;
  el.querySelector(".avatar").addEventListener("click", () => openProfileHub(m.user_id));
  return el;
}

function escapeHtml(str){
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function subscribeToMessages(channelId){
  if(state.messagesChannelSub){ sb.removeChannel(state.messagesChannelSub); }

  state.messagesChannelSub = sb.channel("messages-" + channelId)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `channel_id=eq.${channelId}` },
      async (payload) => {
        const m = payload.new;
        if(!state.serverMembersCache[m.user_id]){
          const { data: profile } = await sb.from("profiles").select("*").eq("id", m.user_id).single();
          if(profile) state.serverMembersCache[m.user_id] = profile;
        }
        const wrap = $("messages");
        wrap.appendChild(messageEl(m));
        wrap.scrollTop = wrap.scrollHeight;
      })
    .subscribe();
}

async function sendMessage(){
  const input = $("message-text");
  const content = input.value.trim();
  if(!content || !state.currentChannelId) return;
  input.value = "";
  await sb.from("messages").insert({ channel_id: state.currentChannelId, user_id: state.user.id, content });
}

$("btn-send-message").addEventListener("click", sendMessage);
$("message-text").addEventListener("keydown", (e) => { if(e.key === "Enter") sendMessage(); });

// ============================================
// VOICE (WebRTC direto, sinalização via Supabase Realtime)
// Usa o padrão "perfect negotiation" para suportar ligar câmera/tela
// no meio da chamada sem quebrar a conexão de ninguém.
// ============================================
// IMPORTANTE: com só STUN, a chamada só funciona bem quando as duas pessoas
// estão em redes "fáceis" (mesmo Wi-Fi, sem firewall restritivo). Em internet
// móvel, redes corporativas ou várias combinações de roteador, o STUN sozinho
// não consegue abrir uma conexão direta — daí o sintoma de "conectou mas não
// vem áudio/tela nenhuma". O TURN abaixo serve de retransmissor quando a
// conexão direta falha. É um servidor TURN gratuito (Open Relay Project) —
// dá pra trocar por outro provedor TURN próprio se precisar de mais volume.
const ICE_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp"
      ],
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};

let voiceState = {
  channel: null,        // canal Realtime do Supabase usado para sinalização
  localStream: null,    // stream do microfone
  peers: {},             // peerId -> RTCPeerConnection
  audioEls: {},           // peerId -> <audio>
  myId: null,
  muted: false,
  roomChannelId: null,
  videoTrack: null,      // track de vídeo atual sendo enviada (câmera OU tela)
  videoKind: null,        // 'camera' | 'screen' | null
  videoStream: null,      // MediaStream da câmera ou da tela, o que estiver ativo
  videoSenders: {},        // peerId -> RTCRtpSender do vídeo
  selectedMicId: localStorage.getItem("agora_mic_device") || null,
  selectedSpeakerId: localStorage.getItem("agora_speaker_device") || null,
  hadPeer: false,          // já teve alguém conectado nesta chamada (pra saber se foi a pessoa que saiu, ou se ainda nem entrou)
};

// ============================================
// TOQUE DE CHAMADA (gerado por código, sem precisar de arquivo de áudio)
// ============================================
let ringtoneCtx = null;
let ringtoneTimer = null;

function startRingtone(kind){ // kind: "outgoing" (chamando) | "incoming" (recebendo)
  stopRingtone();
  try{
    ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    const freqs = kind === "outgoing" ? [480, 620] : [640, 950]; // tons diferentes pra distinguir quem liga de quem recebe
    const beep = () => {
      if(!ringtoneCtx) return;
      const now = ringtoneCtx.currentTime;
      freqs.forEach((f) => {
        const osc = ringtoneCtx.createOscillator();
        const gain = ringtoneCtx.createGain();
        osc.frequency.value = f;
        osc.type = "sine";
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.16, now + 0.03);
        gain.gain.linearRampToValueAtTime(0, now + (kind === "outgoing" ? 0.5 : 0.9));
        osc.connect(gain).connect(ringtoneCtx.destination);
        osc.start(now);
        osc.stop(now + 1);
      });
    };
    beep();
    ringtoneTimer = setInterval(beep, kind === "outgoing" ? 1500 : 1700);
  } catch(err){ console.warn("Não consegui tocar o som de chamada:", err.message); }
}

function stopRingtone(){
  if(ringtoneTimer){ clearInterval(ringtoneTimer); ringtoneTimer = null; }
  if(ringtoneCtx){ ringtoneCtx.close().catch(() => {}); ringtoneCtx = null; }
}

// ============================================
// LIGAR / ATENDER / RECUSAR (chamadas 1:1 por DM)
// ============================================
// A "campainha" é uma linha na tabela `calls` (com Realtime ligado), o mesmo
// mecanismo que já faz os pedidos de amizade e as mensagens de DM aparecerem
// ao vivo sem precisar de F5. Muito mais confiável do que broadcast solto.
let callState = { status: "idle", withUserId: null, callId: null, timeoutTimer: null }; // status: "idle" | "calling"
let incomingCall = null; // linha da tabela `calls` que está tocando agora

async function startOutgoingCall(targetUserId){
  if(callState.status !== "idle" || voiceState.channel || incomingCall) return;
  callState.status = "calling";
  callState.withUserId = targetUserId;

  const friend = state.serverMembersCache[targetUserId] || { username: "Usuário" };
  $("voice-join-prompt").style.display = "none";
  $("calling-avatar").innerHTML = avatarHtml(friend);
  $("calling-status-text").textContent = "Chamando " + displayName(friend) + "...";
  $("voice-calling-status").style.display = "flex";
  startRingtone("outgoing");

  const { data, error } = await sb.from("calls").insert({
    caller_id: state.user.id, callee_id: targetUserId, status: "ringing"
  }).select().single();

  if(error){
    console.error("Erro ao iniciar chamada:", error);
    stopRingtone();
    resetCallUi();
    alert("Não consegui iniciar a chamada: " + error.message);
    return;
  }

  callState.callId = data.id;
  callState.timeoutTimer = setTimeout(() => {
    if(callState.status === "calling") cancelOutgoingCall(true);
  }, 30000);
}

async function cancelOutgoingCall(timedOut){
  if(callState.timeoutTimer){ clearTimeout(callState.timeoutTimer); callState.timeoutTimer = null; }
  if(callState.callId){
    await sb.from("calls").update({ status: "cancelled" }).eq("id", callState.callId);
  }
  stopRingtone();
  resetCallUi();
  if(timedOut) alert("A pessoa não atendeu.");
}

function resetCallUi(){
  callState = { status: "idle", withUserId: null, callId: null, timeoutTimer: null };
  $("voice-calling-status").style.display = "none";
  if(!isCurrentDmCallActive()){
    $("voice-join-prompt").style.display = "flex";
  }
}

// Chega quando ALGUÉM MEXEU numa chamada que EU comecei (aceitou ou recusou)
function handleMyCallUpdated(call){
  if(callState.status !== "calling" || call.id !== callState.callId) return;
  if(call.status === "accepted") onCallAccepted(call);
  else if(call.status === "rejected") onCallRejected(call);
}

function onCallAccepted(call){
  if(callState.timeoutTimer){ clearTimeout(callState.timeoutTimer); callState.timeoutTimer = null; }
  stopRingtone();
  const targetUserId = callState.withUserId;
  callState = { status: "idle", withUserId: null, callId: null, timeoutTimer: null };
  $("voice-calling-status").style.display = "none";
  state.voiceContext = { type: "dm", id: targetUserId };
  joinVoiceChannel(dmRoomId(state.user.id, targetUserId));
}

function onCallRejected(call){
  if(callState.timeoutTimer){ clearTimeout(callState.timeoutTimer); callState.timeoutTimer = null; }
  stopRingtone();
  resetCallUi();
  alert("A chamada foi recusada.");
}

// Chega quando alguém me liga (linha nova em `calls` com callee_id = eu)
async function showIncomingCall(call){
  // Já em outra chamada, ligando, ou já tem uma chamada tocando: recusa automático (ocupado)
  if(callState.status !== "idle" || voiceState.channel || incomingCall){
    await sb.from("calls").update({ status: "rejected" }).eq("id", call.id);
    return;
  }

  let caller = state.serverMembersCache[call.caller_id];
  if(!caller){
    const { data } = await sb.from("profiles").select("*").eq("id", call.caller_id).single();
    caller = data || { username: "Usuário" };
    state.serverMembersCache[call.caller_id] = caller;
  }

  incomingCall = call;
  $("incoming-call-avatar").innerHTML = avatarHtml(caller);
  $("incoming-call-name").textContent = displayName(caller);
  $("incoming-call-overlay").classList.add("active");
  startRingtone("incoming");
}

// Chega quando uma chamada que está tocando pra mim muda de status sem eu ter mexido
// (o caso mais comum: a pessoa que ligou cancelou antes de eu atender)
function handleIncomingCallUpdated(call){
  if(incomingCall && incomingCall.id === call.id && call.status !== "ringing"){
    hideIncomingCall();
  }
}

function hideIncomingCall(){
  $("incoming-call-overlay").classList.remove("active");
  stopRingtone();
  incomingCall = null;
}

$("btn-cancel-call").addEventListener("click", () => cancelOutgoingCall(false));

$("btn-accept-call").addEventListener("click", async () => {
  if(!incomingCall) return;
  const call = incomingCall;
  hideIncomingCall();
  await sb.from("calls").update({ status: "accepted" }).eq("id", call.id);

  state.voiceContext = { type: "dm", id: call.caller_id };
  await joinVoiceChannel(dmRoomId(state.user.id, call.caller_id));

  if(state.mode !== "dm"){
    state.currentDmUserId = call.caller_id;
    enterDmMode();
  } else if(state.currentDmUserId !== call.caller_id){
    await openDm(call.caller_id);
  }
  showDmCallView();
});

$("btn-decline-call").addEventListener("click", async () => {
  if(!incomingCall) return;
  const call = incomingCall;
  hideIncomingCall();
  await sb.from("calls").update({ status: "rejected" }).eq("id", call.id);
});

$("btn-join-voice").addEventListener("click", () => {
  if(state.mode === "dm" && state.currentDmUserId){
    startOutgoingCall(state.currentDmUserId);
  } else {
    state.voiceContext = { type: "channel", id: state.currentChannelId };
    joinVoiceChannel(state.currentChannelId);
  }
});
$("btn-leave-voice").addEventListener("click", leaveVoiceChannel);
$("btn-toggle-mute").addEventListener("click", () => {
  if(!voiceState.localStream) return;
  voiceState.muted = !voiceState.muted;
  voiceState.localStream.getAudioTracks().forEach(t => t.enabled = !voiceState.muted);
  $("btn-toggle-mute").textContent = voiceState.muted ? "🔇 Ativar mic" : "🎤 Mutar";
});
$("btn-toggle-camera").addEventListener("click", toggleCamera);
$("btn-share-screen").addEventListener("click", toggleScreenShare);
$("btn-mic-settings").addEventListener("click", openMicSettings);
$("btn-mic-settings-prejoin").addEventListener("click", openMicSettings);

async function joinVoiceChannel(channelId){
  if(!channelId) return;

  try{
    const audioConstraints = voiceState.selectedMicId ? { deviceId: { exact: voiceState.selectedMicId } } : true;
    voiceState.localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
  } catch(err){
    alert("Não consegui acessar seu microfone: " + err.message + "\n\nDica: o navegador só permite microfone em sites com HTTPS ou em localhost.");
    return;
  }

  voiceState.roomChannelId = channelId;
  voiceState.myId = state.user.id;
  voiceState.muted = false;

  $("voice-join-prompt").style.display = "none";
  $("voice-room").style.display = "flex";
  $("voice-participants").innerHTML = "";
  renderVoiceParticipant(voiceState.myId, { username: displayName(state.profile) + " (você)", avatar_url: state.profile.avatar_url });

  const roomName = `voice-${channelId}`;
  const rtChannel = sb.channel(roomName, { config: { presence: { key: voiceState.myId } } });
  voiceState.channel = rtChannel;

  rtChannel.on("presence", { event: "sync" }, () => {
    handleVoicePresenceSync(rtChannel.presenceState());
  });

  rtChannel.on("broadcast", { event: "signal" }, ({ payload }) => {
    if(payload.to === voiceState.myId) handleVoiceSignal(payload);
  });

  rtChannel.subscribe(async (status) => {
    if(status === "SUBSCRIBED"){
      await rtChannel.track({
        username: displayName(state.profile),
        avatar_url: state.profile.avatar_url || null
      });
    }
  });
}

function handleVoicePresenceSync(presenceState){
  const peerIds = Object.keys(presenceState).filter(id => id !== voiceState.myId);
  const currentIds = Object.keys(voiceState.peers);

  currentIds.forEach(id => { if(!peerIds.includes(id)) removeVoicePeer(id); });

  peerIds.forEach(id => {
    if(voiceState.peers[id]) return;
    const info = presenceState[id][0];
    renderVoiceParticipant(id, info);
    createVoicePeerConnection(id);
    voiceState.hadPeer = true;
  });

  // Chamada privada (1:1): se a outra pessoa saiu da sala, encerra a chamada
  // pros dois lados em vez de deixar essa ponta "pendurada" sozinha.
  if(state.voiceContext && state.voiceContext.type === "dm" && voiceState.hadPeer && peerIds.length === 0){
    leaveVoiceChannel();
  }
}

// Regra combinada dos dois lados pra saber quem "cede" se as duas pontas
// tentarem renegociar ao mesmo tempo (ex: ambos ligam a câmera junto).
function createVoicePeerConnection(peerId){
  const pc = new RTCPeerConnection(ICE_SERVERS);
  pc._polite = voiceState.myId > peerId;
  pc._makingOffer = false;
  pc._ignoreOffer = false;
  voiceState.peers[peerId] = pc;

  voiceState.localStream.getTracks().forEach(track => pc.addTrack(track, voiceState.localStream));
  if(voiceState.videoTrack){
    voiceState.videoSenders[peerId] = pc.addTrack(voiceState.videoTrack, voiceState.videoStream);
  }

  pc.onicecandidate = (e) => { if(e.candidate) sendVoiceSignal(peerId, "ice-candidate", e.candidate); };

  // Se a conexão direta cair (rede instável, trocou de wifi pra 4G, etc.),
  // tenta reabrir a conexão em vez de deixar a chamada muda/travada.
  pc.oniceconnectionstatechange = () => {
    if(pc.iceConnectionState === "failed"){
      console.warn("Conexão de voz com", peerId, "falhou — tentando reconectar...");
      try{ pc.restartIce(); } catch(err){ console.warn(err); }
    }
  };

  pc.ontrack = (e) => {
    if(e.track.kind === "audio"){
      let audioEl = voiceState.audioEls[peerId];
      if(!audioEl){
        audioEl = document.createElement("audio");
        audioEl.autoplay = true;
        document.body.appendChild(audioEl);
        voiceState.audioEls[peerId] = audioEl;
        applySpeakerToElement(audioEl);
      }
      audioEl.srcObject = e.streams[0] || new MediaStream([e.track]);
      audioEl.play().catch(() => {}); // alguns navegadores exigem esse play() explícito
    } else if(e.track.kind === "video"){
      showRemoteVideo(peerId, e.streams[0] || new MediaStream([e.track]));
      e.track.onended = () => hideRemoteVideo(peerId);
    }
  };

  pc.onnegotiationneeded = async () => {
    try{
      pc._makingOffer = true;
      await pc.setLocalDescription();
      sendVoiceSignal(peerId, "offer", pc.localDescription);
    } catch(err){ console.error(err); }
    finally { pc._makingOffer = false; }
  };

  return pc;
}

function sendVoiceSignal(to, type, data){
  voiceState.channel.send({ type: "broadcast", event: "signal", payload: { from: voiceState.myId, to, type, data } });
}

async function handleVoiceSignal(payload){
  const { from, type, data } = payload;
  let pc = voiceState.peers[from];
  if(!pc) pc = createVoicePeerConnection(from);

  try{
    if(type === "offer"){
      const offerCollision = pc._makingOffer || pc.signalingState !== "stable";
      pc._ignoreOffer = !pc._polite && offerCollision;
      if(pc._ignoreOffer) return;

      if(offerCollision){
        await Promise.all([ pc.setLocalDescription({ type: "rollback" }), pc.setRemoteDescription(data) ]);
      } else {
        await pc.setRemoteDescription(data);
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendVoiceSignal(from, "answer", pc.localDescription);
    } else if(type === "answer"){
      await pc.setRemoteDescription(data);
    } else if(type === "ice-candidate"){
      try{ await pc.addIceCandidate(data); } catch(e){ if(!pc._ignoreOffer) console.error(e); }
    }
  } catch(err){ console.error("Erro na sinalização de voz:", err); }
}

function renderVoiceParticipant(id, info){
  if(document.getElementById("voice-p-" + id)) return;
  const card = document.createElement("div");
  card.className = "voice-participant";
  card.id = "voice-p-" + id;
  card.innerHTML = `<div class="avatar" style="cursor:pointer;">${avatarHtml(info)}</div><div class="vname">${escapeHtml(info.username || "Usuário")}</div>`;
  card.querySelector(".avatar").addEventListener("click", () => openProfileHub(id));
  $("voice-participants").appendChild(card);
}

function showRemoteVideo(peerId, stream){
  const card = document.getElementById("voice-p-" + peerId);
  if(!card) return;
  let video = card.querySelector("video");
  if(!video){
    const wrap = document.createElement("div");
    wrap.className = "video-wrap";
    video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // o áudio já toca pelo elemento <audio> separado
    const maxBtn = document.createElement("button");
    maxBtn.className = "video-maximize-btn";
    maxBtn.type = "button";
    maxBtn.title = "Maximizar";
    maxBtn.textContent = "⛶";
    maxBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMaximizeVideo(peerId); });
    wrap.appendChild(video);
    wrap.appendChild(maxBtn);
    card.insertBefore(wrap, card.firstChild);
  }
  video.srcObject = stream;
  card.classList.add("has-video");
}

function hideRemoteVideo(peerId){
  const card = document.getElementById("voice-p-" + peerId);
  if(!card) return;
  if(card.classList.contains("maximized")) toggleMaximizeVideo(peerId);
  const wrap = card.querySelector(".video-wrap");
  if(wrap) wrap.remove();
  card.classList.remove("has-video");
}

function updateLocalVideoPreview(stream){
  const card = document.getElementById("voice-p-" + voiceState.myId);
  if(!card) return;
  let video = card.querySelector("video");
  if(stream){
    if(!video){
      const wrap = document.createElement("div");
      wrap.className = "video-wrap";
      video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      const maxBtn = document.createElement("button");
      maxBtn.className = "video-maximize-btn";
      maxBtn.type = "button";
      maxBtn.title = "Maximizar";
      maxBtn.textContent = "⛶";
      maxBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMaximizeVideo(voiceState.myId); });
      wrap.appendChild(video);
      wrap.appendChild(maxBtn);
      card.insertBefore(wrap, card.firstChild);
    }
    video.srcObject = stream;
    card.classList.add("has-video");
  } else {
    if(card.classList.contains("maximized")) toggleMaximizeVideo(voiceState.myId);
    const wrap = card.querySelector(".video-wrap");
    if(wrap) wrap.remove();
    card.classList.remove("has-video");
  }
}

// Alterna a visualização em tela cheia (dentro do app) de um vídeo específico.
// Fecha automaticamente com a tecla Esc.
function toggleMaximizeVideo(peerId){
  const card = document.getElementById("voice-p-" + peerId);
  if(!card || !card.classList.contains("has-video")) return;
  const container = $("voice-participants");
  const isMaximized = card.classList.contains("maximized");

  if(isMaximized){
    card.classList.remove("maximized");
    container.classList.remove("has-maximized");
    document.removeEventListener("keydown", handleMaximizeEscKey);
  } else {
    document.querySelectorAll(".voice-participant.maximized").forEach(el => el.classList.remove("maximized"));
    card.classList.add("maximized");
    container.classList.add("has-maximized");
    document.addEventListener("keydown", handleMaximizeEscKey);
  }
}

function handleMaximizeEscKey(e){
  if(e.key !== "Escape") return;
  const maximized = document.querySelector(".voice-participant.maximized");
  if(maximized) toggleMaximizeVideo(maximized.id.replace("voice-p-", ""));
}

function removeVoicePeer(peerId){
  const pc = voiceState.peers[peerId];
  if(pc) pc.close();
  delete voiceState.peers[peerId];
  delete voiceState.videoSenders[peerId];
  const audioEl = voiceState.audioEls[peerId];
  if(audioEl){ audioEl.remove(); delete voiceState.audioEls[peerId]; }
  const card = document.getElementById("voice-p-" + peerId);
  if(card) card.remove();
}

// Troca a "faixa" de vídeo (câmera ou tela) enviada para todo mundo já conectado
async function setOutgoingVideoTrack(track, kind, stream){
  for(const peerId of Object.keys(voiceState.peers)){
    const pc = voiceState.peers[peerId];
    let sender = voiceState.videoSenders[peerId];
    if(track){
      if(sender){
        await sender.replaceTrack(track);
      } else {
        voiceState.videoSenders[peerId] = pc.addTrack(track, stream);
      }
    } else if(sender){
      pc.removeTrack(sender);
      delete voiceState.videoSenders[peerId];
    }
  }
  voiceState.videoTrack = track;
  voiceState.videoKind = kind;
  voiceState.videoStream = stream;
}

async function toggleCamera(){
  if(!voiceState.localStream) return; // só funciona dentro de uma chamada

  if(voiceState.videoKind === "camera"){
    voiceState.videoTrack.stop();
    await setOutgoingVideoTrack(null, null, null);
    updateLocalVideoPreview(null);
    $("btn-toggle-camera").textContent = "📷 Ligar câmera";
    return;
  }

  try{
    const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
    const track = camStream.getVideoTracks()[0];
    if(voiceState.videoStream) voiceState.videoStream.getTracks().forEach(t => t.stop());

    await setOutgoingVideoTrack(track, "camera", camStream);
    updateLocalVideoPreview(camStream);
    $("btn-toggle-camera").textContent = "📷 Desligar câmera";
    $("btn-share-screen").textContent = "🖥️ Compartilhar tela";

    track.onended = () => { if(voiceState.videoKind === "camera") toggleCamera(); };
  } catch(err){
    alert("Não consegui acessar sua câmera: " + err.message);
  }
}

async function toggleScreenShare(){
  if(!voiceState.localStream) return;

  if(voiceState.videoKind === "screen"){
    voiceState.videoTrack.stop();
    await setOutgoingVideoTrack(null, null, null);
    updateLocalVideoPreview(null);
    $("btn-share-screen").textContent = "🖥️ Compartilhar tela";
    return;
  }

  try{
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const track = screenStream.getVideoTracks()[0];
    if(voiceState.videoStream) voiceState.videoStream.getTracks().forEach(t => t.stop());

    await setOutgoingVideoTrack(track, "screen", screenStream);
    updateLocalVideoPreview(screenStream);
    $("btn-share-screen").textContent = "🖥️ Parar compartilhamento";
    $("btn-toggle-camera").textContent = "📷 Ligar câmera";

    // Se a pessoa clicar em "Parar compartilhamento" na barra do próprio navegador
    track.onended = () => { if(voiceState.videoKind === "screen") toggleScreenShare(); };
  } catch(err){
    // Cancelar a seleção de tela não é um erro real, só não faz nada
    console.log("Compartilhamento de tela cancelado:", err.message);
  }
}

// Aplica o alto-falante escolhido a um elemento <audio>/<video>, se o navegador suportar.
async function applySpeakerToElement(el){
  if(!voiceState.selectedSpeakerId) return;
  if(typeof el.setSinkId !== "function") return; // Safari/iOS ainda não suporta
  try{ await el.setSinkId(voiceState.selectedSpeakerId); }
  catch(err){ console.warn("Não foi possível trocar a saída de áudio:", err.message); }
}

function applySpeakerToAllAudio(){
  Object.values(voiceState.audioEls).forEach(applySpeakerToElement);
}

async function openMicSettings(){
  const supportsOutputSelection = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
  try{
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === "audioinput");
    const speakers = devices.filter(d => d.kind === "audiooutput");

    const micSelect = $("mic-select");
    micSelect.innerHTML = "";
    mics.forEach((m, i) => {
      const opt = document.createElement("option");
      opt.value = m.deviceId;
      opt.textContent = m.label || `Microfone ${i + 1}`;
      if(m.deviceId === voiceState.selectedMicId) opt.selected = true;
      micSelect.appendChild(opt);
    });

    const speakerSelect = $("speaker-select");
    speakerSelect.innerHTML = "";
    if(supportsOutputSelection && speakers.length){
      speakerSelect.disabled = false;
      speakers.forEach((s, i) => {
        const opt = document.createElement("option");
        opt.value = s.deviceId;
        opt.textContent = s.label || `Alto-falante ${i + 1}`;
        if(s.deviceId === voiceState.selectedSpeakerId) opt.selected = true;
        speakerSelect.appendChild(opt);
      });
      $("speaker-settings-note").textContent = "";
    } else {
      speakerSelect.disabled = true;
      const opt = document.createElement("option");
      opt.textContent = "Não suportado neste navegador";
      speakerSelect.appendChild(opt);
      $("speaker-settings-note").textContent = supportsOutputSelection
        ? "Nenhum alto-falante extra foi detectado."
        : "Seu navegador não permite escolher a saída de áudio (comum no Safari/iOS). O som sai pelo dispositivo padrão do sistema.";
    }

    $("mic-settings-note").textContent = mics.some(m => m.label)
      ? ""
      : "Os nomes dos microfones aparecem depois que você permitir o uso do microfone pela primeira vez.";
    $("modal-mic-settings").classList.add("active");
  } catch(err){
    alert("Não consegui listar os dispositivos de áudio: " + err.message);
  }
}

$("btn-apply-mic").addEventListener("click", async () => {
  const micDeviceId = $("mic-select").value;
  const speakerSelect = $("speaker-select");
  const speakerDeviceId = !speakerSelect.disabled ? speakerSelect.value : null;

  if(speakerDeviceId){
    voiceState.selectedSpeakerId = speakerDeviceId;
    localStorage.setItem("agora_speaker_device", speakerDeviceId);
    applySpeakerToAllAudio();
  }

  if(!micDeviceId){ $("modal-mic-settings").classList.remove("active"); return; }
  voiceState.selectedMicId = micDeviceId;
  localStorage.setItem("agora_mic_device", micDeviceId);

  if(voiceState.localStream){
    try{
      const newStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micDeviceId } } });
      const newTrack = newStream.getAudioTracks()[0];
      const oldTrack = voiceState.localStream.getAudioTracks()[0];
      newTrack.enabled = !voiceState.muted;

      Object.values(voiceState.peers).forEach(pc => {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === "audio");
        if(sender) sender.replaceTrack(newTrack);
      });

      if(oldTrack){ oldTrack.stop(); voiceState.localStream.removeTrack(oldTrack); }
      voiceState.localStream.addTrack(newTrack);
    } catch(err){
      alert("Erro ao trocar de microfone: " + err.message);
    }
  }
  $("modal-mic-settings").classList.remove("active");
});

function leaveVoiceChannel(){
  Object.keys(voiceState.peers).forEach(removeVoicePeer);
  if(voiceState.localStream) voiceState.localStream.getTracks().forEach(t => t.stop());
  if(voiceState.videoTrack) voiceState.videoTrack.stop();
  if(voiceState.channel) sb.removeChannel(voiceState.channel);
  document.removeEventListener("keydown", handleMaximizeEscKey);
  $("voice-participants").classList.remove("has-maximized");

  const keepMicId = voiceState.selectedMicId;
  const keepSpeakerId = voiceState.selectedSpeakerId;
  voiceState = {
    channel: null, localStream: null, peers: {}, audioEls: {}, myId: null, muted: false, roomChannelId: null,
    videoTrack: null, videoKind: null, videoStream: null, videoSenders: {}, selectedMicId: keepMicId, selectedSpeakerId: keepSpeakerId,
    hadPeer: false
  };

  $("voice-room").style.display = "none";
  $("voice-participants").innerHTML = "";
  $("voice-calling-status").style.display = "none";
  $("voice-join-prompt").style.display = "flex";
  $("btn-toggle-mute").textContent = "🎤 Mutar";
  $("btn-toggle-camera").textContent = "📷 Ligar câmera";
  $("btn-share-screen").textContent = "🖥️ Compartilhar tela";
  state.voiceContext = null;
}

// ============================================
// MODALS - generic close + tabs
// ============================================
document.querySelectorAll(".modal-close-x").forEach(x => {
  x.addEventListener("click", () => $(x.dataset.close).classList.remove("active"));
});

document.querySelectorAll(".modal-overlay").forEach(overlay => {
  overlay.addEventListener("click", (e) => { if(e.target === overlay) overlay.classList.remove("active"); });
});

document.querySelectorAll("#modal-server .tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#modal-server .tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll("#modal-server .tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    $("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ============================================
// INIT
// ============================================
checkExistingSession();