// session.js
import admin from "firebase-admin";

if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");
const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL  // ← RTDB URL required
  });
}

const db = admin.firestore();
const usersCollection = db.collection("users");

// ── RTDB refs ──────────────────────────────────────────────────────────────
const rtdb = admin.database();
const gameInvitesRef = rtdb.ref("gameInvites"); // gameInvites moved from Firestore → RTDB
const presenceRef    = rtdb.ref("presence");    // lastSeen moved from Firestore → RTDB

const FRIEND_LIMIT      = 100;
const ONLINE_THRESHOLD  = 12 * 1000; // ping toutes les 10s + 2s marge
const GAME_INVITE_TTL   = 12 * 1000; // 12s (10s display + 2s margin)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Credentials", true);
  res.setHeader("Access-Control-Allow-Origin", allowedOrigin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") { res.status(200).end(); return; }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed." });
  if (allowedOrigin && req.headers.origin !== allowedOrigin) return res.status(403).json({ error: "Forbidden." });

  const { action, ...payload } = req.body;
  if (!action) return res.status(400).json({ error: "Action required." });

  try {
    switch (action) {
      case "get-session":              return await handleGetSession(payload, res);
      case "set-username":             return await handleSetUsername(payload, res);
      case "check-username":           return await handleCheckUsername(payload, res);
      case "ping":                     return await handlePing(payload, res);
      case "search-users":             return await handleSearchUsers(payload, res);
      case "send-friend-request":      return await handleSendFriendRequest(payload, res);
      case "accept-friend-request":    return await handleAcceptFriendRequest(payload, res);
      case "reject-friend-request":    return await handleRejectFriendRequest(payload, res);
      case "cancel-friend-request":    return await handleCancelFriendRequest(payload, res);
      case "remove-friend":            return await handleRemoveFriend(payload, res);
      case "get-friends":              return await handleGetFriends(payload, res);
      case "get-friend-requests":      return await handleGetFriendRequests(payload, res);
      case "get-sent-requests":        return await handleGetSentRequests(payload, res);
      // ── Game Invites (RTDB) ──
      case "send-game-invite":         return await handleSendGameInvite(payload, res);
      case "check-game-invite":        return await handleCheckGameInvite(payload, res);
      case "accept-game-invite":       return await handleAcceptGameInvite(payload, res);
      case "decline-game-invite":      return await handleDeclineGameInvite(payload, res);
      case "cancel-game-invite":       return await handleCancelGameInvite(payload, res);
      case "check-game-invite-status": return await handleCheckGameInviteStatus(payload, res);
      case "update-room-ready":        return await handleUpdateRoomReady(payload, res);
      case "update-room-settings":     return await handleUpdateRoomSettings(payload, res);
      // ── Room Chat (RTDB) ──
      case "send-chat-message":        return await handleSendChatMessage(payload, res);
      case "get-chat-messages":        return await handleGetChatMessages(payload, res);
      // ── Fanorona Game ──
      case "start-fanorona-game":      return await handleStartFanoronaGame(payload, res);
      case "get-fanorona-game":        return await handleGetFanoronaGame(payload, res);
      default: return res.status(400).json({ error: "Invalid action." });
    }
  } catch (err) {
    console.error(`SESSION ERROR [${action}]:`, err);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Lire un nœud RTDB une fois → retourne null si inexistant */
async function rtdbGet(ref) {
  const snap = await ref.once("value");
  return snap.exists() ? snap.val() : null;
}

/**
 * Lire le lastSeen de plusieurs UIDs depuis RTDB en parallèle.
 * Retourne un Map uid → lastSeen (number, 0 si absent).
 */
async function getLastSeenBatch(uids) {
  const entries = await Promise.all(
    uids.map(async uid => {
      const val = await rtdbGet(presenceRef.child(uid).child("lastSeen"));
      return [uid, val || 0];
    })
  );
  return new Map(entries);
}

// ── Existing handlers ──────────────────────────────────────────────────────

async function handleGetSession(body, res) {
  const { uid } = body;
  if (!uid) return res.status(400).json({ error: "UID is required." });
  const userDoc = await usersCollection.doc(uid).get();
  if (!userDoc.exists) return res.status(404).json({ error: "User not found." });

  // lastSeen → RTDB (plus de write Firestore ici)
  await presenceRef.child(uid).update({ lastSeen: Date.now() });

  const userData = userDoc.data();
  return res.status(200).json({
    success: true,
    user: {
      uid:       userData.uid,
      email:     userData.email,
      username:  userData.username || "",
      createdAt: userData.createdAt
    }
  });
}

async function handlePing(body, res) {
  const { uid } = body;
  if (!uid) return res.status(400).json({ error: "UID is required." });

  // lastSeen → RTDB uniquement (économise 1 write Firestore par ping)
  await presenceRef.child(uid).update({ lastSeen: Date.now() });
  return res.status(200).json({ success: true });
}

async function handleSetUsername(body, res) {
  const { uid, username } = body;
  if (!uid) return res.status(400).json({ error: "UID is required." });
  if (!username || username.length < 3 || username.length > 20)
    return res.status(400).json({ error: "Username must be between 3 and 20 characters." });
  if (!/^[a-zA-Z0-9_]+$/.test(username))
    return res.status(400).json({ error: "Username can only contain letters, numbers, and underscores." });
  const existing = await usersCollection.where("username", "==", username).limit(1).get();
  if (!existing.empty && existing.docs[0].id !== uid)
    return res.status(400).json({ error: "This username is already taken." });
  await usersCollection.doc(uid).update({ username, usernameLower: username.toLowerCase(), updatedAt: Date.now() });
  const updated = await usersCollection.doc(uid).get();
  const userData = updated.data();
  return res.status(200).json({
    success: true,
    user: { uid: userData.uid, email: userData.email, username: userData.username }
  });
}

async function handleCheckUsername(body, res) {
  const { username } = body;
  if (!username || username.length < 3 || username.length > 20)
    return res.status(400).json({ error: "Invalid username length." });
  const existing = await usersCollection.where("username", "==", username).limit(1).get();
  return res.status(200).json({ success: true, available: existing.empty });
}

async function handleSearchUsers(body, res) {
  const { uid, query } = body;
  if (!uid) return res.status(400).json({ error: "UID is required." });
  if (!query || query.trim().length < 3)
    return res.status(400).json({ error: "Search query must be at least 3 characters." });
  const q      = query.trim();
  const qLower = q.toLowerCase();
  const currentDoc = await usersCollection.doc(uid).get();
  if (!currentDoc.exists) return res.status(404).json({ error: "User not found." });
  const currentData    = currentDoc.data();
  const friends        = currentData.friends || [];
  const sentRequests   = currentData.sentRequests || [];
  const receivedRequests = currentData.friendRequests || [];
  const currentTotal   = friends.length + sentRequests.length;
  const seenIds = new Set();
  const users   = [];

  // Lire lastSeen depuis RTDB en batch pour les résultats de recherche
  function addDoc(doc) {
    if (!doc || !doc.exists) return;
    if (doc.id === uid) return;
    if (seenIds.has(doc.id)) return;
    const data = doc.data();
    if (!data.username) return;
    seenIds.add(doc.id);
    let relation = "none";
    if (friends.includes(doc.id))          relation = "friend";
    else if (sentRequests.includes(doc.id)) relation = "pending_sent";
    else if (receivedRequests.includes(doc.id)) relation = "pending_received";
    const targetFriends = data.friends || [];
    const targetTotal   = targetFriends.length + (data.friendRequests || []).length;
    const targetFull    = targetTotal >= FRIEND_LIMIT;
    users.push({ uid: doc.id, username: data.username, relation, targetFull });
  }

  const searches = [
    usersCollection
      .where("usernameLower", ">=", qLower)
      .where("usernameLower", "<=", qLower + "\uf8ff")
      .limit(20)
      .get()
  ];
  const isUid = /^\d{9}$/.test(q);
  if (isUid) searches.push(usersCollection.doc(q).get());
  const results = await Promise.all(searches);
  results[0].docs.forEach(addDoc);
  if (isUid && results[1]) addDoc(results[1]);
  return res.status(200).json({ success: true, users, currentTotal, friendLimit: FRIEND_LIMIT });
}

async function handleSendFriendRequest(body, res) {
  const { uid, toUid } = body;
  if (!uid || !toUid) return res.status(400).json({ error: "Both UIDs are required." });
  if (uid === toUid) return res.status(400).json({ error: "You cannot send a friend request to yourself." });
  const [senderDoc, receiverDoc] = await Promise.all([
    usersCollection.doc(uid).get(),
    usersCollection.doc(toUid).get()
  ]);
  if (!senderDoc.exists)   return res.status(404).json({ error: "Sender not found." });
  if (!receiverDoc.exists) return res.status(404).json({ error: "User not found." });
  const senderData   = senderDoc.data();
  const receiverData = receiverDoc.data();
  const senderFriends  = senderData.friends || [];
  const senderSent     = senderData.sentRequests || [];
  if (senderFriends.length + senderSent.length >= FRIEND_LIMIT)
    return res.status(400).json({ error: `You have reached the maximum of ${FRIEND_LIMIT} friends and pending requests.` });
  const receiverFriends   = receiverData.friends || [];
  const receiverReceived  = receiverData.friendRequests || [];
  if (receiverFriends.length + receiverReceived.length >= FRIEND_LIMIT)
    return res.status(400).json({ error: "This player's friend list is full." });
  if (senderFriends.includes(toUid))
    return res.status(400).json({ error: "You are already friends with this user." });
  if (senderSent.includes(toUid))
    return res.status(400).json({ error: "A friend request has already been sent to this user." });
  if ((senderData.friendRequests || []).includes(toUid))
    return res.status(400).json({ error: "This user has already sent you a friend request. Accept it instead." });
  const batch = db.batch();
  batch.update(senderDoc.ref, { sentRequests: admin.firestore.FieldValue.arrayUnion(toUid) });
  batch.update(receiverDoc.ref, {
    friendRequests: admin.firestore.FieldValue.arrayUnion(uid),
    [`friendRequestTimes.${uid}`]: Date.now()
  });
  await batch.commit();
  const updatedSender = await usersCollection.doc(uid).get();
  const sd = updatedSender.data();
  return res.status(200).json({
    success: true,
    friendCount:  (sd.friends || []).length,
    currentTotal: (sd.friends || []).length + (sd.sentRequests || []).length
  });
}

async function handleAcceptFriendRequest(body, res) {
  const { uid, fromUid } = body;
  if (!uid || !fromUid) return res.status(400).json({ error: "Both UIDs are required." });
  const [accepterDoc, senderDoc] = await Promise.all([
    usersCollection.doc(uid).get(),
    usersCollection.doc(fromUid).get()
  ]);
  if (!accepterDoc.exists) return res.status(404).json({ error: "User not found." });
  if (!senderDoc.exists)   return res.status(404).json({ error: "Requesting user not found." });
  const accepterData = accepterDoc.data();
  if (!(accepterData.friendRequests || []).includes(fromUid))
    return res.status(400).json({ error: "No pending friend request from this user." });
  const batch = db.batch();
  batch.update(accepterDoc.ref, {
    friends: admin.firestore.FieldValue.arrayUnion(fromUid),
    friendRequests: admin.firestore.FieldValue.arrayRemove(fromUid),
    [`friendRequestTimes.${fromUid}`]: admin.firestore.FieldValue.delete()
  });
  batch.update(senderDoc.ref, {
    friends: admin.firestore.FieldValue.arrayUnion(uid),
    sentRequests: admin.firestore.FieldValue.arrayRemove(uid)
  });
  await batch.commit();
  const updatedAccepter = await usersCollection.doc(uid).get();
  const ad = updatedAccepter.data();
  return res.status(200).json({
    success: true,
    friendCount:  (ad.friends || []).length,
    currentTotal: (ad.friends || []).length + (ad.sentRequests || []).length
  });
}

async function handleRejectFriendRequest(body, res) {
  const { uid, fromUid } = body;
  if (!uid || !fromUid) return res.status(400).json({ error: "Both UIDs are required." });
  const [rejecterDoc, senderDoc] = await Promise.all([
    usersCollection.doc(uid).get(),
    usersCollection.doc(fromUid).get()
  ]);
  if (!rejecterDoc.exists) return res.status(404).json({ error: "User not found." });
  if (!senderDoc.exists)   return res.status(404).json({ error: "Requesting user not found." });
  const batch = db.batch();
  batch.update(rejecterDoc.ref, {
    friendRequests: admin.firestore.FieldValue.arrayRemove(fromUid),
    [`friendRequestTimes.${fromUid}`]: admin.firestore.FieldValue.delete()
  });
  batch.update(senderDoc.ref, { sentRequests: admin.firestore.FieldValue.arrayRemove(uid) });
  await batch.commit();
  return res.status(200).json({ success: true });
}

async function handleCancelFriendRequest(body, res) {
  const { uid, toUid } = body;
  if (!uid || !toUid) return res.status(400).json({ error: "Both UIDs are required." });
  const [senderDoc, receiverDoc] = await Promise.all([
    usersCollection.doc(uid).get(),
    usersCollection.doc(toUid).get()
  ]);
  if (!senderDoc.exists)   return res.status(404).json({ error: "User not found." });
  if (!receiverDoc.exists) return res.status(404).json({ error: "Target user not found." });
  const batch = db.batch();
  batch.update(senderDoc.ref,   { sentRequests: admin.firestore.FieldValue.arrayRemove(toUid) });
  batch.update(receiverDoc.ref, {
    friendRequests: admin.firestore.FieldValue.arrayRemove(uid),
    [`friendRequestTimes.${uid}`]: admin.firestore.FieldValue.delete()
  });
  await batch.commit();
  const updatedSender = await usersCollection.doc(uid).get();
  const sd = updatedSender.data();
  return res.status(200).json({
    success: true,
    friendCount:  (sd.friends || []).length,
    currentTotal: (sd.friends || []).length + (sd.sentRequests || []).length
  });
}

async function handleRemoveFriend(body, res) {
  const { uid, friendUid } = body;
  if (!uid || !friendUid) return res.status(400).json({ error: "Both UIDs are required." });
  const [userDoc, friendDoc] = await Promise.all([
    usersCollection.doc(uid).get(),
    usersCollection.doc(friendUid).get()
  ]);
  if (!userDoc.exists)   return res.status(404).json({ error: "User not found." });
  if (!friendDoc.exists) return res.status(404).json({ error: "Friend not found." });
  const batch = db.batch();
  batch.update(userDoc.ref,   { friends: admin.firestore.FieldValue.arrayRemove(friendUid) });
  batch.update(friendDoc.ref, { friends: admin.firestore.FieldValue.arrayRemove(uid) });
  await batch.commit();
  const updatedUser = await usersCollection.doc(uid).get();
  const ud = updatedUser.data();
  return res.status(200).json({
    success: true,
    friendCount:  (ud.friends || []).length,
    currentTotal: (ud.friends || []).length + (ud.sentRequests || []).length
  });
}

async function handleGetFriends(body, res) {
  const { uid } = body;
  if (!uid) return res.status(400).json({ error: "UID is required." });
  const userDoc = await usersCollection.doc(uid).get();
  if (!userDoc.exists) return res.status(404).json({ error: "User not found." });
  const userData    = userDoc.data();
  const friendUids  = userData.friends || [];
  const currentTotal = friendUids.length + (userData.sentRequests || []).length;

  if (friendUids.length === 0)
    return res.status(200).json({ success: true, friends: [], friendCount: 0, currentTotal, friendLimit: FRIEND_LIMIT });

  // 1) Lire les profils Firestore (username)
  const chunks = [];
  for (let i = 0; i < friendUids.length; i += 10) chunks.push(friendUids.slice(i, i + 10));
  const profiles = new Map();
  for (const chunk of chunks) {
    const snap = await usersCollection
      .where(admin.firestore.FieldPath.documentId(), "in", chunk)
      .get();
    snap.docs.forEach(doc => profiles.set(doc.id, doc.data()));
  }

  // 2) Lire lastSeen depuis RTDB en parallèle
  const lastSeenMap = await getLastSeenBatch(friendUids);

  const now     = Date.now();
  const friends = friendUids
    .filter(fuid => profiles.has(fuid))
    .map(fuid => {
      const d        = profiles.get(fuid);
      const lastSeen = lastSeenMap.get(fuid) || 0;
      const online   = (now - lastSeen) < ONLINE_THRESHOLD;
      return { uid: fuid, username: d.username || fuid, online, lastSeen };
    });

  friends.sort((a, b) => {
    if (a.online && !b.online) return -1;
    if (!a.online && b.online)  return  1;
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });

  return res.status(200).json({
    success: true,
    friends,
    friendCount:  friendUids.length,
    currentTotal,
    friendLimit: FRIEND_LIMIT
  });
}

async function handleGetFriendRequests(body, res) {
  const { uid } = body;
  if (!uid) return res.status(400).json({ error: "UID is required." });
  const userDoc = await usersCollection.doc(uid).get();
  if (!userDoc.exists) return res.status(404).json({ error: "User not found." });
  const userData    = userDoc.data();
  const requestUids = userData.friendRequests || [];
  const requestTimes = userData.friendRequestTimes || {};
  if (requestUids.length === 0) return res.status(200).json({ success: true, requests: [] });
  const chunks = [];
  for (let i = 0; i < requestUids.length; i += 10) chunks.push(requestUids.slice(i, i + 10));
  const requests = [];
  for (const chunk of chunks) {
    const snap = await usersCollection
      .where(admin.firestore.FieldPath.documentId(), "in", chunk)
      .get();
    snap.docs.forEach(doc => {
      requests.push({
        uid:         doc.id,
        username:    doc.data().username || doc.id,
        requestedAt: requestTimes[doc.id] || 0
      });
    });
  }
  requests.sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0));
  return res.status(200).json({ success: true, requests });
}

