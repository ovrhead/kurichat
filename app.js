// Initialize Socket.IO
const socket = io();

// State
let currentUser = null;
let allUsers = {};
let currentChatId = null;
let cropper = null;
let selectedAvatarBase64 = null;
let dmTargets = {}; // maps roomId -> targetUsername

// UI Elements
const viewLogin = document.getElementById('view-login');
const viewChatlist = document.getElementById('view-chatlist');
const viewChatroom = document.getElementById('view-chatroom');

// Auth UI - Tabs
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const formLogin = document.getElementById('form-login');
const formRegister = document.getElementById('form-register');

// Auth UI - Login
const inputUsername = document.getElementById('login-username');
const inputPin = document.getElementById('login-pin');
const btnLogin = document.getElementById('btn-login');
const loginError = document.getElementById('login-error');

// Auth UI - Register
const regUsername = document.getElementById('reg-username');
const regDisplayname = document.getElementById('reg-displayname');
const regPin = document.getElementById('reg-pin');
const btnRegister = document.getElementById('btn-register');
const registerError = document.getElementById('register-error');

// Chat UI
const chatListContainer = document.getElementById('chat-list-container');
const messageArea = document.getElementById('message-area');
const inputContent = document.getElementById('message-input');
const btnSend = document.getElementById('btn-send');
const btnAttach = document.getElementById('btn-attach');
const mediaInput = document.getElementById('media-input');
const btnMic = document.getElementById('btn-mic');
const btnBack = document.getElementById('btn-back');

// Tab Switching Logic
if (tabLogin && tabRegister) {
    tabLogin.onclick = () => {
        tabLogin.classList.add('active');
        tabRegister.classList.remove('active');
        formLogin.style.display = 'flex';
        formRegister.style.display = 'none';
        loginError.innerText = '';
    };
    tabRegister.onclick = () => {
        tabRegister.classList.add('active');
        tabLogin.classList.remove('active');
        formRegister.style.display = 'flex';
        formLogin.style.display = 'none';
        registerError.innerText = '';
    };
}

// --- Authentication Flow ---
function handleAuthSuccess(data, username, pin) {
    currentUser = data.user;
    allUsers = data.users;
    
    // Save for persistent mobile login
    localStorage.setItem('lg_user', JSON.stringify({ username, pin }));
    
    // Hide Login, show standard app
    viewLogin.classList.remove('active');
    viewChatlist.classList.add('active');
    renderChats();
    
    // Show desktop empty state on wide screens
    if(window.innerWidth >= 768) {
        const emptyState = document.getElementById('desktop-empty-state');
        if(emptyState) emptyState.classList.remove('hidden');
    }
    
    // Request push notification permission
    if('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
    
    // Initial Messages Load
    if(currentChatId) {
        renderMessages(data.messages);
    } else {
        // Keep a reference to messages for later
        window._allMessages = data.messages || [];
    }
}

async function attemptLogin(username, pin) {
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username, pin })
        });
        
        const data = await res.json();
        
        if (!res.ok) {
            loginError.innerText = data.error || "Login Failed";
            localStorage.removeItem('lg_user');
            return false;
        }

        handleAuthSuccess(data, username, pin);
        return true;

    } catch(err) {
        loginError.innerText = "Network Error connecting to server.";
        return false;
    }
}

async function attemptRegister(username, display_name, pin) {
    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username, display_name, pin })
        });
        
        const data = await res.json();
        
        if (!res.ok) {
            registerError.innerText = data.error || "Registration Failed";
            return false;
        }
        
        // If registration is successful, automatically log them in
        return await attemptLogin(username, pin);

    } catch(err) {
        registerError.innerText = "Network Error connecting to server.";
        return false;
    }
}

btnLogin.onclick = async () => {
    const username = inputUsername.value.trim();
    const pin = inputPin.value.trim();
    
    if (!username || pin.length !== 4) {
        loginError.innerText = "Please enter a username and a 4-digit PIN.";
        return;
    }
    
    btnLogin.disabled = true;
    btnLogin.innerText = "Connecting...";
    
    await attemptLogin(username, pin);
    
    btnLogin.disabled = false;
    btnLogin.innerText = "Log In";
};

