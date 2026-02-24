import admin from "firebase-admin";
import bcrypt from "bcryptjs";

const allowedOrigin = process.env.ALLOWED_ORIGIN;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
    databaseURL: "https://tompon-daka-default-rtdb.firebaseio.com"
  });
}

const db = admin.database();

export default async function handler(req, res) {

  if (req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden origin" });
  }

  if (req.method !== "POST")
    return res.status(405).end();

  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: "Missing fields" });

  const userRef = db.ref("users/" + username);
  const snap = await userRef.get();

  if (snap.exists())
    return res.status(400).json({ error: "User already exists" });

  const hashed = await bcrypt.hash(password, 10);

  await userRef.set({
    username,
    password: hashed,
    createdAt: Date.now()
  });

  res.json({ success: true });
      }
