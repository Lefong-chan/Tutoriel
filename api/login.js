import admin from "firebase-admin";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const allowedOrigin = process.env.ALLOWED_ORIGIN;
const SECRET = process.env.JWT_SECRET;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
    databaseURL: "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

export default async function handler(req, res) {

  if (req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ error: "Forbidden origin" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { identifier, password } = req.body;

  if (!identifier || !password) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const snap = await db.ref("users").get();

  if (!snap.exists()) {
    return res.status(400).json({ error: "No users found" });
  }

  const users = snap.val();

  let user = null;
  let uid = null;

  for (const key in users) {
    
    if (identifier.includes("@")) {
      if (users[key].email.toLowerCase() === identifier.toLowerCase()) {
        user = users[key];
        uid = key;
        break;
      }
    }
    
    else {
      if (users[key].username.toLowerCase() === identifier.toLowerCase()) {
        user = users[key];
        uid = key;
        break;
      }
    }
  }

  if (!user) {
    return res.status(400).json({ error: "User not found" });
  }

  const validPassword = await bcrypt.compare(password, user.password);

  if (!validPassword) {
    return res.status(400).json({ error: "Invalid password" });
  }

  const token = jwt.sign(
    {
      uid: user.uid,
      email: user.email
    },
    SECRET,
    { expiresIn: "2h" }
  );

  return res.json({ token });
}