async function handleGetSentRequests(body, res) {
  const { uid } = body;
  if (!uid) return res.status(400).json({ error: "UID is required." });
  const userDoc = await usersCollection.doc(uid).get();
  if (!userDoc.exists) return res.status(404).json({ error: "User not found." });
  const sentUids = userDoc.data().sentRequests || [];
  if (sentUids.length === 0)
    return res.status(200).json({ success: true, sent: [], sentCount: 0 });
  const chunks = [];
  for (let i = 0; i < sentUids.length; i += 10) chunks.push(sentUids.slice(i, i + 10));
  const sent = [];
  for (const chunk of chunks) {
    const snap = await usersCollection
      .where(admin.firestore.FieldPath.documentId(), "in", chunk)
      .get();
    snap.docs.forEach(doc => {
      sent.push({ uid: doc.id, username: doc.data().username || doc.id });
    });
  }
  return res.status(200).json({ success: true, sent, sentCount: sentUids.length });
}

// ── Game Invite handlers (Realtime Database) ───────────────────────────────

/**
 * send-game-invite
 * Body: { uid, toUid, game, color, minutes }
 * Crée gameInvites/{inviteId} dans RTDB avec statut "pending"
 */
async function handleSendGameInvite(body, res) {
  const { uid, toUid, game, color, minutes } = body;
  if (!uid || !toUid) return res.status(400).json({ error: "Both UIDs are required." });
  if (!game)          return res.status(400).json({ error: "Game type is required." });

  const [senderDoc, receiverDoc] = await Promise.all([
    usersCollection.doc(uid).get(),
    usersCollection.doc(toUid).get()
  ]);
  if (!senderDoc.exists)   return res.status(404).json({ error: "Sender not found." });
  if (!receiverDoc.exists) return res.status(404).json({ error: "Receiver not found." });

  const senderUsername   = senderDoc.data().username   || uid;
  const receiverUsername = receiverDoc.data().username || toUid;

  // Annuler toute invitation pending existante du même sender vers le même receiver
  const existingSnap = await gameInvitesRef
    .orderByChild("fromUid")
    .equalTo(uid)
    .once("value");

  if (existingSnap.exists()) {
    const updates = {};
    existingSnap.forEach(child => {
      const data = child.val();
      if (data.toUid === toUid && data.status === "pending") {
        updates[`${child.key}/status`] = "cancelled";
      }
    });
    if (Object.keys(updates).length > 0) await gameInvitesRef.update(updates);
  }

  const newInviteRef = gameInvitesRef.push();
  const inviteId     = newInviteRef.key;
  const now          = Date.now();

  await newInviteRef.set({
    inviteId,
    fromUid:          uid,
    fromUsername:     senderUsername,
    toUid,
    toUsername:       receiverUsername,
    game,
    color:            color   || "green",
    minutes:          minutes || 5,
    status:           "pending",  // pending | accepted | declined | cancelled | expired
    receiverReady:    false,      // ← false à la création; le receiver met true immédiatement à l'entrée
    createdAt:        now,
    expiresAt:        now + GAME_INVITE_TTL
  });

  return res.status(200).json({ success: true, inviteId });
}

