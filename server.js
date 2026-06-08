const express = require('express');
const mysql = require('mysql2/promise');
const { exec } = require('child_process');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcrypt');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 5000;

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));

app.use(session({
    secret: 'iptv_secret_key_9876',
    resave: true,
    saveUninitialized: true,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'sabbir', 
    database: 'iptv_db',
    waitForConnections: true,
    connectionLimit: 15,
    queueLimit: 0
});

function isLinkAliveAsync(url, referer = null) {
    return new Promise((resolve) => {
        let curlCommand = `curl -I -s --connect-timeout 2 -A "VLC/3.0.18 LibVLC/3.0.18" "${url}"`;
        if (referer) curlCommand += ` -e "${referer}"`;
        exec(curlCommand, (error, stdout) => {
            if (error) return resolve(false);
            if (stdout.includes('HTTP/1.1 200') || stdout.includes('HTTP/2 200') || stdout.includes('HTTP/1.1 3')) {
                resolve(true);
            } else {
                resolve(false);
            }
        });
    });
}

function detectCountry(channelInfo, url) {
    const infoLower = channelInfo.toLowerCase();
    const sportsRegex = /(sports|sport|ten\s*\d|cricket|football|t\s*sports|starsports|sony\s*s)/i;
    if (sportsRegex.test(infoLower)) return 'Sports';
    if (infoLower.includes('.bd@') || infoLower.includes('bangladesh') || url.includes('aynaott.com') || infoLower.includes('somoy')) return 'Bangladesh';
    if (infoLower.includes('.in@') || infoLower.includes('india')) return 'India';
    return 'International';
}

// 🕒 🔄 ১০ মিনিটের ব্যাকগ্রাউন্ড ক্রন জব অটো-চেকার
cron.schedule('*/10 * * * *', async () => {
    console.log("⏱️ Running 10-Minute Channel Link Validation Engine...");
    try {
        const [rows] = await pool.query('SELECT id, name, url, referer, country, status FROM channels');
        for (const channel of rows) {
            const alive = await isLinkAliveAsync(channel.url, channel.referer);
            
            if (!alive && channel.status === 'active') {
                await pool.query('UPDATE channels SET status = "deactive" WHERE id = ?', [channel.id]);
                io.emit('channel-deleted', { id: channel.id });
                console.log(`❌ Channel [${channel.name}] went down. Set to deactive.`);
            } 
            else if (alive && channel.status === 'deactive') {
                await pool.query('UPDATE channels SET status = "active" WHERE id = ?', [channel.id]);
                io.emit('new-channel-added', { 
                    id: channel.id, 
                    name: channel.name, 
                    logo: "", 
                    url: channel.url, 
                    referer: channel.referer, 
                    country: channel.country, 
                    userSession: 'admin' 
                });
                console.log(`🚀 Channel [${channel.name}] is back online! Auto-recovered.`);
            }
        }
    } catch (err) { console.error("Cron Error:", err.message); }
});

// ================= AUTHENTICATION APIs =================

app.post('/api/auth/signup', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
    try {
        const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existing.length > 0) return res.status(400).json({ error: 'Username already exists.' });

        const hashedPassword = await bcrypt.hash(password, 10);
        const [result] = await pool.query('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword]);

        req.session.user = { id: result.insertId, username: username.toLowerCase().trim() };
        res.json({ success: true, username: username.toLowerCase().trim() });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const cleanUser = username.toLowerCase().trim();
    try {
        const [users] = await pool.query('SELECT * FROM users WHERE username = ?', [cleanUser]);
        if (users.length === 0) return res.status(400).json({ error: 'User not found.' });

        const user = users[0];
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(400).json({ error: 'Incorrect password.' });

        req.session.user = { id: user.id, username: cleanUser };
        res.json({ success: true, username: cleanUser });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized. Please login first.' });
}

app.post('/api/auth/change-password', isAuthenticated, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const username = req.session.user.username; 
    if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Both fields required.' });

    try {
        const [users] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
        if (users.length === 0) return res.status(400).json({ error: 'User session invalid.' });

        const user = users[0];
        const match = await bcrypt.compare(oldPassword, user.password);
        if (!match) return res.status(400).json({ error: 'Current password does not match.' });

        const newHashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = ? WHERE username = ?', [newHashedPassword, username]);

        res.json({ success: true, message: 'Password updated successfully!' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

function isAdmin(req, res, next) {
    if (req.session && req.session.user && req.session.user.username === 'admin') {
        return next();
    }
    res.status(403).json({ error: 'Access denied. Authorized admins only.' });
}

// ================= 👑 ADMIN PANEL APIs =================

app.get('/api/admin/overview', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [[userCount]] = await pool.query('SELECT COUNT(*) as total FROM users WHERE username != "admin"');
        const [[channelCount]] = await pool.query('SELECT COUNT(*) as total FROM channels WHERE user_session = "admin" AND status = "active"');
        res.json({ totalusers: userCount.total || 0, totalchannels: channelCount.total || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/users', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, username, created_at FROM users WHERE username != "admin"');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/users/:id', isAuthenticated, isAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const [userRow] = await pool.query('SELECT username FROM users WHERE id = ?', [id]);
        if (userRow.length === 0) return res.status(404).json({ error: 'User not found.' });
        const targetUser = userRow[0].username;

        await pool.query('DELETE FROM users WHERE id = ?', [id]);
        io.emit('user-kicked', { username: targetUser }); 
        res.json({ success: true, message: 'User destroyed successfully.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================= IPTV CORE APIs =================

app.post('/api/upload-playlist', isAuthenticated, async (req, res) => {
    const userSession = req.session.user.username;
    if (userSession !== 'admin') {
        return res.status(403).json({ error: 'Access denied. Only admin can inject channels.' });
    }

    const { playlistText } = req.body;
    if (!playlistText) return res.status(400).json({ error: 'Invalid data.' });
    res.json({ message: 'Processing started' });

    try {
        const lines = playlistText.split(/\r?\n/);
        let currentChannelName = '';
        let currentVlcOpt = '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#EXTINF:')) {
                const nameMatch = trimmed.match(/,(.+)$/);
                currentChannelName = nameMatch ? nameMatch[1].trim() : '';
            } 
            else if (trimmed.startsWith('#EXTVLCOPT:')) {
                currentVlcOpt = trimmed;
            } 
            else if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
                const url = trimmed;
                
                if (!currentChannelName || !url || url.includes('example.com')) {
                    currentChannelName = ''; currentVlcOpt = '';
                    continue;
                }

                const [duplicate] = await pool.query('SELECT id FROM channels WHERE name = ? AND user_session = "admin"', [currentChannelName]);
                
                if (duplicate.length === 0) {
                    let referer = null;
                    if (currentVlcOpt && currentVlcOpt.includes('http-referrer=')) {
                        referer = currentVlcOpt.split('http-referrer=')[1];
                    }
                    const country = detectCountry(currentChannelName, url);

                    const alive = await isLinkAliveAsync(url, referer);
                    if (alive) {
                        const [result] = await pool.query(
                            'INSERT INTO channels (name, logo, url, referer, country, user_session, status) VALUES (?, "", ?, ?, ?, "admin", "active")', 
                            [currentChannelName, url, referer, country]
                        );
                        io.emit('new-channel-added', { id: result.insertId, name: currentChannelName, logo: "", url, referer, country, userSession: 'admin' });
                    }
                }
                currentChannelName = ''; currentVlcOpt = '';
            }
        }
    } catch (err) { console.error("Upload Error:", err.message); }
});

app.get('/api/channels', isAuthenticated, async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT id, name, logo, url, referer, country FROM channels WHERE user_session = "admin" AND status = "active"');
        res.json(Array.isArray(rows) ? rows : []);
    } catch (err) { res.json([]); }
});

// ❌ 👑 অ্যাডমিন হার্ড ডিলিট
app.delete('/api/channels/:id', isAuthenticated, async (req, res) => {
    const { id } = req.params;
    if (req.session.user.username !== 'admin') return res.status(403).json({ error: 'Access denied.' });
    try {
        await pool.query('DELETE FROM channels WHERE id = ?', [id]);
        io.emit('channel-deleted', { id: parseInt(id) });
        res.json({ success: true, message: 'Permanently wiped.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

io.on('connection', (socket) => {
    socket.on('user-started-streaming', (data) => {
        io.emit('admin-track-stream', data);
    });
});

server.listen(PORT, () => {
    console.log(`🚀 NextGen IPTV App Running at http://localhost:${PORT}`);
});