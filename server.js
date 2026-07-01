require("dotenv").config();

const path    = require("path");
const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");
const jwt     = require("jsonwebtoken");
const cors    = require("cors");

const app    = express();
const server = http.createServer(app);

const JWT_SECRET       = process.env.JWT_SECRET;
const APP_URL          = process.env.APP_URL      || "*";
const APP_API_BASE_URL = process.env.APP_API_BASE_URL || "";
const PORT             = process.env.PORT         || 3000;
const CF_APP_ID    = process.env.CF_APP_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_BASE      = CF_APP_ID
    ? `https://rtc.live.cloudflare.com/v1/apps/${CF_APP_ID}`
    : null;

if (!JWT_SECRET) {
    console.error("FATAL: JWT_SECRET environment variable is not set.");
    process.exit(1);
}
if (!CF_BASE) {
    console.warn("[NavuliChat] WARNING: CF_APP_ID not set — Cloudflare Calls proxy disabled.");
}
if (!APP_API_BASE_URL) {
    console.warn("[NavuliChat] WARNING: APP_API_BASE_URL not set — block enforcement on calls disabled.");
}

// Accept wildcard "*" OR a specific origin.
// Note: wildcard + credentials requires a dynamic origin function, not the literal string "*".
const corsOrigin = (!APP_URL || APP_URL === "*")
    ? (origin, cb) => cb(null, true)   // allow every origin
    : APP_URL;                          // specific origin for production

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());

// Serve the built-in test client
app.use(express.static(path.join(__dirname, "public")));

const io = new Server(server, {
    cors: {
        origin: corsOrigin,
        methods: ["GET", "POST"],
        credentials: true,
    },
});

// userId (number) -> Set<socketId>
const onlineUsers = new Map();

// Grace-period timers: keeps a user "online" for 15 s after their last socket
// disconnects so brief network hiccups don't incorrectly show them as offline.
const offlineTimers = new Map();

// Pending incoming call buffer: if the callee is briefly offline when a call
// arrives, store it here so it's delivered when they reconnect (TTL: 30 s).
const pendingCalls = new Map(); // targetUserId -> { callerId, callerName, callerPhoto, callType, offer, expiresAt }

function storePendingCall(targetUserId, data) {
    pendingCalls.set(Number(targetUserId), { ...data, expiresAt: Date.now() + 30000 });
}
function clearPendingCall(userId) {
    pendingCalls.delete(Number(userId));
}
function getPendingCall(userId) {
    const c = pendingCalls.get(Number(userId));
    if (!c) return null;
    if (c.expiresAt < Date.now()) { pendingCalls.delete(Number(userId)); return null; }
    return c;
}

// Active call registry — server-side enforcement of one-call-per-user-per-device.
// Tracks users who are currently in (or setting up) a call, keyed by userId.
// Each entry: { peerId, callType, startedAt }
// Any tab/window belonging to the same userId shares this server-side state,
// so a user cannot start a second call from a new tab even though the new tab's
// JS callState is fresh.
const activeCallSessions = new Map();

function markInCall(userId, peerId, callType) {
    activeCallSessions.set(Number(userId), { peerId: Number(peerId), callType, startedAt: Date.now() });
}
function clearCallSession(userId) {
    activeCallSessions.delete(Number(userId));
}
function isInCall(userId) {
    return activeCallSessions.has(Number(userId));
}
// Only clears userId's session if their recorded peer matches expectedPeer.
// Prevents a stale or spoofed decline from clearing the wrong active call.
function clearCallSessionIfPeer(userId, expectedPeer) {
    const s = activeCallSessions.get(Number(userId));
    if (s && s.peerId === Number(expectedPeer)) activeCallSessions.delete(Number(userId));
}

// ------------------------------------------------------------------ Block check (asks CodeIgniter)

const blockCache = new Map(); // "a:b" -> { blocked, expiresAt }