/**
 * check-game-invite
 * Body: { uid }
 * Retourne la dernière invitation "pending" non expirée destinée à cet utilisateur
 */
async function handleCheckGameInvite(body, res) {
  const { uid } = body;
  if (!uid) return res.status(400).json({ error: "UID is required." });

  const now  = Date.now();
  const snap = await gameInvitesRef
    .orderByChild("toUid")
    .equalTo(uid)
    .once("value");

  if (!snap.exists()) return res.status(200).json({ success: true, invite: null });

  const docs = [];
  snap.forEach(child => {
    const data = child.val();
    if (data.status === "pending") {
      docs.push({ key: child.key, data: { ...data, inviteId: child.key } });
    }
  });

  if (docs.length === 0) return res.status(200).json({ success: true, invite: null });

  // Trier par createdAt desc
  docs.sort((a, b) => (b.data.createdAt || 0) - (a.data.createdAt || 0));

  let validInvite = null;
  const expiredUpdates = {};
  for (const { key, data } of docs) {
    if (data.expiresAt < now) {
      expiredUpdates[`${key}/status`] = "expired";
    } else {
      if (!validInvite) validInvite = data;
    }
  }

  if (Object.keys(expiredUpdates).length > 0) {
    gameInvitesRef.update(expiredUpdates).catch(() => {});
  }

  return res.status(200).json({ success: true, invite: validInvite });
}