btnRegister.onclick = async () => {
    const username = regUsername.value.trim();
    const displayname = regDisplayname.value.trim();
    const pin = regPin.value.trim();
    
    if (!username || !displayname || pin.length !== 4) {
        registerError.innerText = "Please fill all fields and use a 4-digit PIN.";
        return;
    }
    
    btnRegister.disabled = true;
    btnRegister.innerText = "Registering...";
    
    await attemptRegister(username, displayname, pin);
    
    btnRegister.disabled = false;
    btnRegister.innerText = "Register Account";
};

// --- Auto Login Check ---
const savedUser = localStorage.getItem('lg_user');
if (savedUser) {
    try {
        const { username, pin } = JSON.parse(savedUser);
        if (username && pin) {
            loginError.innerText = "Reconnecting automatically...";
            inputUsername.value = username;
            inputPin.value = pin;
            attemptLogin(username, pin);
        }
    } catch(e) {}
}

// --- Socket.IO Events ---
socket.on('user_joined', (user) => {
    allUsers[user.username] = user;
    if(currentUser) renderChats();
});

socket.on('receive_message', (msg) => {
    if(!window._allMessages) window._allMessages = [];
    window._allMessages.push(msg);
    
    // Re-render the current chat view if it matches the message's room
    if(currentChatId) {
        const msgRoom = msg.room || 'global';
        if (msgRoom === currentChatId || (currentChatId === 'global' && (!msg.room || msg.room === 'global'))) {
            if(currentChatId === 'global') {
                renderMessages(window._allMessages.filter(m => !m.room || m.room === 'global'));
            } else {
                renderMessages(window._allMessages.filter(m => m.room === currentChatId));
            }
        }
    }
    renderChats(); // Update preview
    
    // Push notification for messages from others
    if(msg.sender !== currentUser.username && Notification.permission === 'granted') {
        const senderUser = allUsers[msg.sender] || {};
        const senderName = senderUser.display_name || msg.sender;
        let body = msg.text || '';
        if(msg.media) body = msg.media.startsWith('data:audio') ? '🎤 Voice Message' : '📷 Photo';
        try {
            new Notification('Kurichat - ' + senderName, {
                body: body,
                icon: senderUser.avatar || undefined,
                tag: 'kurichat-' + msg.id
            });
        } catch(e) {}
    }
});


