let globalChannels = [];
let currentFilter = 'All';
let searchQuery = '';
let videoElement = document.getElementById('video-player');
let shakaPlayer;
let channelQueue = [];
let renderInterval = null;

let activeUsername = localStorage.getItem('aravals_user') || null;
const socket = io();

async function initPlayer() {
    shaka.polyfill.installAll();
    if (shaka.Player.isBrowserSupported()) {
        shakaPlayer = new shaka.Player(videoElement);
    }
}

// 🔐 সেশন চেকআউট বুটস্ট্র্যাপার (রোল বেসড ভিউ কন্ট্রোলার)
async function checkCurrentSession() {
    if (activeUsername) {
        document.getElementById('user-display').innerText = `Profile: ${activeUsername}`;
        document.getElementById('auth-modal').style.display = 'none';
        document.getElementById('app-content').style.filter = 'none';
        document.getElementById('app-content').style.pointerEvents = 'auto';
        document.getElementById('change-pass-section').style.display = 'block';
        
        if (activeUsername === 'admin') {
            document.getElementById('admin-panel').style.display = 'block';
            document.querySelector('.input-box').style.display = 'flex'; 
            fetchAdminDashboard();
        } else {
            document.getElementById('admin-panel').style.display = 'none';
            document.querySelector('.input-box').style.display = 'none'; 
            fetchChannels();
        }
    } else {
        document.getElementById('auth-modal').style.display = 'flex';
    }
}

function toggleAuthMode() {
    let isLoginMode = document.getElementById('auth-title').innerText === "Account Login";
    isLoginMode = !isLoginMode;
    document.getElementById('auth-title').innerText = isLoginMode ? "Account Login" : "Create Account";
    document.getElementById('btn-auth').innerText = isLoginMode ? "Login" : "Sign Up";
    document.getElementById('auth-toggle-text').innerText = isLoginMode ? "Don't have an account? Signup here" : "Already have an account? Login here";
    document.getElementById('auth-error').style.display = 'none';
}

async function handleAuthSubmit() {
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const errorEl = document.getElementById('auth-error');
    const isLoginMode = document.getElementById('auth-title').innerText === "Account Login";

    if (!username || !password) {
        errorEl.innerText = "Please fill all fields.";
        errorEl.style.display = 'block';
        return;
    }

    const endpoint = isLoginMode ? '/api/auth/login' : '/api/auth/signup';

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (data.error) {
            errorEl.innerText = data.error;
            errorEl.style.display = 'block';
        } else {
            activeUsername = data.username;
            localStorage.setItem('aravals_user', activeUsername);
            
            document.getElementById('auth-username').value = "";
            document.getElementById('auth-password').value = "";
            await checkCurrentSession();
        }
    } catch (err) {
        errorEl.innerText = "Connection failed.";
        errorEl.style.display = 'block';
    }
}

async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    localStorage.removeItem('aravals_user');
    location.reload();
}

function togglePasswordBox() {
    const box = document.getElementById('password-box');
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
    document.getElementById('pass-msg').style.display = 'none';
}

async function submitNewPassword() {
    const oldPassword = document.getElementById('old-pass-input').value;
    const newPassword = document.getElementById('new-pass-input').value;
    const msgEl = document.getElementById('pass-msg');

    if (!oldPassword || !newPassword) {
        msgEl.innerText = "❌ Fields cannot be empty!";
        msgEl.style.color = "#ef4444";
        msgEl.style.display = "block";
        return;
    }

    try {
        const res = await fetch('/api/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPassword, newPassword })
        });
        const data = await res.json();

        if (data.error) {
            msgEl.innerText = "❌ " + data.error;
            msgEl.style.color = "#ef4444";
            msgEl.style.display = "block";
        } else {
            msgEl.innerText = "✅ Success! Updated.";
            msgEl.style.color = "#10b981";
            msgEl.style.display = "block";
            document.getElementById('old-pass-input').value = "";
            document.getElementById('new-pass-input').value = "";
            setTimeout(() => { togglePasswordBox(); }, 2000);
        }
    } catch (err) {
        msgEl.innerText = "❌ Network error.";
        msgEl.style.color = "#ef4444";
        msgEl.style.display = "block";
    }
}

// ================== 👑 ADMIN PANEL WORKER LOGIC ==================

let activeStreamMap = new Map();

async function fetchAdminDashboard() {
    try {
        const mRes = await fetch('/api/admin/overview');
        
        if (mRes.status === 403 || mRes.status === 401) {
            console.warn("Unauthorized admin query intercepted.");
            logout();
            return;
        }

        const contentType = mRes.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) return;

        const metrics = await mRes.json();
        
        // 🛠️ ফিক্সড লাইন: ব্যাকএন্ডের অল-লোয়ারকেস কীগুলোর সাথে হুবহু সিঙ্ক করা হলো
        document.getElementById('adm-total-users').innerText = metrics.totalusers;
        document.getElementById('adm-total-channels').innerText = metrics.totalchannels;

        const uRes = await fetch('/api/admin/users');
        if (uRes.ok) {
            const users = await uRes.json();
            renderAdminUserList(users);
        }
        
        fetchChannels();
    } catch (err) { console.error(err); }
}