async function isBlocked(a, b) {
    if (!APP_API_BASE_URL) return false; // fail-open if not configured
    const key = [Number(a), Number(b)].sort((x, y) => x - y).join(":");
    const hit = blockCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.blocked;

    try {
        const res = await fetch(`${APP_API_BASE_URL}/chat/internal/block-check`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Chat-Internal-Secret": JWT_SECRET },
            body: JSON.stringify({ user_a: a, user_b: b }),
        });
        const data = await res.json();
        const blocked = !!data.blocked;
        blockCache.set(key, { blocked, expiresAt: Date.now() + 5000 });
        return blocked;
    } catch (err) {
        console.warn(`[NavuliChat] block-check failed for ${key}: ${err.message}`);
        return false; // fail-open: a transient PHP outage shouldn't break all calling
    }
}

function addOnlineUser(userId, socketId) {
    if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
    onlineUsers.get(userId).add(socketId);
}

function removeOnlineUser(userId, socketId) {
    const sockets = onlineUsers.get(userId);
    if (!sockets) return;
    sockets.delete(socketId);
    if (sockets.size === 0) onlineUsers.delete(userId);
}

function isOnline(userId) {
    const sockets = onlineUsers.get(userId);
    return sockets ? sockets.size > 0 : false;
}

// ------------------------------------------------------------------ JWT auth middleware

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
        console.warn(`[NavuliChat] Auth rejected (${socket.id}): no token`);
        return next(new Error("No token provided"));
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        socket.userId = decoded.userId;
        next();
    } catch (err) {
        console.warn(`[NavuliChat] Auth rejected (${socket.id}): ${err.message}`);
        next(new Error("Invalid or expired token"));
    }
});

// ------------------------------------------------------------------ Connection handler

