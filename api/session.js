import admin from "firebase-admin";

if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");
const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();
const usersCollection = db.collection("users");

const FRIEND_LIMIT = 100;
const ONLINE_THRESHOLD = 35 * 1000;

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
      case "get-session": return await handleGetSession(payload, res);
      case "set-username": return await handleSetUsername(payload, res);
      case "check-username": return await handleCheckUsername(payload, res);
      case "ping": return await handlePing(payload, res);
      case "search-users": return await handleSearchUsers(payload, res);
      case "send-friend-request": return await handleSendFriendRequest(payload, res);
      case "accept-friend-request": return await handleAcceptFriendRequest(payload, res);
      case "reject-friend-request": return await handleRejectFriendRequest(payload, res);
      case "cancel-friend-request": return await handleCancelFriendRequest(payload, res);
      case "remove-friend": return await handleRemoveFriend(payload, res);
      case "get-friends": return await handleGetFriends(payload, res);
      case "get-friend-requests": return await handleGetFriendRequests(payload, res);
      case "get-sent-requests": return await handleGetSentRequests(payload, res);
      default: return res.status(400).json({ error: "Invalid action." });
    }
  } catch (err) {
    console.error(`SESSION ERROR [${action}]:`, err);
    return res.status(500).json({ error: "An unexpected server error occurred." });
  }
}

async function handleGetSession(body, res) {
  const { uid } = body;
  if (!uid) return res.status(400).json({ error: "UID is required." });

  const userDoc = await usersCollection.doc(uid).get();
  if (!userDoc.exists) return res.status(404).json({ error: "User not found." });

  await usersCollection.doc(uid).update({ lastSeen: Date.now() });

  const userData = userDoc.data();
  return res.status(200).json({
    success: true,
    user: { uid: userData.uid, email: userData.email, username: userData.username || "", createdAt: userData.createdAt }
  });
}

async function handlePing(body, res) {
  const { uid } = body;
  if (!uid) return res.status(400).json({ error: "UID is required." });
  await usersCollection.doc(uid).update({ lastSeen: Date.now() });
  return res.status(200).json({ success: true });
}

async function handleSetUsername(body, res) {
  const { uid, username } = body;
  if (!uid) return res.status(400).json({ error: "UID is required." });
  if (!username || username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: "Username must be between 3 and 20 characters." });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: "Username can only contain letters, numbers, and underscores." });
  }

  const existing = await usersCollection.where("username", "==", username).limit(1).get();
  if (!existing.empty && existing.docs[0].id !== uid) {
    return res.status(400).json({ error: "This username is already taken." });
  }

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
  if (!username || username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: "Invalid username length." });
  }
  const existing = await usersCollection.where("username", "==", username).limit(1).get();
  return res.status(200).json({ success: true, available: existing.empty });
}

