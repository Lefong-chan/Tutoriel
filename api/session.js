// session.js
import admin from "firebase-admin";

/* ================= ENV ================= */
if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");

/* ================= FIREBASE INIT ================= */
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();
const usersCollection = db.collection("users");

/* ================= MAIN HANDLER ================= */
export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { action, ...payload } = req.body;
  if (!action) return res.status(400).json({ error: "Action required" });

  try {
    switch (action) {
      case "get-session": return await handleGetSession(payload, res);
      case "set-username": return await handleSetUsername(payload, res);
      case "check-username": return await handleCheckUsername(payload, res);
      default: return res.status(400).json({ error: "Invalid action" });
    }
  } catch (err) {
    console.error(`SESSION ERROR [${action}]:`, err);
    return res.status(500).json({ error: "Server error" });
  }
}

/* ================= FUNCTIONS ================= */

/**
 * Get user session data from database
 * Expects: { uid }
 * Returns: { uid, email, username, createdAt }
 */
async function handleGetSession(body, res) {
  const { uid } = body;
  
  if (!uid) {
    return res.status(400).json({ error: "UID required" });
  }

  try {
    const userDoc = await usersCollection.doc(uid).get();
    
    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const userData = userDoc.data();
    
    // Returns only necessary data
    return res.status(200).json({
      success: true,
      user: {
        uid: userData.uid,
        email: userData.email,
        username: userData.username || "",
        createdAt: userData.createdAt
      }
    });
  } catch (error) {
    console.error("Error getting session:", error);
    return res.status(500).json({ error: "Failed to get session" });
  }
}

/**
 * Set username for a user
 * Expects: { uid, username }
 * Returns: { success, user }
 */
async function handleSetUsername(body, res) {
  const { uid, username } = body;
  
  if (!uid) {
    return res.status(400).json({ error: "UID required" });
  }

  if (!username || username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: "Username must be between 3 and 20 characters" });
  }

  // Validate username format (alphanumeric and underscore only)
  const usernameRegex = /^[a-zA-Z0-9_]+$/;
  if (!usernameRegex.test(username)) {
    return res.status(400).json({ error: "Username can only contain letters, numbers, and underscores" });
  }

  try {
    // Check if username is already taken
    const existingUser = await usersCollection
      .where("username", "==", username)
      .limit(1)
      .get();

    if (!existingUser.empty) {
      // Check if it's the same user
      const existingDoc = existingUser.docs[0];
      if (existingDoc.id !== uid) {
        return res.status(400).json({ error: "Username already taken" });
      }
    }

    // Update username
    await usersCollection.doc(uid).update({
      username: username,
      updatedAt: Date.now()
    });

    // Get updated user data
    const updatedDoc = await usersCollection.doc(uid).get();
    const userData = updatedDoc.data();

    return res.status(200).json({
      success: true,
      user: {
        uid: userData.uid,
        email: userData.email,
        username: userData.username
      }
    });
  } catch (error) {
    console.error("Error setting username:", error);
    return res.status(500).json({ error: "Failed to set username" });
  }
}

/**
 * Check if username is available
 * Expects: { username }
 * Returns: { available: boolean }
 */
async function handleCheckUsername(body, res) {
  const { username } = body;
  
  if (!username || username.length < 3 || username.length > 20) {
    return res.status(400).json({ error: "Invalid username length" });
  }

  try {
    const existingUser = await usersCollection
      .where("username", "==", username)
      .limit(1)
      .get();

    return res.status(200).json({
      success: true,
      available: existingUser.empty
    });
  } catch (error) {
    console.error("Error checking username:", error);
    return res.status(500).json({ error: "Failed to check username" });
  }
}
