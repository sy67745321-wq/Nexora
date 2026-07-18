import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getDatabase, ref, set, get, push, onValue, update, remove, onDisconnect, query, orderByChild, limitToLast } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyDtEKv70MeF6X7nFhyUU-g_6UDmPdwlntw",
    authDomain: "nexora-59099.firebaseapp.com",
    databaseURL: "https://nexora-59099-default-rtdb.firebaseio.com",
    projectId: "nexora-59099"
};

const app = initializeApp(firebaseConfig);
const rtdb = getDatabase(app);
const auth = getAuth(app);

let isLoginMode = false, currentUser = null, activeDMTarget = null, activeTunnelId = null, activeHubId = null;
let replyingToId = null, replyingToText = "";
let activePublicProfile = null;
let dmMessagesListener = null, typingListener = null, presenceListener = null, hubFeedListener = null;
let pendingAvatarBase64 = null, pendingPostMedia = null, pendingPostMediaType = null;
let currentFeedLimit = 10;
let feedUnsubscribe = null;
let lastNotifiedTime = Date.now();

// --- AUTHENTICATION LISTENER ---
onAuthStateChanged(auth, (user) => {
    if (user) {
        // Extract original Node ID from proxy email
        currentUser = user.email.split('@')[0];
        loadApplicationState();
    } else {
        currentUser = null;
        document.getElementById('authPage').classList.add('active');
        document.getElementById('mainNav').classList.remove('authorized');
        document.querySelectorAll('.page:not(#authPage)').forEach(p => p.classList.remove('active'));
    }
});

