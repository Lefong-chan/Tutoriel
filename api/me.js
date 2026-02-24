import admin from "firebase-admin";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_KEY)),
    databaseURL: "https://tutoriel-ff487-default-rtdb.firebaseio.com/"
  });
}

const db = admin.database();

export default async function handler(req, res) {

  const auth = req.headers.authorization;

  if (!auth) {
    return res.status(401).json({ error: "No token provided" });
  }

  const token = auth.split(" ")[1];

  try {

    const decoded = jwt.verify(token, SECRET);

    const uid = decoded.uid;

    const snap = await db.ref("users/" + uid).get();

    if (!snap.exists()) {
      return res.status(401).json({ error: "User not found" });
    }

    const user = snap.val();

    res.json({
      uid: user.uid,
      username: user.username,
      email: user.email
    });

  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}