/**
 * accept-game-invite
 * Body: { uid, inviteId }
 * Met le statut à "accepted" ET receiverReady à true immédiatement
 * → corrige le bug "Opponent not ready" affiché côté sender au premier polling
 */
async function handleAcceptGameInvite(body, res) {
  const { uid, inviteId } = body;
  if (!uid || !inviteId) return res.status(400).json({ error: "UID and inviteId are required." });

  const inviteRef = gameInvitesRef.child(inviteId);
  const invite    = await rtdbGet(inviteRef);

  if (!invite) return res.status(404).json({ error: "Invitation not found." });
  if (invite.toUid !== uid) return res.status(403).json({ error: "Not authorized." });
  if (invite.status !== "pending") return res.status(400).json({ error: "Invitation is no longer valid." });
  if (invite.expiresAt < Date.now()) {
    await inviteRef.update({ status: "expired" });
    return res.status(400).json({ error: "Invitation has expired." });
  }

  // FIX BUG "Opponent not ready":
  // On met receiverReady: true en même temps qu'accepted
  // → le sender verra toujours ready=true dès le 1er polling après l'acceptation
  await inviteRef.update({
    status:        "accepted",
    acceptedAt:    Date.now(),
    receiverReady: true   // ← clé du fix: évite le flash "Opponent not ready"
  });

  return res.status(200).json({
    success:          true,
    game:             invite.game,
    color:            invite.color,
    minutes:          invite.minutes,
    senderUid:        invite.fromUid,
    senderUsername:   invite.fromUsername,
    receiverUid:      invite.toUid,
    receiverUsername: invite.toUsername
  });
}

