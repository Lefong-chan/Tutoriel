import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const allowedOrigin = process.env.ALLOWED_ORIGIN;
const SECRET = process.env.JWT_SECRET;

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

  const snap = await db.ref("users/" + username).get();
  if (!snap.exists())
    return res.status(400).json({ error: "User not found" });

  const user = snap.val();

  const valid = await bcrypt.compare(password, user.password);
  if (!valid)
    return res.status(400).json({ error: "Wrong password" });

  const token = jwt.sign({ username }, SECRET, { expiresIn: "2h" });

  res.json({ token });
}
