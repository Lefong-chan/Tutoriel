// api/session.js

import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;
const isProd = process.env.NODE_ENV === "production";
const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!SECRET) throw new Error("JWT_SECRET not set");
if (!process.env.FIREBASE_KEY) throw new Error("FIREBASE_KEY not set");

// Initialisation Firebase (identique à auth.js)
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

// Regex pour validation du username
const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;

// Helper : extraire l'utilisateur depuis le cookie
async function getUserFromCookie(req) {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  
  const tokenMatch = cookie.match(/token=([^;]+)/);
  if (!tokenMatch) return null;
  
  const token = tokenMatch[1];
  try {
    const decoded = jwt.verify(token, SECRET);
    const uid = decoded.uid;
    const userDoc = await usersCollection.doc(uid).get();
    if (!userDoc.exists) return null;
    return { id: uid, ...userDoc.data() };
  } catch (err) {
    return null;
  }
}

// Helper : définir le cookie (réutilisé)
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

// Helper : supprimer le cookie
function clearCookie(res) {
  const cookieOptions = [
    `token=`,
    "HttpOnly",
    `Max-Age=0`,
    "Path=/",
    `SameSite=${isProd ? "None" : "Lax"}`,
  ];
  if (isProd) cookieOptions.push("Secure");
  res.setHeader("Set-Cookie", cookieOptions.join("; "));
}

export default async function handler(req, res) {
  // Vérification CORS
  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden" });
  }

  // GET : récupérer la session
  if (req.method === "GET") {
    try {
      const user = await getUserFromCookie(req);
      if (!user) {
        return res.status(401).json({ authenticated: false });
      }
      // Ne pas renvoyer les champs sensibles
      const { password, otp, otpExpires, phoneOTP, phoneOTPExpires, resetOTP, resetOTPExpires, ...safeUser } = user;
      return res.status(200).json({ authenticated: true, user: safeUser });
    } catch (err) {
      console.error("SESSION GET ERROR:", err);
      return res.status(500).json({ error: "Server error" });
    }
  }

  // POST : actions (update-username, logout)
  if (req.method === "POST") {
    const { action, ...payload } = req.body;
    if (!action) {
      return res.status(400).json({ error: "Action required" });
    }

    try {
      switch (action) {
        case "update-username":
          return await handleUpdateUsername(req, payload, res);
        case "logout":
          return await handleLogout(res);
        default:
          return res.status(400).json({ error: "Invalid action" });
      }
    } catch (err) {
      console.error(`SESSION POST ERROR [${action}]:`, err);
      return res.status(500).json({ error: "Server error" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

async function handleUpdateUsername(req, body, res) {
  const { newUsername, password } = body;
  if (!newUsername || !password) {
    return res.status(400).json({ error: "New username and password required" });
  }

  // Validation du format
  if (!usernameRegex.test(newUsername)) {
    return res.status(400).json({ error: "Username must be 3-20 characters and contain only letters, numbers, or underscores" });
  }

  // Récupérer l'utilisateur connecté
  const user = await getUserFromCookie(req);
  if (!user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  // Vérifier le mot de passe
  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return res.status(400).json({ error: "Invalid password" });
  }

  // Vérifier l'unicité du username
  const existing = await usersCollection.where("username", "==", newUsername).limit(1).get();
  if (!existing.empty) {
    const existingDoc = existing.docs[0];
    if (existingDoc.id !== user.uid) {
      return res.status(400).json({ error: "Username already taken" });
    }
  }

  // Mettre à jour
  await usersCollection.doc(user.uid).update({
    username: newUsername
  });

  return res.status(200).json({ success: true, username: newUsername });
}

async function handleLogout(res) {
  clearCookie(res);
  return res.status(200).json({ success: true });
}
