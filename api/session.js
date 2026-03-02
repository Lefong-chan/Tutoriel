import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;
const isProd = process.env.NODE_ENV === "production";
const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!SECRET) throw new Error("JWT_SECRET not set");
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

/* ================= USERNAME VALIDATION ================= */
const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;

/* ================= CORS HANDLER ================= */
function applyCors(req, res) {
  const origin = req.headers.origin;
  
  if (allowedOrigin && origin && origin !== allowedOrigin) {
    return false;
  }
  
  res.setHeader(
    "Access-Control-Allow-Origin",
    allowedOrigin || "*"
  );
  res.setHeader(
    "Access-Control-Allow-Credentials",
    "true"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,POST,OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );
  
  return true;
}

/* ================= COOKIE HELPERS ================= */
function setCookie(res, token) {
  const cookieOptions = [
    `token=${token}`,
    "HttpOnly",
    `Max-Age=${7 * 24 * 60 * 60}`,
    "Path=/",
    `SameSite=${isProd ? "None" : "Lax"}`,
    "Priority=High"
  ];
  
  if (isProd) cookieOptions.push("Secure");
  
  res.setHeader("Set-Cookie", cookieOptions.join("; "));
}

function clearCookie(res) {
  const cookieOptions = [
    `token=`,
    "HttpOnly",
    `Max-Age=0`,
    "Path=/",
    `SameSite=${isProd ? "None" : "Lax"}`
  ];
  
  if (isProd) cookieOptions.push("Secure");
  
  res.setHeader("Set-Cookie", cookieOptions.join("; "));
}

/* ================= AUTH FROM COOKIE ================= */
async function getUserFromCookie(req) {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  
  const tokenMatch = cookie.match(/token=([^;]+)/);
  if (!tokenMatch) return null;
  
  try {
    const decoded = jwt.verify(tokenMatch[1], SECRET);
    const userDoc = await usersCollection.doc(decoded.uid).get();
    if (!userDoc.exists) return null;
    return { uid: decoded.uid, ...userDoc.data() };
  } catch {
    return null;
  }
}

/* ================= MAIN HANDLER ================= */
export default async function handler(req, res) {
  
  // CORS
  if (!applyCors(req, res)) {
    return res.status(403).json({ error: "Forbidden" });
  }
  
  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  
  /* ================= GET SESSION ================= */
  if (req.method === "GET") {
    try {
      const user = await getUserFromCookie(req);
      
      if (!user) {
        return res.status(401).json({ authenticated: false });
      }
      
      const {
        password,
        otp,
        otpExpires,
        phoneOTP,
        phoneOTPExpires,
        resetOTP,
        resetOTPExpires,
        ...safeUser
      } = user;
      
      return res.status(200).json({
        authenticated: true,
        user: safeUser
      });
      
    } catch (err) {
      console.error("SESSION GET ERROR:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }
  
  /* ================= POST ACTIONS ================= */
  if (req.method === "POST") {
    
    const { action, ...payload } = req.body;
    
    if (!action) {
      return res.status(400).json({ error: "Action required" });
    }
    
    try {
      switch (action) {
        
        case "set-username":
          return await handleSetUsername(req, payload, res);
          
        case "update-username":
          return await handleUpdateUsername(req, payload, res);
          
        case "logout":
          clearCookie(res);
          return res.status(200).json({ success: true });
          
        default:
          return res.status(400).json({ error: "Invalid action" });
      }
      
    } catch (err) {
      console.error("SESSION POST ERROR:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }
  
  return res.status(405).json({ error: "Method not allowed" });
}

/* ================= SET USERNAME (first time) ================= */
async function handleSetUsername(req, body, res) {
  const { newUsername } = body;
  
  if (!newUsername) {
    return res.status(400).json({ error: "New username required" });
  }
  
  if (!usernameRegex.test(newUsername)) {
    return res.status(400).json({
      error: "Username must be 3-20 characters (letters, numbers, underscores)"
    });
  }
  
  const user = await getUserFromCookie(req);
  if (!user) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  
  // Empêcher si un username existe déjà (première fois seulement)
  if (user.username) {
    return res.status(400).json({ error: "Username already set. Use update-username to change it." });
  }
  
  // Vérifier que le nouveau nom n'est pas déjà pris par un autre utilisateur
  const existing = await usersCollection
    .where("username", "==", newUsername)
    .limit(1)
    .get();
  
  if (!existing.empty) {
    return res.status(400).json({ error: "Username already taken" });
  }
  
  // Mettre à jour l'utilisateur
  await usersCollection.doc(user.uid).update({
    username: newUsername
  });
  
  return res.status(200).json({
    success: true,
    username: newUsername
  });
}

/* ================= UPDATE USERNAME (with password) ================= */
async function handleUpdateUsername(req, body, res) {
  const { newUsername, password } = body;
  
  if (!newUsername || !password) {
    return res.status(400).json({
      error: "New username and password required"
    });
  }
  
  if (!usernameRegex.test(newUsername)) {
    return res.status(400).json({
      error: "Username must be 3-20 characters (letters, numbers, underscores)"
    });
  }
  
  const user = await getUserFromCookie(req);
  if (!user) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return res.status(400).json({ error: "Invalid password" });
  }
  
  const existing = await usersCollection
    .where("username", "==", newUsername)
    .limit(1)
    .get();
  
  if (!existing.empty && existing.docs[0].id !== user.uid) {
    return res.status(400).json({ error: "Username already taken" });
  }
  
  await usersCollection.doc(user.uid).update({
    username: newUsername
  });
  
  return res.status(200).json({
    success: true,
    username: newUsername
  });
}