// Routing and List setup
// To keep it simple, we will have 1 "Global Network" chat, and direct messages
function renderChats() {
    chatListContainer.innerHTML = '';
    if(!window._allMessages) window._allMessages = [];
    
    // 1. Add Global Chat Room
    const globalMsgs = window._allMessages.filter(m => !m.room || m.room === 'global');
    const lastMsgGlobal = globalMsgs.length > 0 ? 
        globalMsgs[globalMsgs.length - 1] : {text: "No messages yet", time: ""};
        
    let previewTextG = lastMsgGlobal.text || 'Start chatting';
    if(lastMsgGlobal.media) previewTextG = lastMsgGlobal.media.startsWith('data:audio') ? '🎤 Voice Message' : '📷 Media';
    // Add sender display name for global chat
    if(lastMsgGlobal.sender && lastMsgGlobal.sender !== currentUser.username) {
        const dName = (allUsers[lastMsgGlobal.sender] && allUsers[lastMsgGlobal.sender].display_name) || lastMsgGlobal.sender;
        previewTextG = dName + ': ' + previewTextG;
    } else if (lastMsgGlobal.sender === currentUser.username) {
        previewTextG = 'You: ' + previewTextG;
    }

    const globalDiv = document.createElement('div');
    globalDiv.className = 'chat-item';
    globalDiv.innerHTML = `
        <div class="avatar" style="background:var(--tg-blue)">G</div>
        <div class="chat-info">
            <div class="chat-top">
                <span class="chat-name">Global Chat</span>
                <span class="chat-time">${lastMsgGlobal.time || ''}</span>
            </div>
            <div class="chat-preview">${previewTextG}</div>
        </div>
    `;
    globalDiv.onclick = () => openChat("global");
    chatListContainer.appendChild(globalDiv);
    
    // 2. Collect DM Rooms from messages
    const rooms = {};
    window._allMessages.forEach(m => {
        if(m.room && m.room.startsWith('dm_')) {
            if(!rooms[m.room]) rooms[m.room] = [];
            rooms[m.room].push(m);
        }
    });
    
    // Also add opened DM rooms that have no messages yet
    Object.keys(dmTargets).forEach(roomId => {
        if(!rooms[roomId]) rooms[roomId] = [];
    });
    
    // Render each DM room we are part of
    Object.keys(rooms).forEach(roomId => {
        const parts = roomId.replace('dm_', '').split('_');
        if(!parts.includes(currentUser.username)) return; // Not our room
        
        const targetUsername = dmTargets[roomId] || (parts[0] === currentUser.username ? parts[1] : parts[0]);
        const u = allUsers[targetUsername] || { username: targetUsername, display_name: targetUsername };
        
        const dmMsgs = rooms[roomId];
        const lastMsg = dmMsgs.length > 0 ? dmMsgs[dmMsgs.length - 1] : null;
        
        let previewText = 'Start chatting';
        if(lastMsg) {
            previewText = lastMsg.text || 'Start chatting';
            if(lastMsg.media) previewText = lastMsg.media.startsWith('data:audio') ? '🎤 Voice Message' : '📷 Media';
            if (lastMsg.sender === currentUser.username) {
                previewText = 'You: ' + previewText;
            }
        }
        
        const av = u.avatar ? `<img src="${u.avatar}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;">` : `<span style="font-size:20px">${(u.display_name||u.username).charAt(0).toUpperCase()}</span>`;
        
        const item = document.createElement('div');
        item.className = 'chat-item';
        item.style.cursor = 'pointer';
        item.innerHTML = `
            <div class="avatar" style="background:var(--tg-blue); border-radius:50%; overflow:hidden;">${av}</div>
            <div class="chat-info">
                <div class="chat-top">
                    <span class="chat-name">${u.display_name || u.username}</span>
                    <span class="chat-time">${lastMsg ? (lastMsg.time || '') : ''}</span>
                </div>
                <div class="chat-preview">${previewText}</div>
            </div>
        `;
        item.onclick = () => openChat(roomId, targetUsername);
        chatListContainer.appendChild(item);
    });
}

function openChat(chatId, targetUsername = null) {
    currentChatId = chatId;
    
    // Store DM target for later sidebar rendering
    if(targetUsername && chatId.startsWith('dm_')) {
        dmTargets[chatId] = targetUsername;
    }
    
    // If reopening a DM without targetUsername, look it up
    if(!targetUsername && chatId.startsWith('dm_')) {
        targetUsername = dmTargets[chatId];
        if(!targetUsername) {
            const parts = chatId.replace('dm_', '').split('_');
            targetUsername = parts[0] === currentUser.username ? parts[1] : parts[0];
        }
    }
    
    if (chatId === "global") {
        document.getElementById('current-chat-name').innerText = "Global Chat";
        document.getElementById('current-chat-username').innerText = "@global";
        document.getElementById('current-chat-avatar').innerHTML = "G";
        document.getElementById('current-chat-avatar').style.background = "var(--tg-blue)";
        
        renderMessages(window._allMessages.filter(m => !m.room || m.room === 'global'));
    } else if (targetUsername) {
        const u = allUsers[targetUsername] || { display_name: targetUsername, username: targetUsername };
        document.getElementById('current-chat-name').innerText = u.display_name || u.username;
        document.getElementById('current-chat-username').innerText = "@" + u.username;
        
        if (u.avatar) {
            document.getElementById('current-chat-avatar').innerHTML = `<img src="${u.avatar}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;">`;
        } else {
            document.getElementById('current-chat-avatar').innerHTML = `<span style="font-size:18px">${(u.display_name || u.username).charAt(0).toUpperCase()}</span>`;
            document.getElementById('current-chat-avatar').style.background = u.color || "var(--tg-blue)";
        }
        
        renderMessages(window._allMessages.filter(m => m.room === chatId));
    }
    
    // Hide the desktop empty state
    const emptyState = document.getElementById('desktop-empty-state');
    if(emptyState) emptyState.classList.add('hidden');
    
    // Show chatroom
    viewChatroom.classList.add('active');
    
    // On mobile, hide the chat list
    if(window.innerWidth < 768) {
        viewChatlist.classList.remove('active');
    }
}