function renderAdminUserList(users) {
    const listContainer = document.getElementById('admin-user-list');
    listContainer.innerHTML = '';
    if(users.length === 0) {
        listContainer.innerHTML = '<div style="color:#6b7280; padding:10px;">No registered clients found.</div>';
        return;
    }
    users.forEach(user => {
        const row = document.createElement('div');
        row.className = 'admin-row-item';
        row.innerHTML = `
            <div>
                <strong style="color: #38bdf8;">${user.username}</strong>
                <div style="font-size:10px; color:#6b7280; margin-top:2px;">Joined: ${new Date(user.created_at).toLocaleDateString()}</div>
            </div>
            <button onclick="deleteUserAccount(${user.id})" class="btn-kick">Delete User</button>
        `;
        listContainer.appendChild(row);
    });
}

async function deleteUserAccount(id) {
    if(!confirm("⚠️ Delete user account?")) return;
    try {
        const res = await fetch(`/api/admin/users/${id}`, { method: 'DELETE' });
        if(res.ok) fetchAdminDashboard();
    } catch (err) { console.error(err); }
}

function updateAdminLiveStreamUI() {
    const liveContainer = document.getElementById('admin-live-streams');
    liveContainer.innerHTML = '';
    document.getElementById('adm-active-streams').innerText = activeStreamMap.size;
    
    if(activeStreamMap.size === 0) {
        liveContainer.innerHTML = '<div style="color: #6b7280; padding:10px;">Waiting for activity...</div>';
        return;
    }
    
    activeStreamMap.forEach((channelName, username) => {
        const row = document.createElement('div');
        row.className = 'admin-row-item';
        row.style.borderLeft = "3px solid #10b981";
        row.innerHTML = `
            <div><span style="color:#10b981; font-weight:bold;">● Live</span> <strong>${username}</strong></div>
            <div style="color: #38bdf8; font-weight:600;">Watching: ${channelName}</div>
        `;
        liveContainer.appendChild(row);
    });
}

socket.on('admin-track-stream', (data) => {
    if (activeUsername === 'admin') {
        activeStreamMap.set(data.username, data.channelName);
        updateAdminLiveStreamUI();
    }
});

socket.on('user-kicked', (data) => {
    if(activeUsername === data.username) {
        alert('Session terminated.');
        logout();
    }
});

// ================== IPTV CORE LOGIC ==================

async function submitPlaylist() {
    const fileInput = document.getElementById('file-input');
    const textareaData = document.getElementById('playlist-input').value;
    let playlistText = "";
    if (fileInput.files.length > 0) {
        playlistText = await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.readAsText(fileInput.files[0]);
        });
    } else { playlistText = textareaData; }

    if (!playlistText || !playlistText.trim()) return alert('Empty data.');
    document.getElementById('sync-status').innerText = "Streaming injection processing...";
    document.getElementById('sync-status').style.color = "#f59e0b";

    const res = await fetch('/api/upload-playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playlistText })
    });
    if(res.status === 401) return logout();
    fileInput.value = ""; document.getElementById('playlist-input').value = "";
}

async function fetchChannels() {
    try {
        const response = await fetch(`/api/channels`);
        if (response.status === 401) return logout();
        const contentType = response.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) return;

        globalChannels = await response.json();
        updateCounter();
        renderFilterButtons();
        renderChannels(globalChannels);
    } catch (err) { console.error(err); }
}

function updateCounter() {
    const counter = document.getElementById('channel-counter');
    if (counter) counter.innerText = `Total Live Channels: ${globalChannels.length}`;
}

function renderFilterButtons() {
    const filterBar = document.getElementById('filter-bar');
    filterBar.innerHTML = `<button onclick="filterGroup('All')" id="btn-all" class="country-btn ${currentFilter === 'All' ? 'active' : ''}">All</button>`;
    const uniqueCountries = [...new Set(globalChannels.map(c => c.country))].sort();
    uniqueCountries.forEach(country => {
        const btn = document.createElement('button');
        btn.className = `country-btn ${currentFilter === country ? 'active' : ''}`;
        let emoji = '🌐 ';
        if (country === 'Bangladesh') emoji = '🇧🇩 ';
        if (country === 'India') emoji = '🇮🇳 ';
        if (country === 'Sports') emoji = '⚽ ';
        btn.innerText = `${emoji}${country}`;
        btn.onclick = () => filterGroup(country);
        filterBar.appendChild(btn);
    });
}

function renderChannels(channels) {
    const container = document.getElementById('channel-container');
    container.innerHTML = '';
    if(!channels || channels.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding:20px; color:#6b7280;">No channels online.</div>';
        return;
    }
    const fragment = document.createDocumentFragment();
    channels.forEach(channel => fragment.appendChild(createChannelCardElement(channel)));
    container.appendChild(fragment);
}