async function handleSearchUsers(body, res) {
  const { uid, query } = body;
  if (!uid) return res.status(400).json({ error: "UID is required." });
  if (!query || query.trim().length < 3) return res.status(400).json({ error: "Search query must be at least 3 characters." });

  const q = query.trim();
  const qLower = q.toLowerCase();

  const currentDoc = await usersCollection.doc(uid).get();
  if (!currentDoc.exists) return res.status(404).json({ error: "User not found." });
  const currentData = currentDoc.data();
  const friends = currentData.friends || [];
  const sentRequests = currentData.sentRequests || [];
  const receivedRequests = currentData.friendRequests || [];
  const currentTotal = friends.length + sentRequests.length;

  const seenIds = new Set();
  const users = [];

  function addDoc(doc) {
    if (!doc || !doc.exists) return;
    if (doc.id === uid) return;
    if (seenIds.has(doc.id)) return;
    const data = doc.data();
    if (!data.username) return;
    seenIds.add(doc.id);
    let relation = "none";
    if (friends.includes(doc.id)) relation = "friend";
    else if (sentRequests.includes(doc.id)) relation = "pending_sent";
    else if (receivedRequests.includes(doc.id)) relation = "pending_received";

    const targetFriends = data.friends || [];
    const targetTotal = targetFriends.length + (data.friendRequests || []).length;
    const targetFull = targetTotal >= FRIEND_LIMIT;

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
  if (!senderDoc.exists) return res.status(404).json({ error: "Sender not found." });
  if (!receiverDoc.exists) return res.status(404).json({ error: "User not found." });

  const senderData = senderDoc.data();
  const receiverData = receiverDoc.data();

  const senderFriends = senderData.friends || [];
  const senderSent = senderData.sentRequests || [];
  const senderTotal = senderFriends.length + senderSent.length;

  if (senderTotal >= FRIEND_LIMIT) {
    return res.status(400).json({ error: `You have reached the maximum of ${FRIEND_LIMIT} friends and pending requests.` });
  }

  const receiverFriends = receiverData.friends || [];
  const receiverReceived = receiverData.friendRequests || [];
  const receiverTotal = receiverFriends.length + receiverReceived.length;

  if (receiverTotal >= FRIEND_LIMIT) {
    return res.status(400).json({ error: "This player's friend list is full." });
  }

  if (senderFriends.includes(toUid)) return res.status(400).json({ error: "You are already friends with this user." });
  if (senderSent.includes(toUid)) return res.status(400).json({ error: "A friend request has already been sent to this user." });
  if ((senderData.friendRequests || []).includes(toUid)) return res.status(400).json({ error: "This user has already sent you a friend request. Accept it instead." });

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
    friendCount: (sd.friends || []).length,
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
  if (!senderDoc.exists) return res.status(404).json({ error: "Requesting user not found." });

  const accepterData = accepterDoc.data();
  if (!(accepterData.friendRequests || []).includes(fromUid)) {
    return res.status(400).json({ error: "No pending friend request from this user." });
  }

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
    friendCount: (ad.friends || []).length,
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
  if (!senderDoc.exists) return res.status(404).json({ error: "Requesting user not found." });

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
  if (!senderDoc.exists) return res.status(404).json({ error: "User not found." });
  if (!receiverDoc.exists) return res.status(404).json({ error: "Target user not found." });

  const batch = db.batch();
  batch.update(senderDoc.ref, { sentRequests: admin.firestore.FieldValue.arrayRemove(toUid) });
  batch.update(receiverDoc.ref, {
    friendRequests: admin.firestore.FieldValue.arrayRemove(uid),
    [`friendRequestTimes.${uid}`]: admin.firestore.FieldValue.delete()
  });
  await batch.commit();

  const updatedSender = await usersCollection.doc(uid).get();
  const sd = updatedSender.data();
  return res.status(200).json({
    success: true,
    friendCount: (sd.friends || []).length,
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
  if (!userDoc.exists) return res.status(404).json({ error: "User not found." });
  if (!friendDoc.exists) return res.status(404).json({ error: "Friend not found." });

  const batch = db.batch();
  batch.update(userDoc.ref, { friends: admin.firestore.FieldValue.arrayRemove(friendUid) });
  batch.update(friendDoc.ref, { friends: admin.firestore.FieldValue.arrayRemove(uid) });
  await batch.commit();

  const updatedUser = await usersCollection.doc(uid).get();
  const ud = updatedUser.data();
  return res.status(200).json({
    success: true,
    friendCount: (ud.friends || []).length,
    currentTotal: (ud.friends || []).length + (ud.sentRequests || []).length
  });
}

async function handleGetFriends(body, res) {
  const { uid } = body;
  if (!uid) return res.status(400).json({ error: "UID is required." });

  const userDoc = await usersCollection.doc(uid).get();
  if (!userDoc.exists) return res.status(404).json({ error: "User not found." });

  const userData = userDoc.data();
  const friendUids = userData.friends || [];
  const currentTotal = friendUids.length + (userData.sentRequests || []).length;

  if (friendUids.length === 0) {
    return res.status(200).json({ success: true, friends: [], friendCount: 0, currentTotal, friendLimit: FRIEND_LIMIT });
  }

  const chunks = [];
  for (let i = 0; i < friendUids.length; i += 10) chunks.push(friendUids.slice(i, i + 10));

  const friends = [];
  const now = Date.now();
  for (const chunk of chunks) {
    const snap = await usersCollection.where(admin.firestore.FieldPath.documentId(), "in", chunk).get();
    snap.docs.forEach(doc => {
      const d = doc.data();
      const lastSeen = d.lastSeen || 0;
      const online = (now - lastSeen) < ONLINE_THRESHOLD;
      friends.push({
        uid: doc.id,
        username: d.username || doc.id,
        online,
        lastSeen
      });
    });
  }

  friends.sort((a, b) => {
    if (a.online && !b.online) return -1;
    if (!a.online && b.online) return 1;
    return (b.lastSeen || 0) - (a.lastSeen || 0);
  });

  return res.status(200).json({ success: true, friends, friendCount: friendUids.length, currentTotal, friendLimit: FRIEND_LIMIT });
}

async function handleGetFriendRequests(body, res) {
  const { uid } = body;
  if (!uid) return res.status(400).json({ error: "UID is required." });

  const userDoc = await usersCollection.doc(uid).get();
  if (!userDoc.exists) return res.status(404).json({ error: "User not found." });

  const userData = userDoc.data();
  const requestUids = userData.friendRequests || [];
  const requestTimes = userData.friendRequestTimes || {};

  if (requestUids.length === 0) return res.status(200).json({ success: true, requests: [] });

  const chunks = [];
  for (let i = 0; i < requestUids.length; i += 10) chunks.push(requestUids.slice(i, i + 10));

  const requests = [];
  for (const chunk of chunks) {
    const snap = await usersCollection.where(admin.firestore.FieldPath.documentId(), "in", chunk).get();
    snap.docs.forEach(doc => {
      requests.push({
        uid: doc.id,
        username: doc.data().username || doc.id,
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
  if (sentUids.length === 0) return res.status(200).json({ success: true, sent: [], sentCount: 0 });

  const chunks = [];
  for (let i = 0; i < sentUids.length; i += 10) chunks.push(sentUids.slice(i, i + 10));

  const sent = [];
  for (const chunk of chunks) {
    const snap = await usersCollection.where(admin.firestore.FieldPath.documentId(), "in", chunk).get();
    snap.docs.forEach(doc => {
      sent.push({ uid: doc.id, username: doc.data().username || doc.id });
    });
  }

  return res.status(200).json({ success: true, sent, sentCount: sentUids.length });
}