function closeChat() {
    currentChatId = null;
    viewChatroom.classList.remove('active');
    viewChatlist.classList.add('active');
    
    // Show the desktop empty state again
    const emptyState = document.getElementById('desktop-empty-state');
    if(emptyState) emptyState.classList.remove('hidden');
    
    renderChats();
}

btnBack.onclick = closeChat;

function renderMessages(msgs) {
    messageArea.innerHTML = '';
    msgs.forEach(m => {
        const div = document.createElement('div');
        const isMe = m.sender === currentUser.username;
        
        // Wrapper for WhatsApp style avatar pairing
        div.style.display = "flex";
        div.style.alignItems = "flex-end";
        div.style.gap = "8px";
        div.style.marginBottom = "8px";
        if (isMe) {
            div.style.flexDirection = "row-reverse";
            div.style.alignSelf = "flex-end";
        } else {
            div.style.alignSelf = "flex-start";
        }
        
        div.style.maxWidth = "85%";

        let avatarHtml = '';
        if (!isMe) {
            const senderUser = allUsers[m.sender] || {};
            const dName = senderUser.display_name || m.sender;
            const av = senderUser.avatar ? `<img src="${senderUser.avatar}" style="width:100%; height:100%; object-fit:cover;">` : `<span style="font-size:14px">${dName.charAt(0).toUpperCase()}</span>`;
            avatarHtml = `<div style="width:30px; height:30px; border-radius:15px; background:var(--tg-blue); color:white; display:flex; align-items:center; justify-content:center; flex-shrink:0; overflow:hidden;">${av}</div>`;
        }

        let bubbleHtml = `<div class="msg ${isMe ? 'out' : 'in'}" style="margin-bottom:0; max-width:100%;">`;
        
        // Add sender name if not me inside bubble, WhatsApp style
        if(!isMe) {
            const senderUser = allUsers[m.sender] || {};
            const dName = senderUser.display_name || m.sender;
            bubbleHtml += `<div style="font-size:13px; color:var(--tg-blue); margin-bottom:4px; font-weight:600">${dName} <span style="font-size:10px; color:var(--text-muted); font-weight:normal;">@${m.sender}</span></div>`;
        }
        
        if (m.media) {
            if (m.media.startsWith('data:audio')) {
                bubbleHtml += `<audio controls src="${m.media}" style="max-width:200px; height:40px; margin-bottom:4px;"></audio><br>`;
            } else {
                bubbleHtml += `<img src="${m.media}" alt="Media" style="max-width: 100%; border-radius: 12px; margin-bottom: 4px;">`;
            }
        }
        
        bubbleHtml += `<div style="display:flex; flex-wrap:wrap; align-items:flex-end; gap:8px;">
            <div style="flex:1;">${m.text.replace(/\n/g, '<br>')}</div>
            <span class="msg-time" style="float:none; margin:0 0 -2px 0;">${m.time}</span>
        </div></div>`;

        div.innerHTML = avatarHtml + bubbleHtml;
        messageArea.appendChild(div);
    });
    scrollToBottom();
}

function scrollToBottom() {
    messageArea.scrollTop = messageArea.scrollHeight;
}

// Logic for Sending Messages
function getCurrentTime() {
    const now = new Date();
    return now.getHours() + ':' + String(now.getMinutes()).padStart(2, '0');
}