function escapeHTML(str) { 
    if (str === null || str === undefined) return "";
    return String(str).replace(/[&<>'"]/g, tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)); 
}

function compressImage(file, maxWidth, maxHeight, callback) {
    const reader = new FileReader();
    reader.onload = event => {
        const img = new Image();
        img.onload = () => {
            let w = img.width, h = img.height;
            if (w > maxWidth || h > maxHeight) {
                const ratio = Math.min(maxWidth / w, maxHeight / h);
                w *= ratio; h *= ratio;
            }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            callback(canvas.toDataURL('image/jpeg', 0.7)); 
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
}

function enableBackgroundNotifications() {
    if ("Notification" in window && Notification.permission !== "granted") {
        Notification.requestPermission();
    }
    onValue(ref(rtdb, 'dms'), snap => {
        if(!snap.exists() || !currentUser || !document.hidden) return;
        snap.forEach(tunnel => {
            if (tunnel.key.includes(currentUser)) {
                let msgs = [];
                tunnel.forEach(m => { if(typeof m.val() === 'object') msgs.push(m.val()); });
                if (msgs.length === 0) return;
                let lastMsg = msgs[msgs.length - 1];
                if (lastMsg && lastMsg.sender !== currentUser && lastMsg.timestamp > lastNotifiedTime) {
                    lastNotifiedTime = lastMsg.timestamp;
                    if (Notification.permission === "granted") {
                        new Notification("Nexora Transmission", {
                            body: `${escapeHTML(lastMsg.sender)}: ${lastMsg.type === 'image' ? '[Data Package]' : escapeHTML(lastMsg.message)}`
                        });
                    }
                }
            }
        });
    });
}

document.getElementById('navFeedBtn').addEventListener('click', function() { switchPage('feedPage', this); });
document.getElementById('navHubsBtn').addEventListener('click', function() { switchPage('subspacesPage', this); });
document.getElementById('navProfileBtn').addEventListener('click', function() { switchPage('profilePage', this); });
document.getElementById('navDMsBtn').addEventListener('click', () => { document.getElementById('dmInboxPanel').classList.add('sliding-active'); });
document.getElementById('closeInboxBtn').addEventListener('click', () => { document.getElementById('dmInboxPanel').classList.remove('sliding-active'); });
document.getElementById('closePublicProfileBtn').addEventListener('click', () => { document.getElementById('publicProfilePanel').classList.remove('sliding-active'); activePublicProfile = null; });

function switchPage(pageId, button) { 
    window.scrollTo(0, 0);
    document.querySelectorAll('.page').forEach(page => page.classList.remove('active')); 
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.remove('active')); 
    document.getElementById(pageId).classList.add('active'); 
    if(button) button.classList.add('active'); 

    // Force close all full-screen overlays
    document.querySelectorAll('.full-screen-panel').forEach(panel => panel.classList.remove('sliding-active'));
    activePublicProfile = null;
}

document.getElementById('authBtn').addEventListener('click', handleAuth);
document.getElementById('authToggle').addEventListener('click', toggleAuthMode);
document.getElementById('disconnectBtn').addEventListener('click', logout);

function toggleAuthMode() {
    isLoginMode = !isLoginMode; document.getElementById('authFeedback').style.display = 'none';
    document.getElementById('authTitle').innerText = isLoginMode ? "Authenticate" : "Initialize Node";
    document.getElementById('authBtn').innerText = isLoginMode ? "Connect" : "Register";
    document.getElementById('authToggle').innerText = isLoginMode ? "Unregistered? Initialize" : "Already registered? Authenticate";
}

function handleAuth() {
    const userNode = document.getElementById('authUsername').value.trim().toLowerCase();
    const pass = document.getElementById('authPassword').value.trim();
    const msgNode = document.getElementById('authFeedback');
    msgNode.style.display = 'none'; 
    
    if(!userNode || !pass) { showError("Parameters missing."); return; }
    if(/[.#$\[\]\s]/.test(userNode)) { showError("Invalid syntax in Node ID."); return; }
    
    msgNode.className = "feedback-log loading"; msgNode.innerText = "Connecting..."; msgNode.style.display = 'block';

    const proxyEmail = `${userNode}@nexora.net`;

    if (!isLoginMode) {
        createUserWithEmailAndPassword(auth, proxyEmail, pass)
            .then(() => {
                set(ref(rtdb, 'users/' + userNode), { username: userNode, bio: "Active system node.", avatar: "", color: "#3797F0" });
            })
            .catch(err => {
                if(err.code === 'auth/email-already-in-use') showError("Node ID taken.");
                else showError(`ERROR: ${err.message}`);
            });
    } else {
        signInWithEmailAndPassword(auth, proxyEmail, pass)
            .catch(err => showError("Authentication failed."));
    }
}

function showError(msg) { const n = document.getElementById('authFeedback'); n.className = "feedback-log error"; n.innerText = msg; n.style.display = 'block'; }

function loadApplicationState() {
    if(!currentUser) return;
    document.getElementById('authPage').classList.remove('active'); document.getElementById('mainNav').classList.add('authorized'); document.getElementById('feedPage').classList.add('active');
    
    // Clear credentials from UI
    document.getElementById('authUsername').value = '';
    document.getElementById('authPassword').value = '';

    const myPresenceRef = ref(rtdb, `presence/${currentUser}`); set(myPresenceRef, true); onDisconnect(myPresenceRef).remove();
    
    get(ref(rtdb, 'users/' + currentUser)).then(snapshot => {
        if(snapshot.exists()) {
            let data = snapshot.val(); 
            document.getElementById('displayUsername').innerText = currentUser; 
            document.getElementById('displayBio').innerText = data.bio || "Active node.";
            document.getElementById('editBio').value = data.bio || "";
            
            if (data.avatar) {
                document.getElementById('profileAvatarFallback').style.display = 'none';
                document.getElementById('profileAvatarImg').src = escapeHTML(data.avatar);
                document.getElementById('profileAvatarImg').style.display = 'block';
            } else {
                document.getElementById('profileAvatarImg').style.display = 'none';
                document.getElementById('profileAvatarFallback').style.display = 'block';
                document.getElementById('profileAvatarFallback').innerText = currentUser.charAt(0).toUpperCase();
            }
            if (data.color) {
                document.getElementById('editAccentColor').value = data.color;
                document.documentElement.style.setProperty('--accent-blue', data.color);
            }
        }
        syncFeed(); 
        syncDMHistoryList();
        syncHubs();
        enableBackgroundNotifications();
    });
}

document.getElementById('saveProfileBtn').addEventListener('click', updateProfile);
document.getElementById('profileAvatarTrigger').addEventListener('click', () => { document.getElementById('profileUploadInput').click(); });

document.getElementById('profileUploadInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if(!file) return;
    compressImage(file, 400, 400, base64 => {
        pendingAvatarBase64 = base64;
        document.getElementById('profileAvatarFallback').style.display = 'none';
        const img = document.getElementById('profileAvatarImg');
        img.src = pendingAvatarBase64;
        img.style.display = 'block';
    });
});

function updateProfile() {
    const btn = document.getElementById('saveProfileBtn');
    const bio = document.getElementById('editBio').value.trim();
    const color = document.getElementById('editAccentColor').value;
    
    let updates = {}; 
    if(bio) updates[`users/${currentUser}/bio`] = bio; 
    if(color) updates[`users/${currentUser}/color`] = color;
    if(pendingAvatarBase64) updates[`users/${currentUser}/avatar`] = pendingAvatarBase64;
    
    btn.classList.add('loading');
    btn.innerText = "Compiling...";
    
    update(ref(rtdb), updates).then(() => { 
        pendingAvatarBase64 = null;
        btn.classList.remove('loading');
        btn.innerText = "Compiled!";
        setTimeout(() => btn.innerText = "Compile Changes", 2000);
        loadApplicationState(); 
    });
}

function logout() { signOut(auth).then(() => { location.reload(); }); }

document.getElementById('createPostBtn').addEventListener('click', createPost);
document.getElementById('attachFeedMediaBtn').addEventListener('click', () => { document.getElementById('feedMediaInput').click(); });

document.getElementById('feedMediaInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if(!file) return;
    pendingPostMediaType = file.type.startsWith('video') ? 'video' : 'image';
    if (pendingPostMediaType === 'image') {
        compressImage(file, 1080, 1080, base64 => {
            pendingPostMedia = base64;
            document.getElementById('postMediaPreview').style.display = 'inline-block';
        });
    } else {
        const reader = new FileReader();
        reader.onload = function(event) {
            pendingPostMedia = event.target.result;
            document.getElementById('postMediaPreview').style.display = 'inline-block';
        };
        reader.readAsDataURL(file);
    }
});

function createPost() {
    const txt = document.getElementById('postInput').value.trim();
    if(!txt && !pendingPostMedia) return; 
    
    const btn = document.getElementById('createPostBtn');
    btn.classList.add('loading');
    btn.innerText = "Wait...";
    btn.setAttribute('disabled', 'true');
    
    const newPostRef = push(ref(rtdb, 'posts'));
    const postData = { id: newPostRef.key, user: currentUser, content: txt, media: pendingPostMedia || "", mediaType: pendingPostMediaType || "text", time: Date.now(), likes: 0 };

    set(newPostRef, postData).then(() => { 
        document.getElementById('postInput').value = ''; 
        document.getElementById('feedMediaInput').value = '';
        document.getElementById('postMediaPreview').style.display = 'none';
        pendingPostMedia = null; pendingPostMediaType = null;
        btn.classList.remove('loading');
        btn.innerText = "Transmit";
        btn.removeAttribute('disabled');
    }).catch(e => {
        alert("Upload failed. File might be too large.");
        btn.classList.remove('loading');
        btn.innerText = "Transmit";
        btn.removeAttribute('disabled');
    });
}

function syncFeed() {
    if (feedUnsubscribe) feedUnsubscribe();
    
    const feedQuery = query(ref(rtdb, 'posts'), orderByChild('time'), limitToLast(currentFeedLimit));
    
    feedUnsubscribe = onValue(feedQuery, postsSnapshot => {
        onValue(ref(rtdb, 'users'), usersSnapshot => {
            const feed = document.getElementById('postFeed'); 
            feed.innerHTML = '';
            
            let posts = []; 
            postsSnapshot.forEach(child => { posts.push({ id: child.key, ...child.val() }); }); 
            posts.sort((a, b) => (b.time || 0) - (a.time || 0));
            
            if(posts.length === 0) { 
                feed.innerHTML = `<div class="post"><div class="post-content" style="color:var(--text-muted); text-align:center;">Silence... Be the first to transmit.</div></div>`; 
                return; 
            }
            
            let userMap = usersSnapshot.val() || {};
            posts.forEach(p => {
                let div = document.createElement('div'); div.classList.add('post');
                const hasLiked = p.likedBy && p.likedBy[currentUser] === true;
                
                let mediaBlock = '';
                if (p.media) {
                    if (p.mediaType === 'video') mediaBlock = `<div style="margin-top: 14px; border-radius: 12px; overflow: hidden; background: #000;"><video src="${escapeHTML(p.media)}" controls style="width: 100%; max-height: 400px; display: block;"></video></div>`;
                    else mediaBlock = `<div style="margin-top: 14px; border-radius: 12px; overflow: hidden; background: #050507;"><img src="${escapeHTML(p.media)}" style="width: 100%; max-height: 400px; object-fit: contain; display: block;"></div>`;
                }

                let avatarHTML = (userMap[p.user] && userMap[p.user].avatar) ? `<img src="${escapeHTML(userMap[p.user].avatar)}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">` : (p.user ? p.user.charAt(0).toUpperCase() : '?');
                let timeString = p.time && typeof p.time === 'number' ? new Date(p.time).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) : "Just now";

                div.innerHTML = `
                    <div class="post-meta" onclick="openPublicProfile('${escapeHTML(p.user)}')">
                        <div class="post-avatar">${avatarHTML}</div>
                        <div><div style="font-weight:bold;">${escapeHTML(p.user)}</div><div style="font-size:11px; color:var(--text-muted);">${timeString}</div></div>
                    </div>
                    <div class="post-content">${escapeHTML(p.content)}</div>
                    ${mediaBlock}
                    <div class="post-actions">
                        <button class="action-link ${hasLiked ? 'liked' : ''} like-trigger">❤ ${p.likes || 0}</button>
                        <button class="action-link comment-trigger">💬 Reply</button>
                        ${p.user === currentUser ? `<button class="action-link delete-action">🗑</button>` : ''}
                    </div>
                    <div id="comments-${p.id}" class="comment-section"></div>
                `;
                
                let delBtn = div.querySelector('.delete-action'); if(delBtn) delBtn.addEventListener('click', () => remove(ref(rtdb, 'posts/' + p.id)));
                div.querySelector('.like-trigger').addEventListener('click', () => {
                    const likedRef = ref(rtdb, `posts/${p.id}/likedBy/${currentUser}`), countRef = ref(rtdb, `posts/${p.id}/likes`);
                    if (!hasLiked) { set(likedRef, true); set(countRef, (p.likes || 0) + 1); } else { remove(likedRef); set(countRef, Math.max(0, (p.likes || 0) - 1)); }
                });
                div.querySelector('.comment-trigger').addEventListener('click', () => {
                    const txt = prompt("Data transmission:");
                    if(txt && currentUser) push(ref(rtdb, `posts/${p.id}/comments`), { user: currentUser, text: txt, time: Date.now() });
                });

                if(p.comments) {
                    const cDiv = div.querySelector(`#comments-${p.id}`); cDiv.style.display = 'block';
                    Object.values(p.comments).forEach(c => {
                        cDiv.innerHTML += `<div class="comment"><b onclick="openPublicProfile('${escapeHTML(c.user)}')">${escapeHTML(c.user)}</b>${escapeHTML(c.text)}</div>`;
                    });
                }

                feed.appendChild(div);
            });

            if (posts.length >= currentFeedLimit) {
                const loadMoreBtn = document.createElement('button');
                loadMoreBtn.className = 'action-btn';
                loadMoreBtn.style.margin = '20px auto';
                loadMoreBtn.style.width = 'fit-content';
                loadMoreBtn.style.padding = '8px 24px';
                loadMoreBtn.innerText = 'Load Older Data';
                loadMoreBtn.onclick = () => { 
                    currentFeedLimit += 10; 
                    syncFeed(); 
                };
                feed.appendChild(loadMoreBtn);
            }
        });
    });
}

window.openPublicProfile = function(targetUser) {
    if(!targetUser) return;
    activePublicProfile = targetUser;
    
    document.getElementById('nxUsername').innerText = `@${targetUser}`;
    document.getElementById('nxAvatar').innerHTML = '';
    document.getElementById('nxBio').innerText = 'Scanning...';
    document.getElementById('nxRecentPosts').innerHTML = '';
    document.getElementById('publicProfilePanel').classList.add('sliding-active');
    
    get(ref(rtdb, 'users/' + targetUser)).then(snap => {
        if(snap.exists()) {
            let d = snap.val();
            document.getElementById('nxBio').innerText = d.bio || "No telemetry found.";
            if(d.avatar) { document.getElementById('nxAvatar').innerHTML = `<img src="${escapeHTML(d.avatar)}">`; } 
            else { document.getElementById('nxAvatar').innerText = targetUser.charAt(0).toUpperCase(); }
        }
    });

    onValue(ref(rtdb, `followers/${targetUser}`), snap => {
        const followers = snap.exists() ? Object.keys(snap.val()) : [];
        document.getElementById('nxStatNodes').innerText = followers.length;
        
        const btn = document.getElementById('nxConnectBtn');
        if(targetUser === currentUser) { btn.style.display = 'none'; } 
        else {
            btn.style.display = 'block';
            const isFollowing = followers.includes(currentUser);
            if(isFollowing) { btn.innerText = 'Linked'; btn.className = 'nx-btn nx-btn-connected'; } 
            else { btn.innerText = 'Establish Link'; btn.className = 'nx-btn nx-btn-connect'; }
            
            btn.onclick = () => {
                const targetRef = ref(rtdb, `followers/${targetUser}/${currentUser}`);
                const myRef = ref(rtdb, `following/${currentUser}/${targetUser}`);
                if(isFollowing) { remove(targetRef); remove(myRef); } 
                else { set(targetRef, true); set(myRef, true); }
            };
        }
    });

    document.getElementById('nxMessageBtn').onclick = () => {
        document.getElementById('publicProfilePanel').classList.remove('sliding-active');
        connectDMTunnel(targetUser);
    };

    onValue(ref(rtdb, 'posts'), snap => {
        const recentPosts = document.getElementById('nxRecentPosts');
        recentPosts.innerHTML = '';
        let postCount = 0; let likesAccumulated = 0; let userPosts = [];
        
        if(snap.exists()) {
            snap.forEach(child => {
                let p = child.val();
                if(p.user === targetUser) { userPosts.push(p); postCount++; likesAccumulated += (p.likes || 0); }
            });
        }
        
        document.getElementById('nxStatData').innerText = postCount;
        document.getElementById('nxStatTrust').innerText = postCount === 0 ? "0.0" : (likesAccumulated / postCount + (postCount * 0.1)).toFixed(1);
        
        userPosts.sort((a, b) => b.time - a.time).slice(0, 5).forEach(p => {
            recentPosts.innerHTML += `<div class="post" style="border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:12px;"><div style="font-size:11px; color:var(--text-muted); margin-bottom:8px;">${new Date(p.time).toLocaleString()}</div><div style="font-size:14px;">${escapeHTML(p.content)}</div></div>`;
        });
        if(userPosts.length === 0) recentPosts.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">No broadcast history.</div>';
    });

    onValue(ref(rtdb, 'hubs'), snap => {
        const hubList = document.getElementById('nxHubList'); hubList.innerHTML = ''; let found = false;
        if(snap.exists()) {
            snap.forEach(child => {
                let h = child.val();
                if(h.members && h.members[targetUser]) {
                    found = true;
                    hubList.innerHTML += `<div class="nx-hub-item"><span class="nx-hub-name">${escapeHTML(h.name)}</span><span class="nx-hub-tag">${escapeHTML(h.tag || 'SYS')}</span></div>`;
                }
            });
        }
        if(!found) hubList.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">No active hub connections.</div>';
    });
};

document.getElementById('createHubBtn').addEventListener('click', () => {
    const name = document.getElementById('subspaceName').value.trim();
    const desc = document.getElementById('subspaceDesc').value.trim();
    const tag = document.getElementById('subspaceType').value.trim().toUpperCase();
    if(!name || !currentUser) return;
    
    const btn = document.getElementById('createHubBtn'); btn.innerText = "Deploying...";
    const newHubRef = push(ref(rtdb, 'hubs'));
    set(newHubRef, { id: newHubRef.key, name, desc, tag, creator: currentUser, members: { [currentUser]: true }, timestamp: Date.now() }).then(() => {
        document.getElementById('subspaceName').value = ''; document.getElementById('subspaceDesc').value = ''; document.getElementById('subspaceType').value = '';
        btn.innerText = "Create Hub";
    });
});

function syncHubs() {
    onValue(ref(rtdb, 'hubs'), snap => {
        const container = document.getElementById('subspaceHub'); container.innerHTML = '';
        if(!snap.exists()) return;
        
        snap.forEach(child => {
            let h = child.val(); let memberCount = h.members ? Object.keys(h.members).length : 0;
            let div = document.createElement('div'); div.className = 'hub-item'; div.style.padding = '16px 24px';
            div.innerHTML = `
                <div class="hub-info">
                    <h3>${escapeHTML(h.name)}</h3>
                    <p>${escapeHTML(h.desc)}</p>
                    ${h.tag ? `<span class="hub-tag">${escapeHTML(h.tag)}</span>` : ''}
                </div>
                <button class="join-btn">Enter</button>
            `;
            div.querySelector('.join-btn').addEventListener('click', () => openHub(h.id, h.name, memberCount, h.members));
            container.appendChild(div);
        });
    });
}

function openHub(id, name, count, membersObj) {
    activeHubId = id; document.getElementById('activeHubName').innerText = name; document.getElementById('activeHubMembers').innerText = `${count} Nodes`;
    document.getElementById('hubViewPanel').classList.add('sliding-active');
    
    const joinBtn = document.getElementById('joinHubBtn');
    const isMember = membersObj && membersObj[currentUser];
    
    joinBtn.innerText = isMember ? "Disconnect" : "Join";
    joinBtn.style.background = isMember ? "transparent" : "var(--accent-blue)";
    joinBtn.onclick = () => { if(isMember) remove(ref(rtdb, `hubs/${id}/members/${currentUser}`)); else set(ref(rtdb, `hubs/${id}/members/${currentUser}`), true); };

    if(hubFeedListener) hubFeedListener();
    hubFeedListener = onValue(ref(rtdb, `hub_posts/${id}`), snap => {
        const feed = document.getElementById('hubPostFeed'); feed.innerHTML = ''; let posts = [];
        if(snap.exists()) { snap.forEach(c => posts.push({id: c.key, ...c.val()})); }
        posts.sort((a,b) => b.timestamp - a.timestamp);
        
        if(posts.length === 0) { feed.innerHTML = '<div style="text-align:center; padding:40px; color:var(--text-muted); font-size:14px; animation: popIn 0.4s ease;">Silence...</div>'; return; }
        
        posts.forEach(p => {
            let timeString = p.timestamp ? new Date(p.timestamp).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'}) : "Just now";
            let div = document.createElement('div'); div.className = 'post'; div.style.padding = '16px 0';
            div.innerHTML = `
                <div class="post-meta" style="margin-bottom:8px;" onclick="openPublicProfile('${escapeHTML(p.user)}')">
                    <div class="post-avatar" style="width:28px; height:28px;">${p.user.charAt(0).toUpperCase()}</div>
                    <div>
                        <div style="font-weight:bold; font-size:13px;">${escapeHTML(p.user)}</div>
                        <div style="font-size:10px; color:var(--text-muted);">${timeString}</div>
                    </div>
                </div>
                <div class="post-content" style="font-size:14px;">${escapeHTML(p.content)}</div>
            `;
            feed.appendChild(div);
        });
    });
}

document.getElementById('createHubPostBtn').addEventListener('click', () => {
    const txt = document.getElementById('hubPostInput').value.trim();
    if(!txt || !activeHubId) return;
    const btn = document.getElementById('createHubPostBtn'); btn.classList.add('loading'); btn.innerText = "Posting..."; btn.setAttribute('disabled', 'true');
    
    const newPostRef = push(ref(rtdb, `hub_posts/${activeHubId}`));
    set(newPostRef, { id: newPostRef.key, user: currentUser, content: txt, timestamp: Date.now() }).then(() => {
        document.getElementById('hubPostInput').value = '';
        btn.classList.remove('loading'); btn.innerText = "Post"; btn.removeAttribute('disabled');
    });
});

document.getElementById('startNewChatBtn').addEventListener('click', () => { const user = document.getElementById('newChatInput').value.trim().toLowerCase(); if(user) connectDMTunnel(user); });
document.getElementById('backToInboxBtn').addEventListener('click', () => { document.getElementById('dmChatPanel').classList.remove('sliding-active'); if(dmMessagesListener) dmMessagesListener(); if(typingListener) typingListener(); if(presenceListener) presenceListener(); activeDMTarget = null; activeTunnelId = null; resetReplyState(); });
document.getElementById('nukeChatBtn').addEventListener('click', () => { if(activeTunnelId) { remove(ref(rtdb, `dms/${activeTunnelId}`)).then(() => { document.getElementById('dmChatLog').innerHTML = '<div style="color:#22c55e; text-align:center; padding:20px; animation: popIn 0.3s ease forwards;">Tunnel wiped. Say Hi!</div>'; }); } });
document.getElementById('dmSendBtn').addEventListener('click', sendDM);
document.getElementById('cancelReplyBtn').addEventListener('click', resetReplyState);
document.getElementById('mediaPhotoBtn').addEventListener('click', () => { if(activeDMTarget) document.getElementById('dmPhotoFile').click(); });

document.getElementById('dmPhotoFile').addEventListener('change', (e) => { 
    const file = e.target.files[0]; if(!file || !activeDMTarget || !activeTunnelId) return; 
    compressImage(file, 800, 800, base64 => {
        push(ref(rtdb, `dms/${activeTunnelId}`), { sender: currentUser, receiver: activeDMTarget, message: base64, type: "image", timestamp: Date.now(), status: "sent" }); 
    });
    e.target.value = ''; 
});

const dmInputField = document.getElementById('dmMsgInput');
dmInputField.addEventListener('input', function() { const btn = document.getElementById('dmSendBtn'); if(this.value.trim().length > 0) { btn.style.display = 'block'; btn.removeAttribute('disabled'); } else { btn.style.display = 'none'; btn.setAttribute('disabled', 'true'); } });
dmInputField.addEventListener('keypress', function(e) { if(e.key === 'Enter') { e.preventDefault(); sendDM(); } });

function connectDMTunnel(targetUser, explicitTunnelId = null) {
    if(!targetUser || !currentUser || targetUser === currentUser) return;
    activeDMTarget = targetUser;
    activeTunnelId = explicitTunnelId || (currentUser < activeDMTarget ? `${currentUser}_${activeDMTarget}` : `${activeDMTarget}_${currentUser}`);

    document.getElementById('dmMsgInput').removeAttribute('disabled'); 
    document.getElementById('dmHeaderName').innerText = activeDMTarget;
    document.getElementById('dmStatus').innerText = "Connecting...";
    document.getElementById('activeChatAvatar').innerText = activeDMTarget.charAt(0).toUpperCase();
    document.getElementById('dmChatPanel').classList.add('sliding-active');
    
    if(dmMessagesListener) dmMessagesListener(); if(typingListener) typingListener(); if(presenceListener) presenceListener();
    
    presenceListener = onValue(ref(rtdb, `presence/${activeDMTarget}`), snap => { document.getElementById('dmStatus').innerText = snap.exists() ? "Active Node" : `Offline`; });
    typingListener = onValue(ref(rtdb, `typing/${activeTunnelId}/${activeDMTarget}`), snap => { document.getElementById('typingIndicator').innerText = (snap.exists() && snap.val() === true) ? `${activeDMTarget} is typing...` : ""; });

    dmMessagesListener = onValue(ref(rtdb, `dms/${activeTunnelId}`), dmSnapshot => {
        const log = document.getElementById('dmChatLog'); log.innerHTML = '';
        
        if(!dmSnapshot.exists()) { log.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-muted); font-size:13px; animation: popIn 0.3s ease forwards;">Secure tunnel established. Send data.</div>`; return; }

        try {
            let msgs = [];
            let statusUpdates = {}; 

            dmSnapshot.forEach(child => {
                let val = child.val();
                if(typeof val === 'object' && val !== null) {
                    msgs.push({ id: child.key, ...val });
                    if (val.sender !== currentUser && val.status !== 'seen') {
                        statusUpdates[`${child.key}/status`] = 'seen';
                    }
                }
                else msgs.push({ id: child.key, sender: "System", message: String(val) });
            });
            
            if (Object.keys(statusUpdates).length > 0) {
                update(ref(rtdb, `dms/${activeTunnelId}`), statusUpdates);
            }
            
            let lastTime = 0;
            msgs.forEach((m, index) => {
                let safeTimestamp = Number(m.timestamp) || 0;
                if (safeTimestamp && (safeTimestamp - lastTime > 3600000)) { let timeDiv = document.createElement('div'); timeDiv.className = 'time-divider'; timeDiv.innerText = new Date(safeTimestamp).toLocaleString([], {weekday: 'short', hour: '2-digit', minute:'2-digit'}); log.appendChild(timeDiv); }
                if(safeTimestamp) lastTime = safeTimestamp;

                let senderName = m.sender ? String(m.sender) : "Unknown"; let isMe = senderName === currentUser;
                let prev = index > 0 ? msgs[index - 1] : null; let next = index < msgs.length - 1 ? msgs[index + 1] : null;
                let prevSender = prev && prev.sender ? String(prev.sender) : null; let nextSender = next && next.sender ? String(next.sender) : null;

                let isFirst = !prev || prevSender !== senderName || (safeTimestamp && prev.timestamp && safeTimestamp - prev.timestamp > 300000);
                let isLast = !next || nextSender !== senderName || (next.timestamp && safeTimestamp && next.timestamp - safeTimestamp > 300000);

                let radiusClass = (isFirst && isLast) ? "single" : (isFirst && !isLast) ? "group-start" : (!isFirst && !isLast) ? "group-mid" : "group-end";

                let row = document.createElement('div'); row.className = `message-row ${isMe ? 'me' : 'them'} ${radiusClass}`; 
                let avatarHTML = !isMe ? `<div class="them-avatar" style="${isLast || isFirst ? 'visibility:visible;' : 'visibility:hidden;'}">${senderName.charAt(0).toUpperCase()}</div>` : '';

                let msgText = m.message ? String(m.message) : (m.text ? String(m.text) : "...");
                let bubble = document.createElement('div'); bubble.className = `dm-bubble ${isMe ? 'me' : 'them'}`; bubble.dataset.msgid = m.id; bubble.dataset.sender = senderName;
                
                let replyHTML = m.replyTo ? `<div class="replied-to-ref">↪ ${escapeHTML(m.replyTo)}</div>` : "";
                let contentHTML = m.type === "image" ? `<img src="${escapeHTML(msgText)}" class="dm-media-img">` : escapeHTML(msgText);
                let reactionHTML = m.reaction ? `<div class="reaction-badge">${escapeHTML(m.reaction)}</div>` : ""; 
                
                bubble.innerHTML = replyHTML + contentHTML + reactionHTML;
                row.innerHTML = avatarHTML; row.appendChild(bubble); log.appendChild(row);

                if (index === msgs.length - 1 && isMe && m.status === 'seen') { let seenDiv = document.createElement('div'); seenDiv.className = 'seen-status'; seenDiv.innerText = 'Seen'; log.appendChild(seenDiv); }
            });
            setTimeout(() => { const lastElement = log.lastElementChild; if(lastElement) lastElement.scrollIntoView({ block: 'end' }); }, 50);
        } catch (err) { log.innerHTML = `<div class="sys-error-msg"><b>Data Error:</b><br>${err.message}<br><br>Tap 'Wipe' above to fix.</div>`; }
    });
}

function sendDM() {
    const input = document.getElementById('dmMsgInput'); const msgText = input.value.trim();
    if(!msgText || !activeDMTarget || !activeTunnelId) return; 
    
    const log = document.getElementById('dmChatLog'); const tempId = 'opt_' + Date.now();
    log.insertAdjacentHTML('beforeend', `<div id="${tempId}" class="message-row me single"><div class="dm-bubble me" style="opacity: 0.5;">${escapeHTML(msgText)}</div></div>`);
    setTimeout(() => { log.scrollTop = log.scrollHeight + 1000; }, 10);
    
    let payload = { sender: currentUser, receiver: activeDMTarget, message: msgText, type: "text", timestamp: Date.now(), status: "sent" };
    if(replyingToText) payload.replyTo = replyingToText;
    
    input.value = ''; resetReplyState(); document.getElementById('dmSendBtn').style.display = 'none'; document.getElementById('dmSendBtn').setAttribute('disabled', 'true');
    push(ref(rtdb, `dms/${activeTunnelId}`), payload);
}

function syncDMHistoryList() {
    onValue(ref(rtdb, 'dms'), dmsSnapshot => {
        onValue(ref(rtdb, 'users'), usersSnapshot => {
            onValue(ref(rtdb, 'presence'), presenceSnapshot => {
                const container = document.getElementById('recent-chats-container'); container.innerHTML = '';
                if(!dmsSnapshot.exists() || !currentUser) return;
                let userMap = usersSnapshot.val() || {}, presenceMap = presenceSnapshot.val() || {}, chatList = [];
                
                dmsSnapshot.forEach(child => {
                    let participants = child.key.split('_');
                    if (participants.includes(currentUser)) {
                        let otherUser = participants.find(n => n !== currentUser);
                        if (otherUser) {
                            let msgs = [], unreadCount = 0; 
                            child.forEach(m => { if(typeof m.val() === 'object') { msgs.push(m.val()); if(m.val().sender !== currentUser && m.val().status !== 'seen') unreadCount++; } }); 
                            let lastMsg = msgs[msgs.length - 1] || {}; let msgText = lastMsg.message || lastMsg.text || ""; let previewText = lastMsg.type === 'text' ? msgText : `Data Package`;
                            chatList.push({ tunnelId: child.key, username: otherUser, avatar: (userMap[otherUser] && userMap[otherUser].avatar) ? userMap[otherUser].avatar : "", preview: previewText, isOnline: !!presenceMap[otherUser], timestamp: lastMsg.timestamp || 0, unread: unreadCount });
                        }
                    }
                });
                chatList.sort((a, b) => b.timestamp - a.timestamp);
                if(chatList.length === 0) return;
                chatList.forEach(chat => {
                    let safeUsername = chat.username || "Unknown";
                    let avatarHTML = chat.avatar ? `<img src="${escapeHTML(chat.avatar)}" class="chat-avatar">` : `<div class="chat-avatar">${safeUsername.charAt(0).toUpperCase()}</div>`;
                    let badgeHTML = chat.unread > 0 ? `<div class="unread-badge" style="display:block;">${chat.unread}</div>` : '';
                    let row = document.createElement('div'); row.className = 'chat-row';
                    row.innerHTML = `<div class="chat-avatar-container">${avatarHTML}<div class="online-dot" style="display: ${chat.isOnline ? 'block' : 'none'};"></div></div><div class="chat-details"><div><div class="chat-username">${escapeHTML(safeUsername)}</div><div class="chat-preview" style="${chat.unread > 0 ? 'font-weight:bold; color:var(--text);' : ''}">${escapeHTML(chat.preview)}</div></div>${badgeHTML}</div>`;
                    row.addEventListener('click', () => { connectDMTunnel(safeUsername, chat.tunnelId); }); 
                    container.appendChild(row);
                });
            });
        });
    });
}

let touchStartX = 0, currentTouchX = 0, isSwiping = false, pressTimer, lastTap = 0, activeBubble = null;
const logEl = document.getElementById('dmChatLog');

logEl.addEventListener('touchstart', e => {
    let bubble = e.target.closest('.dm-bubble'); if(!bubble) return;
    activeBubble = bubble; touchStartX = e.touches[0].clientX; isSwiping = false;
    pressTimer = setTimeout(() => {
        const tray = document.getElementById('reactionTray'); const rect = activeBubble.getBoundingClientRect();
        let trayX = Math.max(160, Math.min(window.innerWidth - 160, rect.left + (rect.width / 2)));
        tray.style.display = 'flex'; tray.style.left = trayX + 'px'; tray.style.top = (rect.top - 10) + 'px';
        tray.dataset.msgid = activeBubble.dataset.msgid; tray.dataset.sender = activeBubble.dataset.sender;
        document.getElementById('unsendMenuTrigger').style.display = (activeBubble.dataset.sender === currentUser) ? 'block' : 'none';
    }, 500);
}, {passive: true});

logEl.addEventListener('touchmove', e => {
    if(!activeBubble) return; currentTouchX = e.touches[0].clientX; let diff = currentTouchX - touchStartX;
    if(Math.abs(diff) > 10) { isSwiping = true; clearTimeout(pressTimer); }
    let row = activeBubble.parentElement;
    if (diff < 0 && activeBubble.classList.contains('me')) row.style.transform = `translateX(${Math.max(diff, -60)}px)`;
    else if (diff > 0 && activeBubble.classList.contains('them')) row.style.transform = `translateX(${Math.min(diff, 60)}px)`;
}, {passive: true});

logEl.addEventListener('touchend', e => {
    if(!activeBubble) return; clearTimeout(pressTimer);
    let row = activeBubble.parentElement; row.style.transform = 'translateX(0)';
    if (isSwiping && Math.abs(currentTouchX - touchStartX) > 40) { triggerReply(activeBubble.dataset.msgid, activeBubble.innerText, activeBubble.dataset.sender); } 
    else if (!isSwiping) {
        let currentTime = new Date().getTime(); let tapLength = currentTime - lastTap;
        if (tapLength < 300 && tapLength > 0 && activeTunnelId) {
            let overlay = activeBubble.querySelector('.heart-overlay');
            if(!overlay) { overlay = document.createElement('div'); overlay.className = 'heart-overlay'; overlay.innerText = '❤️'; activeBubble.appendChild(overlay); }
            overlay.style.display = 'block'; overlay.style.animation = 'none'; void overlay.offsetWidth; overlay.style.animation = 'heartBurst 0.6s ease-out forwards';
            update(ref(rtdb, `dms/${activeTunnelId}/${activeBubble.dataset.msgid}`), { reaction: "❤️" });
        }
        lastTap = currentTime;
    }
    activeBubble = null;
});

document.addEventListener('touchstart', (e) => { if(!e.target.closest('.reaction-tray') && !e.target.closest('.dm-bubble')) document.getElementById('reactionTray').style.display = 'none'; });

document.querySelectorAll('.reaction-emoji').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const tray = document.getElementById('reactionTray'); if(!activeTunnelId || !tray.dataset.msgid) return;
        if (e.target.id === "unsendMenuTrigger") { if(tray.dataset.sender === currentUser) remove(ref(rtdb, `dms/${activeTunnelId}/${tray.dataset.msgid}`)); } 
        else { update(ref(rtdb, `dms/${activeTunnelId}/${tray.dataset.msgid}`), { reaction: e.target.innerText }); }
        tray.style.display = 'none';
    });
});

function triggerReply(msgId, text, sender) {
    replyingToId = msgId; replyingToText = text;
    document.getElementById('replyTargetName').innerText = sender;
    document.getElementById('replyTargetText').innerText = String(text).substring(0, 40) + (String(text).length > 40 ? '...' : '');
    document.getElementById('replyPreviewBar').style.display = 'flex';
    document.getElementById('dmMsgInput').focus();
}
function resetReplyState() { replyingToId = null; replyingToText = ""; document.getElementById('replyPreviewBar').style.display = 'none'; }
