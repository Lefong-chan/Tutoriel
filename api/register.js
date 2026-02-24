import admin from "firebase-admin";
import bcrypt from "bcryptjs";

const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
    databaseURL: "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

function generateUID() {
  return Math.floor(100000000 + Math.random() * 900000000).toString();
}

export default async function handler(req, res) {

  if (req.headers.origin !== allowedOrigin)
    return res.status(403).json({ error: "Forbidden origin" });

  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ error: "Missing email or password" });

  const snap = await db.ref("users").get();
  const users = snap.val();

  if (users) {
    for (let key in users) {
      if (users[key].email === email) {
        return res.status(400).json({ error: "Email already registered" });
      }
    }
  }

  const hashed = await bcrypt.hash(password, 10);

  let uid;
  let exists = true;

  while (exists) {
    uid = generateUID();
    const check = await db.ref("users/" + uid).get();
    if (!check.exists()) exists = false;
  }

  await db.ref("users/" + uid).set({
    uid,
    email,
    password: hashed,
    provider: "local",
    createdAt: Date.now()
  });

  res.json({ success: true });
}