function sendMessage(mediaBase64 = null) {
    const text = inputContent.innerText.trim();
    if(!text && !mediaBase64) return;

    const msg = {
        id: Date.now(),
        text: text,
        sender: currentUser.username,
        time: getCurrentTime(),
        media: mediaBase64,
        room: currentChatId || "global"
    };

    // Emit to server
    socket.emit('send_message', msg);

    inputContent.innerText = '';
    toggleActionButtons();
}

btnSend.onclick = () => sendMessage();

// Trigger file input dialog when clicking the wrapper button
btnAttach.onclick = () => mediaInput.click();

// Image and Media Sending
mediaInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = function(event) {
            sendMessage(event.target.result); // Send complete base64 (image)
        };
        reader.readAsDataURL(file);
    }
    e.target.value = ''; // clean input
});

// Voice recording implementation
let mediaRecorder;
let audioChunks = [];

btnMic.onmousedown = btnMic.ontouchstart = async (e) => {
    e.preventDefault();
    btnMic.style.color = "red"; // Visual cue
    
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            
            mediaRecorder.ondataavailable = event => {
                audioChunks.push(event.data);
            };
            
            mediaRecorder.onstop = () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.readAsDataURL(audioBlob);
                reader.onloadend = () => {
                    const base64Audio = reader.result;
                    sendMessage(base64Audio); // Send the audio over socket
                };
            };
            
            mediaRecorder.start();
        } catch (err) {
            alert('Microphone permission required for voice messages!');
        }
    } else {
        alert("Audio recording isn't supported in this browser environment.");
    }
};

btnMic.onmouseup = btnMic.ontouchend = (e) => {
    e.preventDefault();
    btnMic.style.color = "var(--text-muted)"; // Reset visual cue
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(t => t.stop()); // kill the mic stream cleanly
    }
};

// Compose Button logic
const btnCompose = document.getElementById('btn-compose');
const viewCompose = document.getElementById('view-compose');
const btnCancelCompose = document.getElementById('btn-cancel-compose');
const composeSearchUsername = document.getElementById('compose-search-username');
const btnStartDm = document.getElementById('btn-start-dm');
const composeMsg = document.getElementById('compose-msg');

if (btnCompose && viewCompose) {
    btnCompose.addEventListener('click', (e) => {
        e.preventDefault();
        composeSearchUsername.value = '';
        composeMsg.innerText = '';
        viewCompose.classList.add('active');
    });

    btnCancelCompose.addEventListener('click', (e) => {
        e.preventDefault();
        viewCompose.classList.remove('active');
    });

    btnStartDm.onclick = () => {
        const targetUsername = composeSearchUsername.value.trim();
        if(!targetUsername) return;
        if(targetUsername === currentUser.username) {
            composeMsg.innerText = "You can't message yourself.";
            return;
        }
        
        // Ensure user exists on network
        if(!allUsers[targetUsername]) {
            composeMsg.innerText = "User not found on this network.";
            return;
        }
        
        viewCompose.classList.remove('active');
        
        // Create consistent room ID between the two users
        // e.g. "dm_alice_bob"
        const roomUsers = [currentUser.username, targetUsername].sort();
        const roomId = `dm_${roomUsers[0]}_${roomUsers[1]}`;
        
        openChat(roomId, targetUsername);
    };
}

// Dynamically swap Send vs Mic icons
function toggleActionButtons() {
    if (inputContent.innerText.trim().length > 0) {
        btnSend.style.display = 'flex';
        btnMic.style.display = 'none';
        btnAttach.style.display = 'none'; // Hide attach when typing to save space
    } else {
        btnSend.style.display = 'none';
        btnAttach.style.display = 'initial'; 
        btnMic.style.display = 'initial'; 
    }
}

inputContent.addEventListener('input', toggleActionButtons);

