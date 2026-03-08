// api/session.js

import admin from 'firebase-admin';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

/* ================= ENV ================= */
const SECRET = process.env.JWT_SECRET;
const isProd = process.env.NODE_ENV === 'production';

if (!SECRET) throw new Error('JWT_SECRET not set');
if (!process.env.FIREBASE_KEY) throw new Error('FIREBASE_KEY not set');

/* ================= FIREBASE INIT ================= */
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();
const usersCollection = db.collection('users');

/* ================= HELPER: Extraire le token du cookie ================= */
function getTokenFromCookie(req) {
  const cookieHeader = req.headers.cookie || '';
  const cookies = cookieHeader.split(';').reduce((acc, cookie) => {
    const [key, value] = cookie.trim().split('=');
    if (key && value) acc[key] = value;
    return acc;
  }, {});
  return cookies.token || null;
}

/* ================= HELPER: Vérifier l'utilisateur ================= */
async function verifyUserFromToken(token) {
  try {
    const decoded = jwt.verify(token, SECRET);
    const userDoc = await usersCollection.doc(decoded.uid).get();
    if (!userDoc.exists) return null;
    const userData = userDoc.data();
    return {
      uid: userDoc.id,
      email: userData.email,
      username: userData.username || null,
      emailVerified: userData.emailVerified || false,
    };
  } catch (err) {
    return null;
  }
}

/* ================= VALIDATION PSEUDO ================= */
const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;

async function isUsernameTaken(username) {
  const snap = await usersCollection.where('username', '==', username).limit(1).get();
  return !snap.empty;
}

/* ================= MAIN HANDLER ================= */
export default async function handler(req, res) {
  // Gestion des CORS si nécessaire (identique à auth.js)
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  if (allowedOrigin && req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Récupération du token
  const token = getTokenFromCookie(req);
  if (!token) {
    return res.status(401).json({ error: 'Non authentifié' });
  }

  const user = await verifyUserFromToken(token);
  if (!user) {
    return res.status(401).json({ error: 'Token invalide' });
  }

  // === GET : renvoyer les infos utilisateur ===
  if (req.method === 'GET') {
    return res.status(200).json({
      authenticated: true,
      user: {
        uid: user.uid,
        email: user.email,
        username: user.username,
        emailVerified: user.emailVerified,
      },
    });
  }

  // === POST : actions sur la session ===
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, ...payload } = req.body;

  try {
    switch (action) {
      case 'set-username':
        return await handleSetUsername(user, payload, res);
      case 'update-username':
        return await handleUpdateUsername(user, payload, res);
      case 'logout':
        return await handleLogout(res);
      default:
        return res.status(400).json({ error: 'Action invalide' });
    }
  } catch (err) {
    console.error('SESSION ERROR:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}

/* ================= SET USERNAME (première fois) ================= */
async function handleSetUsername(user, body, res) {
  const { newUsername } = body;

  if (!newUsername || !usernameRegex.test(newUsername)) {
    return res.status(400).json({ error: 'Format de pseudo invalide (3-20 caractères, lettres, chiffres, _).' });
  }

  // Vérifier si l'utilisateur a déjà un pseudo
  const userDoc = await usersCollection.doc(user.uid).get();
  if (userDoc.data().username) {
    return res.status(400).json({ error: 'Vous avez déjà un pseudo' });
  }

  // Vérifier l'unicité
  if (await isUsernameTaken(newUsername)) {
    return res.status(400).json({ error: 'Nom d\'utilisateur déjà pris' });
  }

  // Mettre à jour
  await usersCollection.doc(user.uid).update({
    username: newUsername,
  });

  return res.status(200).json({ success: true });
}

/* ================= UPDATE USERNAME (avec vérification mot de passe) ================= */
async function handleUpdateUsername(user, body, res) {
  const { newUsername, password } = body;

  if (!newUsername || !usernameRegex.test(newUsername)) {
    return res.status(400).json({ error: 'Format de pseudo invalide' });
  }
  if (!password) {
    return res.status(400).json({ error: 'Mot de passe requis' });
  }

  // Vérifier le mot de passe
  const userDoc = await usersCollection.doc(user.uid).get();
  const userData = userDoc.data();
  const isMatch = await bcrypt.compare(password, userData.password);
  if (!isMatch) {
    return res.status(400).json({ error: 'Invalid password' });
  }

  // Vérifier l'unicité (ne pas prendre le même pseudo)
  if (newUsername !== userData.username) {
    if (await isUsernameTaken(newUsername)) {
      return res.status(400).json({ error: 'Username already taken' });
    }
  }

  // Mettre à jour
  await usersCollection.doc(user.uid).update({
    username: newUsername,
  });

  return res.status(200).json({ success: true });
}

/* ================= LOGOUT ================= */
async function handleLogout(res) {
  // Effacer le cookie HttpOnly
  const cookieOptions = [
    'token=',
    'HttpOnly',
    'Max-Age=0',
    'Path=/',
    `SameSite=${isProd ? 'None' : 'Lax'}`,
  ];
  if (isProd) cookieOptions.push('Secure');
  res.setHeader('Set-Cookie', cookieOptions.join('; '));

  return res.status(200).json({ success: true });
}