io.on("connection", (socket) => {
    const userId = socket.userId;

    addOnlineUser(userId, socket.id);
    socket.join(`user:${userId}`);

    // Cancel any pending "go offline" grace timer for this user
    if (offlineTimers.has(userId)) {
        clearTimeout(offlineTimers.get(userId));
        offlineTimers.delete(userId);
    }

    console.log(`[NavuliChat] User ${userId} connected (${socket.id})`);

    socket.broadcast.emit("user_status", { userId, status: "online" });

    // Deliver any buffered incoming call that arrived while this user was offline,
    // but only if the user is not already in an active call session.
    const pendingCall = getPendingCall(userId);
    if (pendingCall) {
        if (isInCall(userId)) {
            // User is already on a call — auto-decline the buffered call on their behalf.
            console.log(`[NavuliChat] Dropping buffered call for User ${userId} (already in call) — declining to caller ${pendingCall.callerId}`);
            clearPendingCall(userId);
            io.to(`user:${pendingCall.callerId}`).emit("call_declined", { reason: "busy" });
        } else {
            console.log(`[NavuliChat] Delivering buffered call to User ${userId} from User ${pendingCall.callerId}`);
            socket.emit("incoming_call", {
                callerId:       pendingCall.callerId,
                callerName:     pendingCall.callerName,
                callerPhoto:    pendingCall.callerPhoto,
                callType:       pendingCall.callType,
                offer:          pendingCall.offer,
                conversationId: pendingCall.conversationId || null,
            });
        }
    }

    // ---- Join a conversation room ----
    socket.on("join_conversation", (conversationId) => {
        if (conversationId) {
            socket.join(`conv:${conversationId}`);
            console.log(`[NavuliChat] User ${userId} joined conv:${conversationId}`);
        }
    });

    // ---- Leave a conversation room ----
    socket.on("leave_conversation", (conversationId) => {
        if (conversationId) socket.leave(`conv:${conversationId}`);
    });

    // ---- Broadcast new message to conversation participants ----
    socket.on("new_message", ({ conversationId, message, receiverUserId }) => {
        if (!conversationId || !message) return;

        console.log(`[NavuliChat] new_message conv:${conversationId} receiver:${receiverUserId}`);

        const payload = { conversationId, message };

        // Deliver directly to the receiver's personal room (always joined on connect).
        if (receiverUserId) {
            socket.to(`user:${receiverUserId}`).emit("message_received", payload);
        }

        // Also broadcast to the conversation room (group chats, multi-device, etc.)
        socket.to(`conv:${conversationId}`).emit("message_received", payload);
    });

    // ---- Typing indicator ----
    socket.on("typing", ({ conversationId, isTyping }) => {
        if (!conversationId) return;
        socket.to(`conv:${conversationId}`).emit("user_typing", {
            userId,
            conversationId,
            isTyping: !!isTyping,
        });
    });

    // ---- Message deleted (broadcast to conversation room) ----
    socket.on("message_deleted", ({ conversationId, messageId, scope }) => {
        if (!conversationId || !messageId) return;
        socket.to(`conv:${conversationId}`).emit("message_deleted", {
            messageId,
            scope,
            deletedBy: userId,
        });
    });

    // ---- Message reacted (broadcast to conversation room) ----
    socket.on("message_reacted", ({ conversationId, messageId, reactions }) => {
        if (!conversationId || !messageId) return;
        socket.to(`conv:${conversationId}`).emit("message_reacted", { messageId, reactions });
    });

    // ---- Mark messages as read ----
    socket.on("messages_read", ({ conversationId }) => {
        if (!conversationId) return;
        socket.to(`conv:${conversationId}`).emit("messages_read", { userId, conversationId });
    });

    // ---- Call signaling relay ----
    socket.on("call_request", async ({ targetUserId, conversationId, callType, offer, callerName, callerPhoto }) => {
        if (!targetUserId || !offer) return;

        // Reject if the CALLER is already in a call on another tab/window.
        if (isInCall(userId)) {
            console.log(`[NavuliChat] call_request  ${userId} → ${targetUserId} REJECTED: caller already in call`);
            socket.emit("call_already_in_call", {});
            return;
        }

        // Reject if the TARGET is already in a call — decline on their behalf so
        // none of their tabs (including new ones) ever receive the incoming_call event.
        if (isInCall(targetUserId)) {
            console.log(`[NavuliChat] call_request  ${userId} → ${targetUserId} REJECTED: target already in call`);
            socket.emit("call_declined", { reason: "busy" });
            return;
        }

        if (await isBlocked(userId, targetUserId)) {
            console.log(`[NavuliChat] call_request  ${userId} → ${targetUserId} BLOCKED`);
            socket.emit("call_blocked", {});
            return;
        }

        // Mark caller as occupied (calling) so any other tab is blocked immediately.
        markInCall(userId, targetUserId, callType || "voice");

        console.log(`[NavuliChat] call_request  ${userId} → ${targetUserId} (${callType}) conv:${conversationId}`);
        const payload = { callerId: userId, callerName, callerPhoto, callType, offer, conversationId: conversationId || null };
        socket.to(`user:${targetUserId}`).emit("incoming_call", payload);
        storePendingCall(targetUserId, payload);
    });

    socket.on("call_answer", ({ callerId, answer }) => {
        if (!callerId || !answer) return;
        console.log(`[NavuliChat] call_answer   ${userId} → ${callerId}`);
        clearPendingCall(userId);
        // Mark callee as occupied now that they have accepted.
        markInCall(userId, callerId, activeCallSessions.get(Number(callerId))?.callType || "voice");
        socket.to(`user:${callerId}`).emit("call_answered", { answer });
    });

    socket.on("call_decline", ({ callerId, reason }) => {
        if (!callerId) return;
        console.log(`[NavuliChat] call_decline  ${userId} → ${callerId}${reason ? "  reason=" + reason : ""}`);
        clearPendingCall(userId);
        // The caller's call didn't connect — release their session so they can call again.
        clearCallSessionIfPeer(callerId, userId);
        socket.to(`user:${callerId}`).emit("call_declined", { reason: reason || null });
    });

    socket.on("call_end", ({ targetUserId }) => {
        if (!targetUserId) return;
        console.log(`[NavuliChat] call_end      ${userId} → ${targetUserId}`);
        clearCallSession(userId);
        clearCallSession(targetUserId);
        socket.to(`user:${targetUserId}`).emit("call_ended", {});
    });

    socket.on("call_cancel", ({ targetUserId }) => {
        if (!targetUserId) return;
        console.log(`[NavuliChat] call_cancel   ${userId} → ${targetUserId}`);
        clearCallSession(userId);           // caller gave up — release their slot
        clearPendingCall(targetUserId);
        socket.to(`user:${targetUserId}`).emit("call_cancelled", {});
    });

    socket.on("ice_candidate", ({ targetUserId, candidate }) => {
        if (!targetUserId || !candidate) return;
        socket.to(`user:${targetUserId}`).emit("ice_candidate", { candidate });
    });

    // ---- Cloudflare Calls SFU signaling ----
    // Caller → callee: "I published my tracks to CF, here is my session + track info"
    socket.on("cf_call_offer", async ({ targetUserId, conversationId, callType, callerName, callerPhoto, callerSessionId, tracks }) => {
        if (!targetUserId || !callerSessionId) return;

        if (isInCall(userId)) {
            console.log(`[NavuliChat] cf_call_offer  ${userId} → ${targetUserId} REJECTED: caller already in call`);
            socket.emit("call_already_in_call", {});
            return;
        }

        if (isInCall(targetUserId)) {
            console.log(`[NavuliChat] cf_call_offer  ${userId} → ${targetUserId} REJECTED: target already in call`);
            socket.emit("call_declined", { reason: "busy" });
            return;
        }

        if (await isBlocked(userId, targetUserId)) {
            console.log(`[NavuliChat] cf_call_offer  ${userId} → ${targetUserId} BLOCKED`);
            socket.emit("call_blocked", {});
            return;
        }

        markInCall(userId, targetUserId, callType || "voice");

        console.log(`[NavuliChat] cf_call_offer  ${userId} → ${targetUserId} (${callType})`);
        const payload = { callerId: userId, callerName, callerPhoto, callType, conversationId: conversationId || null, callerSessionId, tracks };
        socket.to(`user:${targetUserId}`).emit("cf_incoming_call", payload);
        storePendingCall(targetUserId, payload);
    });

    // Callee → caller: "I published my tracks to CF, here is my session + track info"
    socket.on("cf_call_answer", ({ callerId, calleeSessionId, tracks }) => {
        if (!callerId || !calleeSessionId) return;
        console.log(`[NavuliChat] cf_call_answer ${userId} → ${callerId}`);
        clearPendingCall(userId);
        markInCall(userId, callerId, activeCallSessions.get(Number(callerId))?.callType || "voice");
        socket.to(`user:${callerId}`).emit("cf_call_answered", { calleeSessionId, tracks });
    });

    // Either peer → other: "I added new tracks to my CF session, please pull them"
    socket.on("cf_tracks_pull", ({ targetUserId, sessionId, tracks }) => {
        if (!targetUserId || !sessionId) return;
        socket.to(`user:${targetUserId}`).emit("cf_tracks_pull", { fromUserId: userId, sessionId, tracks });
    });

    // ---- Online status query ----
    socket.on("check_online", (userIds, callback) => {
        if (typeof callback !== "function") return;
        const result = {};
        (Array.isArray(userIds) ? userIds : []).forEach((id) => {
            result[id] = isOnline(Number(id));
        });
        callback(result);
    });

    // ---- Disconnect ----
    socket.on("disconnect", () => {
        removeOnlineUser(userId, socket.id);
        console.log(`[NavuliChat] User ${userId} disconnected (${socket.id})`);
        if (!isOnline(userId)) {
            // If the user was in an active call, end it for their peer and release both slots.
            const callSession = activeCallSessions.get(Number(userId));
            if (callSession) {
                console.log(`[NavuliChat] User ${userId} disconnected during call with ${callSession.peerId} — ending call`);
                clearCallSession(userId);
                clearCallSession(callSession.peerId);
                io.to(`user:${callSession.peerId}`).emit("call_ended", {});
            }

            // 15-second grace period before broadcasting offline.
            // If the user reconnects within this window they stay "online".
            const timer = setTimeout(() => {
                offlineTimers.delete(userId);
                if (!isOnline(userId)) {
                    socket.broadcast.emit("user_status", { userId, status: "offline" });
                }
            }, 15000);
            offlineTimers.set(userId, timer);
        }
    });
});