inputContent.addEventListener('keydown', (e) => {
    if(e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Clean up pasted content
inputContent.addEventListener('paste', (e) => {
    e.preventDefault();
    let text = (e.originalEvent || e).clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
});

// Settings UI
const btnSettingsToggle = document.getElementById('btn-settingsToggle');
const viewSettings = document.getElementById('view-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const btnLogout = document.getElementById('btn-logout');
const settingsDisplayname = document.getElementById('settings-displayname');
const btnSaveSettings = document.getElementById('btn-save-settings');
const settingsMsg = document.getElementById('settings-msg');

const settingsAvatarInput = document.getElementById('settings-avatar-input');
const viewCropper = document.getElementById('view-cropper');
const cropperImage = document.getElementById('cropper-image');
const btnCancelCrop = document.getElementById('btn-cancel-crop');
const btnSaveCrop = document.getElementById('btn-save-crop');
const settingsAvatarPreview = document.getElementById('settings-avatar-preview');

if(btnSettingsToggle && viewSettings) {
    btnSettingsToggle.onclick = () => {
        settingsDisplayname.value = currentUser.display_name || currentUser.username;
        
        // Show username handle
        const handleEl = document.getElementById('settings-username-handle');
        if(handleEl) handleEl.innerText = '@' + currentUser.username;
        
        if(currentUser.avatar) {
            settingsAvatarPreview.innerHTML = `<img src="${currentUser.avatar}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;">`;
        } else {
            settingsAvatarPreview.innerHTML = `<span style="font-size: 40px;">${(currentUser.display_name || currentUser.username).charAt(0).toUpperCase()}</span>`;
        }
        viewSettings.classList.add('active');
        settingsMsg.innerText = '';
    };

    btnCloseSettings.onclick = () => {
        viewSettings.classList.remove('active');
    };

    btnLogout.onclick = () => {
        localStorage.removeItem('lg_user');
        window.location.reload();
    };

    btnSaveSettings.onclick = async () => {
        const dName = settingsDisplayname.value.trim();
        if(!dName) return;
        
        btnSaveSettings.disabled = true;
        btnSaveSettings.innerText = "Saving...";
        
        try {
            const res = await fetch('/api/update_profile', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ 
                    username: currentUser.username, 
                    display_name: dName,
                    avatar: selectedAvatarBase64 
                })
            });
            const data = await res.json();
            if(res.ok) {
                currentUser = data.user;
                allUsers[currentUser.username] = currentUser;
                settingsMsg.innerText = "Profile saved! Changes applied.";
                settingsMsg.style.color = "var(--tg-blue)";
                renderChats();
                
                // Emitting profile change so others see it immediately
                socket.emit('update_profile', currentUser);
            } else {
                settingsMsg.innerText = data.error || "Error saving profile.";
                settingsMsg.style.color = "#ff3b30";
            }
        } catch(err) {
            settingsMsg.innerText = "Connection error.";
            settingsMsg.style.color = "#ff3b30";
        }
        
        btnSaveSettings.disabled = false;
        btnSaveSettings.innerText = "Save Profile";
    };

    // Cropping flow inside Settings
    if(settingsAvatarInput) {
        settingsAvatarInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                const url = URL.createObjectURL(file);
                cropperImage.src = url;
                viewCropper.classList.add('active');
                
                if (cropper) cropper.destroy();
                cropper = new Cropper(cropperImage, {
                    aspectRatio: 1,
                    viewMode: 1,
                    dragMode: 'move',
                    autoCropArea: 1,
                    restore: false,
                    guides: false,
                    center: false,
                    highlight: false,
                    cropBoxMovable: false,
                    cropBoxResizable: false,
                    toggleDragModeOnDblclick: false,
                });
            }
            e.target.value = ''; // Reset
        });

        btnCancelCrop.onclick = () => {
            viewCropper.classList.remove('active');
            if (cropper) cropper.destroy();
        };

        btnSaveCrop.onclick = () => {
            if (!cropper) return;
            const canvas = cropper.getCroppedCanvas({ width: 200, height: 200 });
            selectedAvatarBase64 = canvas.toDataURL('image/jpeg', 0.8);
            
            settingsAvatarPreview.innerHTML = `<img src="${selectedAvatarBase64}" style="width:100%; height:100%; object-fit:cover; border-radius:50%;">`;
            viewCropper.classList.remove('active');
            cropper.destroy();
        };
    }
}