/**
 * decline-game-invite
 * Body: { uid, inviteId }
 */
async function handleDeclineGameInvite(body, res) {
  const { uid, inviteId } = body;
  if (!uid || !inviteId) return res.status(400).json({ error: "UID and inviteId are required." });

  const inviteRef = gameInvitesRef.child(inviteId);
  const invite    = await rtdbGet(inviteRef);

  if (!invite) return res.status(404).json({ error: "Invitation not found." });
  if (invite.toUid !== uid) return res.status(403).json({ error: "Not authorized." });

  await inviteRef.update({ status: "declined", declinedAt: Date.now() });
  return res.status(200).json({ success: true });
}

/**
 * cancel-game-invite
 * Body: { uid, inviteId }
 * Utilisé par l'expéditeur pour annuler (countdown écoulé ou retour)
 */
async function handleCancelGameInvite(body, res) {
  const { uid, inviteId } = body;
  if (!uid || !inviteId) return res.status(400).json({ error: "UID and inviteId are required." });

  const inviteRef = gameInvitesRef.child(inviteId);
  const invite    = await rtdbGet(inviteRef);

  if (!invite) return res.status(200).json({ success: true }); // déjà supprimé
  if (invite.fromUid !== uid) return res.status(403).json({ error: "Not authorized." });

  await inviteRef.update({ status: "cancelled" });
  return res.status(200).json({ success: true });
}