// ------------------------------------------------------------------ Cloudflare Calls proxy
// Browsers call these endpoints; the CF API token stays on the server.
// All endpoints require a valid JWT in the Authorization: Bearer header.

function requireJwt(req, res, next) {
    const header = req.headers.authorization || "";
    const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
        req.jwtPayload = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: "Invalid or expired token" });
    }
}

async function cfFetch(path, method, body) {
    const res = await fetch(`${CF_BASE}${path}`, {
        method,
        headers: {
            Authorization:  `Bearer ${CF_API_TOKEN}`,
            "Content-Type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
}

if (CF_BASE) {
    // Create a new Cloudflare Calls session
    app.post("/cf-calls/sessions/new", requireJwt, async (req, res) => {
        const { ok, status, data } = await cfFetch("/sessions/new", "POST", {});
        res.status(ok ? 200 : status).json(data);
    });

    // Push local tracks to CF / pull remote tracks into this session
    app.post("/cf-calls/sessions/:sessionId/tracks/new", requireJwt, async (req, res) => {
        const { ok, status, data } = await cfFetch(
            `/sessions/${req.params.sessionId}/tracks/new`, "POST", req.body,
        );
        res.status(ok ? 200 : status).json(data);
    });

    // Renegotiate after adding remote tracks (CF returns a new SDP answer)
    app.put("/cf-calls/sessions/:sessionId/renegotiate", requireJwt, async (req, res) => {
        const { ok, status, data } = await cfFetch(
            `/sessions/${req.params.sessionId}/renegotiate`, "PUT", req.body,
        );
        res.status(ok ? 200 : status).json(data);
    });

    // Close specific tracks
    app.put("/cf-calls/sessions/:sessionId/tracks/close", requireJwt, async (req, res) => {
        const { ok, status, data } = await cfFetch(
            `/sessions/${req.params.sessionId}/tracks/close`, "PUT", req.body,
        );
        res.status(ok ? 200 : status).json(data);
    });

    console.log(`[NavuliChat] Cloudflare Calls proxy enabled (App: ${CF_APP_ID})`);
}

// ------------------------------------------------------------------ REST endpoints

app.get("/ping", (_req, res) => {
    res.json({ message: "pong" });
});

app.get("/health", (_req, res) => {
    res.json({
        status:      "ok",
        connections: io.engine.clientsCount,
        onlineUsers: onlineUsers.size,
        uptime:      process.uptime(),
        cfCalls:     CF_BASE ? "enabled" : "disabled",
    });
});

// Dev-only token endpoint — lets the test client generate JWTs without PHP
app.post("/dev-token", (req, res) => {
    const userId = parseInt(req.body?.userId, 10);
    if (!userId || userId < 1) {
        return res.status(400).json({ error: "userId (positive integer) required" });
    }
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: "24h" });
    res.json({ token });
});

// ------------------------------------------------------------------ Start

server.listen(PORT, () => {
    console.log(`[NavuliChat] Socket.IO server running on port ${PORT}`);
    console.log(`[NavuliChat] Test client: http://localhost:${PORT}`);
});