function createChannelCardElement(channel) {
    const card = document.createElement('div');
    card.className = "channel-card";
    card.id = `ch-${channel.id}`;
    const matchesFilter = (currentFilter === 'All' || channel.country === currentFilter);
    const matchesSearch = channel.name.toLowerCase().includes(searchQuery) || channel.country.toLowerCase().includes(searchQuery);
    card.style.display = (matchesFilter && matchesSearch) ? 'flex' : 'none';
    
    const deleteButtonHTML = (activeUsername === 'admin') 
        ? `<button onclick="deleteChannel(${channel.id})" style="background: none; border: none; color: #ef4444; font-weight: bold; cursor: pointer; padding: 5px; font-size:14px;">×</button>`
        : '';

    card.innerHTML = `
        <div class="channel-logo" style="flex-shrink: 0;" onclick="playStream(${JSON.stringify(channel).replace(/"/g, '&quot;')})">${channel.name.substring(0,2)}</div>
        <div style="flex-grow: 1; min-width: 0; padding-left: 10px;" onclick="playStream(${JSON.stringify(channel).replace(/"/g, '&quot;')})">
            <div style="font-size:14px; font-weight:bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${channel.name}</div>
            <div style="font-size:11px; color:#9ca3af; margin-top:2px;">${channel.country}</div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px; margin-left: auto;">
            <div style="width: 8px; height: 8px; background-color: #10b981; border-radius: 50%; box-shadow: 0 0 8px #10b981;"></div>
            ${deleteButtonHTML}
        </div>
    `;
    return card;
}

function startBatchRenderTimer() {
    if (renderInterval) return;
    renderInterval = setInterval(() => {
        if (channelQueue.length === 0) { clearInterval(renderInterval); renderInterval = null; return; }
        const container = document.getElementById('channel-container');
        if (container.innerHTML.includes('No channels online')) container.innerHTML = '';

        const fragment = document.createDocumentFragment();
        const batchSize = Math.min(channelQueue.length, 50);
        const batch = channelQueue.splice(0, batchSize);
        
        batch.forEach(channel => {
            if (channel.id) { globalChannels.push(channel); fragment.appendChild(createChannelCardElement(channel)); }
        });
        container.appendChild(fragment);
        updateCounter(); renderFilterButtons();
    }, 1200);
}

function handleSearch() {
    searchQuery = document.getElementById('search-input').value.toLowerCase().trim();
    globalChannels.forEach(channel => {
        const element = document.getElementById(`ch-${channel.id}`);
        if (element) {
            const matchesFilter = (currentFilter === 'All' || channel.country === currentFilter);
            const matchesSearch = channel.name.toLowerCase().includes(searchQuery) || channel.country.toLowerCase().includes(searchQuery);
            element.style.display = (matchesFilter && matchesSearch) ? 'flex' : 'none';
        }
    });
}

async function deleteChannel(id) {
    if(!confirm("Are you sure?")) return;
    const res = await fetch(`/api/channels/${id}`, { method: 'DELETE' });
    if(res.status === 401) return logout();
}

async function playStream(channel) {
    document.getElementById('playing-title').innerText = "Streaming: " + channel.name;
    socket.emit('user-started-streaming', { username: activeUsername, channelName: channel.name });
    try {
        await shakaPlayer.load(channel.url);
        videoElement.play();
    } catch (e) {
        videoElement.src = channel.url;
        videoElement.play();
    }
}

function filterGroup(country) {
    currentFilter = country;
    document.querySelectorAll('.country-btn').forEach(btn => btn.classList.remove('active'));
    const buttons = document.querySelectorAll('.country-btn');
    buttons.forEach(btn => { if(btn.innerText.includes(country)) btn.classList.add('active'); });
    if(country === 'All') document.getElementById('btn-all').classList.add('active');
    
    globalChannels.forEach(channel => {
        const element = document.getElementById(`ch-${channel.id}`);
        if (element) {
            const matchesFilter = (country === 'All' || channel.country === country);
            const matchesSearch = channel.name.toLowerCase().includes(searchQuery) || channel.country.toLowerCase().includes(searchQuery);
            element.style.display = (matchesFilter && matchesSearch) ? 'flex' : 'none';
        }
    });
}

socket.on('new-channel-added', (channel) => {
    if (!globalChannels.some(c => c.id === channel.id) && !channelQueue.some(c => c.id === channel.id)) {
        channelQueue.push(channel); startBatchRenderTimer();
    }
});

socket.on('channel-deleted', (data) => {
    globalChannels = globalChannels.filter(c => c.id !== data.id);
    channelQueue = channelQueue.filter(c => c.id !== data.id);
    updateCounter(); renderFilterButtons();
    const element = document.getElementById(`ch-${data.id}`);
    if (element) element.remove();
});

window.onload = () => { 
    initPlayer(); 
    checkCurrentSession(); 
};