/**
 * check-game-invite-status
 * Body: { uid, inviteId }
 * Utilisé par l'expéditeur pour savoir si son invitation a été acceptée/refusée
 * + utilisé par la room sync polling (sender & receiver)
 */
// Cache simple en mémoire (TTL 2s) — évite les lectures RTDB répétées
const _inviteStatusCache = new Map();
const _INVITE_STATUS_TTL = 2000;

async function handleCheckGameInviteStatus(body, res) {
  const { uid, inviteId } = body;
  if (!uid || !inviteId) return res.status(400).json({ error: "UID and inviteId are required." });

  // Vérifier le cache
  const cached = _inviteStatusCache.get(inviteId);
  if (cached && (Date.now() - cached.ts) < _INVITE_STATUS_TTL) {
    const inv = cached.data;
    if (inv.senderUid !== uid && inv.receiverUid !== uid)
      return res.status(403).json({ error: "Not authorized." });
    return res.status(200).json({ success: true, ...inv });
  }

  const inviteRef = gameInvitesRef.child(inviteId);
  const invite    = await rtdbGet(inviteRef);

  if (!invite) return res.status(200).json({ success: true, status: "not_found" });
  if (invite.fromUid !== uid && invite.toUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  const responseData = {
    status:           invite.status,
    game:             invite.game,
    color:            invite.color,
    minutes:          invite.minutes,
    receiverReady:    invite.receiverReady !== false,
    senderUid:        invite.fromUid,
    senderUsername:   invite.fromUsername,
    receiverUid:      invite.toUid,
    receiverUsername: invite.toUsername
  };

  _inviteStatusCache.set(inviteId, { data: responseData, ts: Date.now() });
  setTimeout(() => _inviteStatusCache.delete(inviteId), _INVITE_STATUS_TTL + 100);

  return res.status(200).json({ success: true, ...responseData });
}

/**
 * update-room-ready
 * Body: { uid, inviteId, ready }
 * Receiver met à jour son état prêt (true/false)
 */
async function handleUpdateRoomReady(body, res) {
  const { uid, inviteId, ready } = body;
  if (!uid || !inviteId) return res.status(400).json({ error: "UID and inviteId are required." });

  const inviteRef = gameInvitesRef.child(inviteId);
  const invite    = await rtdbGet(inviteRef);

  if (!invite) return res.status(404).json({ error: "Invitation not found." });
  if (invite.toUid !== uid) return res.status(403).json({ error: "Not authorized." });
  if (invite.status !== "accepted") return res.status(400).json({ error: "Invitation is not active." });

  await inviteRef.update({ receiverReady: ready === true || ready === "true" });
  return res.status(200).json({ success: true });
}

/**
 * update-room-settings
 * Body: { uid, inviteId, color, minutes, game }
 * Sender met à jour color/minutes/game dans RTDB pour que le receiver les voie
 */
async function handleUpdateRoomSettings(body, res) {
  const { uid, inviteId, color, minutes, game } = body;
  if (!uid || !inviteId) return res.status(400).json({ error: "UID and inviteId are required." });

  const inviteRef = gameInvitesRef.child(inviteId);
  const invite    = await rtdbGet(inviteRef);

  if (!invite) return res.status(404).json({ error: "Invitation not found." });
  if (invite.fromUid !== uid) return res.status(403).json({ error: "Not authorized." });
  if (invite.status !== "accepted") return res.status(400).json({ error: "Invitation is not active." });

  const update = {};
  if (color)   update.color   = color;
  if (minutes) update.minutes = parseInt(minutes);
  if (game)    update.game    = game;
  await inviteRef.update(update);
  return res.status(200).json({ success: true });
}

// ── Room Chat handlers (RTDB) ──────────────────────────────────────────────

const CHAT_MAX_CHARS   = 30;
const CHAT_MAX_MSGS    = 20;

/**
 * send-chat-message
 * Body: { uid, inviteId, text }
 * Vérifie que uid est bien sender ou receiver de l'invite,
 * puis écrit le message dans RTDB: roomChats/{inviteId}/messages/{pushId}
 * et supprime automatiquement les messages > 20
 */
async function handleSendChatMessage(body, res) {
  const { uid, inviteId, text } = body;
  if (!uid || !inviteId) return res.status(400).json({ error: "UID and inviteId are required." });
  if (!text || !text.trim()) return res.status(400).json({ error: "Message cannot be empty." });

  // Vérifier que l'utilisateur appartient bien à cette room
  const inviteRef = gameInvitesRef.child(inviteId);
  const invite    = await rtdbGet(inviteRef);
  if (!invite) return res.status(404).json({ error: "Room not found." });
  if (invite.fromUid !== uid && invite.toUid !== uid)
    return res.status(403).json({ error: "Not authorized." });
  if (invite.status !== "accepted")
    return res.status(400).json({ error: "Room is not active." });

  // Limiter à CHAT_MAX_CHARS (compté en Array.from pour les emojis)
  const chars = Array.from(text.trim());
  const safeText = chars.slice(0, CHAT_MAX_CHARS).join('');

  // Récupérer username depuis Firestore
  const userDoc = await usersCollection.doc(uid).get();
  const username = userDoc.exists ? (userDoc.data().username || uid) : uid;

  const msgsRef = rtdb.ref(`roomChats/${inviteId}/messages`);
  const newMsgRef = msgsRef.push();
  await newMsgRef.set({
    senderUid:      uid,
    senderUsername: username,
    text:           safeText,
    ts:             Date.now()
  });

  // Supprimer automatiquement les messages dépassant CHAT_MAX_MSGS
  const allSnap = await msgsRef.once("value");
  if (allSnap.exists()) {
    const allMsgs = [];
    allSnap.forEach(child => {
      allMsgs.push({ key: child.key, ts: child.val().ts || 0 });
    });
    if (allMsgs.length > CHAT_MAX_MSGS) {
      allMsgs.sort((a, b) => a.ts - b.ts);
      const toDelete = allMsgs.slice(0, allMsgs.length - CHAT_MAX_MSGS);
      const delUpdates = {};
      toDelete.forEach(m => { delUpdates[m.key] = null; });
      await msgsRef.update(delUpdates);
    }
  }

  return res.status(200).json({ success: true });
}

/**
 * get-chat-messages
 * Body: { uid, inviteId }
 * Retourne les messages triés par ts (max CHAT_MAX_MSGS derniers)
 */
async function handleGetChatMessages(body, res) {
  const { uid, inviteId } = body;
  if (!uid || !inviteId) return res.status(400).json({ error: "UID and inviteId are required." });

  // Vérifier appartenance à la room
  const inviteRef = gameInvitesRef.child(inviteId);
  const invite    = await rtdbGet(inviteRef);
  if (!invite) return res.status(404).json({ error: "Room not found." });
  if (invite.fromUid !== uid && invite.toUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  const msgsRef = rtdb.ref(`roomChats/${inviteId}/messages`);
  const snap    = await msgsRef.once("value");

  if (!snap.exists()) return res.status(200).json({ success: true, messages: [] });

  const msgs = [];
  snap.forEach(child => {
    const d = child.val();
    msgs.push({
      key:            child.key,
      senderUid:      d.senderUid,
      senderUsername: d.senderUsername,
      text:           d.text,
      ts:             d.ts || 0
    });
  });

  msgs.sort((a, b) => a.ts - b.ts);
  const last = msgs.slice(-CHAT_MAX_MSGS);

  return res.status(200).json({ success: true, messages: last });
}


// ── Fanorona Game handlers ─────────────────────────────────────────────────

const ROWS = ['A','B','C','D','E'];
const COLS = ['1','2','3','4','5','6','7','8','9'];

/**
 * start-fanorona-game
 * Body: { uid, inviteId }
 * Seul le sender (host) peut démarrer.
 * Crée games/{inviteId} dans RTDB avec plateau initial + infos joueurs.
 * Met invite.status = "started".
 */
async function handleStartFanoronaGame(body, res) {
  const { uid, inviteId } = body;
  if (!uid || !inviteId) return res.status(400).json({ error: "UID and inviteId are required." });

  const inviteRef = gameInvitesRef.child(inviteId);
  const invite    = await rtdbGet(inviteRef);

  if (!invite) return res.status(404).json({ error: "Room not found." });
  if (invite.fromUid !== uid) return res.status(403).json({ error: "Only the room host can start the game." });
  if (invite.status !== "accepted") return res.status(400).json({ error: "Room is not active." });

  const gameRef   = rtdb.ref(`games/${inviteId}`);
  const existing  = await rtdbGet(gameRef);

  if (!existing) {
    const initialPieces = {};
    ROWS.forEach((r, ri) => {
      COLS.forEach((c, ci) => {
        const key = r + c;
        if (ri < 2)       initialPieces[key] = "mena";
        else if (ri > 2)  initialPieces[key] = "maintso";
        else {
          if ([1,3,6,8].includes(ci))      initialPieces[key] = "mena";
          else if ([0,2,5,7].includes(ci)) initialPieces[key] = "maintso";
          // ci=4 (C5) = vide
        }
      });
    });

    // Récupérer usernames
    const senderDoc   = await usersCollection.doc(invite.fromUid).get();
    const receiverDoc = await usersCollection.doc(invite.toUid).get();
    const senderUsername   = senderDoc.exists   ? (senderDoc.data().username   || invite.fromUid) : invite.fromUid;
    const receiverUsername = receiverDoc.exists ? (receiverDoc.data().username || invite.toUid)   : invite.toUid;

    // Sender mahazo ny color nofidiny; Receiver mahazo ny mifanohitra
    // invite.color = 'green' na 'red' (ny color nofidiny an'ilay sender)
    const senderColorRaw   = invite.color || 'green';
    const senderColorGame  = senderColorRaw  === 'red' ? 'mena' : 'maintso';
    const receiverColorGame = senderColorGame === 'mena' ? 'maintso' : 'mena';
    // Ny turn voalohany dia maintso foana (araka ny fitsipika fanorona)
    await gameRef.set({
      pieces:            initialPieces,
      turn:              "maintso",
      prevFirstTurn:     "maintso",   // voatahiry ho an'ny restart
      senderUid:         invite.fromUid,
      senderUsername,
      senderColor:       senderColorGame,
      receiverUid:       invite.toUid,
      receiverUsername,
      receiverColor:     receiverColorGame,
      startedAt:         Date.now()
    });
  }

  await inviteRef.update({ status: "started", gameId: inviteId });

  return res.status(200).json({ success: true, gameId: inviteId });
}

/**
 * get-fanorona-game
 * Body: { uid, gameId }
 * Retourne l'état du jeu + couleur du joueur appelant.
 */
async function handleGetFanoronaGame(body, res) {
  const { uid, gameId } = body;
  if (!uid || !gameId) return res.status(400).json({ error: "UID and gameId are required." });

  const gameRef = rtdb.ref(`games/${gameId}`);
  const game    = await rtdbGet(gameRef);

  if (!game) return res.status(404).json({ error: "Game not found." });
  if (game.senderUid !== uid && game.receiverUid !== uid)
    return res.status(403).json({ error: "Not authorized." });

  // Jerena senderColor/receiverColor voatahiry (arakaraka ny nofidian'ilay sender)
  // Fallback: sender=maintso, receiver=mena (raha game taloha tsy misy senderColor)
  const myColor = game.senderUid === uid
    ? (game.senderColor   || "maintso")
    : (game.receiverColor || "mena");
  const opponentColor = myColor === "maintso" ? "mena" : "maintso";
  const opponentUsername = game.senderUid === uid ? game.receiverUsername : game.senderUsername;

  return res.status(200).json({
    success: true,
    myColor,
    opponentColor,
    opponentUsername,
    senderUsername:   game.senderUsername,
    receiverUsername: game.receiverUsername,
    pieces:           game.pieces,
    turn:             game.turn
  });
}
